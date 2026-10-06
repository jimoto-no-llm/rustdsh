import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Releases } from "../releases.mjs";
import { identity } from "../state.mjs";
import { SessionLedger } from "../session-ledger.mjs";
import { verifyRelease } from "../release-artifacts.mjs";
import { qualifyRelease } from "../release-qualification.mjs";

const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../../", import.meta.url));
const cli = path.join(repo, "dashboard/cli.mjs");
const code = (expected) => (error) => error.code === expected;
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-releases-test-"));
  const releases = new Releases(path.join(root, "state/managed-releases"));
  const projects = [];
  for (const name of ["alpha", "beta"]) {
    const cwd = path.join(root, name);
    await fs.mkdir(cwd);
    const project = await identity(cwd);
    project.directory = path.join(root, "state/projects", project.id);
    projects.push(project);
  }
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    DSH_HOME: path.join(root, "native-home"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    APPDATA: path.join(root, "data"),
    LOCALAPPDATA: path.join(root, "local"),
    RDSH_DASHBOARD_HOME: path.join(root, "state"),
    GIT_CEILING_DIRECTORIES: root,
  };
  const adapters = [];
  const stage = async (name, overrides = {}) => {
    const source = path.join(root, "code-" + name);
    await fs.mkdir(source);
    await fs.writeFile(
      path.join(source, "package.json"),
      JSON.stringify({
        name: "@deepseek-ai/dsh",
        version: overrides.package_version || "0.2.0-rc.2",
      }),
    );
    await fs.writeFile(
      path.join(source, "build.json"),
      JSON.stringify({ name, version: "0.2.0-rc.2", ...overrides }),
    );
    await fs.copyFile(
      path.join(repo, "dashboard/test/fixtures/release-acp-cli.mjs"),
      path.join(source, "bin.mjs"),
    );
    await fs.copyFile(
      path.join(repo, "dashboard/test/fixtures/dsh-acp-0.2.0-rc.2.json"),
      path.join(source, "protocol.json"),
    );
    return releases.stage({
      executable: process.execPath,
      dsh_root: source,
      entrypoint: "bin.mjs",
      adapter_root: repo,
      changes: "Fixture build " + name,
      rollback: "Requalify a previous project release before selecting it",
      provenance: "Local ACP fixture; not native Cordis proof",
    });
  };
  const attach = async (project, run_id = null, plan = null) => {
    const attached = await releases.attach(
      project,
      plan || (await releases.plan(project, run_id)),
      { run_id, env },
    );
    adapters.push(attached.adapter);
    return attached;
  };
  t.after(async () => {
    for (const adapter of adapters) await adapter.stop();
    if (
      path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) ||
      !path.basename(root).startsWith("rdsh-releases-test-")
    )
      throw new Error("Unsafe cleanup");
    // Release files deliberately have read-only permissions, including on Windows.
    const unlock = async (dir) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await unlock(file);
        else if (entry.isFile()) await fs.chmod(file, 0o600);
      }
    };
    await unlock(root);
    await fs.rm(root, { recursive: true });
  });
  return { root, releases, projects, env, stage, attach };
}

test("failed one-project canary retains observations and cannot alter or roll out to the other project", async (t) => {
  const {
    releases,
    projects: [alpha, beta],
    stage,
  } = await fixture(t);
  const stable = await stage("stable");
  assert.equal(
    (
      await releases.check(alpha, stable.release_id, 0, {
        requestTimeout: 3000,
      })
    ).changed,
    true,
  );
  await releases.promote(beta, stable.release_id, 0);
  const before = (await releases.inspect(beta)).selection;
  const candidate = await stage("bad-plugin", { plugin: "fail" });
  const failed = await releases.check(alpha, candidate.release_id, 1, {
    requestTimeout: 300,
  });
  assert.equal(failed.changed, false);
  assert.equal(failed.qualification.status, "failed");
  assert.equal(failed.qualification.checks.start, "acknowledged");
  assert.equal(failed.qualification.error, "native_plugin_load_unconfirmed");
  assert.deepEqual((await releases.inspect(beta)).selection, before);
  const badResume = await stage("bad-resume", { resume: "fail" });
  const resumeFailure = await releases.check(alpha, badResume.release_id, 1);
  assert.equal(resumeFailure.qualification.status, "failed");
  assert.equal(
    resumeFailure.qualification.checks.plugin_start,
    "native_injection_observed",
  );
  assert.equal(resumeFailure.qualification.checks.resume, "not_confirmed");
  assert.deepEqual((await releases.inspect(beta)).selection, before);
  await assert.rejects(
    releases.promote(beta, candidate.release_id, 1),
    code("candidate_not_qualified_no_rollout"),
  );
  await assert.rejects(
    releases.check(beta, candidate.release_id, 1),
    code("candidate_is_reserved_for_one_canary_project"),
  );
  assert.deepEqual((await releases.inspect(beta)).selection, before);
});

