// E2E: prove `rdsh-answer-guard` recovers a reasoning-only turn on the REAL
// DeepSeek Harness AgentLoop.
//
// The whole point of this harness is that nothing about the loop is faked:
//
//   real cordis Context
//   real AgentRegistry / SessionStore / SessionProjectionRegistry
//   real SystemPrompt / ToolRuntime
//   real @deepseek-ai/dsh-llm LlmRuntime  (registerAdapter + `llm/stream` waterfall)
//   real @deepseek-ai/dsh-agent-loop AgentLoop, reached through agent.followup()
//
// Only the *provider* is local: a stub LlmAdapter yields hand-written chunks.
// It performs the exact failure shape from session-95eb2a07 turn 38 on the
// first call (one `reasoning` block, no `text`, no tool call), and an ordinary
// text answer on the second call. No network, no provider SDK, no model API.
//
// Usage:
//   RDSH_NATIVE_MODULES=<installed DSH node_modules> \
//     node tests/e2e/answer-guard-native.mjs
//
// Manual run only (like discord-native.mjs): it needs an installed DSH tree, so
// it is not part of the `npm test` chain in this directory.
// Exit code 0 only when every scenario's assertions hold.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// Default: the worktree under review. Override with RDSH_ANSWER_GUARD_PLUGIN to
// point the same harness at a different copy.
const PLUGIN = resolve(
  process.env.RDSH_ANSWER_GUARD_PLUGIN ??
    join(HERE, '../../plugins/rdsh-answer-guard/index.js'),
);
assert.ok(existsSync(PLUGIN), `rdsh-answer-guard plugin not found at ${PLUGIN}`);

// --- load the installed DSH as the launcher does -----------------------------
const modules = process.env.RDSH_NATIVE_MODULES;
assert.ok(
  modules,
  'Set RDSH_NATIVE_MODULES to the installed DSH node_modules (e.g. /home/ryu/.dsh/runtime/node_modules)',
);
const load = (name) =>
  import(pathToFileURL(join(modules, '@deepseek-ai', name, 'lib/index.js')).href);

const [
  { Context },
  { AgentRegistry },
  { SessionStore },
  { SessionProjectionRegistry },
  { SystemPrompt },
  { ToolRuntime },
  { LlmRuntime, LlmAdapter, createUserMessage },
  { AgentLoop },
] = await Promise.all(
  [
    'cordis',
    'dsh-agent',
    'dsh-session',
    'dsh-session-projection',
    'dsh-system-prompt',
    'dsh-tools',
    'dsh-llm',
    'dsh-agent-loop',
  ].map(load),
);

const { apply: applyAnswerGuard } = await import(pathToFileURL(PLUGIN).href);

// The exact contract the guard promises, pinned literally here so a mutated
// plugin cannot pass by being self-consistent with its own exported constants.
const EXPECTED_SOURCE_KIND = 'rdsh-answer-guard';
process.env.RDSH_LANG ??= 'ja';
const EXPECTED_SUMMARY = {
  en: 'A reply without visible text was detected; another output was requested',
  'zh-CN': '检测到没有正文的回复，已请求重新输出',
  ja: '本文なしの応答を検知したため、再出力を要求しました',
}[process.env.RDSH_LANG];
assert.ok(EXPECTED_SUMMARY, 'Use en, zh-CN or ja for this locale fixture');
const EXPECTED_TEXT_PREFIX =
  'Your previous assistant message contained no visible text:';

// --- the stub provider -------------------------------------------------------
const REASONING_ONLY_TEXT = 'securing the requirement list ... (this never reaches the reader)';
const VISIBLE_ANSWER = '要約: 対象は 3 ファイルです。';

/**
 * A provider-wire adapter that yields deterministic chunks. It is registered
 * through the real `LlmRuntime.registerAdapter()`, so the request takes the
 * genuine route: AgentLoop -> LlmRuntime.prepareCall -> `llm/stream` waterfall
 * -> adapterStream -> this generator.
 */
function makeStubAdapter(record) {
  return new (class StubAdapter extends LlmAdapter {
    providerInfo(provider) {
      return { id: provider, name: 'Answer Guard E2E stub' };
    }
    async *stream(options) {
      const call = {
        n: record.calls.length + 1,
        provider: options.provider,
        model: options.model,
        // The messages the loop actually assembled for this attempt.
        sources: options.messages.map((m) => m.source?.kind ?? m.role),
        guardNoticeInRequest: options.messages.some(
          (m) => m.source?.kind === 'rdsh-answer-guard',
        ),
      };
      record.calls.push(call);
      if (call.n === 1) {
        yield { type: 'block-start', index: 0, blockType: 'reasoning' };
        yield { type: 'reasoning-delta', index: 0, text: REASONING_ONLY_TEXT };
        yield {
          type: 'block-end',
          index: 0,
          block: { type: 'reasoning', text: REASONING_ONLY_TEXT },
        };
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: VISIBLE_ANSWER };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: VISIBLE_ANSWER } };
      }
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  })();
}

