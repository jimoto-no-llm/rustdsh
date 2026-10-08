import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { identity } from "../state.mjs";
import {
  RetryHistory,
  RetryFailure,
  retryKinds,
  runWithRetry,
} from "../retry.mjs";
import { probeCliWithRetry } from "../retry-probe.mjs";

const exec = promisify(execFile);
const fixture = fileURLToPath(
  new URL("./fixtures/acp-cli.mjs", import.meta.url),
);
const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const scope = "a".repeat(64);
const opId = () => "op_" + randomUUID();
const error = (code) => (value) => value.code === code;
const authorized = async () => ({ allowed: true, scope_digest: scope });
const confirmed = (context, outcome) => ({
  ...context,
  outcome,
  source: "authoritative_operation_status",
  evidence_id: "fixture-evidence-secret-not-for-output",
  observed_at: new Date().toISOString(),
});
// Callback context also has kind: formal reconciliation accepts only its own fields.
const receipt = (context, outcome) =>
  confirmed(
    { operation_id: context.operation_id, scope_digest: context.scope_digest },
    outcome,
  );
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-retry-test-"));
  const cwd = path.join(root, "project");
  await fs.mkdir(cwd);
  const project = await identity(cwd);
  project.directory = path.join(root, "dashboard", "projects", project.id);
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|LANG|LC_ALL)$/i.test(
          key,
        ),
      ),
    ),
    HOME: root,
    USERPROFILE: root,
    DSH_HOME: path.join(root, "dsh"),
    RDSH_DASHBOARD_HOME: path.join(root, "dashboard"),
    GIT_CEILING_DIRECTORIES: root,
    RDSH_ADAPTER_FIXTURE_TRACE: path.join(root, "trace.jsonl"),
  };
  const history = await RetryHistory.open(project);
  const clock = { value: 0, waits: [] };
  const timing = {
    now: () => clock.value,
    wait: async (ms) => {
      clock.waits.push(ms);
      clock.value += ms;
    },
  };
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("rdsh-retry-test-"));
    await fs.rm(resolved, { recursive: true });
  });
  return { root, project, env, history, clock, timing };
}

