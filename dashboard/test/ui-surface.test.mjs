import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  presentSurface, applyUiAction, publicUiSurfaces, validateUiSurfaces, UiError,
} from "../ui/surface.mjs";
import { identity, ProjectStore } from "../state.mjs";

const state = () => ({ schema: 1, revision: 0, feedback: [] });
const choiceBlock = () => ({
  id: "pick", kind: "choice",
  data: { prompt: "次に行う操作", choices: [{ id: "fix", label: "修正する" }, { id: "log", label: "ログを見る" }] },
});
const chartBlock = () => ({
  id: "chart", kind: "chart.bar",
  data: { bars: [{ label: "成功", value: 12 }, { label: "失敗", value: 8 }, { label: "保留", value: null }], unit: "件" },
});
const present = (current, blocks, extra) =>
  presentSurface(current, Object.assign({ message_id: "m-1", blocks }, extra || {}));
const submit = (result, action, value, requestId) =>
  applyUiAction(result.state, {
    surface_id: result.surface_id, surface_revision: result.revision,
    block_id: action.block_id, action_id: action.action_id, value,
    action_request_id: requestId || "req-1",
  });
function withState() {
  const current = state();
  const result = present(current, [chartBlock(), choiceBlock()]);
  return { current, result: Object.assign({ state: current }, result) };
}

test("present issues a surface id, revision and server-owned action ids", () => {
  const { result } = withState();
  assert.match(result.surface_id, /^srf_/);
  assert.equal(result.revision, 1);
  assert.equal(result.block_count, 2);
  assert.deepEqual(result.fallback, []);
  assert.deepEqual(result.actions, [{
    block_id: "pick", action_id: "pick:submit", kind: "submit_choice",
    label: "選択を送信", handling: "session",
  }]);
});

test("reusing a surface id bumps the revision and keeps the id", () => {
  const { current, result } = withState();
  const again = present(current, [chartBlock()], { message_id: "m-2", surface_id: result.surface_id });
  assert.equal(again.surface_id, result.surface_id);
  assert.equal(again.revision, 2);
  assert.equal(current.ui_surfaces.current.message_id, "m-2");
});

test("invalid blocks degrade to text and are reported to the agent", () => {
  const current = state();
  const result = presentSurface(current, {
    message_id: "m-1",
    blocks: [chartBlock(), { id: "bad", kind: "diagram.sankey", data: {} }, { id: "typed", kind: "text", data: { text: 7 } }],
  });
  assert.equal(result.block_count, 3);
  assert.equal(result.fallback.length, 2);
  assert.equal(result.fallback[0].kind, "diagram.sankey");
  assert.equal(current.ui_surfaces.current.blocks[1].kind, "text");
  assert.match(current.ui_surfaces.current.blocks[1].data.text, /文字表示/);
});

test("fallback surfaces with invalid metadata survive persistence validation", () => {
  const current = state();
  const result = present(current, [
    { id: "x".repeat(129), kind: "text", data: { text: "note" } },
    { id: "unknown", kind: "text", data: { text: "note" }, observation: { kind: "guessed" } },
    null,
    { kind: "text", data: { text: "missing id" } },
  ]);
  assert.equal(result.fallback.length, 4);
  assert.equal(new Set(current.ui_surfaces.current.blocks.map((block) => block.id)).size, 4);
  assert.doesNotThrow(() => validateUiSurfaces(JSON.parse(JSON.stringify(current))));
});

test("duplicate block ids cannot hide an action, including nested blocks", () => {
  for (const first of [
    { id: "pick", kind: "text", data: { text: "first" } },
    { id: "container", kind: "card", data: { blocks: [
      { id: "pick", kind: "text", data: { text: "nested" } },
    ] } },
  ]) {
    const current = state();
    assert.throws(() => present(current, [first, choiceBlock()]), /ui_duplicate_block/);
    assert.equal(current.ui_surfaces, undefined);
    assert.equal(current.feedback.length, 0);
  }
  const current = state();
  present(current, [chartBlock()]);
  current.ui_surfaces.current.blocks.push(structuredClone(current.ui_surfaces.current.blocks[0]));
  assert.throws(() => validateUiSurfaces(current), /ui_invalid_store/);
});

test("invalid entries still count toward the surface block limit", () => {
  assert.throws(() => present(state(), Array(201).fill(null)), /ui_too_many_blocks/);
});

test("an action returns to the same session as feedback without authority", () => {
  const { current, result } = withState();
  const recorded = submit(result, result.actions[0], { choice_id: "fix" }, "req-1");
  assert.equal(recorded.accepted, true);
  assert.equal(recorded.sequence, 1);
  assert.equal(recorded.execution_authorized, false);
  assert.equal(recorded.delivered_to_session, true);
  assert.equal(recorded.handling, "session");
  assert.deepEqual(recorded.value, { choice_id: "fix" });
  assert.equal(current.feedback.length, 1);
  const message = current.feedback[0];
  assert.equal(message.type, "ui_action");
  assert.equal(message.action_id, "pick:submit");
  assert.equal(message.surface_id, result.surface_id);
  assert.equal(message.execution_authorized, false);
  assert.match(message.label, /選択を送信/);
});

test("request-type actions are recorded as requests only", () => {
  const current = state();
  const result = presentSurface(current, {
    message_id: "m-1",
    blocks: [{ id: "run", kind: "button", data: { label: "テストを実行" },
      actions: [{ id: "run:go", kind: "request_tool", label: "テストを実行" }] }],
  });
  const recorded = submit(Object.assign({ state: current }, result), result.actions[0], null, "req-run");
  assert.equal(recorded.handling, "request");
  assert.equal(recorded.followup_required, true);
  assert.equal(recorded.execution_authorized, false);
  assert.match(recorded.note, /実行は別の認可された経路/);
});

