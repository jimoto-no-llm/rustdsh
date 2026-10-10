import test from "node:test";
import assert from "node:assert/strict";
import { loadDashboard, MemoryStorage, stateFor } from "./answer-dom.mjs";

const denied = (status = 401, error = "Open this dashboard through rdsh-dashboard open or its QR code") =>
  new Response(JSON.stringify({ error }), {
    status, headers: { "content-type": "application/json" },
  });
const configFor = (state, shared = false) => ({
  kind: "project", project: state.project,
  share: shared
    ? { state: "ready", message: "Connected", url: "https://synthetic.example.test/" }
    : { state: "disabled", message: "Local test", url: null },
});

function assertRecoveryNotice(ui) {
  const notice = ui.element("auth-notice");
  assert.ok(notice, "authentication failure needs a visible recovery notice");
  assert.equal(notice.hidden, false);
  assert.equal(notice.getAttribute("role"), "alert");
  assert.match(notice.textContent, /PC/);
  assert.match(notice.textContent, /最新/);
  assert.match(notice.textContent, /完全URL/);
  assert.match(notice.textContent, /QR/);
  assert.match(notice.textContent, /再起動/);
  assert.match(notice.textContent, /ブラウザ/);
  assert.match(notice.textContent, /下書き/);
  assert.match(notice.textContent, /コピー/);
  assert.match(notice.textContent, /タブ/);
  assert.doesNotMatch(ui.element("connection").textContent, /接続済み|再接続中/);
}

test("an initial HTTP 401 explains how to obtain a fresh link without erasing stored drafts", async () => {
  const state = stateFor();
  const storage = new MemoryStorage();
  const prior = await loadDashboard({ state, storage });
  await prior.input("認証を回復するまで保持する下書き");
  const draftKey = "rdsh_project_drafts_v1:" + state.project.id;
  const saved = storage.getItem(draftKey);
  const ui = await loadDashboard({
    state, storage, hash: "", readConfig: async () => denied(),
  });
  assertRecoveryNotice(ui);
  assert.ok(ui.element("title").textContent.trim());
  assert.doesNotMatch(ui.element("title").textContent, /読み込み中/);
  assert.equal(storage.getItem(draftKey), saved);
  assert.deepEqual(ui.requests.map(({ route }) => route), ["config"]);
  assert.equal(ui.answers().length, 0);
  assert.equal(ui.requests[0].headers["x-rdsh-browser-token"], "test-browser-token");

  const recovered = await loadDashboard({ state, storage, hash: "#key=fresh-synthetic-key" });
  assert.equal(recovered.element("auth-notice").hidden, true);
  assert.equal(recovered.textarea().value, "認証を回復するまで保持する下書き");
  assert.equal(recovered.answers().length, 0);
  assert.ok(recovered.requests.every(({ headers }) =>
    headers["x-rdsh-browser-token"] === "fresh-synthetic-key"));
});

test("a state HTTP 401 after startup retains the project and unsent answer across SSE errors", async () => {
  const state = stateFor();
  let expired = false;
  const ui = await loadDashboard({ state, readState: async () => expired ? denied() : state });
  await ui.input("切断後も残す日本語の回答");
  const title = ui.element("title").textContent;
  expired = true;
  await ui.changed();
  assertRecoveryNotice(ui);
  assert.equal(ui.element("title").textContent, title);
  assert.equal(ui.textarea().value, "切断後も残す日本語の回答");
  await ui.streamError();
  assertRecoveryNotice(ui);
  assert.equal(ui.textarea().value, "切断後も残す日本語の回答");
  assert.equal(ui.answers().length, 0);
});

test("an event-stream failure checks authentication without requiring a manual reload", async () => {
  const state = stateFor();
  let expired = false;
  const ui = await loadDashboard({ state, readState: async () => expired ? denied() : state });
  await ui.input("再読み込みせず保持する下書き");
  expired = true;
  await ui.streamError();
  assertRecoveryNotice(ui);
  assert.equal(ui.textarea().value, "再読み込みせず保持する下書き");
  assert.equal(ui.answers().length, 0);
});

test("a reachable state API does not claim that a disconnected event stream has recovered", async () => {
  const ui = await loadDashboard();
  await ui.streamError();
  assert.equal(ui.element("auth-notice").hidden, true);
  assert.match(ui.element("connection").textContent, /再接続中/);
  await ui.changed();
  assert.match(ui.element("connection").textContent, /再接続中/);
  await ui.streamOpen();
  assert.match(ui.element("connection").textContent, /接続済み/);
});

test("an answer HTTP 401 preserves the uncertain draft and never retries the answer automatically", async () => {
  const state = stateFor();
  let expired = false;
  const ui = await loadDashboard({
    state, readState: async () => expired ? denied() : state,
    postAnswer: async () => { expired = true; return denied(); },
  });
  await ui.input("回答時の認証切れでも失わない本文");
  await ui.submit();
  assertRecoveryNotice(ui);
  assert.equal(ui.textarea().value, "回答時の認証切れでも失わない本文");
  assert.equal(state.questions[0].answer, null);
  assert.equal(ui.button().disabled, true);
  await ui.changed();
  await ui.streamError();
  assert.equal(ui.answers().length, 1);
  assertRecoveryNotice(ui);
});

test("a share refresh HTTP 401 removes obsolete QR details and gives a fresh-link instruction", async () => {
  const state = stateFor();
  const ui = await loadDashboard({
    state, readConfig: async () => configFor(state, true),
    refreshShare: async () => denied(),
  });
  assert.equal(ui.element("qr").hidden, false);
  await ui.input("共有更新前から入力していた本文");
  await ui.element("share-refresh").click();
  assertRecoveryNotice(ui);
  assert.equal(ui.element("qr").hidden, true);
  assert.ok(ui.element("share-url").hidden || !ui.element("share-url").textContent,
    "the stale sharing address must not be offered as recovery");
  assert.equal(ui.element("share-refresh").disabled, true);
  assert.equal(ui.textarea().value, "共有更新前から入力していた本文");
  assert.equal(ui.answers().length, 0);
});

test("a QR HTTP 401 uses the same recovery guidance instead of only a QR-download error", async () => {
  const state = stateFor();
  const ui = await loadDashboard({
    state, readConfig: async () => configFor(state, true), readQr: async () => denied(),
  });
  assertRecoveryNotice(ui);
  assert.equal(ui.element("qr").hidden, true);
  assert.equal(ui.answers().length, 0);
});

test("a diagnostics HTTP 401 keeps the current project and draft while showing the same recovery notice", async () => {
  const ui = await loadDashboard({ readDiagnostics: async () => denied() });
  await ui.input("接続診断中にも残す回答");
  await ui.element("diagnostics-refresh").click();
  assertRecoveryNotice(ui);
  assert.equal(ui.textarea().value, "接続診断中にも残す回答");
  assert.match(ui.element("overview-context").textContent, /project-alpha/);
  assert.match(ui.element("diagnostics-status").textContent, /診断を取得できません/);
  assert.equal(ui.answers().length, 0);
});

for (const [name, fail] of [
  ["HTTP 403", () => denied(403, "Forbidden")],
  ["HTTP 500", () => denied(500, "Server failure")],
  ["network disconnection", () => { throw new Error("Network unavailable"); }],
]) {
  test(`${name} does not claim that browser credentials expired`, async () => {
    const ui = await loadDashboard({ readConfig: async () => fail() });
    const notice = ui.element("auth-notice");
    assert.ok(!notice || notice.hidden);
    assert.doesNotMatch(ui.element("connection").textContent, /最新.*URL|接続し直/);
    assert.equal(ui.answers().length, 0);
  });
}