test("read-only transient failures back off and succeed with durable reasons, times and budgets", async (t) => {
  const { history, clock, timing } = await setup(t);
  let calls = 0;
  const report = await runWithRetry({
    history,
    kind: "cli_usage_read",
    scope_digest: scope,
    authorize: authorized,
    budget: { max_attempts: 3, total_ms: 1000, base_ms: 10, max_delay_ms: 100 },
    ...timing,
    execute: async () => {
      if (++calls < 3) throw new RetryFailure("unavailable");
      return "fixture-peer-result-secret-not-for-history";
    },
  });
  assert.equal(report.status, "completed");
  assert.equal(report.attempts, 3);
  assert.equal(report.wait_ms, 30);
  assert.equal(report.elapsed_ms, 30);
  assert.deepEqual(clock.waits, [10, 20]);
  assert.equal(report.permission_expanded, false);
  const waits = report.history.filter((event) => event.step === "waiting");
  assert.equal(waits.length, 2);
  assert.ok(
    waits.every(
      (event) =>
        event.next_attempt_at &&
        event.category === "unavailable" &&
        event.reason === "retry_scheduled",
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(await history.inspect(report.operation_id)),
    /fixture-peer-result-secret/,
  );
});

test("attempt, elapsed and delay caps stop automatic retries rather than shrinking a server cooldown", async (t) => {
  for (const [budget, expected, count, clockCost, retryAfter] of [
    [
      { max_attempts: 2, total_ms: 1000, base_ms: 10, max_delay_ms: 20 },
      "attempt_budget_exhausted",
      2,
      0,
      null,
    ],
    [
      { max_attempts: 10, total_ms: 15, base_ms: 10, max_delay_ms: 20 },
      "elapsed_budget_exhausted",
      1,
      8,
      null,
    ],
    [
      { max_attempts: 3, total_ms: 1000, base_ms: 10, max_delay_ms: 20 },
      "delay_budget_exhausted",
      1,
      0,
      50,
    ],
  ]) {
    const { history, timing, clock } = await setup(t);
    let calls = 0;
    const result = await runWithRetry({
      history,
      kind: "cli_usage_read",
      scope_digest: scope,
      authorize: authorized,
      budget,
      ...timing,
      execute: async () => {
        calls++;
        clock.value += clockCost;
        throw new RetryFailure("rate_limited", retryAfter);
      },
    });
    assert.equal(result.status, "budget_exhausted");
    assert.equal(result.history.at(-1).reason, expected);
    assert.equal(calls, count);
  }
});

test("a successful external send with a lost response is reconciled once and never sent twice", async (t) => {
  const { root, history, timing } = await setup(t);
  let sends = 0,
    queries = 0;
  const transaction = path.join(root, "transaction.json");
  const report = await runWithRetry({
    history,
    kind: "external_send",
    scope_digest: scope,
    authorize: authorized,
    ...timing,
    execute: async (context) => {
      sends++;
      await fs.writeFile(
        transaction,
        JSON.stringify({
          operation_id: context.operation_id,
          scope_digest: context.scope_digest,
          applied: true,
        }),
      );
      throw new RetryFailure("timeout");
    },
    reconcile: async (context) => {
      queries++;
      const saved = JSON.parse(await fs.readFile(transaction, "utf8"));
      assert.equal(saved.operation_id, context.operation_id);
      return receipt(context, saved.applied ? "applied" : "not_applied");
    },
  });
  assert.equal(report.status, "completed");
  assert.equal(report.certainty, "reconciled_applied");
  assert.equal(sends, 1);
  assert.equal(queries, 1);
  assert.ok(
    report.history.find((event) => event.step === "reconcile_result")
      .evidence_digest,
  );
  assert.doesNotMatch(JSON.stringify(report), /fixture-evidence-secret/);
  const previous = await fs.readFile(history.file(report.operation_id));
  const replay = await runWithRetry({
    history,
    operation_id: report.operation_id,
    kind: "external_send",
    scope_digest: scope,
    authorize: authorized,
    ...timing,
    execute: async () => {
      sends++;
    },
    reconcile: async () => {
      queries++;
    },
  });
  assert.equal(replay.reused_operation, true);
  assert.equal(sends, 1);
  assert.equal(queries, 1);
  assert.deepEqual(
    await fs.readFile(history.file(report.operation_id)),
    previous,
  );
});

test("an actual disposable Git commit is not duplicated after its response is lost", async (t) => {
  const { project, env, history, timing } = await setup(t);
  await exec("git", ["-C", project.root, "init", "-b", "retry-qa"], { env });
  let commits = 0;
  const report = await runWithRetry({
    history,
    kind: "git_commit",
    scope_digest: scope,
    authorize: authorized,
    ...timing,
    execute: async ({ operation_id }) => {
      commits++;
      await exec(
        "git",
        [
          "-C",
          project.root,
          "-c",
          "user.name=Retry Fixture",
          "-c",
          "user.email=retry@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "--allow-empty",
          "-m",
          "Fixture operation: " + operation_id,
        ],
        { env },
      );
      throw new RetryFailure("timeout");
    },
    reconcile: async (context) => {
      const message = (
        await exec("git", ["-C", project.root, "log", "-1", "--format=%B"], {
          env,
        })
      ).stdout.trim();
      assert.equal(message, "Fixture operation: " + context.operation_id);
      return receipt(context, "applied");
    },
  });
  assert.equal(report.certainty, "reconciled_applied");
  assert.equal(commits, 1);
  assert.equal(
    (
      await exec("git", ["-C", project.root, "rev-list", "--count", "HEAD"], {
        env,
      })
    ).stdout.trim(),
    "1",
  );
});

test("authoritative final not-applied permits a bounded retry, while missing or mismatched reconciliation stops", async (t) => {
  const { history, timing, clock } = await setup(t);
  let calls = 0;
  const good = await runWithRetry({
    history,
    kind: "payment",
    scope_digest: scope,
    authorize: authorized,
    budget: { base_ms: 10 },
    ...timing,
    execute: async () => {
      if (++calls === 1) throw new RetryFailure("unavailable");
    },
    reconcile: async (context) => receipt(context, "not_applied"),
  });
  assert.equal(good.status, "completed");
  assert.equal(calls, 2);
  assert.deepEqual(clock.waits, [10]);
  for (const reconcile of [
    null,
    async (context) => receipt(context, "unknown"),
    async (context) => ({
      ...receipt(context, "not_applied"),
      operation_id: opId(),
    }),
    async (context) => ({
      ...receipt(context, "not_applied"),
      source: "missing_from_eventually_consistent_list",
    }),
  ]) {
    let attempts = 0;
    const bad = await runWithRetry({
      history,
      kind: "external_send",
      scope_digest: scope,
      authorize: authorized,
      ...timing,
      execute: async () => {
        attempts++;
        throw new RetryFailure("timeout");
      },
      reconcile,
    });
    assert.equal(bad.status, "unknown");
    assert.equal(attempts, 1);
    assert.equal(bad.certainty, "unknown");
  }
});

test("auth denial, permanent rejection and arbitrary secret peer errors are never transient retry signals", async (t) => {
  const { history, timing, clock } = await setup(t);
  for (const [failure, expected] of [
    [new RetryFailure("auth_denied"), "authentication_required"],
    [new RetryFailure("permanent"), "permanent_failure"],
    [
      new Error("fixture-secret-401-rate-limit-do-not-log"),
      "unclassified_failure",
    ],
  ]) {
    let calls = 0;
    const report = await runWithRetry({
      history,
      kind: "external_send",
      scope_digest: scope,
      authorize: authorized,
      ...timing,
      execute: async () => {
        calls++;
        throw failure;
      },
    });
    assert.equal(report.status, "unknown");
    assert.equal(report.history.at(-1).reason, expected);
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(report), /fixture-secret|401-rate/);
  }
  assert.deepEqual(clock.waits, []);
});

