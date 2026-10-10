import test from "node:test";
import assert from "node:assert/strict";
import { deferred, loadDashboard, MemoryStorage, stateFor } from "./answer-dom.mjs";

test("typed answer survives a fresh document using the same tab storage", async () => {
  const storage = new MemoryStorage();
  const first = await loadDashboard({ storage });
  await first.input("未送信の回答\n条件を確認してから実行してください。");
  const reloaded = await loadDashboard({ storage });
  assert.equal(reloaded.textarea().value, "未送信の回答\n条件を確認してから実行してください。");
  assert.equal(reloaded.answers().length, 0);
});

test("a held answer remains locked after SSE redraw and repeated submit sends only once", async () => {
  const held = deferred();
  const state = stateFor();
  const ui = await loadDashboard({ state, postAnswer: () => held.promise });
  await ui.input("Answer exactly once");
  const firstSubmission = ui.submit();
  assert.equal(ui.answers().length, 1);
  assert.equal(ui.button().disabled, true);
  await ui.changed();
  const lockedAfterRefresh = ui.button().disabled;
  const secondSubmission = ui.submit();
  const requestCount = ui.answers().length;
  // POST /api/update/answer returns publicState after committing the answer.
  state.questions[0].answer = "Answer exactly once";
  state.revision++;
  held.resolve(state);
  await Promise.all([firstSubmission, secondSubmission]);
  assert.equal(requestCount, 1, "SSE redraw must not permit a second POST for the held answer");
  assert.equal(lockedAfterRefresh, true, "the replacement submit button must stay disabled");
  assert.ok(ui.form() === null);
});

test("drafts remain separate for each question and project, including the shared route", async () => {
  const storage = new MemoryStorage();
  const alpha = stateFor("alpha", ["Q1", "Q2"]);
  const first = await loadDashboard({ storage, state: alpha });
  await first.input("Alpha Q1", "Q1");
  await first.input("Alpha Q2", "Q2");
  const beta = await loadDashboard({ storage, state: stateFor("beta") });
  assert.equal(beta.textarea().value, "");
  await beta.input("Beta Q1");
  const returned = await loadDashboard({ storage, state: alpha, pathname: "/_rdsh/", hash: "" });
  assert.equal(returned.textarea("Q1").value, "Alpha Q1");
  assert.equal(returned.textarea("Q2").value, "Alpha Q2");
  const betaReloaded = await loadDashboard({ storage, state: stateFor("beta") });
  assert.equal(betaReloaded.textarea().value, "Beta Q1");
});

test("a failed POST reconciles state and keeps an editable draft for explicit retry", async () => {
  const state = stateFor();
  const ui = await loadDashboard({ state, postAnswer: async () => { throw new Error("Connection lost"); } });
  await ui.input("Keep me after a network failure");
  await ui.submit();
  assert.equal(ui.textarea().value, "Keep me after a network failure");
  assert.equal(ui.textarea().readOnly, false);
  assert.equal(ui.button().disabled, false);
  assert.equal(ui.answers().length, 1);
  assert.ok(ui.requests.filter((request) => request.route === "state").length >= 2,
    "a failed response must be reconciled with server state");
  await ui.changed();
  assert.equal(ui.textarea().value, "Keep me after a network failure");
  assert.equal(ui.answers().length, 1, "a state refresh must never retry the POST automatically");
  const reloaded = await loadDashboard({ state, storage: ui.storage });
  assert.equal(reloaded.textarea().value, "Keep me after a network failure");
});

test("a committed answer with a lost response is reconciled without sending again", async () => {
  const state = stateFor();
  const ui = await loadDashboard({
    state,
    postAnswer: async ({ id, answer }) => {
      state.questions.find((question) => question.id === id).answer = answer;
      state.revision++;
      throw new Error("Response lost after commit");
    },
  });
  await ui.input("Committed once");
  await ui.submit();
  assert.ok(ui.form() === null, "authoritative answered state removes the pending form");
  assert.match(ui.element("answers").textContent, /Committed once/);
  assert.equal(ui.answers().length, 1);
  const reloaded = await loadDashboard({ state, storage: ui.storage });
  assert.ok(reloaded.form() === null);
  assert.equal(reloaded.answers().length, 0);
  assert.ok(![...ui.storage.values.values()].some((value) => value.includes("Committed once")),
    "a confirmed answer must not remain in draft storage");
});

test("confirmation clears a submitted draft whose whitespace is preserved by the server", async () => {
  const ui = await loadDashboard();
  await ui.input("  Answer with intentional spacing\n");
  await ui.submit();
  assert.equal(ui.answers()[0].body.answer, "  Answer with intentional spacing\n");
  assert.ok(ui.form() === null);
  assert.equal(ui.element("retained-drafts").hidden, true,
    "the exact submitted answer must not be reported as a conflicting draft");
  assert.ok(![...ui.storage.values.values()].some((value) => value.includes("Answer with intentional spacing")));
});