test("existing run keeps the original adapter/Node/DSH command and native ID through update and verified rollback", async (t) => {
  const {
    releases,
    projects: [alpha, beta],
    stage,
    attach,
    env,
  } = await fixture(t);
  const old = await stage("old");
  await releases.check(alpha, old.release_id, 0);
  await assert.rejects(
    releases.check(alpha, old.release_id, 1),
    code("release_already_selected"),
  );
  assert.equal((await releases.read()).releases[0].status, "qualified");
  await releases.promote(beta, old.release_id, 0);
  const ongoing = await attach(alpha);
  const originalCommand = ongoing.record.launch;
  await ongoing.adapter.stop();
  const candidate = await stage("new");
  const updated = await releases.check(alpha, candidate.release_id, 1);
  assert.equal(
    updated.qualification.checks.resume,
    "same_native_id_acknowledged",
  );
  assert.equal(
    (await releases.inspect(beta)).selection.default_release,
    old.release_id,
  );
  const fresh = await attach(alpha);
  await fresh.adapter.stop();
  assert.equal(fresh.release.release_id, candidate.release_id);
  assert.notEqual(fresh.record.cli_session_id, ongoing.record.cli_session_id);
  const resumed = await attach(alpha, ongoing.record.run_id);
  await resumed.adapter.stop();
  assert.equal(resumed.release.release_id, old.release_id);
  assert.deepEqual(resumed.record.launch, originalCommand);
  assert.equal(resumed.record.cli_session_id, ongoing.record.cli_session_id);
  assert.equal(resumed.release.use, "existing_run_pin");
  await assert.rejects(
    releases.check(alpha, old.release_id, 1, { rollback: true }),
    code("selection_changed_refresh_revision"),
  );
  const oldFile = path.join(
    (await releases.plan(alpha, ongoing.record.run_id)).slot,
    "dsh/build.json",
  );
  const oldBytes = await fs.readFile(oldFile);
  await fs.chmod(oldFile, 0o600);
  await fs.unlink(oldFile);
  const unavailable = await releases.check(alpha, old.release_id, 2, {
    rollback: true,
  });
  assert.equal(unavailable.changed, false);
  assert.equal(unavailable.qualification.checks.start, "not_dispatched");
  assert.equal(
    (await releases.inspect(alpha)).selection.default_release,
    candidate.release_id,
  );
  await fs.writeFile(oldFile, oldBytes, { mode: 0o444 });
  const rolled = await releases.check(alpha, old.release_id, 2, {
    rollback: true,
  });
  assert.equal(rolled.changed, true);
  assert.equal(
    rolled.qualification.checks.plugin_resume,
    "native_injection_observed",
  );
  assert.equal(rolled.qualification.checks.stop, "both_owned_exits_confirmed");
  const after = await attach(alpha);
  await after.adapter.stop();
  assert.equal(after.release.release_id, old.release_id);
  const stillNew = await attach(alpha, fresh.record.run_id);
  await stillNew.adapter.stop();
  assert.equal(stillNew.release.release_id, candidate.release_id);
  assert.equal(stillNew.record.cli_session_id, fresh.record.cli_session_id);
  const view = await releases.inspect(alpha);
  assert.equal(view.selection.history.at(-1).reason, "rollback_requalified");
  assert.equal(view.pins.length, 3);
  assert.ok(view.releases.every((r) => r.changes && r.rollback));
  assert.equal(
    view.releases
      .find((r) => r.release_id === old.release_id)
      .qualifications.at(-1).purpose,
    "rollback",
  );
  assert.ok(!JSON.stringify(await releases.read()).includes(env.HOME));
});