test("authority is checked after preparation and again after backoff, with no scope expansion", async (t) => {
  const { history, timing, clock } = await setup(t);
  let allowed = true,
    calls = 0;
  const expired = await runWithRetry({
    history,
    kind: "cli_usage_read",
    scope_digest: scope,
    authorize: async () => ({ allowed, scope_digest: scope }),
    execute: async () => {
      calls++;
      throw new RetryFailure("unavailable");
    },
    ...timing,
    wait: async (ms) => {
      clock.value += ms;
      allowed = false;
    },
  });
  assert.equal(expired.status, "blocked");
  assert.equal(calls, 1);
  let permissions = 0,
    writes = 0;
  const prepared = await runWithRetry({
    history,
    kind: "external_send",
    scope_digest: scope,
    authorize: async () => ({
      allowed: ++permissions === 1,
      scope_digest: scope,
    }),
    prepare: async () => {},
    execute: async () => {
      writes++;
    },
    ...timing,
  });
  assert.equal(prepared.status, "blocked");
  assert.equal(prepared.certainty, "not_dispatched");
  assert.equal(writes, 0);
  const wrongScope = await runWithRetry({
    history,
    kind: "external_send",
    scope_digest: scope,
    authorize: async () => ({ allowed: true, scope_digest: "b".repeat(64) }),
    execute: async () => {
      writes++;
    },
    ...timing,
  });
  assert.equal(wrongScope.attempts, 0);
  assert.equal(writes, 0);
});

test("an in-flight deadline stops new attempts, aborts cooperatively and ignores a late response", async (t) => {
  const { history } = await setup(t);
  let calls = 0,
    aborted = false;
  const report = await runWithRetry({
    history,
    kind: "external_send",
    scope_digest: scope,
    authorize: authorized,
    budget: { total_ms: 2500 },
    execute: async ({ signal }) => {
      calls++;
      await new Promise((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        ),
      );
      return "fixture-late-secret";
    },
  });
  assert.equal(report.status, "budget_exhausted");
  assert.equal(report.certainty, "unknown");
  assert.equal(calls, 1);
  assert.equal(aborted, true);
  await delay(10);
  assert.equal(
    (await history.inspect(report.operation_id)).status,
    "budget_exhausted",
  );
});

test("a deadline consumed by durable persistence prevents preparation and reconciliation callbacks", async (t) => {
  for (const stage of ["attempt_started", "reconcile_started"]) {
    const { history, timing, clock } = await setup(t);
    const save = history.save.bind(history);
    history.save = async (record) => {
      await save(record);
      if (record.history.at(-1).step === stage) clock.value = 100;
    };
    let prepares = 0,
      queries = 0,
      writes = 0;
    const report = await runWithRetry({
      history,
      kind: "external_send",
      scope_digest: scope,
      authorize: authorized,
      budget: { total_ms: 100 },
      ...timing,
      prepare: async () => {
        prepares++;
      },
      execute: async () => {
        writes++;
        throw new RetryFailure("timeout");
      },
      reconcile: async (context) => {
        queries++;
        return receipt(context, "not_applied");
      },
    });
    assert.equal(report.status, "budget_exhausted");
    assert.equal(report.history.at(-1).reason, "elapsed_budget_exhausted");
    assert.equal(queries, 0);
    assert.equal(writes, stage === "attempt_started" ? 0 : 1);
    assert.equal(prepares, stage === "attempt_started" ? 0 : 1);
    assert.equal(report.certainty, writes ? "unknown" : "not_dispatched");
  }
});

