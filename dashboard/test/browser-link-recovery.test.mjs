import test from "node:test";
import assert from "node:assert/strict";
import { loadDashboard, MemoryStorage, stateFor } from "./answer-dom.mjs";

// Model a same-document navigation without recreating the running app. Only an
// explicit browser reload below creates the next document with the same storage.
async function receiveLink(ui, hash) {
  const reloads = [];
  ui.window.location.reload = () => reloads.push(ui.window.location.hash);
  ui.window.location.hash = hash;
  await ui.window.dispatch("hashchange");
  return reloads;
}

function assertNewAuthentication(ui) {
  assert.ok(ui.requests.length > 0);
  for (const request of ui.requests) {
    assert.equal(request.headers["x-rdsh-browser-token"], "synthetic-new-key");
  }
  assert.equal(ui.storage.getItem("rdsh_project_browser_token"), "synthetic-new-key");
}

test("a new browser link restarts a document whose initial config request failed", async () => {
  const state = stateFor();
  const storage = new MemoryStorage();
  storage.setItem("rdsh_project_browser_token", "synthetic-old-key");
  const failed = await loadDashboard({
    state, storage, hash: "",
    readConfig: async () => { throw new Error("401 Unauthorized (synthetic)"); },
  });
  assert.match(failed.element("connection").textContent, /401/);
  assert.equal(failed.requests[0].headers["x-rdsh-browser-token"], "synthetic-old-key");

  const reloads = await receiveLink(failed, "#key=synthetic-new-key");
  assert.deepEqual(reloads, ["#key=synthetic-new-key"],
    "the new key must survive until the requested full-document reload");
  assert.equal(failed.answers().length, 0);

  const recovered = await loadDashboard({ state, storage, hash: reloads[0] });
  assertNewAuthentication(recovered);
  assert.match(recovered.element("connection").textContent, /接続済み/);
  assert.ok(recovered.form());
  await recovered.changed();
  assertNewAuthentication(recovered);
  assert.equal(recovered.answers().length, 0);
});

test("a new browser link preserves a draft through the requested reload without sending it", async () => {
  const state = stateFor();
  const storage = new MemoryStorage();
  const first = await loadDashboard({ state, storage, hash: "#key=synthetic-old-key" });
  const answer = "同じタブで保持する未送信の回答";
  await first.input(answer);

  const reloads = await receiveLink(first, "#key=synthetic-new-key");
  assert.deepEqual(reloads, ["#key=synthetic-new-key"]);
  assert.equal(first.answers().length, 0);
  const recovered = await loadDashboard({ state, storage, hash: reloads[0] });
  assert.equal(recovered.textarea().value, answer);
  assert.equal(recovered.answers().length, 0);
  await recovered.changed();
  assert.equal(recovered.textarea().value, answer);
  assert.equal(recovered.answers().length, 0);
  assertNewAuthentication(recovered);

  await recovered.submit();
  assert.equal(recovered.answers().length, 1);
  assert.equal(recovered.answers()[0].body.answer, answer);
  assertNewAuthentication(recovered);
});

test("question and task anchors do not reload or replace the current browser credential", async () => {
  const ui = await loadDashboard({ hash: "#key=synthetic-old-key" });
  await ui.input("アンカー移動で消さない回答");
  for (const hash of ["#question-Q1", "#task-T1", "", "#key=", "#keyed=unrelated"]) {
    assert.deepEqual(await receiveLink(ui, hash), []);
    assert.equal(ui.textarea().value, "アンカー移動で消さない回答");
    assert.equal(ui.storage.getItem("rdsh_project_browser_token"), "synthetic-old-key");
  }
  assert.equal(ui.answers().length, 0);
});

test("a stored browser key preserves an initial task anchor and selects its overview", async () => {
  const storage = new MemoryStorage();
  storage.setItem("rdsh_project_browser_token", "synthetic-old-key");
  const state = stateFor();
  state.tasks = [{ id: "T-main", title: "既存のタスク概要", status: "doing", blocker: "" }];
  const ui = await loadDashboard({ state, storage, hash: "#task-T-main" });
  assert.equal(ui.window.location.hash, "#task-T-main");
  assert.equal(ui.element("overview-task").value, "T-main");
  assert.match(ui.element("overview-context").textContent, /T-main 既存のタスク概要/);
  assert.equal(ui.requests[0].headers["x-rdsh-browser-token"], "synthetic-old-key");
  assert.equal(ui.answers().length, 0);
});

test("a new link cannot discard the latest draft when saving it exceeded storage quota", async () => {
  const state = stateFor();
  const storage = new MemoryStorage();
  const ui = await loadDashboard({ state, storage, hash: "#key=synthetic-old-key" });
  await ui.input("最後に保存できた古い本文");
  const key = "rdsh_project_drafts_v1:" + state.project.id;
  const saved = storage.getItem(key);
  storage.setItem = () => { throw new Error("QuotaExceededError (synthetic)"); };
  const latest = "容量不足の後に入力した最新の本文";
  await ui.input(latest);
  assert.equal(storage.getItem(key), saved);
  const notices = () => ["connection", "draft-storage-note"]
    .map((id) => ui.element(id).textContent).join(" ");
  const previousNotice = notices();

  assert.deepEqual(await receiveLink(ui, "#key=synthetic-new-key"), [],
    "the app must keep the only copy of the newest draft in this document");
  assert.equal(ui.textarea().value, latest);
  assert.equal(storage.getItem(key), saved);
  assert.equal(ui.answers().length, 0);
  assert.notEqual(notices(), previousNotice,
    "the received link must explain how to continue while preserving the unsaved text");
  assert.match(notices(), /コピー/);
  assert.match(notices(), /再読み込み|リロード/);
  assert.equal(ui.window.location.hash, "#key=synthetic-new-key",
    "manual reload after copying must still receive the new connection key");
});

test("storage failure without an unsaved answer does not prevent link recovery", async () => {
  const storage = new MemoryStorage();
  storage.setItem = () => { throw new Error("QuotaExceededError (synthetic)"); };
  const failed = await loadDashboard({
    storage, hash: "#key=synthetic-old-key",
    readConfig: async () => { throw new Error("401 Unauthorized (synthetic)"); },
  });
  const reloads = await receiveLink(failed, "#key=synthetic-new-key");
  assert.deepEqual(reloads, ["#key=synthetic-new-key"]);

  const recovered = await loadDashboard({ storage, hash: reloads[0] });
  assert.match(recovered.element("connection").textContent, /接続済み/);
  assert.equal(recovered.textarea().value, "");
  assert.equal(recovered.answers().length, 0);
  assert.ok(recovered.requests.every((request) =>
    request.headers["x-rdsh-browser-token"] === "synthetic-new-key"));
});
