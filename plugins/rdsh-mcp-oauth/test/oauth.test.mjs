import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { loadRuntime } from "../runtime.mjs";
import { openCredentials, main } from "../cli.mjs";
import { createOAuthManager, configuration } from "../oauth.mjs";
import {
  patchSource,
  changeSeam,
  verifySeam,
  ORIGINAL_SHA256,
  sha256,
} from "../native-seam.mjs";
import { oauthFixture } from "./fixture.mjs";
import { createPlugin } from "../index.mjs";

const runtime = await loadRuntime();
async function setup(t) {
  const fixture = await oauthFixture(),
    home = await mkdtemp(join(tmpdir(), "rdsh-mcp-oauth-"));
  const p = await openCredentials(runtime, home);
  let time = Date.now();
  const make = (config = fixture.config(), credentials = p.credentials) =>
    createOAuthManager({
      config,
      credentials,
      sdk: runtime.sdk,
      now: () => time,
    });
  const login = async (manager, requested) =>
    manager.finishLogin(
      fixture.callback((await manager.beginLogin(requested)).authorizationUrl),
    );
  t.after(async () => {
    await p.close();
    await fixture.close();
    await rm(home, { recursive: true });
  });
  return {
    ...fixture,
    home,
    credentials: p.credentials,
    make,
    login,
    advance: (ms) => (time += ms),
  };
}
test("native grant store: alias and URL isolation, targeted logout and secret-free export", async (t) => {
  const f = await setup(t),
    a = f.make(),
    b = f.make(f.config("private"));
  await f.login(a);
  await f.login(b);
  assert.notEqual(a.key, b.key);
  assert.notEqual(await a.token(), await b.token());
  await a.logout();
  assert.equal((await a.inspect()).configured, false);
  assert.equal((await b.inspect()).configured, true);
  const changed = f.make({ ...f.config("private"), url: f.base + "/new" });
  assert.notEqual(changed.key, b.key);
  assert.equal((await changed.inspect()).configured, false);
  const output = JSON.stringify(await b.inspect());
  assert.doesNotMatch(
    output,
    /FAKE_ACCESS|FAKE_REFRESH|FAKE_CODE|verifier|client_secret/,
  );
  assert.doesNotMatch(
    b.redactDiagnostic(`remote echoed ${await b.token()}`),
    /FAKE_ACCESS/,
  );
  assert.match(
    await readFile(join(f.home, ".credentials.yaml"), "utf8"),
    /kind: grant/,
  );
});
test("real SDK PKCE login rejects callback substitution, duplicates, state, issuer, expiry and replay before token exchange", async (t) => {
  const f = await setup(t),
    a = f.make();
  const callback = f.callback((await a.beginLogin()).authorizationUrl);
  for (const [change, pattern] of [
    [(u) => (u.pathname = "/bad"), /callback_mismatch/],
    [(u) => u.searchParams.set("state", "bad"), /state_mismatch/],
    [
      (u) => u.searchParams.append("code", "extra"),
      /duplicate_callback_parameter/,
    ],
    [(u) => u.searchParams.set("iss", f.base + "/alien"), /operation_failed/],
  ]) {
    const url = new URL(callback);
    change(url);
    await assert.rejects(a.finishLogin(url.href), pattern);
    assert.equal(f.state.tokens, 0);
  }
  await f.credentials.modifyRecord(a.key, (record) => ({
    ...record,
    payload: {
      ...record.payload,
      pending: { ...record.payload.pending, verifier: "tampered" },
    },
  }));
  await assert.rejects(a.finishLogin(callback), /pkce_mismatch/);
  assert.equal(f.state.tokens, 0);
  const good = f.callback((await a.beginLogin()).authorizationUrl);
  await a.finishLogin(good);
  await assert.rejects(a.finishLogin(good), /login_expired_or_absent/);
  await a.beginLogin();
  f.advance(600001);
  await assert.rejects(a.finishLogin(good), /login_expired_or_absent/);
});
test("untrusted metadata, issuer echo, and token redirects are refused without credential forwarding", async (t) => {
  const f = await setup(t);
  await assert.rejects(
    f.make({ ...f.config(), issuer: f.base + "/alien" }).beginLogin(),
    /untrusted_issuer/,
  );
  f.state.wrongResource = true;
  await assert.rejects(f.make().beginLogin(), /resource_mismatch/);
  f.state.wrongResource = false;
  f.state.wrongIssuer = true;
  await assert.rejects(
    f.make().beginLogin(),
    /operation_failed|issuer_mismatch/,
  );
  f.state.wrongIssuer = false;
  const a = f.make(),
    callback = f.callback((await a.beginLogin()).authorizationUrl);
  f.state.redirectToken = true;
  await assert.rejects(a.finishLogin(callback), /operation_failed/);
  assert.equal(
    f.state.requests.some((r) => r.path === "/leak"),
    false,
  );
  assert.equal(
    f.state.requests
      .filter((r) => r.path.includes(".well-known"))
      .some((r) => r.headers.authorization),
    false,
  );
});
test("expiry refresh is serialized through native cross-process writer; rotating tokens refreshed once", async (t) => {
  const f = await setup(t),
    a = f.make();
  await f.login(a);
  f.advance(61000);
  const second = await openCredentials(runtime, f.home);
  t.after(second.close);
  const b = f.make(f.config(), second.credentials);
  const values = await Promise.all([
    a.token(),
    b.token(),
    a.token(),
    b.token(),
  ]);
  assert.equal(new Set(values).size, 1);
  assert.equal(f.state.refreshes, 1);
  assert.equal(
    f.state.requests
      .filter((r) => r.path === "/token")
      .at(-1)
      .body.includes("scope="),
    false,
  );
});
test("invalid_grant invalidates only selected alias; remote echoed secrets are absent from errors", async (t) => {
  const f = await setup(t),
    a = f.make(),
    b = f.make(f.config("private"));
  await f.login(a);
  await f.login(b);
  f.advance(61000);
  f.state.invalidRefresh = true;
  await assert.rejects(
    a.token(),
    (e) => e.message === "MCP OAuth: login_required",
  );
  assert.equal((await a.inspect()).configured, false);
  assert.equal((await b.inspect()).configured, true);
});
test("additional scope requires explicit fresh consent, including scopes outside metadata scopes_supported", async (t) => {
  const f = await setup(t),
    a = f.make();
  await f.login(a);
  f.state.requiredScope = "read write";
  const options = a.transportOptions();
  await options.authProvider.token();
  await assert.rejects(
    options.fetch(f.config().url, {
      headers: { authorization: "Bearer fake" },
    }),
    /consent_required/,
  );
  await assert.rejects(a.beginLogin(), /consent_required/);
  assert.equal(f.state.refreshes, 0);
  await f.login(a, ["read", "write"]);
  assert.deepEqual((await a.inspect()).scopes, ["read", "write"]);
  f.state.tokenExtraScope = true;
  await assert.rejects(
    f
      .make(f.config("new"))
      .finishLogin(
        f.callback(
          (await f.make(f.config("new")).beginLogin(["read", "write"]))
            .authorizationUrl,
        ),
      ),
    /unconsented_scope/,
  );
});
test("SSH finish via stdin and CLI export/error output never print callback or grant secrets", async (t) => {
  const f = await setup(t),
    file = join(f.home, "server.json");
  await writeFile(file, JSON.stringify(f.config()));
  const args = [
    "--dsh-package",
    resolve("package.json"),
    "--config",
    file,
    "--dsh-home",
    f.home,
  ];
  let output = "",
    error = "";
  const stdout = { write: (s) => (output += s) },
    stderr = { write: (s) => (error += s) };
  assert.equal(await main(["login", ...args], { stdout, stderr }), 0);
  const callback = f.callback(JSON.parse(output).authorizationUrl);
  output = "";
  assert.equal(
    await main(["finish", ...args], {
      stdin: Readable.from([callback]),
      stdout,
      stderr,
    }),
    0,
  );
  assert.equal(await main(["export", ...args], { stdout, stderr }), 0);
  assert.doesNotMatch(
    output + error,
    /FAKE_ACCESS|FAKE_REFRESH|FAKE_CODE|code_verifier|client_secret/,
  );
  assert.equal(
    await main(["finish", ...args], {
      stdin: Readable.from([callback]),
      stdout,
      stderr,
    }),
    1,
  );
  assert.match(error, /login_expired_or_absent/);
});
test("foreign records and configuration drift cannot overwrite credentials; inline credentials are refused", async (t) => {
  const f = await setup(t),
    a = f.make();
  await f.credentials.modifyRecord(a.key, () => ({
    kind: "grant",
    payload: { owner: "other" },
  }));
  const before = await readFile(join(f.home, ".credentials.yaml"), "utf8");
  await assert.rejects(a.beginLogin(), /credential_binding_mismatch/);
  await assert.rejects(a.logout(), /credential_binding_mismatch/);
  assert.equal(
    await readFile(join(f.home, ".credentials.yaml"), "utf8"),
    before,
  );
  const other = f.make(f.config("owned"));
  await f.login(other);
  const drift = f.make({
    ...f.config("owned"),
    clientId: "different-registered-client",
  });
  await assert.rejects(drift.token(), /credential_binding_mismatch/);
  for (const config of [
    { ...f.config(), headers: { authorization: "secret" } },
    { ...f.config(), callbackUrl: "https://evil.example/callback" },
    { ...f.config(), url: "http://remote.example/mcp" },
  ])
    assert.throws(() => configuration(config));
});
test("diagnosis is read-only; DSH-specific dynamic registration and credential references stay private", async (t) => {
  const f = await setup(t),
    config = { ...f.config(), dynamicRegistration: true };
  delete config.clientId;
  const a = f.make(config);
  assert.deepEqual((await a.diagnose()).requiredScopes, ["read"]);
  await assert.rejects(readFile(join(f.home, ".credentials.yaml")), {
    code: "ENOENT",
  });
  await f.login(a);
  const registration = JSON.parse(
    f.state.requests.find((r) => r.path === "/register").body,
  );
  assert.equal(registration.client_name, "rustdsh / DSH MCP");
  assert.equal(registration.scope, "read");
  assert.doesNotMatch(JSON.stringify(registration), /pi\.dev|offline_access/);
  await f.credentials.set("MCP_FIXTURE_SECRET", "FAKE_CLIENT_SECRET");
  const b = f.make({
    ...f.config("confidential"),
    clientSecretRef: "MCP_FIXTURE_SECRET",
  });
  await f.login(b);
  assert.match(
    f.state.requests.filter((r) => r.path === "/token").at(-1).body,
    /client_secret=FAKE_CLIENT_SECRET/,
  );
  const record = await f.credentials.readRecord(b.key);
  assert.doesNotMatch(JSON.stringify(record), /FAKE_CLIENT_SECRET/);
  assert.equal(
    f.state.requests
      .filter((r) => r.path.includes(".well-known") || r.path === "/mcp")
      .some(
        (r) =>
          r.body.includes("FAKE_CLIENT_SECRET") ||
          JSON.stringify(r.headers).includes("FAKE_CLIENT_SECRET"),
      ),
    false,
  );
});
test("401 retry refreshes rejected token only once and never silently enlarges scope", async (t) => {
  const f = await setup(t),
    a = f.make();
  await f.login(a);
  const options = a.transportOptions(),
    rejected = await options.authProvider.token();
  f.state.rejectedToken = rejected;
  const response = await options.fetch(f.config().url, {
    headers: { authorization: `Bearer ${rejected}` },
  });
  const delayed = await options.fetch(f.config().url, {
    headers: { authorization: `Bearer ${rejected}` },
  });
  await options.authProvider.onUnauthorized({ response });
  assert.notEqual(await a.token(), rejected);
  assert.equal(f.state.refreshes, 1);
  await options.authProvider.token();
  await options.authProvider.onUnauthorized({ response: delayed });
  assert.equal(
    f.state.refreshes,
    1,
    "a delayed old-token 401 cannot refresh the rotated token",
  );
  f.state.requiredScope = "read write";
  await assert.rejects(
    options.authProvider.onUnauthorized({
      response: await options.fetch(f.config().url),
    }),
    /consent_required/,
  );
  assert.equal(f.state.refreshes, 1);
});
test("audited native seam install/verify/revert is explicit, idempotent and rejects unknown source", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rdsh-oauth-seam-")),
    file = join(dir, "index.js");
  t.after(() => rm(dir, { recursive: true }));
  const source = await readFile(runtime.mcpPath, "utf8");
  assert.equal(sha256(source), ORIGINAL_SHA256);
  await writeFile(file, source);
  await changeSeam(file, "install");
  assert.equal(await verifySeam(file), sha256(patchSource(source)));
  assert.equal((await changeSeam(file, "install")).changed, false);
  await changeSeam(file, "revert");
  assert.equal(await readFile(file, "utf8"), source);
  await writeFile(file, source + "\n// unrelated update\n");
  await assert.rejects(changeSeam(file, "install"), /unaudited/);
  assert.match(await readFile(file, "utf8"), /unrelated update/);
});
test("real native MCP transport discovers and calls the same server-qualified tool with OAuth options", async (t) => {
  const f = await setup(t),
    a = f.make();
  await f.login(a);
  const modules = resolve("node_modules"),
    dir = await mkdtemp(join(modules, "rdsh-native-fixture-"));
  t.after(() => rm(dir, { recursive: true }));
  const file = join(dir, "index.mjs");
  await writeFile(file, patchSource(await readFile(runtime.mcpPath, "utf8")));
  const native = await import(pathToFileURL(file).href),
    definitions = new Map();
  const ctx = new runtime.cordis.Context();
  ctx.provide("tools", {
    register(definition) {
      definitions.set(definition.name, definition);
      return () => definitions.delete(definition.name);
    },
  });
  ctx.provide("credentials", f.credentials);
  const plugin = createPlugin({
    ...runtime,
    mcpPath: file,
    loadMcp: async () => native,
  });
  const fiber = await ctx.plugin(plugin, {
    ...f.config(),
    failOnStartupError: true,
    reconnect: { enabled: false },
  });
  t.after(() => fiber.dispose());
  assert.deepEqual([...definitions.keys()], ["mcp__work__echo"]);
  const definition = definitions.get("mcp__work__echo");
  const result = await definition.execute(
    { value: "oauth fixture proof" },
    { signal: new AbortController().signal },
  );
  assert.deepEqual(result, {
    content: [{ type: "text", text: "oauth fixture proof" }],
    structuredContent: { value: "oauth fixture proof" },
  });
  await fiber.dispose();
  assert.equal(definitions.size, 0);
});