test("CLI retry flags cannot silently enable another command or change the operation effect catalog", async (t) => {
  const { project, env } = await setup(t);
  assert.throws(() => {
    retryKinds.external_send.idempotent = true;
  }, TypeError);
  for (const args of [
    ["adapters", "--retry-attempts", "3"],
    ["session-ledger", "list", "--retry"],
    ["retry-history", "list", "--retry"],
  ]) {
    await assert.rejects(
      exec(process.execPath, [cli, ...args, "--project", project.root], {
        env,
      }),
      (failure) =>
        failure.code === 1 &&
        /Retry options require --retry|--retry is available for adapters only/.test(
          failure.stderr,
        ),
    );
  }
});

test("corrupt records, ID collisions and surviving locks refuse mutation and allow safe read-only diagnosis", async (t) => {
  const { history, timing, project } = await setup(t);
  const done = await runWithRetry({
    history,
    kind: "cli_usage_read",
    scope_digest: scope,
    authorize: authorized,
    execute: async () => {},
    ...timing,
  });
  const bytes = await fs.readFile(history.file(done.operation_id));
  await assert.rejects(
    runWithRetry({
      history,
      operation_id: done.operation_id,
      kind: "external_send",
      scope_digest: scope,
      authorize: authorized,
      execute: async () => {},
      ...timing,
    }),
    error("operation_changed"),
  );
  assert.deepEqual(await fs.readFile(history.file(done.operation_id)), bytes);
  const incomplete = JSON.parse(bytes);
  incomplete.status = "dispatching";
  incomplete.certainty = "unknown";
  await history.save(incomplete);
  const lock = path.join(history.directory, done.operation_id + ".lock");
  await fs.writeFile(lock, "fixture-stale-lock");
  assert.equal((await history.inspect(done.operation_id)).status, "unknown");
  await assert.rejects(
    runWithRetry({
      history,
      operation_id: done.operation_id,
      kind: "cli_usage_read",
      scope_digest: scope,
      authorize: authorized,
      execute: async () => {},
      ...timing,
    }),
    error("operation_busy"),
  );
  assert.equal(await fs.readFile(lock, "utf8"), "fixture-stale-lock");
  await fs.unlink(lock);
  const broken = '{"schema":99,"fixture":"secret-dont-echo"}';
  await fs.writeFile(history.file(done.operation_id), broken);
  await assert.rejects(
    (await RetryHistory.open(project)).inspect(done.operation_id),
    (failure) =>
      failure.code === "invalid_retry_history" &&
      !failure.message.includes("secret"),
  );
  assert.equal(
    await fs.readFile(history.file(done.operation_id), "utf8"),
    broken,
  );
});

test("original CLI version retry uses actual bounded children and persistent inspection without profile boot", async (t) => {
  const { history, project, root, env } = await setup(t);
  const counter = path.join(root, "versions");
  const report = await probeCliWithRetry({
    history,
    command: [process.execPath, fixture],
    cwd: project.root,
    env: {
      ...env,
      RDSH_ADAPTER_FIXTURE_MODE: "version_timeout_once",
      RDSH_ADAPTER_FIXTURE_VERSION_COUNTER: counter,
    },
    budget: {
      max_attempts: 3,
      total_ms: 10000,
      base_ms: 10,
      max_delay_ms: 100,
    },
    requestTimeout: 700,
  });
  assert.equal(report.retry.status, "completed");
  assert.equal(report.retry.attempts, 2);
  assert.equal(report.adapter.health, "version_matched");
  assert.equal(await fs.readFile(counter, "utf8"), "2");
  await assert.rejects(
    fs.readFile(env.RDSH_ADAPTER_FIXTURE_TRACE),
    (failure) => failure.code === "ENOENT",
  );
  const inspected = JSON.parse(
    (
      await exec(
        process.execPath,
        [
          cli,
          "retry-history",
          "inspect",
          "--project",
          project.root,
          "--operation-id",
          report.retry.operation_id,
        ],
        { env, windowsHide: true },
      )
    ).stdout,
  );
  assert.equal(inspected.status, "completed");
  assert.equal(inspected.attempts, 2);
  const normal = JSON.parse(
    (
      await exec(
        process.execPath,
        [
          cli,
          "adapters",
          "--cli",
          "dsh",
          "--executable",
          process.execPath,
          "--entrypoint",
          fixture,
          "--project",
          project.root,
          "--retry",
        ],
        { env, windowsHide: true, timeout: 15000, maxBuffer: 256 * 1024 },
      )
    ).stdout,
  );
  assert.equal(normal.retry.status, "completed");
  assert.equal(normal.retry.attempts, 1);
  assert.equal(normal.adapter.health, "version_matched");
});
