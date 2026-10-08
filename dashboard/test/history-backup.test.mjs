import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, randomBytes } from "node:crypto";
import { EventsHub } from "../webhooks.mjs";
import {
  identity,
  ProjectStore,
  applyOperation,
  writeJson,
} from "../state.mjs";
import { startDashboard } from "../server.mjs";
import { AcceptanceStore } from "../acceptance.mjs";
import {
  createHistoryBackup,
  backupHash,
  validateHistoryBackup,
  backupSelection,
} from "../history-backup.mjs";
import { backupRequest } from "../backup-client.mjs";
import {
  readBackupJson,
  writeHistoryBackup,
  backupInspection,
} from "../backup-files.mjs";
const exec = promisify(execFile),
  cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const evidenceId = "evi_" + randomUUID();
const secrets = [
  "sk_fixture_private_key_123456",
  "ghp_fixture_private_token_123456",
  "Bearer fixture-credential",
  "https://user:password@example.invalid/code?token=fixture-secret#key=old",
  "const privateSource = 'DO_NOT_COPY_CODE'",
  "a".repeat(64),
];
const selection = {
  types: ["tasks", "answers", "decisions", "evidence"],
  task_ids: ["task-1"],
};
function seed(state) {
  applyOperation(state, "task", {
    id: "task-1",
    title: secrets[0],
    status: "done",
    milestone: secrets[4],
    blocker: secrets[3],
  });
  applyOperation(state, "task", {
    id: "unselected-task",
    title: secrets[1],
    status: "todo",
  });
  applyOperation(state, "question", {
    id: "question-1",
    question: secrets[2],
    decision: {
      kind: "approval",
      target: {
        task_id: "task-1",
        action_id: "old-action",
        revision: "old-revision",
        run_id: "old-run",
        session_id: "old-session",
      },
      choices: [
        { id: "yes", label: secrets[0] },
        { id: "no", label: "Later" },
      ],
      diff: secrets[4],
      impact: secrets[3],
      conditions: secrets[5],
      cost: { currency: "USD", max: null },
    },
  });
  const card = state.question_contracts.cards["question-1"];
  applyOperation(state, "answer", {
    id: "question-1",
    answer: secrets[1],
    expected_revision: card.revision,
    contract_fingerprint: card.fingerprint,
    choice_id: "yes",
  });
  state.runtime = { token: secrets[5], url: secrets[3] };
  state.changes = [{ credential: secrets[5] }];
  return state;
}
const index = (projectId) => ({
  schema: 1,
  project_id: projectId,
  revision: 1,
  tasks: [
    {
      id: "task-1",
      criteria: [
        { id: "criterion-1", description: secrets[0], inputs: ["private.js"] },
      ],
      updated_at: new Date().toISOString(),
    },
  ],
  evidence: [
    {
      sequence: 1,
      evidence_id: evidenceId,
      task_id: "task-1",
      criterion_id: "criterion-1",
      scope: "full",
    },
  ],
});
async function freePort() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}
async function setup(t, count = 1) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-backup-test-")),
    projects = [],
    dashboards = [];
  t.after(async () => {
    for (const d of dashboards.reverse()) await d.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("rdsh-backup-test-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  for (let i = 0; i < count; i++) {
    const cwd = path.join(root, `project-${i}`);
    await fs.mkdir(cwd);
    const project = await identity(cwd);
    project.directory = path.join(root, "home", "projects", project.id);
    projects.push(project);
  }
  async function start(project) {
    const d = await startDashboard({
      project,
      port: await freePort(),
      tailscale: false,
    });
    dashboards.push(d);
    return d;
  }
  return { root, projects, start };
}
function reviewFor(archive, replacements = []) {
  return {
    source: archive.source,
    selection_digest: backupHash(archive.selection),
    replacements,
  };
}
function reseal(a) {
  const { integrity, ...body } = a;
  a.integrity = { algorithm: "sha256", digest: backupHash(body) };
  return a;
}

test("selected task, original question revision, answer and evidence remain linked while all raw free text/code/credentials are withheld", async (t) => {
  const f = await setup(t),
    store = await ProjectStore.open(f.projects[0]);
  seed(store.value);
  const a = createHistoryBackup(
      store.value,
      index(store.project.id),
      selection,
    ),
    encoded = JSON.stringify(a);
  for (const secret of secrets) assert.ok(!encoded.includes(secret));
  for (const key of [
    "runtime",
    "changes",
    "consumer_id",
    "old-run",
    "old-session",
    "old-action",
    "private.js",
  ])
    assert.ok(!encoded.includes(key));
  assert.equal(a.records.tasks.length, 1);
  assert.equal(a.records.answers[0].question_id, a.records.questions[0].id);
  assert.equal(a.records.answers[0].decision_id, a.records.decisions[0].id);
  assert.equal(a.records.decisions[0].task_id, a.records.tasks[0].id);
  assert.equal(a.records.evidence[0].task_id, a.records.tasks[0].id);
  assert.equal(a.records.evidence[0].freshness, "unverified");
  assert.equal(a.records.answers[0].answer, null);
  assert.ok(a.withheld_fields.includes("answers/answer_1/answer"));
  const reviewed = createHistoryBackup(
    store.value,
    index(store.project.id),
    selection,
    reviewFor(a, [
      { path: "tasks/task-1/title", value: "Reviewed task" },
      {
        path: "answers/answer_1/answer",
        value: "Proceed with the reviewed patch",
      },
    ]),
  );
  assert.equal(reviewed.records.tasks[0].title, "Reviewed task");
  assert.equal(
    reviewed.records.answers[0].answer,
    "Proceed with the reviewed patch",
  );
  for (const secret of secrets)
    assert.ok(!JSON.stringify(reviewed).includes(secret));
  assert.deepEqual(backupInspection(reviewed).counts, {
    tasks: 1,
    questions: 1,
    answers: 1,
    decisions: 1,
    evidence: 1,
  });
});

test("review is pinned to source and selection; unsafe replacements/metadata and nonexistent paths are refused", async (t) => {
  const f = await setup(t),
    store = await ProjectStore.open(f.projects[0]);
  seed(store.value);
  const a = createHistoryBackup(
    store.value,
    index(store.project.id),
    selection,
  );
  for (const value of secrets)
    assert.throws(
      () =>
        createHistoryBackup(
          store.value,
          index(store.project.id),
          selection,
          reviewFor(a, [{ path: "tasks/task-1/title", value }]),
        ),
      /sensitive_backup_replacement/,
    );
  assert.throws(
    () =>
      createHistoryBackup(
        store.value,
        index(store.project.id),
        selection,
        reviewFor(a, [{ path: "runtime/token", value: "safe" }]),
      ),
    /sensitive_backup_replacement/,
  );
  store.value.revision++;
  assert.throws(
    () =>
      createHistoryBackup(
        store.value,
        index(store.project.id),
        selection,
        reviewFor(a),
      ),
    /review_source_changed/,
  );
  assert.throws(
    () => backupSelection({ types: ["tasks"], task_ids: ["__proto__"] }),
    /selection_ids/,
  );
  assert.throws(
    () =>
      backupSelection({ types: ["tasks"], since: "2026-02-30T00:00:00.000Z" }),
    /time_range/,
  );
  assert.throws(
    () =>
      createHistoryBackup(store.value, null, {
        types: ["evidence"],
        since: "2026-01-01T00:00:00.000Z",
      }),
    /evidence_range_requires_ids/,
  );
});

test("answer date range restores its older decision revision and task dependencies, never replacing it with the current revision", async (t) => {
  const f = await setup(t),
    store = await ProjectStore.open(f.projects[0]);
  seed(store.value);
  const prior = store.value.question_contracts.cards["question-1"];
  applyOperation(store.value, "question", {
    id: "question-1",
    action: "revise",
    expected_revision: 1,
    question: "New question",
    decision: {
      ...prior.snapshot.decision,
      target: { ...prior.snapshot.decision.target, revision: "new-revision" },
    },
  });
  const answer = store.value.feedback[0];
  const a = createHistoryBackup(store.value, null, {
    types: ["answers"],
    question_ids: ["question-1"],
    since: answer.created_at,
    until: answer.created_at,
  });
  assert.equal(a.records.decisions[0].revision, 1);
  assert.equal(a.records.decisions[0].source_status, "superseded");
  assert.equal(a.records.tasks[0].id, "task-1");
  assert.equal(a.records.answers[0].decision_id, a.records.decisions[0].id);
  const empty = createHistoryBackup(store.value, null, {
    types: ["answers"],
    until: "2000-01-01T00:00:00.000Z",
  });
  assert.equal(empty.records.answers.length, 0);
  assert.equal(empty.records.tasks.length, 0);
});

test("corruption, forged authority, unknown fields and broken relationships fail validation even with a recomputed checksum", async (t) => {
  const f = await setup(t),
    store = await ProjectStore.open(f.projects[0]);
  seed(store.value);
  const a = createHistoryBackup(
    store.value,
    index(store.project.id),
    selection,
  );
  const broken = structuredClone(a);
  broken.records.tasks[0].status = "todo";
  assert.throws(() => validateHistoryBackup(broken), /integrity_mismatch/);
  for (const mutate of [
    (v) => (v.policy.execution_authorized = true),
    (v) => (v.token = secrets[5]),
    (v) => (v.records.answers[0].question_id = "missing"),
    (v) => (v.records.decisions[0].target = { run_id: "old-run" }),
    (v) => (v.records.evidence[0].reference = secrets[3]),
    (v) => (v.records.tasks[0].id = "../../outside"),
    (v) => (v.records.tasks[0].title = "Bearer injected-secret"),
  ]) {
    const forged = structuredClone(a);
    mutate(forged);
    assert.throws(() => validateHistoryBackup(reseal(forged)));
  }
});

test("empty target restores only historical data using fresh authentication; old keys cannot reconnect or recreate event subscriptions", async (t) => {
  const f = await setup(t, 2),
    [source, target] = f.projects;
  const store = await ProjectStore.open(source);
  seed(store.value);
  delete store.value.runtime;
  delete store.value.changes;
  await store.commit(store.value);
  await writeJson(
    path.join(source.directory, "acceptance", "index.json"),
    index(source.id),
  );
  const signingKey = "whsec_" + randomBytes(32).toString("base64");
  const hub = await EventsHub.open(
    source,
    () => store.value,
    async (_url, _headers, body) => ({
      status: 200,
      body: JSON.stringify({ challenge: JSON.parse(body).challenge }),
    }),
  );
  await hub.subscribe({
    name: "dashboard.answer.created",
    arguments: { project_id: source.id },
    delivery: {
      mode: "webhook",
      url: "https://receiver.example/events?source=private",
      secret: signingKey,
    },
    ttlMs: 60000,
  });
  assert.equal(hub.status().active, 1);
  const src = await f.start(source),
    dst = await f.start(target);
  const oldRuntime = JSON.parse(
    await fs.readFile(path.join(source.directory, "runtime.json"), "utf8"),
  );
  const newRuntime = JSON.parse(
    await fs.readFile(path.join(target.directory, "runtime.json"), "utf8"),
  );
  const a = await backupRequest(source, "preview", { selection });
  for (const secret of [
    oldRuntime.token,
    oldRuntime.mcp_token,
    oldRuntime.browser_url,
    signingKey,
    "receiver.example",
  ])
    assert.ok(!JSON.stringify(a).includes(secret));
  const result = await backupRequest(target, "restore", {
    archive: a,
    expected_revision: 0,
  });
  assert.equal(result.execution_authorized, false);
  const history = await backupRequest(target, "history");
  assert.deepEqual(history.history_backups[0].archive, a);
  const loaded = await ProjectStore.open(target);
  assert.throws(() => {
    loaded.value.history_backups[0].archive.records.tasks[0].status = "todo";
  }, TypeError);
  assert.throws(() => {
    loaded.value.history_backups.push({});
  }, TypeError);
  assert.equal(loaded.value.questions.length, 0);
  assert.equal(loaded.value.feedback.length, 0);
  assert.equal(loaded.value.tasks.length, 0);
  for (const field of [
    "answer_applications",
    "instructions",
    "changes",
    "cost_ledger",
    "budget_admission",
  ])
    assert.equal(loaded.value[field], undefined);
  const acceptance = await (await AcceptanceStore.open(target)).read();
  assert.equal(acceptance.evidence.length, 0);
  for (const token of [oldRuntime.token, oldRuntime.mcp_token])
    assert.equal(
      (
        await fetch(dst.localUrl + "api/state", {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
      401,
    );
  assert.equal(
    (
      await fetch(dst.localUrl + "api/state", {
        headers: {
          "x-rdsh-browser-token": new URL(oldRuntime.browser_url).hash.slice(5),
        },
      })
    ).status,
    401,
  );
  assert.notEqual(oldRuntime.token, newRuntime.token);
  assert.notEqual(oldRuntime.instance_id, newRuntime.instance_id);
  const config = await fetch(dst.localUrl + "api/config", {
    headers: { authorization: `Bearer ${newRuntime.token}` },
  });
  assert.equal((await config.json()).events.active, 0);
  const forbidden = [
    newRuntime.mcp_token,
    new URL(newRuntime.browser_url).hash.slice(5),
  ];
  for (const token of forbidden)
    assert.ok(
      [401, 403].includes(
        (
          await fetch(dst.localUrl + "api/backup/restore", {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "x-rdsh-browser-token": token,
              "content-type": "application/json",
            },
            body: JSON.stringify({ archive: a, expected_revision: 1 }),
          })
        ).status,
      ),
    );
  assert.deepEqual(
    (await fs.readdir(target.directory)).sort(),
    [
      "mcp-config.json",
      "mcp-http-config.json",
      "runtime.json",
      "server.lock",
      "state.json",
    ].sort(),
  );
  assert.ok(src.localUrl);
  await dst.close();
  const immutableHistory = loaded.value.history_backups;
  await loaded.mutate("metrics", { model_calls: 2 });
  assert.equal(loaded.value.history_backups, immutableHistory);
  const forged = loaded.clone();
  forged.history_backups = structuredClone(immutableHistory);
  forged.history_backups[0].archive.policy.execution_authorized = true;
  reseal(forged.history_backups[0].archive);
  const beforeReplacement = await fs.readFile(
    path.join(target.directory, "state.json"),
  );
  await assert.rejects(loaded.commit(forged), /cannot_restore_authority/);
  assert.deepEqual(
    await fs.readFile(path.join(target.directory, "state.json")),
    beforeReplacement,
  );
});

test("all collisions, stale revisions and corrupt restores leave state bytes unchanged; concurrent restores serialize atomically", async (t) => {
  const f = await setup(t, 2),
    [source, target] = f.projects;
  const s = await ProjectStore.open(source);
  seed(s.value);
  const a = createHistoryBackup(s.value, index(source.id), selection);
  const targetStore = await ProjectStore.open(target);
  await targetStore.mutate("task", {
    id: "task-1",
    title: "Existing work",
    status: "doing",
  });
  const dst = await f.start(target),
    file = path.join(target.directory, "state.json"),
    before = await fs.readFile(file);
  await assert.rejects(
    backupRequest(target, "restore", { archive: a, expected_revision: 1 }),
    /id_collision/,
  );
  assert.deepEqual(await fs.readFile(file), before);
  await dst.close();
  // Use a separate empty target for concurrency; preserve the dirty target.
  const cwd = path.join(f.root, "empty");
  await fs.mkdir(cwd);
  const empty = await identity(cwd);
  empty.directory = path.join(f.root, "home", "projects", empty.id);
  await f.start(empty);
  const results = await Promise.allSettled([
    backupRequest(empty, "restore", { archive: a, expected_revision: 0 }),
    backupRequest(empty, "restore", { archive: a, expected_revision: 0 }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const prior = await fs.readFile(path.join(empty.directory, "state.json"));
  await assert.rejects(
    backupRequest(empty, "restore", { archive: a, expected_revision: 1 }),
    /duplicate_restored_archive|id_collision/,
  );
  const broken = structuredClone(a);
  broken.integrity.digest = "0".repeat(64);
  await assert.rejects(
    backupRequest(empty, "restore", { archive: broken, expected_revision: 1 }),
    /integrity_mismatch/,
  );
  assert.deepEqual(
    await fs.readFile(path.join(empty.directory, "state.json")),
    prior,
  );
  const e = await ProjectStore.open(empty);
  await assert.rejects(
    e.mutate("question", { id: "question-1", question: "Reuse id" }),
    /id_collision/,
  );
  assert.deepEqual(
    await fs.readFile(path.join(empty.directory, "state.json")),
    prior,
  );
});

test("CLI previews, reviews, exports, inspects, restores and re-exports a portable archive; exclusive files and invalid UTF-8 fail safely", async (t) => {
  const f = await setup(t, 2),
    [source, target] = f.projects;
  const store = await ProjectStore.open(source);
  seed(store.value);
  delete store.value.runtime;
  delete store.value.changes;
  await store.commit(store.value);
  await writeJson(
    path.join(source.directory, "acceptance", "index.json"),
    index(source.id),
  );
  await f.start(source);
  await f.start(target);
  const selectionFile = path.join(f.root, "selection.json"),
    archiveFile = path.join(f.root, "backup.json"),
    reviewFile = path.join(f.root, "review.json");
  await writeJson(selectionFile, selection);
  const env = {
    ...process.env,
    RDSH_DASHBOARD_HOME: path.join(f.root, "home"),
  };
  const run = async (args) =>
    JSON.parse(
      (
        await exec(process.execPath, [cli, "backup", ...args], {
          env,
          timeout: 30000,
        })
      ).stdout,
    );
  const preview = await run([
    "preview",
    "--project",
    source.root,
    "--selection-file",
    selectionFile,
  ]);
  await writeJson(reviewFile, {
    source: preview.source,
    selection_digest: preview.selection_digest,
    replacements: [
      { path: "tasks/task-1/title", value: "Public task" },
      {
        path: "questions/question-1/question",
        value: "Apply the reviewed change?",
      },
      { path: "answers/answer_1/answer", value: "Yes, apply that change" },
    ],
  });
  await run([
    "export",
    "--project",
    source.root,
    "--selection-file",
    selectionFile,
    "--review-file",
    reviewFile,
    "--output-file",
    archiveFile,
  ]);
  const bytes = await fs.readFile(archiveFile),
    a = await readBackupJson(archiveFile);
  for (const secret of secrets) assert.ok(!bytes.toString().includes(secret));
  assert.equal(
    (await run(["inspect", "--archive-file", archiveFile])).records.answers[0]
      .answer,
    "Yes, apply that change",
  );
  const r = await run([
    "restore",
    "--project",
    target.root,
    "--archive-file",
    archiveFile,
    "--expected-revision",
    "0",
  ]);
  assert.equal(r.mode, "historical-only");
  assert.equal(
    (await run(["history", "--project", target.root])).history_backups[0]
      .archive.records.tasks[0].title,
    "Public task",
  );
  const reexport = path.join(f.root, "again.json");
  await run([
    "export",
    "--project",
    target.root,
    "--archive-id",
    a.archive_id,
    "--output-file",
    reexport,
  ]);
  assert.deepEqual(await fs.readFile(reexport), bytes);
  await assert.rejects(writeHistoryBackup(archiveFile, a), /EEXIST/);
  assert.deepEqual(await fs.readFile(archiveFile), bytes);
  const invalid = path.join(f.root, "invalid.json");
  await fs.writeFile(invalid, Buffer.from([0xc3, 0x28]));
  await assert.rejects(readBackupJson(invalid), /Invalid backup JSON/);
  await assert.rejects(readBackupJson(f.root), /Invalid backup JSON/);
  await fs.writeFile(invalid, Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(readBackupJson(invalid), /Invalid backup JSON/);
  if (process.platform !== "win32") {
    const link = path.join(f.root, "link.json");
    await fs.symlink(archiveFile, link);
    await assert.rejects(readBackupJson(link), /Invalid backup JSON/);
    assert.equal((await fs.stat(archiveFile)).mode & 0o777, 0o600);
  }
});

test("existing question and acceptance evidence IDs reject import before writing, and imported history is validated on reopen", async (t) => {
  const f = await setup(t, 3),
    [source, questionTarget, evidenceTarget] = f.projects;
  const s = await ProjectStore.open(source);
  seed(s.value);
  const a = createHistoryBackup(s.value, index(source.id), selection);
  const q = await ProjectStore.open(questionTarget);
  await q.mutate("question", {
    id: "question-1",
    question: "Existing unanswered question",
  });
  await f.start(questionTarget);
  const qFile = path.join(questionTarget.directory, "state.json"),
    qBefore = await fs.readFile(qFile);
  await assert.rejects(
    backupRequest(questionTarget, "restore", {
      archive: a,
      expected_revision: 1,
    }),
    /id_collision/,
  );
  assert.deepEqual(await fs.readFile(qFile), qBefore);
  const e = await ProjectStore.open(evidenceTarget);
  await e.commit(e.value);
  const existing = index(evidenceTarget.id);
  existing.tasks[0].id = "other-task";
  existing.evidence[0].task_id = "other-task";
  await writeJson(
    path.join(evidenceTarget.directory, "acceptance", "index.json"),
    existing,
  );
  await f.start(evidenceTarget);
  const eFile = path.join(evidenceTarget.directory, "state.json"),
    eBefore = await fs.readFile(eFile);
  await assert.rejects(
    backupRequest(evidenceTarget, "restore", {
      archive: a,
      expected_revision: 1,
    }),
    /id_collision/,
  );
  assert.deepEqual(await fs.readFile(eFile), eBefore);
  await fs.unlink(
    path.join(evidenceTarget.directory, "acceptance", "index.json"),
  );
  await backupRequest(evidenceTarget, "restore", {
    archive: a,
    expected_revision: 1,
  });
  const corrupt = JSON.parse(await fs.readFile(eFile, "utf8"));
  corrupt.history_backups[0].archive.policy.execution_authorized = true;
  reseal(corrupt.history_backups[0].archive);
  await writeJson(eFile, corrupt);
  await assert.rejects(
    ProjectStore.open(evidenceTarget),
    /cannot_restore_authority/,
  );
});