test("storage denial does not prevent startup, SSE draft retention, or answering", async () => {
  const storage = {
    getItem() { throw new Error("Storage denied"); },
    setItem() { throw new Error("Storage denied"); },
    removeItem() { throw new Error("Storage denied"); },
  };
  const ui = await loadDashboard({ storage });
  assert.ok(ui.form(), "project questions must still render");
  await ui.input("In-memory answer");
  await ui.changed();
  assert.equal(ui.textarea().value, "In-memory answer");
  await ui.submit();
  assert.ok(ui.form() === null);
  assert.equal(ui.answers().length, 1);
});

test("an older overlapping state response cannot restore a question already answered", async () => {
  const initial = stateFor();
  const stale = structuredClone(initial);
  const answered = structuredClone(initial);
  answered.revision++;
  answered.questions[0].answer = "Answered elsewhere";
  const oldResponse = deferred();
  let reads = 0;
  const ui = await loadDashboard({
    state: initial,
    readState: async () => {
      reads++;
      if (reads === 1) return initial;
      if (reads === 2) return oldResponse.promise;
      return answered;
    },
  });
  await ui.input("Obsolete draft");
  const olderRefresh = ui.changed();
  await ui.changed();
  assert.ok(ui.form() === null);
  oldResponse.resolve(stale);
  await olderRefresh;
  assert.ok(ui.form() === null, "an older revision must not recreate an answered form");
  assert.match(ui.element("answers").textContent, /Answered elsewhere/);
  assert.equal(ui.answers().length, 0);
});

test("an uncertain answer stays locked until a separate state check confirms it was not saved", async () => {
  const state = stateFor();
  let offline = false;
  const ui = await loadDashboard({
    state,
    readState: async () => {
      if (offline) throw new Error("Offline while checking state");
      return state;
    },
    postAnswer: async () => {
      offline = true;
      throw new Error("Answer response lost");
    },
  });
  await ui.input("Do not blindly resend");
  await ui.submit();
  assert.equal(ui.button().disabled, true);
  await ui.submit();
  assert.equal(ui.answers().length, 1, "an uncertain outcome must not allow a duplicate POST");
  const check = ui.form().querySelectorAll("button")
    .find((button) => button.textContent.includes("送信結果を確認"));
  assert.ok(check, "the user must be able to request a state check without posting again");
  offline = false;
  await check.click();
  assert.equal(ui.answers().length, 1);
  assert.equal(ui.button().disabled, false);
  assert.equal(ui.textarea().readOnly, false);
  assert.equal(ui.textarea().value, "Do not blindly resend");
});

test("back-forward cache restoration checks server state and keeps an unsent draft", async () => {
  const ui = await loadDashboard();
  await ui.input("Draft before navigating away");
  const before = ui.requests.filter((request) => request.route === "state").length;
  await ui.window.dispatch("pageshow", { persisted: true });
  assert.ok(ui.requests.filter((request) => request.route === "state").length > before);
  assert.equal(ui.textarea().value, "Draft before navigating away");
  assert.equal(ui.answers().length, 0);
});

test("SSE redraw preserves the active answer's text selection", async () => {
  const ui = await loadDashboard();
  await ui.input("Answer under editing");
  ui.textarea().focus();
  ui.textarea().setSelectionRange(7, 12, "backward");
  await ui.changed();
  assert.ok(ui.document.activeElement === ui.textarea());
  assert.equal(ui.textarea().value, "Answer under editing");
  assert.equal(ui.textarea().selectionStart, 7);
  assert.equal(ui.textarea().selectionEnd, 12);
  assert.equal(ui.textarea().selectionDirection, "backward");
});

for (const [field, value] of [
  ["question", "A different question using the same id"],
  ["created_at", "2026-10-09T00:00:00.000Z"],
  ["default_action", "A changed default action"],
  ["answer", "Another person's answer"],
]) {
  test(`a changed ${field} preserves a copy without applying the old draft to the current question`, async () => {
    const state = stateFor();
    const ui = await loadDashboard({ state });
    const draft = "Original draft <img src=x onerror=alert(1)>";
    await ui.input(draft);
    state.questions[0][field] = value;
    state.revision++;
    await ui.changed();
    const current = ui.textarea();
    if (field === "answer") assert.ok(current === null);
    else assert.equal(current.value, "", "the changed question must start without the previous draft");
    assert.equal(ui.element("retained-drafts").hidden, false);
    const copy = ui.element("retained-draft-list").querySelector("textarea");
    assert.equal(copy.value, draft);
    assert.equal(copy.readOnly, true);
    assert.equal(ui.element("retained-draft-list").querySelectorAll("img").length, 0);
    assert.equal(ui.answers().length, 0);
    const reloaded = await loadDashboard({ state, storage: ui.storage });
    assert.equal(reloaded.element("retained-draft-list").querySelector("textarea").value, draft);
    if (field !== "answer") assert.equal(reloaded.textarea().value, "");
  });
}

