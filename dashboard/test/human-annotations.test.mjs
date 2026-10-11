import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HumanAnnotationStore, eventIdentifier } from "../human-annotations.mjs";
import { startDashboard } from "../server.mjs";

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-annotations-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  const directory = path.join(temporary, "state");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(directory, { recursive: true });
  const runGit = (...args) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  runGit("init", "-q");
  runGit("config", "user.name", "Annotation Test");
  runGit("config", "user.email", "annotation-test@example.invalid");
  runGit("config", "core.autocrlf", "false");
  await fs.writeFile(path.join(root, "src", "example.rs"), "first line\noriginal target\nlast line\n");
  runGit("add", "src/example.rs");
  runGit("commit", "-m", "initial fixture");
  const project = {
    id: "0123456789abcdef",
    name: "annotation-fixture",
    root,
    directory,
  };
  const event = {
    event_id: "event-fixture-1",
    sequence: 1,
    type: "note",
    title: "Deployment decision",
    detail: "first detail line\nline to bookmark\nlast detail line",
    artifact: "",
    created_at: "2026-10-10T01:02:03.000Z",
  };
  const state = {
    tasks: [{ id: "T-1", title: "Review deployment" }],
    events: [event],
    questions: [
      {
        id: "Q-1",
        question: "Should deployment wait?",
        answer: "Wait for the backup check.",
        answered_at: "2026-10-10T01:03:00.000Z",
      },
    ],
  };
  return { temporary, root, project, state, runGit };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("human event, decision, and diff bookmarks persist independently and never retarget changed sources", async (t) => {
  const f = await fixture(t);
  const store = await HumanAnnotationStore.open(f.project);
  const event = f.state.events[0];
  const commit = f.runGit("rev-parse", "HEAD");
  const eventRecord = await store.add(
    {
      kind: "event",
      task_id: "T-1",
      event_id: eventIdentifier(event),
      line: 2,
      note: "This was the reason for the hold.",
    },
    f.state,
  );
  const decisionRecord = await store.add(
    {
      kind: "decision",
      task_id: "T-1",
      question_id: "Q-1",
      note: "Keep the human decision visible.",
    },
    f.state,
  );
  const diffRecord = await store.add(
    {
      kind: "diff",
      task_id: "T-1",
      commit,
      path: "src/example.rs",
      line: 2,
      note: "Review this exact implementation line.",
    },
    f.state,
  );

  assert.equal(eventRecord.author, "human");
  assert.equal(eventRecord.source, "browser");
  assert.equal(eventRecord.target.excerpt, "line to bookmark");
  assert.equal(decisionRecord.target.question_id, "Q-1");
  assert.equal(diffRecord.target.commit, commit);
  assert.equal(diffRecord.target.excerpt, "original target");
  assert.deepEqual(
    (await store.inspect(f.state)).annotations.map((item) => item.reference_status.code),
    ["current", "current", "current"],
  );
  f.state.events.push({
    event_id: "event-fixture-2",
    sequence: 2,
    type: "progress",
    title: "Later report",
    detail: "an unrelated event update",
    artifact: "",
    created_at: "2026-10-10T01:04:00.000Z",
  });
  const afterEventUpdate = await store.inspect(f.state);
  assert.equal(afterEventUpdate.annotations[0].reference_status.code, "current");
  assert.equal(afterEventUpdate.annotations[0].note, "This was the reason for the hold.");
  assert.equal(afterEventUpdate.annotations[0].target.excerpt, "line to bookmark");

  const reopened = await HumanAnnotationStore.open(f.project);
  assert.equal(reopened.value.revision, 3);
  assert.equal(reopened.value.annotations[2].target.excerpt, "original target");

  f.state.events = [];
  f.state.questions[0].answer = "The decision changed after a new review.";
  await fs.writeFile(path.join(f.root, "src", "example.rs"), "first line\nnew target\nlast line\n");
  f.runGit("add", "src/example.rs");
  f.runGit("commit", "-m", "change pinned line");
  let inspected = await reopened.inspect(f.state);
  assert.deepEqual(
    inspected.annotations.map((item) => item.reference_status.code),
    ["missing", "changed", "changed"],
  );
  assert.equal(inspected.annotations[0].note, "This was the reason for the hold.");
  assert.equal(inspected.annotations[0].target.excerpt, "line to bookmark");
  assert.equal(inspected.annotations[1].target.answer_excerpt, "Wait for the backup check.");
  assert.equal(inspected.annotations[2].target.excerpt, "original target");
  assert.doesNotMatch(inspected.annotations[2].target.excerpt, /new target/);

  await fs.rm(path.join(f.root, "src", "example.rs"));
  f.runGit("add", "-A");
  f.runGit("commit", "-m", "remove target file");
  inspected = await reopened.inspect(f.state);
  assert.equal(inspected.annotations[2].reference_status.code, "missing");
});