test("public CLI re-execs the captured runtime and refuses overrides or changed pins", async (t) => {
  const {
    releases,
    projects: [alpha],
    stage,
    env,
  } = await fixture(t);
  const release = await stage("cli");
  const invoke = async (...args) =>
    JSON.parse(
      (
        await exec(process.execPath, [cli, ...args], {
          env,
          timeout: 60000,
          maxBuffer: 1024 * 1024,
        })
      ).stdout,
    );
  const selected = await invoke(
    "release",
    "canary",
    "--project",
    alpha.root,
    "--release-id",
    release.release_id,
    "--selection-revision",
    "0",
  );
  assert.equal(selected.changed, true);
  if (process.platform === "win32") {
    const aliasedRoot = new Releases(releases.home.toUpperCase());
    assert.equal(
      (await aliasedRoot.plan(alpha)).manifest.release_id,
      release.release_id,
    );
  }
  const started = await invoke(
    "session-ledger",
    "start",
    "--project",
    alpha.root,
  );
  assert.equal(started.release.release_id, release.release_id);
  assert.equal(
    started.run.launch.executable,
    (await releases.plan(alpha)).command[0],
  );
  const resumed = await invoke(
    "session-ledger",
    "resume",
    "--project",
    alpha.root,
    "--run-id",
    started.run.run_id,
  );
  assert.equal(resumed.run.cli_session_id, started.run.cli_session_id);
  assert.equal(resumed.process.confirmed, true);
  await assert.rejects(
    invoke(
      "session-ledger",
      "resume",
      "--project",
      alpha.root,
      "--run-id",
      started.run.run_id,
      "--executable",
      process.execPath,
    ),
    /omit executable/,
  );
  await assert.rejects(
    invoke(
      "session-ledger",
      "start",
      "--project",
      alpha.root,
      "--managed-release-id",
      release.release_id,
      "--managed-revision",
      "0",
    ),
    /selection changed/,
  );
  const inspected = await invoke("release", "inspect", "--project", alpha.root);
  assert.equal(inspected.pins[0].run_id, started.run.run_id);
  env.NODE_OPTIONS = "--no-warnings";
  await assert.rejects(
    invoke(
      "session-ledger",
      "resume",
      "--project",
      alpha.root,
      "--run-id",
      started.run.run_id,
    ),
    /resolve NODE_OPTIONS\/NODE_PATH/,
  );
  delete env.NODE_OPTIONS;
  await assert.rejects(
    releases.attach(alpha, await releases.plan(alpha, started.run.run_id), {
      run_id: started.run.run_id,
      env: { ...env, NODE_PATH: "/external/mutable/code" },
    }),
    code("external_node_injection_wait_explicit_resolution"),
  );
});

test("tampered, missing, incompatible and unqualified bytes block dispatch; legacy records are not silently pinned", async (t) => {
  await assert.rejects(
    qualifyRelease({ manifest: { tuple: { node: "v23.0.0" } } }, {}),
    code("adapter_runtime_changed_use_pinned_cli"),
  );
  const {
    releases,
    projects: [alpha],
    stage,
    attach,
    env,
  } = await fixture(t);
  const old = await stage("intact");
  await releases.check(alpha, old.release_id, 0);
  const original = await attach(alpha);
  await original.adapter.stop();
  const plan = await releases.plan(alpha, original.record.run_id);
  const file = path.join(plan.slot, "dsh/build.json");
  const bytes = await fs.readFile(file);
  await fs.chmod(file, 0o600);
  await fs.writeFile(file, "{}");
  await assert.rejects(
    attach(alpha, original.record.run_id),
    code("artifact_changed_wait_restore_pinned_bytes"),
  );
  await assert.rejects(
    releases.promote(alpha, old.release_id, 1),
    code("artifact_changed_wait_restore_pinned_bytes"),
  );
  await fs.writeFile(file, bytes);
  await fs.chmod(file, 0o444);
  await fs.unlink(file);
  await assert.rejects(
    attach(alpha, original.record.run_id),
    (err) => err.code === "ENOENT",
  );
  await fs.writeFile(file, bytes, { mode: 0o444 });
  const legacy = await (
    await SessionLedger.open(alpha)
  ).record({ cli_session_id: "external-unpinned" });
  assert.equal(await releases.plan(alpha, legacy.run_id), null);
  assert.equal((await releases.inspect(alpha)).pins.length, 1);
  await assert.rejects(
    stage("unsupported-package", { package_version: "0.2.0-rc.3" }),
    code("incompatible_tuple_wait_for_compatible_runtime"),
  );
  // Package version and artifact tuple are supported, but the executable lies.
  const bad = await stage("unsupported-executable", { version: "0.2.0-rc.3" });
  const failure = await releases.check(alpha, bad.release_id, 1);
  assert.equal(failure.changed, false);
  assert.equal(failure.qualification.status, "failed");
  assert.equal(
    (await releases.inspect(alpha)).selection.default_release,
    old.release_id,
  );
  assert.ok(!JSON.stringify(await releases.read()).includes(env.HOME));
});