test("explicitly discarding an active draft keeps it empty after reload", async () => {
  const ui = await loadDashboard();
  await ui.input("Discard this draft");
  await ui.form().querySelectorAll("button")
    .find((button) => button.textContent === "下書きを破棄").click();
  assert.equal(ui.textarea().value, "");
  const reloaded = await loadDashboard({ storage: ui.storage });
  assert.equal(reloaded.textarea().value, "");
  assert.equal(ui.answers().length, 0);
  assert.equal(reloaded.answers().length, 0);
});

test("explicitly discarding a retained copy removes it after reload", async () => {
  const state = stateFor();
  const ui = await loadDashboard({ state });
  await ui.input("Old copy to discard");
  state.questions[0].question = "Replacement question";
  state.revision++;
  await ui.changed();
  await ui.element("retained-draft-list").querySelector("button").click();
  assert.equal(ui.element("retained-drafts").hidden, true);
  const reloaded = await loadDashboard({ state, storage: ui.storage });
  assert.equal(reloaded.element("retained-drafts").hidden, true);
  assert.equal(reloaded.textarea().value, "");
  assert.equal(ui.answers().length, 0);
});

test("corrupted draft storage warns without overwriting the unreadable record", async () => {
  const storage = new MemoryStorage();
  const first = await loadDashboard({ storage });
  await first.input("Locate the persisted draft");
  const draftKey = [...storage.values].find(([, value]) => value.includes("Locate the persisted draft"))[0];
  storage.setItem(draftKey, "{incomplete JSON");
  const ui = await loadDashboard({ storage });
  assert.ok(ui.form());
  assert.match(ui.element("draft-storage-note").textContent, /保存できません/);
  await ui.input("New in-memory draft");
  await ui.changed();
  assert.equal(ui.textarea().value, "New in-memory draft");
  assert.equal(storage.getItem(draftKey), "{incomplete JSON");
  assert.equal(ui.answers().length, 0);
});

test("exhausted storage warns while retaining the latest in-memory draft", async () => {
  const storage = new MemoryStorage();
  const ui = await loadDashboard({ storage });
  await ui.input("Initially saved draft");
  storage.setItem = () => { throw new Error("Quota exceeded"); };
  await ui.input("Latest draft must remain available for copying");
  assert.match(ui.element("draft-storage-note").textContent, /保存できません/);
  await ui.changed();
  assert.equal(ui.textarea().value, "Latest draft must remain available for copying");
  assert.equal(ui.answers().length, 0);
});

test("a pending state read started before POST failure cannot release the uncertain-answer lock", async () => {
  const state = stateFor();
  const oldPending = deferred();
  const failedPost = deferred();
  let reads = 0;
  const ui = await loadDashboard({
    state,
    readState: async () => {
      reads++;
      if (reads === 1) return state;
      if (reads === 2) return oldPending.promise;
      throw new Error("Unable to check saved state");
    },
    postAnswer: () => failedPost.promise,
  });
  await ui.input("Do not resend based on an old read");
  const staleRefresh = ui.changed();
  const submission = ui.submit();
  failedPost.reject(new Error("POST response lost"));
  await submission;
  assert.equal(ui.button().disabled, true);
  oldPending.resolve(state);
  await staleRefresh;
  assert.equal(ui.button().disabled, true);
  assert.equal(ui.textarea().readOnly, true);
  await ui.submit();
  assert.equal(ui.answers().length, 1);
  assert.equal(ui.textarea().value, "Do not resend based on an old read");
});

test("a whitespace-only answer shows an accessible error without posting", async () => {
  const ui = await loadDashboard();
  await ui.input(" \t\n　");
  await ui.submit();
  const alert = ui.form().querySelectorAll("div")
    .find((element) => element.getAttribute("role") === "alert");
  assert.ok(alert, "invalid input must produce an accessible alert");
  assert.equal(alert.textContent, "空白以外の回答を入力してください。");
  assert.equal(ui.answers().length, 0);
  assert.equal(ui.button().disabled, false);
  assert.ok(ui.document.activeElement === ui.textarea());
});

test("SSE redraw preserves focus and selection while copying a retained draft", async () => {
  const state = stateFor();
  const ui = await loadDashboard({ state });
  await ui.input("Retained draft selected for copying");
  state.questions[0].answer = "Answered from another session";
  state.revision++;
  await ui.changed();
  const copy = ui.element("retained-draft-list").querySelector("textarea");
  copy.focus();
  copy.setSelectionRange(0, 14, "forward");
  await ui.changed();
  const refreshedCopy = ui.element("retained-draft-list").querySelector("textarea");
  assert.ok(ui.document.activeElement === refreshedCopy);
  assert.equal(refreshedCopy.value, "Retained draft selected for copying");
  assert.equal(refreshedCopy.readOnly, true);
  assert.equal(refreshedCopy.selectionStart, 0);
  assert.equal(refreshedCopy.selectionEnd, 14);
  assert.equal(refreshedCopy.selectionDirection, "forward");
  assert.equal(ui.answers().length, 0);
});