test("stale revisions, unknown actions and foreign surfaces are refused", () => {
  const { current, result } = withState();
  const action = result.actions[0];
  const attempt = (patch) => () => applyUiAction(current, Object.assign({
    surface_id: result.surface_id, surface_revision: result.revision,
    block_id: action.block_id, action_id: action.action_id,
    value: { choice_id: "fix" }, action_request_id: "req-x",
  }, patch));
  assert.throws(attempt({ surface_revision: 99 }), (error) => error instanceof UiError && error.code === "ui_action_stale" && error.status === 409);
  assert.throws(attempt({ action_id: "nope" }), /ui_action_unknown/);
  assert.throws(attempt({ surface_id: "srf_other" }), /ui_surface_mismatch/);
  assert.throws(attempt({ action_id: "chart:submit" }), /ui_action_unknown/);
  present(current, [chartBlock()], { message_id: "m-9", surface_id: result.surface_id });
  assert.throws(attempt({}), /ui_action_stale/);
  assert.equal(current.feedback.length, 0);
});

test("replays are idempotent and one-shot actions refuse a second submit", () => {
  const { current, result } = withState();
  const action = result.actions[0];
  submit(result, action, { choice_id: "fix" }, "req-1");
  const replay = submit(result, action, { choice_id: "fix" }, "req-1");
  assert.equal(replay.replayed, true);
  assert.equal(current.feedback.length, 1);
  assert.throws(() => submit(result, action, { choice_id: "log" }, "req-2"), /ui_action_already_submitted/);
  assert.equal(current.feedback.length, 1);
});

test("choice ids and form values are validated", () => {
  const { current, result } = withState();
  assert.throws(() => submit(result, result.actions[0], { choice_id: "missing" }, "r1"), /ui_unknown_choice/);
  assert.throws(() => submit(result, result.actions[0], null, "r2"), /ui_value_required/);
  const formState = state();
  const form = presentSurface(formState, {
    message_id: "m-2",
    blocks: [{ id: "f", kind: "form", data: { fields: [{ id: "note", label: "メモ" }] } }],
  });
  const bad = () => applyUiAction(formState, {
    surface_id: form.surface_id, surface_revision: form.revision,
    block_id: "f", action_id: "f:submit", value: { note: 42 }, action_request_id: "r3",
  });
  assert.throws(bad, /ui_invalid_value/);
  const good = applyUiAction(formState, {
    surface_id: form.surface_id, surface_revision: form.revision,
    block_id: "f", action_id: "f:submit", value: { note: "再実行してください" }, action_request_id: "r4",
  });
  assert.deepEqual(good.value, { note: "再実行してください" });
});

test("public state exposes the surface but never authority", () => {
  const { current, result } = withState();
  submit(result, result.actions[0], { choice_id: "fix" }, "req-1");
  const visible = publicUiSurfaces(current);
  assert.equal(visible.current.surface_id, result.surface_id);
  assert.equal(visible.current.revision, 1);
  assert.equal(visible.current.blocks.length, 2);
  assert.equal(visible.actions.length, 1);
  assert.equal(visible.actions[0].execution_authorized, false);
  assert.equal(JSON.stringify(visible).includes("true,\"execution_authorized\""), false);
  assert.deepEqual(publicUiSurfaces({}), { schema: 1, current: null, actions: [] });
});

test("a damaged stored surface is rejected on load", () => {
  const current = state();
  present(current, [chartBlock()]);
  assert.doesNotThrow(() => validateUiSurfaces(current));
  current.ui_surfaces.current.blocks = [{ id: "x", kind: "diagram.sankey", data: {} }];
  assert.throws(() => validateUiSurfaces(current), /ui_invalid_store/);
  current.ui_surfaces.schema = 2;
  assert.throws(() => validateUiSurfaces(current), /ui_invalid_store/);
});

test("the store persists the surface and the returned action", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-ui-surface-"));
  const previousHome = process.env.RDSH_DASHBOARD_HOME;
  process.env.RDSH_DASHBOARD_HOME = path.join(root, "state");
  t.after(async () => {
    if (previousHome) process.env.RDSH_DASHBOARD_HOME = previousHome;
    else delete process.env.RDSH_DASHBOARD_HOME;
    await fs.rm(root, { recursive: true, force: true });
  });
  const cwd = path.join(root, "project");
  await fs.mkdir(cwd);
  const project = await identity(cwd);
  project.directory = path.join(root, "dashboard", "projects", project.id);
  const store = await ProjectStore.open(project);
  const presented = await store.mutateUiSurface({ message_id: "turn-1", blocks: [chartBlock(), choiceBlock()] });
  assert.equal(presented.revision, 1);
  const delivered = await store.mutateUiAction({
    surface_id: presented.surface_id, surface_revision: presented.revision,
    block_id: "pick", action_id: "pick:submit", value: { choice_id: "log" },
    action_request_id: "req-store-1",
  });
  assert.equal(delivered.delivered_to_session, true);
  const reopened = await ProjectStore.open(project);
  assert.equal(reopened.value.ui_surfaces.current.surface_id, presented.surface_id);
  assert.equal(reopened.value.ui_surfaces.current.blocks.length, 2);
  assert.equal(reopened.value.feedback.at(-1).type, "ui_action");
  assert.equal(reopened.value.feedback.at(-1).value.choice_id, "log");
  const visible = publicUiSurfaces(reopened.value);
  assert.equal(visible.current.revision, 1);
  await assert.rejects(
    () => reopened.mutateUiAction({
      surface_id: presented.surface_id, surface_revision: presented.revision,
      block_id: "pick", action_id: "pick:submit", value: { choice_id: "fix" },
      action_request_id: "req-store-2",
    }),
    /ui_action_already_submitted/,
  );
});
