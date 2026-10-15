import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { loadRuntime } from "../runtime.mjs";
import { openCredentials } from "../cli.mjs";
import { createOAuthManager } from "../oauth.mjs";
import { patchSource, sha256 } from "../native-seam.mjs";
import { createPlugin } from "../index.mjs";
import { oauthFixture } from "./fixture.mjs";

const runtime = await loadRuntime(),
  f = await oauthFixture();
const home = await mkdtemp(join(tmpdir(), "rdsh-oauth-proof-"));
const provider = await openCredentials(runtime, home);
const manager = createOAuthManager({
  config: f.config(),
  credentials: provider.credentials,
  sdk: runtime.sdk,
});
const dir = await mkdtemp(join(resolve("node_modules"), "rdsh-native-proof-"));
const source = await readFile(runtime.mcpPath, "utf8");
const observations = {
  schema: 1,
  nativeVersion: "0.2.0-rc.2",
  sdkVersion: "2.0.0",
  originalSha256: sha256(source),
  patchedSha256: sha256(patchSource(source)),
  modelCalls: 0,
};
async function connect(label, file, oauth) {
  const native = await import(pathToFileURL(file).href),
    ctx = new runtime.cordis.Context(),
    definitions = new Map();
  // Suppress fixture diagnostic values; only explicit public observations below
  // are emitted. Real bundle logging redacts grants through the scoped logger.
  const logger = () => logger;
  for (const k of ["warn", "error", "info", "debug"]) logger[k] = () => {};
  const root = ctx.extend({ logger });
  root.provide("tools", {
    register(d) {
      definitions.set(d.name, d);
      return () => definitions.delete(d.name);
    },
  });
  root.provide("credentials", provider.credentials);
  const fiber = oauth
    ? root.plugin(
        createPlugin({
          ...runtime,
          mcpPath: file,
          loadMcp: async () => native,
        }),
        {
          ...f.config(),
          failOnStartupError: true,
          reconnect: { enabled: false },
        },
      )
    : root.plugin({
        name: "original-fixture",
        async apply(child) {
          await native.apply(
            child,
            native.Config({
              transport: "streamable-http",
              serverName: "work",
              url: f.config().url,
              failOnStartupError: true,
              reconnect: { enabled: false },
            }),
          );
        },
      });
  try {
    await fiber;
    const result = await definitions
      .get("mcp__work__echo")
      .execute(
        { value: "fixture call succeeded" },
        { signal: new AbortController().signal },
      );
    observations[label] = {
      connected: true,
      publicTools: [...definitions.keys()],
      callText: result.content[0].text,
    };
  } catch {
    observations[label] = {
      connected: false,
      publicTools: [...definitions.keys()],
      status: "unauthorized",
    };
  } finally {
    await fiber.dispose();
  }
}
try {
  const original = join(dir, "original.mjs"),
    patched = join(dir, "patched.mjs");
  await writeFile(original, source);
  await writeFile(patched, patchSource(source));
  await connect("before", original, false);
  const login = await manager.beginLogin();
  await manager.finishLogin(f.callback(login.authorizationUrl));
  await connect("after", patched, true);
  observations.after.credentialsConfigured = (
    await manager.inspect()
  ).configured;
  await manager.logout();
  observations.logout = { configured: (await manager.inspect()).configured };
  console.log(JSON.stringify(observations, null, 2));
} finally {
  await provider.close();
  await f.close();
  await rm(home, { recursive: true });
  await rm(dir, { recursive: true });
}
