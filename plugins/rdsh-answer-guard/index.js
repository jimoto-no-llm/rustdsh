// rdsh-answer-guard: turn a silent, reasoning-only completion back into a
// visible answer.
//
// Observed failure (2026-10-15, session-95eb2a07 in this workspace, 7 of 18
// turns on `opencode-go/deepseek-v4.1-flash` with reasoningEffort=high):
// the model ends the turn with its whole reply inside the reasoning channel.
// The assistant message then carries a `reasoning` block and no `text` block.
//
// DSH classifies that as a normal stop — `mapStopReason()` in
// `@deepseek-ai/dsh-llm-pi-ai` raises EMPTY_RESPONSE only when
// `message.content.length === 0`, and a reasoning block is content — so the
// built-in retry policy never fires and the turn closes as `completed`.
// The Web UI then folds that step as process: `hasAssistantReplyContent()`
// ignores reasoning and tool-call blocks, so the reader is shown no answer at
// all and the agent looks like it stopped responding.
//
// This guard cannot change the model, and it deliberately does not patch DSH
// internals. It watches committed session events, and when a turn is about to
// close with no reader-visible reply it steers one short reminder into
// `agent.inbox.next-step`, which the Agent Loop documents as the way to make a
// closing turn run another step. The model then restates its answer as text.
//
// Only reader-visible content and the turn number are inspected: no prompt,
// no model output, and no credential leaves this process.
//
// Feature switch lives in $DSH_HOME/rdsh.json (`features.answer_guard`).

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const name = "rdsh-answer-guard";

/** Producer label stamped on every reminder. Load-bearing: an unlabeled
 * context would render as a user prompt in derived history, and the client
 * only renders the `notice` form from a source that carries a summary. */
export const REMINDER_SOURCE_KIND = "rdsh-answer-guard";

/** One nudge per turn: enough to recover, bounded so a model that only ever
 * emits reasoning cannot be steered in a loop. */
export const DEFAULT_MAX_NUDGES = 1;

/** Shown on the collapsed notice row, so the reader can tell the answer is
 * late rather than missing. Human-facing, hence the session's language. */
export const REMINDER_SUMMARY = "本文なしの応答を検知したため、再出力を要求しました";

/** Model-facing instruction. English matches every other DSH reminder
 * (e.g. `dsh-repeat-tool-reminder`); the model still answers in the user's
 * language. It must not invite a re-run of the work already done. */
export const REMINDER_TEXT =
  "Your previous assistant message contained no visible text: it was about to end the turn with only reasoning, so the reader was shown no answer. Do not repeat tool calls or redo the work. Restate the answer you already reached as ordinary text, outside any reasoning block, now.";

// Feature switches live in $DSH_HOME/rdsh.json. An absent id (or a missing,
// unreadable or corrupt file) keeps the fallback; an explicit false disables
// the guard without subscribing or steering.
function featureEnabled(id, fallback, env = process.env) {
  try {
    const path = join(env.DSH_HOME || join(homedir(), ".dsh"), "rdsh.json");
    const value = JSON.parse(readFileSync(path, "utf8"))?.features?.[id];
    return typeof value === "boolean" ? value : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Whether one assistant message ends a turn with no reader-visible reply.
 *
 * Mirrors the client's `hasAssistantReplyContent()` for the text and reasoning
 * blocks, but additionally requires that no tool call was issued: a message
 * that still owes a tool result is not the silent case this guard recovers from
 * (the turn continues on its own).
 *
 * @param content - the assistant message's `content` array, as committed.
 * @returns true only for a reply the reader cannot see.
 */
export function isSilentReply(content) {
  if (!Array.isArray(content)) return false;
  let toolCall = false;
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    switch (block.type) {
      case "reasoning":
        break;
      case "tool-call":
        toolCall = true;
        break;
      case "text":
        if (typeof block.text === "string" && block.text.trim() !== "") return false;
        break;
      default:
        // Any other block kind is reader-visible per hasAssistantReplyContent.
        return false;
    }
  }
  return !toolCall;
}

/**
 * Build one reminder message shaped exactly like `createUserMessage()` would
 * produce it (fresh id, user role, notice source). Built locally on purpose:
 * a linked plugin cannot resolve `@deepseek-ai/dsh-llm` from its own path, so
 * the guard stays dependency-free.
 * @returns an immutable-enough pending user message for `agent.steer`.
 */
export function createReminder(summary = REMINDER_SUMMARY, text = REMINDER_TEXT) {
  return Object.freeze({
    id: randomUUID(),
    role: "user",
    content: Object.freeze([Object.freeze({ type: "text", text })]),
    source: Object.freeze({ kind: REMINDER_SOURCE_KIND, form: "notice", summary }),
  });
}

/**
 * The guard's decision core, detached from cordis so it can be tested alone.
 *
 * @param options - `maxNudges` (validated fail-loud) and an injectable
 *   `reminder` factory.
 * @returns `observe(session, event)` to fold committed events and
 *   `stopping({agent, turn, signal})` to decide one closing turn.
 */
export function createAnswerGuard({ maxNudges = DEFAULT_MAX_NUDGES, reminder = createReminder } = {}) {
  if (!Number.isInteger(maxNudges) || maxNudges < 0)
    throw new Error(`rdsh-answer-guard: maxNudges must be an integer >= 0, got ${maxNudges}`);
  // WeakMap keyed by the Session object: a disposed session takes its state
  // with it, and two sessions never share a turn number.
  const lastReply = new WeakMap();
  const nudged = new WeakMap();

  function observe(session, event) {
    if (event?.type !== "assistant/message") return;
    const data = event.data;
    if (data === null || typeof data !== "object") return;
    if (!Number.isInteger(data.turn)) return;
    // Keep the latest assistant message of the session; `stopping` only acts
    // when its turn is the turn that is closing.
    lastReply.set(session, { turn: data.turn, silent: isSilentReply(data.message?.content) });
  }

  function stopping({ agent, turn, signal } = {}) {
    if (signal?.aborted) return false;
    if (agent === null || typeof agent !== "object") return false;
    if (typeof agent.steer !== "function") return false;
    const session = agent.session;
    const reply = lastReply.get(session);
    // No assistant message this turn, or a visible one: nothing to recover.
    if (reply === undefined || reply.turn !== turn || !reply.silent) return false;
    const counts = nudged.get(session) ?? new Map();
    const used = counts.get(turn) ?? 0;
    if (used >= maxNudges) return false;
    counts.set(turn, used + 1);
    nudged.set(session, counts);
    agent.steer(reminder());
    return true;
  }

  return { observe, stopping };
}

/** Install the guard on this plugin's fiber. */
export function apply(ctx, config = {}) {
  if (!featureEnabled("answer_guard", true)) return;
  const guard = createAnswerGuard(config ?? {});
  ctx.on("session/event", (session, event) => guard.observe(session, event));
  // turn-stopping is a serial hook: a listener that steers makes the loop
  // re-read its inbox, and fresh steering runs another step.
  ctx.on("agent/turn-stopping", ({ agent, turn, signal }) => guard.stopping({ agent, turn, signal }));
}
