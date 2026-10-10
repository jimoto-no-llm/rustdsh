import test from "node:test";
import assert from "node:assert/strict";
import { loadDashboard, MemoryStorage, stateFor } from "./answer-dom.mjs";

const draftKey = (state) => "rdsh_project_drafts_v1:" + state.project.id;
const savedDrafts = (storage, state) => JSON.parse(storage.getItem(draftKey(state)));
const unavailable = (resource) => { throw new Error(resource + " unavailable while offline"); };

function assertStoredAuthentication(ui) {
  assert.ok(ui.requests.length > 0);
  for (const request of ui.requests) {
    assert.equal(request.headers["x-rdsh-browser-token"], "test-browser-token",
      "a hash-free reload must use the browser credential saved in the same tab");
  }
}

test("a failed send survives config failure and a hash-free reload before explicit retry", async () => {
  const state = stateFor();
  const storage = new MemoryStorage();
  const answer = "保存前に切断しても\n同じタブで復元する";
  let offline = false;
  const first = await loadDashboard({
    state, storage,
    readState: async () => offline ? unavailable("state") : state,
    postAnswer: async () => {
      offline = true;
      return unavailable("answer");
    },
  });
  await first.input(answer);
  await first.submit();
  assert.equal(first.answers().length, 1);
  assert.equal(state.questions[0].answer, null);
  assert.equal(first.textarea().value, answer);
  assert.equal(first.textarea().readOnly, true);
  assert.equal(savedDrafts(storage, state)[0].uncertain, true);
  const persisted = storage.getItem(draftKey(state));

  const failedStartup = await loadDashboard({
    state, storage, hash: "", readConfig: async () => unavailable("config"),
  });
  assert.deepEqual(failedStartup.requests.map((request) => request.route), ["config"]);
  assertStoredAuthentication(failedStartup);
  assert.match(failedStartup.element("connection").textContent, /config unavailable/);
  assert.equal(storage.getItem(draftKey(state)), persisted,
    "startup failure must not replace the saved uncertain answer");
  assert.equal(failedStartup.answers().length, 0);

  // Reconnection alone is not assumed to restart a failed initialization.
  // The user reloads the same tab explicitly after the server is reachable.
  const recovered = await loadDashboard({ state, storage, hash: "" });
  assertStoredAuthentication(recovered);
  assert.equal(recovered.textarea().value, answer);
  assert.equal(recovered.textarea().readOnly, false);
  assert.equal(recovered.button().textContent, "内容を確認して再送");
  assert.equal(recovered.answers().length, 0);
  await recovered.changed();
  assert.equal(recovered.answers().length, 0, "state refresh must not automatically resend");
  await recovered.submit();
  assert.equal(recovered.answers().length, 1);
  assert.equal(recovered.answers()[0].body.answer, answer);
  assert.equal(state.questions[0].answer, answer);
  assert.equal(recovered.form(), null);
  assert.deepEqual(savedDrafts(storage, state), []);
});

test("a draft survives initial state failure and an explicit hash-free reload", async () => {
  const state = stateFor();
  const storage = new MemoryStorage();
  const answer = "初回の状態取得が失敗しても下書きを残す";
  const first = await loadDashboard({ state, storage });
  await first.input(answer);
  const persisted = storage.getItem(draftKey(state));

  const failedStartup = await loadDashboard({
    state, storage, hash: "", readState: async () => unavailable("state"),
  });
  assert.deepEqual(failedStartup.requests.map((request) => request.route), ["config", "state"]);
  assertStoredAuthentication(failedStartup);
  assert.match(failedStartup.element("connection").textContent, /state unavailable/);
  assert.equal(storage.getItem(draftKey(state)), persisted);
  assert.equal(failedStartup.answers().length, 0);

  const recovered = await loadDashboard({ state, storage, hash: "" });
  assertStoredAuthentication(recovered);
  assert.equal(recovered.textarea().value, answer);
  assert.equal(recovered.textarea().readOnly, false);
  assert.equal(recovered.button().textContent, "回答を返す");
  assert.equal(recovered.answers().length, 0);
  assert.equal(state.questions[0].answer, null);
  assert.equal(savedDrafts(storage, state)[0].draft, answer);
  await recovered.changed();
  assert.equal(recovered.textarea().value, answer);
  assert.equal(recovered.answers().length, 0);
});

test("a saved answer with a lost response is confirmed after config failure without resending", async () => {
  const state = stateFor();
  const storage = new MemoryStorage();
  const answer = "保存後に応答が消えても\n回答は一度だけ";
  let offline = false;
  const first = await loadDashboard({
    state, storage,
    readState: async () => offline ? unavailable("state") : state,
    postAnswer: async ({ id, answer: submitted }) => {
      state.questions.find((question) => question.id === id).answer = submitted;
      state.revision++;
      offline = true;
      return unavailable("answer response");
    },
  });
  await first.input(answer);
  await first.submit();
  assert.equal(first.answers().length, 1);
  assert.equal(state.questions[0].answer, answer);
  assert.equal(first.textarea().value, answer);
  assert.equal(first.textarea().readOnly, true);
  assert.equal(savedDrafts(storage, state)[0].uncertain, true);
  const persisted = storage.getItem(draftKey(state));

  const failedStartup = await loadDashboard({
    state, storage, hash: "", readConfig: async () => unavailable("config"),
  });
  assert.deepEqual(failedStartup.requests.map((request) => request.route), ["config"]);
  assertStoredAuthentication(failedStartup);
  assert.match(failedStartup.element("connection").textContent, /config unavailable/);
  assert.equal(storage.getItem(draftKey(state)), persisted);
  assert.equal(failedStartup.answers().length, 0);

  const recovered = await loadDashboard({ state, storage, hash: "" });
  assertStoredAuthentication(recovered);
  assert.equal(recovered.form(), null, "the authoritative saved answer leaves the pending list");
  assert.ok(recovered.element("answers").textContent.includes(answer));
  assert.equal(recovered.element("retained-drafts").hidden, true);
  assert.deepEqual(savedDrafts(storage, state), []);
  await recovered.changed();
  assert.equal(recovered.answers().length, 0, "reloading and refreshing must not resubmit a saved answer");
  assert.equal(state.questions[0].answer, answer);
});