test("stale selection plans never start native work, while exclusive registry ownership preserves concurrent writers", async (t) => {
  const {
    releases,
    projects: [alpha, beta],
    stage,
    attach,
  } = await fixture(t);
  const first = await stage("first");
  await releases.check(alpha, first.release_id, 0);
  const stale = await releases.plan(alpha);
  const second = await stage("second");
  await releases.check(alpha, second.release_id, 1);
  await assert.rejects(
    attach(alpha, null, stale),
    code("selection_changed_before_native_dispatch"),
  );
  const ledger = await SessionLedger.open(alpha);
  assert.equal((await ledger.list()).length, 1);
  assert.equal((await ledger.list())[0].binding, "unknown");
  assert.equal((await releases.inspect(alpha)).pins.length, 0);
  const handle = await fs.open(releases.lock, "wx");
  try {
    await assert.rejects(
      releases.promote(beta, first.release_id, 0),
      code("release_registry_busy_wait"),
    );
  } finally {
    await handle.close();
    await fs.unlink(releases.lock);
  }
  await releases.promote(beta, first.release_id, 0);
  assert.equal(
    (await releases.inspect(beta)).selection.default_release,
    first.release_id,
  );
  assert.equal(
    (await releases.inspect(alpha)).selection.default_release,
    second.release_id,
  );
  await assert.rejects(
    verifyRelease(releases.home, "../../outside"),
    code("exact_release_id_required"),
  );
  const saved = await fs.readFile(releases.file, "utf8");
  const corrupt = JSON.parse(saved);
  corrupt.pins.push({
    project_id: alpha.id,
    run_id: "run-invalid",
    release_id: second.release_id,
  });
  await fs.writeFile(releases.file, JSON.stringify(corrupt));
  await assert.rejects(releases.plan(alpha), code("invalid_release_registry"));
  await assert.rejects(
    releases.promote(beta, second.release_id, 1),
    code("invalid_release_registry"),
  );
  assert.equal(
    await fs.readFile(releases.file, "utf8"),
    JSON.stringify(corrupt),
  );
  await fs.writeFile(releases.file, saved);
  const source = path.join((await releases.plan(alpha)).slot, "dsh/bin.mjs");
  if (process.platform !== "win32") {
    const sourceBytes = await fs.readFile(source);
    const sourceMode = (await fs.stat(source)).mode & 0o777;
    await fs.unlink(source);
    await fs.symlink(path.join(rootFor(alpha), "outside.mjs"), source);
    await assert.rejects(
      releases.plan(alpha),
      code("artifact_changed_wait_restore_pinned_bytes"),
    );
    await fs.unlink(source);
    await fs.writeFile(source, sourceBytes, { mode: sourceMode });
    const codeDirectory = path.dirname(source);
    const copiedDirectory = path.join(rootFor(alpha), "linked-code");
    const heldDirectory = path.join(rootFor(alpha), "held-code");
    assert.ok(codeDirectory.startsWith(rootFor(alpha) + path.sep));
    await fs.cp(codeDirectory, copiedDirectory, { recursive: true });
    await fs.rename(codeDirectory, heldDirectory);
    await fs.symlink(copiedDirectory, codeDirectory, "dir");
    await assert.rejects(
      releases.plan(alpha),
      code("artifact_has_unrecorded_files"),
    );
    await fs.unlink(codeDirectory);
    await fs.rename(heldDirectory, codeDirectory);
  }
});

function rootFor(project) {
  return path.dirname(project.root);
}
