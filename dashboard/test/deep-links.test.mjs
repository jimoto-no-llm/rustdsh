import test from "node:test";
import assert from "node:assert/strict";
import {
  clearPendingProjectDeepLink,
  clearProjectDeepLinkUrl,
  createProjectDeepLink,
  parseProjectDeepLink,
  pendingProjectDeepLink,
  rememberProjectDeepLink,
  resolveProjectDeepLink,
} from "../deep-links.mjs";

const state = {
  project: { id: "project-a" },
  tasks: [{ id: "task-1", title: "same name" }],
  questions: [{ id: "question-1", question: "confirm?" }],
  events: [{ sequence: 42, title: "progress" }],
  answer_applications: { consumers: {
    consumer_a: { consumer_id: "consumer_a", run_id: "run-a", session_id: "session-a" },
    consumer_b: { consumer_id: "consumer_b", run_id: "run-b", session_id: "session-a" },
  } },
};

test("deep links preserve project identity and never copy URL credentials", () => {
  const href = createProjectDeepLink(
    "https://user:password@dashboard.example/project?token=query-secret#key=fragment-secret",
    "project-a", "task", "task-1",
  );
  const url = new URL(href);
  assert.equal(url.origin, "https://dashboard.example");
  assert.equal(url.pathname, "/project");
  assert.equal(url.username, "");
  assert.equal(url.password, "");
  assert.equal(url.searchParams.get("rdsh_project"), "project-a");
  assert.equal(url.searchParams.get("rdsh_kind"), "task");
  assert.equal(url.searchParams.get("rdsh_id"), "task-1");
  assert.equal(url.searchParams.has("token"), false);
  assert.equal(url.hash, "");
  assert.deepEqual(parseProjectDeepLink(href), {
    status: "target", projectId: "project-a", kind: "task", id: "task-1",
  });
});

test("task, question, session and log targets resolve by exact scoped IDs", () => {
  for (const [kind, id, runId, elementId] of [
    ["task", "task-1", undefined, "task-task-1"],
    ["question", "question-1", undefined, "question-question-1"],
    ["event", "42", undefined, "event-42"],
  ]) {
    const target = parseProjectDeepLink(createProjectDeepLink("https://x.test/", "project-a", kind, id));
    assert.deepEqual(resolveProjectDeepLink(target, state), { status: "found", kind, id, elementId });
  }
  const session = parseProjectDeepLink(createProjectDeepLink("https://x.test/", "project-a", "session", "session-a", "run-b"));
  assert.deepEqual(resolveProjectDeepLink(session, state), {
    status: "found", kind: "session", id: "session-a", consumerId: "consumer_b",
  });
  assert.equal(resolveProjectDeepLink({ ...session, runId: "missing-run" }, state).status, "not_found");
});

test("wrong projects, deleted targets, and malformed links never choose a same-named object", () => {
  const target = parseProjectDeepLink(createProjectDeepLink("https://x.test/", "project-a", "task", "task-1"));
  assert.equal(resolveProjectDeepLink(target, { ...state, project: { id: "project-b" } }).status, "wrong_project");
  assert.equal(resolveProjectDeepLink({ ...target, id: "deleted" }, state).status, "not_found");
  assert.deepEqual(parseProjectDeepLink("https://x.test/?rdsh_kind=task"), { status: "invalid" });
  assert.deepEqual(parseProjectDeepLink("https://x.test/?rdsh_project=a&rdsh_project=b&rdsh_kind=task&rdsh_id=task-1"), { status: "invalid" });
  assert.deepEqual(parseProjectDeepLink("https://x.test/"), { status: "none" });
  assert.equal(resolveProjectDeepLink({ ...target, kind: "unknown" }, state).status, "invalid");
});

test("a pending target survives the pairing page briefly and is consumed explicitly", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const target = parseProjectDeepLink(createProjectDeepLink("https://x.test/", "project-a", "question", "question-1"));
  assert.equal(rememberProjectDeepLink(storage, target, 100), true);
  assert.deepEqual(pendingProjectDeepLink(storage, 101), target);
  assert.deepEqual(pendingProjectDeepLink(storage, 600101), { status: "none" });
  assert.equal(rememberProjectDeepLink(storage, target, 100), true);
  clearPendingProjectDeepLink(storage);
  assert.deepEqual(pendingProjectDeepLink(storage, 101), { status: "none" });
});

test("consuming a deep link removes navigation and credential-like query parameters", () => {
  assert.equal(
    clearProjectDeepLinkUrl("/project?keep=1&token=secret&rdsh_project=p&rdsh_kind=event&rdsh_id=42#safe-anchor"),
    "/project?keep=1#safe-anchor",
  );
});
