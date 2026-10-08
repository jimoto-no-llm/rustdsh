import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  preflightTask,
  taskRequirements,
  requireReady,
} from "../preflight.mjs";
import { SessionLedger, attachRecordedSession } from "../session-ledger.mjs";
import { identity } from "../state.mjs";

const exec = promisify(execFile);
const fixture = fileURLToPath(
  new URL("./fixtures/acp-cli.mjs", import.meta.url),
);
const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const standalone = fileURLToPath(new URL("../preflight.mjs", import.meta.url));
const check = (report, id) => report.checks.find((entry) => entry.id === id);
const forbidden = async () => {
  throw new Error("unnecessary-probe-secret");
};
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-preflight-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("rdsh-preflight-"));
    await fs.rm(root, { recursive: true });
  });
  return {
    root,
    command: [process.execPath, fixture],
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      DSH_HOME: path.join(root, "dsh"),
      RDSH_DASHBOARD_HOME: path.join(root, "ledger"),
      GIT_CEILING_DIRECTORIES: path.dirname(root),
      RDSH_ADAPTER_FIXTURE_TRACE: path.join(root, "trace.jsonl"),
    },
  };
}
test("CPU-only tasks do not probe GPU, WSL, CLI or authentication", async (t) => {
  const { root } = await setup(t);
  const result = await preflightTask(
    { cwd: root },
    {
      exec: forbidden,
      fetch: forbidden,
      adapterFactory: () => {
        throw new Error();
      },
    },
  );
  assert.equal(result.ready, true);
  for (const id of ["gpu", "wsl", "cli", "auth"])
    assert.equal(check(result, id).status, "not_required");
  assert.equal(result.execution_authority, false);
  assert.equal(result.automatic_repairs, false);
});
test("missing CLI, wrong cwd/profile and unsupported Node report a blocking item and minimal fix", async (t) => {
  const { root } = await setup(t);
  const missing = await preflightTask({
    cwd: root,
    requirements: { cli: "dsh" },
  });
  assert.equal(check(missing, "cli").status, "blocked");
  const wrong = await preflightTask(
    {
      cwd: path.join(root, "absent"),
      requirements: { cli: "dsh", profile: "headless" },
    },
    {
      adapterFactory: () => {
        throw new Error("must not spawn");
      },
    },
  );
  assert.equal(check(wrong, "cwd").reason, "cwd_unavailable");
  assert.equal(check(wrong, "profile").reason, "unsupported_profile");
  assert.ok(
    wrong.checks
      .filter((item) => item.status === "blocked")
      .every((item) => item.fix),
  );
  assert.equal(
    check(
      await preflightTask({ cwd: root }, { nodeVersion: "20.19.0" }),
      "node",
    ).status,
    "blocked",
  );
});
test("version-checked CLI is a configuration fact without pretending protocol or provider communication", async (t) => {
  const { root, command, env } = await setup(t);
  const result = await preflightTask({
    cwd: root,
    command,
    env,
    requirements: { cli: "dsh", min_free_bytes: 1 },
  });
  assert.equal(result.ready, true);
  assert.equal(check(result, "cli").detected_version, "0.2.0-rc.2");
  assert.equal(check(result, "cli").protocol_checked, false);
  const mismatch = await preflightTask({
    cwd: root,
    command,
    env: { ...env, RDSH_ADAPTER_FIXTURE_MODE: "new_version" },
    requirements: { cli: "dsh" },
  });
  assert.equal(mismatch.ready, false);
  assert.equal(check(mismatch, "cli").detected_version, null);
});
test("insufficient or unobservable disk space blocks without fabricating a zero measurement", async (t) => {
  const { root } = await setup(t);
  const low = await preflightTask(
    { cwd: root, requirements: { min_free_bytes: 4096 } },
    { statfs: async () => ({ bavail: 1n, bsize: 1024n }) },
  );
  assert.equal(check(low, "disk").reason, "insufficient_disk_space");
  assert.equal(check(low, "disk").free_bytes, "1024");
  const unavailable = await preflightTask(
    { cwd: root, requirements: { min_free_bytes: 1 } },
    { statfs: forbidden },
  );
  assert.equal(check(unavailable, "disk").reason, "disk_space_unknown");
  assert.equal(Object.hasOwn(check(unavailable, "disk"), "free_bytes"), false);
});
test("an actual occupied loopback port blocks and a released port is observed without reserving it", async (t) => {
  const { root } = await setup(t);
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    assert.equal(
      check(await preflightTask({ cwd: root, requirements: { port } }), "port")
        .reason,
      "port_unavailable",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const result = await preflightTask({ cwd: root, requirements: { port } });
  assert.equal(check(result, "port").status, "pass");
  assert.equal(check(result, "port").reservation, false);
});
test("project dependencies distinguish existing and missing files and reject traversal", async (t) => {
  const { root } = await setup(t);
  await fs.writeFile(path.join(root, "dependency.txt"), "fixture");
  assert.equal(
    check(
      await preflightTask({
        cwd: root,
        requirements: { required_files: ["dependency.txt"] },
      }),
      "dependencies",
    ).status,
    "pass",
  );
  assert.equal(
    check(
      await preflightTask({
        cwd: root,
        requirements: { required_files: ["dependency.txt", "missing"] },
      }),
      "dependencies",
    ).missing_count,
    1,
  );
  assert.throws(
    () => taskRequirements({ required_files: ["../outside"] }),
    (error) => error.code === "invalid_requirements",
  );
});
test("required WSL checks the named distribution only on Windows and preserves no subprocess output", async (t) => {
  const { root } = await setup(t);
  const requirements = { wsl: { distribution: "FixtureWSL" } };
  assert.equal(
    check(
      await preflightTask(
        { cwd: root, requirements },
        { platform: "linux", exec: forbidden },
      ),
      "wsl",
    ).reason,
    "wsl_requires_windows",
  );
  let calls = 0;
  const valid = await preflightTask(
    { cwd: root, requirements },
    {
      platform: "win32",
      exec: async (file, args, options) => {
        calls++;
        assert.equal(file, "wsl.exe");
        assert.deepEqual(args, ["-d", "FixtureWSL", "--exec", "/bin/true"]);
        assert.equal(options.shell, false);
        return { stdout: "peer-secret-not-for-report" };
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(check(valid, "wsl").stage, "communication");
  assert.equal(check(valid, "wsl").status, "pass");
  assert.equal(JSON.stringify(valid).includes("peer-secret"), false);
  assert.equal(
    check(
      await preflightTask(
        { cwd: root, requirements },
        { platform: "win32", exec: forbidden },
      ),
      "wsl",
    ).status,
    "blocked",
  );
});
test("required GPU distinguishes missing, hidden, insufficient and observed driver inventory", async (t) => {
  const { root } = await setup(t);
  const options = {
    cwd: root,
    env: {},
    requirements: { gpu: { min_free_mib: 8192 } },
  };
  assert.equal(
    check(await preflightTask(options, { exec: forbidden }), "gpu").reason,
    "gpu_inventory_unavailable",
  );
  assert.equal(
    check(
      await preflightTask(
        { ...options, env: { CUDA_VISIBLE_DEVICES: "-1" } },
        { exec: forbidden },
      ),
      "gpu",
    ).reason,
    "gpu_hidden_by_environment",
  );
  assert.equal(
    check(
      await preflightTask(options, {
        exec: async () => ({ stdout: "4096 MiB\n" }),
      }),
      "gpu",
    ).reason,
    "insufficient_gpu_memory",
  );
  const available = await preflightTask(options, {
    exec: async () => ({ stdout: "8192 MiB\n16384 MiB\n" }),
  });
  assert.equal(check(available, "gpu").max_free_mib, 16384);
  assert.match(
    check(available, "gpu").scope,
    /workload compatibility unverified/,
  );
  assert.equal(
    check(
      await preflightTask(options, { exec: async () => ({ stdout: "N/A\n" }) }),
      "gpu",
    ).status,
    "blocked",
  );
});
test("a present invalid credential is never authentication success and never enters copyable diagnostics", async (t) => {
  const { root } = await setup(t);
  const options = {
    cwd: root,
    requirements: { auth: { provider: "openai" } },
    env: { OPENAI_API_KEY: "fixture-credential-secret" },
  };
  const presence = await preflightTask(options, { fetch: forbidden });
  assert.equal(check(presence, "auth").credential_presence, "present");
  assert.equal(check(presence, "auth").verified, false);
  assert.equal(check(presence, "auth").stage, "configuration");
  assert.equal(presence.ready, false);
  assert.equal(
    JSON.stringify(presence).includes("fixture-credential-secret"),
    false,
  );
  const invalid = await preflightTask(
    {
      ...options,
      env: { OPENAI_API_KEY: " fixture-credential-secret\n" },
      verifyAuth: true,
    },
    { fetch: forbidden },
  );
  assert.equal(
    check(invalid, "auth").reason,
    "credential_configuration_invalid",
  );
  const expired = await preflightTask(
    { ...options, verifyAuth: true },
    {
      fetch: async () =>
        new Response("fixture-credential-secret", { status: 401 }),
    },
  );
  assert.equal(check(expired, "auth").reason, "authentication_rejected");
  assert.equal(
    JSON.stringify(expired).includes("fixture-credential-secret"),
    false,
  );
});
test("opt-in authentication uses only the selected official models endpoint and exposes its limited scope", async (t) => {
  const { root } = await setup(t);
  for (const [provider, variable, url] of [
    ["openai", "OPENAI_API_KEY", "https://api.openai.com/v1/models"],
    ["deepseek", "DEEPSEEK_API_KEY", "https://api.deepseek.com/models"],
  ]) {
    let requests = 0;
    const result = await preflightTask(
      {
        cwd: root,
        env: { [variable]: "fixture-key" },
        verifyAuth: true,
        requirements: { auth: { provider } },
      },
      {
        fetch: async (actual, options) => {
          requests++;
          assert.equal(actual, url);
          assert.equal(options.method, "GET");
          assert.equal(options.redirect, "error");
          assert.equal(options.headers.authorization, "Bearer fixture-key");
          return Response.json({
            object: "list",
            data: [{ id: "fixture-model" }],
          });
        },
      },
    );
    assert.equal(requests, 1);
    assert.equal(check(result, "auth").verified, true);
    assert.equal(check(result, "auth").verification_scope, "models_read_only");
    assert.equal(check(result, "auth").model_request, false);
    assert.equal(JSON.stringify(result).includes("fixture-key"), false);
  }
  const otherKey = await preflightTask(
    {
      cwd: root,
      env: { DEEPSEEK_API_KEY: "other-provider-secret" },
      verifyAuth: true,
      requirements: { auth: { provider: "openai" } },
    },
    { fetch: forbidden },
  );
  assert.equal(check(otherKey, "auth").reason, "credential_not_observed");
});
test("auth transport, malformed/oversized responses, redirects and disabled TLS never become verified", async (t) => {
  const { root } = await setup(t);
  const options = {
    cwd: root,
    env: { OPENAI_API_KEY: "fixture-key" },
    verifyAuth: true,
    requirements: { auth: { provider: "openai" } },
  };
  for (const fetcher of [
    forbidden,
    async () => new Response("peer-secret-bad-json"),
    async () => new Response("x".repeat(1024 * 1024 + 1)),
    async () =>
      new Response("", {
        status: 302,
        headers: { location: "https://untrusted.invalid" },
      }),
    async () => new Response("peer-secret-rate-limit", { status: 429 }),
  ]) {
    const result = await preflightTask(options, { fetch: fetcher });
    assert.equal(result.ready, false);
    assert.equal(check(result, "auth").verified, false);
    assert.equal(JSON.stringify(result).includes("peer-secret"), false);
  }
  assert.equal(
    check(
      await preflightTask(
        {
          ...options,
          env: { ...options.env, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
        },
        { fetch: forbidden },
      ),
      "auth",
    ).reason,
    "insecure_auth_transport",
  );
});
test("preflight blocks session creation before a CLI profile or ledger write occurs", async (t) => {
  const { root, command, env } = await setup(t);
  const project = await identity(root);
  project.directory = path.join(root, "state");
  const ledger = await SessionLedger.open(project);
  await assert.rejects(
    attachRecordedSession({
      ledger,
      command,
      env,
      requirements: { min_free_bytes: Number.MAX_SAFE_INTEGER },
    }),
    (error) =>
      error.code === "blocked" &&
      check(error.report, "disk").reason === "insufficient_disk_space",
  );
  assert.deepEqual(await ledger.list(), []);
  await assert.rejects(
    fs.stat(ledger.file),
    (error) => error.code === "ENOENT",
  );
  await assert.rejects(
    fs.stat(env.RDSH_ADAPTER_FIXTURE_TRACE),
    (error) => error.code === "ENOENT",
  );
});
test("standalone and public CLI return copyable reports and nonzero exit on blocked prerequisites", async (t) => {
  const { root, env } = await setup(t);
  const cpu = JSON.parse(
    (await exec(process.execPath, [standalone, "--project", root], { env }))
      .stdout,
  );
  assert.equal(cpu.ready, true);
  const requirements = path.join(root, "requirements.json");
  await fs.writeFile(
    requirements,
    JSON.stringify({ min_free_bytes: Number.MAX_SAFE_INTEGER }),
  );
  await assert.rejects(
    exec(
      process.execPath,
      [cli, "preflight", "--project", root, "--requirements", requirements],
      { env },
    ),
    (error) => {
      const report = JSON.parse(error.stdout);
      return (
        error.code === 1 &&
        check(report, "disk").status === "blocked" &&
        report.execution_authority === false
      );
    },
  );
  await fs.writeFile(requirements, "fixture-secret-invalid-json");
  await assert.rejects(
    exec(
      process.execPath,
      [standalone, "--project", root, "--requirements", requirements],
      { env },
    ),
    (error) => error.code === 1 && !error.stdout.includes("fixture-secret"),
  );
});