test("annotation HTTP access is browser-only and survives dashboard restart", async (t) => {
  const f = await fixture(t);
  let dashboard = await startDashboard({
    project: f.project,
    port: await freePort(),
    tailscale: false,
  });
  t.after(async () => dashboard?.close());
  await dashboard.store.mutate("task", {
    id: "T-1",
    title: "Review deployment",
    status: "doing",
  });
  const eventState = await dashboard.store.mutate("event", {
    type: "note",
    title: "Deployment decision",
    detail: "first line\nsecond line",
  });
  let runtime = JSON.parse(
    await fs.readFile(path.join(f.project.directory, "runtime.json"), "utf8"),
  );
  const browser = {
    "x-rdsh-browser-token": new URL(runtime.browser_url).hash.slice(5),
  };
  const agent = { authorization: `Bearer ${runtime.mcp_token}` };
  const admin = { authorization: `Bearer ${runtime.token}` };
  const base = dashboard.localUrl + "api/annotations";
  const origin = new URL(dashboard.localUrl).origin;
  const post = (headers, body) =>
    fetch(base, {
      method: "POST",
      headers: { ...headers, origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  assert.equal((await fetch(base, { headers: { ...agent, origin } })).status, 401);
  assert.equal((await fetch(base, { headers: { ...admin, origin } })).status, 403);
  assert.equal((await fetch(base, { headers: { origin } })).status, 401);
  const created = await post(browser, {
    action: "create",
    kind: "event",
    task_id: "T-1",
    event_id: eventIdentifier(eventState.events[0]),
    line: 2,
    note: "Human-only durable note.",
  });
  assert.equal(created.status, 201);
  assert.equal((await post(agent, { action: "delete", id: "any" })).status, 401);
  assert.equal((await post(admin, { action: "delete", id: "any" })).status, 403);

  const visible = await (await fetch(base, { headers: { ...browser, origin } })).json();
  assert.equal(visible.annotations.length, 1);
  assert.equal(visible.annotations[0].reference_status.code, "current");
  const mcpState = await (
    await fetch(dashboard.localUrl + "api/state", { headers: { ...agent, origin } })
  ).json();
  assert.equal(Object.hasOwn(mcpState, "human_annotations"), false);
  assert.equal(
    (await fetch(dashboard.localUrl + "human-annotations-ui.mjs", { headers: { origin } })).status,
    200,
  );

  await dashboard.close();
  dashboard = await startDashboard({
    project: f.project,
    port: await freePort(),
    tailscale: false,
  });
  runtime = JSON.parse(
    await fs.readFile(path.join(f.project.directory, "runtime.json"), "utf8"),
  );
  const browserAfterRestart = {
    "x-rdsh-browser-token": new URL(runtime.browser_url).hash.slice(5),
  };
  const afterRestart = await (
    await fetch(dashboard.localUrl + "api/annotations", {
      headers: { ...browserAfterRestart, origin: new URL(dashboard.localUrl).origin },
    })
  ).json();
  assert.equal(afterRestart.annotations.length, 1);
  assert.equal(afterRestart.annotations[0].note, "Human-only durable note.");
});

test("annotation anchors reject missing tasks, retained log events, invalid lines, and unsafe Git paths", async (t) => {
  const f = await fixture(t);
  const store = await HumanAnnotationStore.open(f.project);
  await assert.rejects(
    store.add(
      {
        kind: "event",
        task_id: "removed-task",
        event_id: eventIdentifier(f.state.events[0]),
        note: "x",
      },
      f.state,
    ),
    /task that is still present/,
  );
  await assert.rejects(
    store.add(
      {
        kind: "event",
        task_id: "T-1",
        event_id: eventIdentifier(f.state.events[0]),
        line: 4,
        note: "x",
      },
      f.state,
    ),
    /not present/,
  );
  await assert.rejects(
    store.add(
      {
        kind: "diff",
        task_id: "T-1",
        commit: f.runGit("rev-parse", "HEAD"),
        path: "../outside.txt",
        line: 1,
        note: "x",
      },
      f.state,
    ),
    /parent segments/,
  );
});
