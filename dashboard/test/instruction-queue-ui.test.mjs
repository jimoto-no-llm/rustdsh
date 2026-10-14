import test from "node:test";
import assert from "node:assert/strict";

import { execFileSync } from "node:child_process";

function detailNode(tag, value = "", className = "") {
  let ownText = value;
  const el = {
    tag,
    tagName: tag.toUpperCase(),
    className,
    dataset: {},
    attrs: {},
    children: [],
    events: {},
    value: "",
    append(...items) {
      this.children.push(...items);
    },
    replaceChildren(...items) {
      this.children = items;
      ownText = "";
    },
    setAttribute(key, value) {
      this.attrs[key] = value;
    },
    addEventListener(name, fn) {
      this.events[name] = fn;
    },
    focus() {},
    setSelectionRange() {},
    querySelectorAll(selector) {
      const matches = (item) =>
        selector === "[data-question]"
          ? Boolean(item.dataset.question)
          : selector === '[role="alert"]'
            ? item.attrs.role === "alert"
            : selector === 'input[type="radio"]:checked'
              ? item.tag === "input" && item.type === "radio" && item.checked
              : item.tag === selector;
      return this.children.flatMap((item) => [
        ...(matches(item) ? [item] : []),
        ...item.querySelectorAll(selector),
      ]);
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    get textContent() {
      return ownText + this.children.map((item) => item.textContent).join(" ");
    },
    set textContent(value) {
      ownText = value;
      this.children = [];
    },
  };
  return el;
}

for (const language of ["en", "zh-CN", "ja"])
  test(`instruction panel renders ${language} while preserving received values`, () => {
    const source = `
    import assert from "node:assert/strict";
    globalThis.document = { documentElement: { dataset: { rdshLocale: ${JSON.stringify(language)} } }, getElementById() { return null; }, activeElement: null };
    ${detailNode.toString()}
    const node = detailNode;
    const { text, formatDateTime, catalog } = await import(${JSON.stringify(new URL("../locale.mjs", import.meta.url).href)});

    const { createInstructionPanel } = await import(${JSON.stringify(new URL("../instruction-queue-ui.mjs", import.meta.url).href)});
    const store = new Map();
    globalThis.sessionStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) };
    const root = node("div");
    const received = [];
    let fail = false;
    const raw = " 原文 日本語 / 中文 · English {id} ";
    const consumer = { consumer_id: "consumer_日本語", task_id: "task_中文", run_id: "run_日本語", session_id: "session_中文" };
    const state = { project: { id: "project" }, input_queue_revision: 4, feedback: [], answer_applications: { consumers: { [consumer.consumer_id]: consumer }, commands: {} }, instructions: { requests: {}, commands: {} } };
    const render = createInstructionPanel(root, { node, refreshState: async () => {}, api: async (route, payload) => { received.push({ route, payload }); if (fail) throw new Error(raw); return { request: { status: "saved", command_id: payload.command_id } }; } });
    const phases = ["saved", "read", "started", "succeeded", "failed", "unknown", "unapplied", "future-phase"];
    for (const [index, phase] of phases.entries()) {
      const id = "cmd_" + index;
      state.instructions.requests[id] = { ...consumer, command_id: id, actor: "human", mode: "next_turn", effective_mode: "next_turn", text: raw, status: "saved", control: { target_command_id: "original", phase: ["confirmed", "not_needed", "pending"][index % 3] } };
      state.instructions.commands[id] = { command_id: id, source_kind: "instruction", consumer_id: consumer.consumer_id, phase, queue_sequence: index, saved_at: "2026-10-14T01:02:03Z", read_at: null, result_reason: index === 7 ? "future-result" : "native_prompt_completed", queue_blocker: { command_id: "previous", phase: ["unknown", "started", "saved"][index % 3] } };
    }
    state.instructions.requests.review = { ...consumer, command_id: "review", actor: "management_agent", mode: "interrupt", text: raw, status: "review_required" };
    state.instructions.requests.rejected = { ...consumer, command_id: "rejected", actor: "administrator", mode: "steer", text: raw, status: "rejected" };
    render(state);
    for (const phase of phases.slice(0, -1)) assert.ok(root.textContent.includes(text("queue.phase." + phase)), phase);
    for (const key of ["queue.submit", "queue.content", "queue.reviewPending", "queue.rejected", "queue.steerUnsupported", "queue.result.native_prompt_completed"]) assert.ok(root.textContent.includes(text(key)), key);
    assert.ok(root.textContent.includes(formatDateTime("2026-10-14T01:02:03Z")));
    assert.ok(root.textContent.includes("future-phase"));
    assert.ok(root.textContent.includes("future-result"));
    assert.ok(root.textContent.includes("run_日本語"));
    assert.ok(root.querySelectorAll("pre").every(pre => pre.textContent === raw));
    const area = root.querySelector("textarea");
    area.value = raw;
    area.events.input();
    await root.querySelector("form").onsubmit({ preventDefault() {} });
    assert.equal(received[0].route, "instructions/submit");
    assert.equal(received[0].payload.text, raw);
    assert.equal(received[0].payload.mode, "next_turn");
    assert.equal(received[0].payload.consumer_id, consumer.consumer_id);
    fail = true;
    area.value = raw;
    area.events.input();
    await root.querySelector("form").onsubmit({ preventDefault() {} });
    assert.equal(root.children[0].children.at(-1).textContent, text("queue.saveFailed", { error: raw }));
    assert.equal(received[1].payload.text, raw);

  `;
    execFileSync(process.execPath, ["--input-type=module", "-e", source], {
      encoding: "utf8",
    });
  });