// --- one scenario ------------------------------------------------------------
/**
 * Build a complete, isolated DSH runtime and run exactly one user prompt
 * through it.
 *
 * @param label - scenario name, used in the printed record.
 * @param options.withPlugin - call the guard's `apply(ctx, {})`.
 * @param options.answerGuardFeature - value written to `features.answer_guard`
 *   in the throwaway `$DSH_HOME/rdsh.json` (`undefined` writes no file).
 */
async function runScenario(label, { withPlugin, answerGuardFeature }) {
  // Throwaway DSH_HOME: the guard reads $DSH_HOME/rdsh.json for its feature
  // switch, and ~/.dsh must never be touched.
  const home = mkdtempSync(join(tmpdir(), `ag-e2e-${label}-`));
  mkdirSync(home, { recursive: true });
  if (answerGuardFeature !== undefined)
    writeFileSync(
      join(home, 'rdsh.json'),
      JSON.stringify({ features: { answer_guard: answerGuardFeature } }, null, 2) + '\n',
    );
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;

  const ctx = new Context();
  new AgentRegistry(ctx);
  new SessionStore(ctx);
  new SessionProjectionRegistry(ctx);
  new SystemPrompt(ctx, {});
  new ToolRuntime(ctx);
  const llm = new LlmRuntime(ctx);

  const record = { calls: [], waterfall: [], events: [], errors: [] };

  // Proof that the real waterfall middleware chain is traversed for every
  // request (this is the same seam @deepseek-ai/dsh-llm-retry and
  // plugins/rdsh-budget-guard hook). It observes and passes through.
  ctx.on('llm/stream', (options, next) => {
    record.waterfall.push({ provider: options.provider, model: options.model });
    return next();
  });

  llm.registerAdapter(['stub-provider'], makeStubAdapter(record));

  const loop = new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 10 });

  ctx.on('agent/error', ({ error }) => record.errors.push(String(error?.message ?? error)));
  ctx.on('session/event', (session, event) => {
    record.events.push({
      seq: event.seq,
      type: event.type,
      data: event.data,
    });
  });

  if (withPlugin) applyAnswerGuard(ctx, {});

  const agent = await loop.create(`ag-e2e-${label}`, {
    provider: 'stub-provider',
    model: 'stub-model',
  });
  agent.followup(
    createUserMessage({
      source: { kind: 'human' },
      content: [{ type: 'text', text: '一覧を要約して' }],
    }),
  );

  let timedOut = false;
  let watchdog;
  await Promise.race([
    agent.whenIdle(),
    new Promise((resolveTimeout) => {
      watchdog = setTimeout(() => {
        timedOut = true;
        resolveTimeout();
      }, 20000);
    }),
  ]);
  clearTimeout(watchdog);

  // Read the durable session log straight off the real Session object.
  const log = agent.session.snapshotEvents().map((event) => ({
    seq: event.seq,
    type: event.type,
    data: event.data,
  }));

  const assistantMessages = log.filter((e) => e.type === 'assistant/message');
  const guardSplices = log.filter(
    (e) =>
      e.type === 'agent/inbox/spliced' &&
      (e.data.inserted ?? []).some((m) => m.source?.kind === 'rdsh-answer-guard'),
  );
  const turnEnds = log.filter((e) => e.type === 'turn/end');

  const result = {
    label,
    dshHome: home,
    withPlugin,
    answerGuardFeature,
    modelCalls: record.calls.length,
    calls: record.calls.map((c) => ({
      n: c.n,
      guardNoticeInRequest: c.guardNoticeInRequest,
      sources: c.sources,
    })),
    waterfallTraversed: record.waterfall.length,
    assistantMessages: assistantMessages.map((e) => ({
      seq: e.seq,
      turn: e.data.turn,
      step: e.data.step,
      content: e.data.message.content,
    })),
    guardSplices: guardSplices.map((e) => ({
      seq: e.seq,
      target: e.data.target,
      inserted: e.data.inserted.map((m) => ({
        role: m.role,
        source: m.source,
        content: m.content,
      })),
    })),
    turnEnds: turnEnds.map((e) => ({ seq: e.seq, turn: e.data.turn, reason: e.data.reason })),
    eventTypes: log.map((e) => e.type),
    // The live `session/event` stream a Cordis listener sees must match the
    // durable log: that is the stream the guard folds in `guard.observe()`.
    liveEventTypesMatchLog: JSON.stringify(record.events.map((e) => e.type)) === JSON.stringify(log.map((e) => e.type)),
    errors: record.errors,
    timedOut,
  };

  await ctx.fiber.dispose();
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;

  return result;
}

// --- scenarios ---------------------------------------------------------------
const report = [];
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
  return condition;
}

// A) guard enabled: the reasoning-only turn must be recovered.
const enabled = await runScenario('enabled', { withPlugin: true, answerGuardFeature: undefined });
report.push(enabled);

check(
  enabled.modelCalls === 2,
  `(a) guard ON: expected 2 model calls, saw ${enabled.modelCalls}`,
);
check(
  enabled.assistantMessages.some((m) =>
    m.content.some((b) => b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== ''),
  ),
  '(b) guard ON: no assistant/message with a text block in the session log',
);
check(
  enabled.guardSplices.length === 1 &&
    enabled.guardSplices[0].target === 'next-step' &&
    enabled.guardSplices[0].inserted[0].source.kind === EXPECTED_SOURCE_KIND &&
    enabled.guardSplices[0].inserted[0].source.form === 'notice' &&
    enabled.guardSplices[0].inserted[0].source.summary === EXPECTED_SUMMARY &&
    enabled.guardSplices[0].inserted[0].content[0].text.startsWith(EXPECTED_TEXT_PREFIX),
  `(c) guard ON: expected exactly one rdsh-answer-guard notice splice into next-step, saw ${JSON.stringify(enabled.guardSplices)}`,
);
check(
  enabled.calls[1]?.guardNoticeInRequest === true,
  '(a) guard ON: the second model call did not carry the guard notice in its request messages',
);
check(
  enabled.assistantMessages.length === 2 &&
    enabled.assistantMessages[1].step === 2 &&
    enabled.assistantMessages[0].turn === enabled.assistantMessages[1].turn,
  `(a) guard ON: expected the second assistant message in step 2 of the same turn, saw ${JSON.stringify(enabled.assistantMessages.map((m) => [m.turn, m.step]))}`,
);
check(enabled.errors.length === 0, `guard ON: agent errors: ${enabled.errors.join('; ')}`);
check(!enabled.timedOut, 'guard ON: the agent never went idle (timeout)');
check(
  enabled.liveEventTypesMatchLog,
  'guard ON: the live session/event stream did not match the durable session log',
);

// B) control: identical runtime, plugin not applied.
const control = await runScenario('control', { withPlugin: false, answerGuardFeature: undefined });
report.push(control);

check(
  control.modelCalls === 1,
  `(control) expected exactly 1 model call without the guard, saw ${control.modelCalls}`,
);
check(control.guardSplices.length === 0, '(control) unexpected guard splice without the plugin');
check(
  !control.assistantMessages.some((m) => m.content.some((b) => b.type === 'text')),
  '(control) a text block appeared without the guard, so the failure was not reproduced',
);
check(!control.timedOut, 'control: the agent never went idle (timeout)');

// C) feature switch off in $DSH_HOME/rdsh.json.
const disabled = await runScenario('disabled', {
  withPlugin: true,
  answerGuardFeature: false,
});
report.push(disabled);

check(
  disabled.modelCalls === 1,
  `(features.answer_guard=false) expected exactly 1 model call, saw ${disabled.modelCalls}`,
);
check(
  disabled.guardSplices.length === 0,
  '(features.answer_guard=false) the guard steered even though it was disabled',
);
check(
  !disabled.assistantMessages.some((m) => m.content.some((b) => b.type === 'text')),
  '(features.answer_guard=false) a text block appeared, so the failure was not reproduced',
);

// D) feature switch explicitly on in $DSH_HOME/rdsh.json. This separates
//    "the guard read the throwaway DSH_HOME and honoured `false`" from
//    "the guard never read the file at all".
const explicitOn = await runScenario('explicit-on', {
  withPlugin: true,
  answerGuardFeature: true,
});
report.push(explicitOn);

check(
  explicitOn.modelCalls === 2,
  `(features.answer_guard=true) expected 2 model calls, saw ${explicitOn.modelCalls}`,
);
check(
  explicitOn.guardSplices.length === 1,
  '(features.answer_guard=true) expected exactly one guard splice',
);

// --- raw output --------------------------------------------------------------
const clean = (value) =>
  JSON.parse(
    JSON.stringify(value, (key, v) => (key === 'dshHome' ? '<tmp DSH_HOME>' : v)),
  );

console.log('=== SCENARIO RECORDS ===');
console.log(JSON.stringify(clean(report), null, 2));
console.log('=== VERDICT ===');
if (failures.length === 0) {
  console.log('PASS: all answer-guard E2E assertions held');
} else {
  for (const failure of failures) console.log('FAIL:', failure);
  process.exitCode = 1;
}

// Clean up the throwaway DSH_HOMEs (they live under the OS temp dir).
for (const scenario of report) {
  if (existsSync(scenario.dshHome)) rmSync(scenario.dshHome, { recursive: true, force: true });
}
