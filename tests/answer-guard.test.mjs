import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  apply,
  createAnswerGuard,
  createReminder,
  isSilentReply,
  DEFAULT_MAX_NUDGES,
  REMINDER_SOURCE_KIND,
} from '../plugins/rdsh-answer-guard/index.js';

// Feature switches live in $DSH_HOME/rdsh.json. Every switch test uses a
// hermetic temp home so the real ~/.dsh/rdsh.json never changes the result.
async function featureHome(t, features) {
  const home = await mkdtemp(join(tmpdir(), 'rdsh-answer-guard-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  });
  if (features !== undefined)
    await writeFile(join(home, 'rdsh.json'), typeof features === 'string' ? features : JSON.stringify({ features }));
  return home;
}

function fakeAgent() {
  const steered = [];
  const session = {};
  return { agent: { session, steer: (message) => steered.push(message) }, steered, session };
}

function assistantMessage(session, turn, content, guard) {
  guard.observe(session, { type: 'assistant/message', data: { turn, step: 1, message: { role: 'assistant', content } } });
}

// Minimal stand-in for the cordis event dispatcher. `serial()` in
// `@deepseek-ai/cordis/lib/index.js` (line 289) awaits each listener in
// registration order and stops at the first bail value; `isBailed` (line 219)
// bails unless the value is null, false or undefined. `dsh-agent-loop`
// (lib/index.js line 999) dispatches `agent/turn-stopping` through exactly this
// contract, so a listener that returns anything else swallows every listener
// registered after it.
function serialDispatch(listeners, payload) {
  for (const listener of listeners) {
    const result = listener(payload);
    if (result !== null && result !== false && result !== undefined) return result;
  }
  return undefined;
}

// Record every handler per event in registration order, like a real Context.
function listenerLog() {
  const listeners = new Map();
  return {
    ctx: {
      on: (event, handler) => listeners.set(event, [...(listeners.get(event) ?? []), handler]),
    },
    handlers: (event) => listeners.get(event) ?? [],
  };
}

// The exact shape recorded in session-95eb2a07 turn 38 on
// opencode-go/deepseek-v4.1-flash: one reasoning block, no text, stop=stop.
const REASONING_ONLY = [{ type: 'reasoning', text: 'Complete picture. Let me summarize for the user.' }];

test('isSilentReply: a reasoning-only reply is silent', () => {
  assert.equal(isSilentReply(REASONING_ONLY), true);
  assert.equal(isSilentReply([{ type: 'reasoning', text: '' }]), true);
  assert.equal(isSilentReply([]), true);
});

test('isSilentReply: any reader-visible block makes the reply visible', () => {
  assert.equal(isSilentReply([{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'こんにちは' }]), false);
  assert.equal(isSilentReply([{ type: 'text', text: 'answer' }]), false);
  // Whitespace-only text is invisible to the reader, exactly as the client sees it.
  assert.equal(isSilentReply([{ type: 'text', text: '  \n ' }]), true);
  // A pending tool call is not the silent case: the turn continues by itself.
  assert.equal(isSilentReply([{ type: 'reasoning', text: 'think' }, { type: 'tool-call', name: 'bash' }]), false);
  assert.equal(isSilentReply([{ type: 'tool-call', name: 'bash' }]), false);
  // Unknown block kinds are reader-visible per hasAssistantReplyContent.
  assert.equal(isSilentReply([{ type: 'image' }]), false);
});

test('isSilentReply: a malformed content array never reports silence', () => {
  assert.equal(isSilentReply(undefined), false);
  assert.equal(isSilentReply(null), false);
  assert.equal(isSilentReply('reasoning'), false);
  assert.equal(isSilentReply([null, 7]), true);
});

test('guard steers one notice when a turn closes with no visible text', () => {
  const guard = createAnswerGuard();
  const { agent, steered, session } = fakeAgent();
  assistantMessage(session, 38, REASONING_ONLY, guard);
  assert.equal(guard.stopping({ agent, turn: 38 }), true);
  assert.equal(steered.length, 1);
  const [message] = steered;
  assert.equal(message.role, 'user');
  assert.equal(message.source.kind, REMINDER_SOURCE_KIND);
  assert.equal(message.source.form, 'notice');
  assert.equal(typeof message.source.summary, 'string');
  assert.notEqual(message.source.summary, '');
  assert.equal(typeof message.id, 'string');
  assert.notEqual(message.id, '');
  assert.match(message.content[0].text, /no visible text/);
});

test('guard leaves a turn that produced visible text alone', () => {
  const guard = createAnswerGuard();
  const { agent, steered, session } = fakeAgent();
  assistantMessage(session, 1, [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'done' }], guard);
  assert.equal(guard.stopping({ agent, turn: 1 }), false);
  assert.equal(steered.length, 0);
});

test('guard leaves a turn whose last message owes a tool result alone', () => {
  const guard = createAnswerGuard();
  const { agent, steered, session } = fakeAgent();
  assistantMessage(session, 5, [{ type: 'tool-call', name: 'bash' }], guard);
  assert.equal(guard.stopping({ agent, turn: 5 }), false);
  assert.equal(steered.length, 0);
});

test('guard ignores a closing turn that has no assistant message', () => {
  const guard = createAnswerGuard();
  const { agent, steered, session } = fakeAgent();
  assistantMessage(session, 2, REASONING_ONLY, guard);
  // A later turn number cannot reuse the earlier silent reply.
  assert.equal(guard.stopping({ agent, turn: 3 }), false);
  assert.equal(steered.length, 0);
});

test('guard nudges a silent turn at most once', () => {
  const guard = createAnswerGuard();
  const { agent, steered, session } = fakeAgent();
  assistantMessage(session, 38, REASONING_ONLY, guard);
  assert.equal(guard.stopping({ agent, turn: 38 }), true);
  assert.equal(guard.stopping({ agent, turn: 38 }), false);
  assert.equal(guard.stopping({ agent, turn: 38 }), false);
  assert.equal(steered.length, DEFAULT_MAX_NUDGES);
});

test('guard recovers from a second silent turn after a visible one', () => {
  const guard = createAnswerGuard();
  const { agent, steered, session } = fakeAgent();
  assistantMessage(session, 38, REASONING_ONLY, guard);
  guard.stopping({ agent, turn: 38 });
  assistantMessage(session, 39, [{ type: 'text', text: 'answer' }], guard);
  assert.equal(guard.stopping({ agent, turn: 39 }), false);
  assistantMessage(session, 40, REASONING_ONLY, guard);
  assert.equal(guard.stopping({ agent, turn: 40 }), true);
  assert.equal(steered.length, 2);
});

test('guard keeps sessions apart', () => {
  const guard = createAnswerGuard();
  const first = fakeAgent();
  const second = fakeAgent();
  assistantMessage(first.session, 7, REASONING_ONLY, guard);
  assert.equal(guard.stopping({ agent: second.agent, turn: 7 }), false);
  assert.equal(second.steered.length, 0);
  assert.equal(guard.stopping({ agent: first.agent, turn: 7 }), true);
});

test('guard never steers an aborted turn or a foreign agent', () => {
  const guard = createAnswerGuard();
  const { agent, steered, session } = fakeAgent();
  assistantMessage(session, 4, REASONING_ONLY, guard);
  const controller = new AbortController();
  controller.abort();
  assert.equal(guard.stopping({ agent, turn: 4, signal: controller.signal }), false);
  assert.equal(guard.stopping({ agent: { session }, turn: 4 }), false);
  assert.equal(guard.stopping({ turn: 4 }), false);
  assert.equal(guard.stopping(), false);
  assert.equal(steered.length, 0);
});

test('guard honours a caller-supplied nudge budget and rejects a bad one', () => {
  const { agent, steered, session } = fakeAgent();
  const zero = createAnswerGuard({ maxNudges: 0 });
  assistantMessage(session, 1, REASONING_ONLY, zero);
  assert.equal(zero.stopping({ agent, turn: 1 }), false);
  assert.equal(steered.length, 0);

  const twice = createAnswerGuard({ maxNudges: 2, reminder: () => createReminder('summary', 'text') });
  assistantMessage(session, 1, REASONING_ONLY, twice);
  assert.equal(twice.stopping({ agent, turn: 1 }), true);
  assert.equal(twice.stopping({ agent, turn: 1 }), true);
  assert.equal(twice.stopping({ agent, turn: 1 }), false);
  assert.equal(steered.length, 2);

  assert.throws(() => createAnswerGuard({ maxNudges: -1 }), /maxNudges/);
  assert.throws(() => createAnswerGuard({ maxNudges: 1.5 }), /maxNudges/);
});

test('apply subscribes both hooks while the feature switch allows it', async (t) => {
  await featureHome(t, undefined);
  const listeners = new Map();
  const ctx = { on: (event, handler) => listeners.set(event, handler) };
  apply(ctx, {});
  assert.ok(listeners.has('session/event'));
  assert.ok(listeners.has('agent/turn-stopping'));

  const { agent, steered, session } = fakeAgent();
  listeners.get('session/event')(session, {
    type: 'assistant/message',
    data: { turn: 9, step: 1, message: { role: 'assistant', content: REASONING_ONLY } },
  });
  listeners.get('agent/turn-stopping')({ agent, turn: 9 });
  assert.equal(steered.length, 1);
});

test('apply subscribes nothing when features.answer_guard is false', async (t) => {
  await featureHome(t, { answer_guard: false });
  const listeners = new Map();
  apply({ on: (event, handler) => listeners.set(event, handler) }, {});
  assert.equal(listeners.size, 0);
});

test('apply subscribes when rdsh.json is missing or corrupt', async (t) => {
  await featureHome(t, undefined);
  const first = new Map();
  apply({ on: (event, handler) => first.set(event, handler) }, {});
  assert.ok(first.has('agent/turn-stopping'));
  await featureHome(t, '{ not json');
  const second = new Map();
  apply({ on: (event, handler) => second.set(event, handler) }, {});
  assert.ok(second.has('agent/turn-stopping'));
});

test('serialDispatch mirrors the cordis bail contract', () => {
  const hops = (value) => {
    const seen = [];
    serialDispatch([
      () => {
        seen.push('guard');
        return value;
      },
      () => {
        seen.push('later');
      },
    ]);
    return seen;
  };
  // null/false/undefined continue the chain; anything else, including 0 and '',
  // stops it before the next listener.
  assert.deepEqual(hops(null), ['guard', 'later']);
  assert.deepEqual(hops(false), ['guard', 'later']);
  assert.deepEqual(hops(undefined), ['guard', 'later']);
  assert.deepEqual(hops(true), ['guard']);
  assert.deepEqual(hops(0), ['guard']);
  assert.deepEqual(hops(''), ['guard']);
});

test('apply: a guard nudge leaves later turn-stopping listeners running', async (t) => {
  await featureHome(t, undefined);
  const { ctx, handlers } = listenerLog();
  apply(ctx, {});
  const later = [];
  // A block body: `Array#push` returns a length, which is itself a bail value.
  ctx.on('agent/turn-stopping', ({ turn }) => {
    later.push(turn);
  });

  const { agent, steered, session } = fakeAgent();
  handlers('session/event')[0](session, {
    type: 'assistant/message',
    data: { turn: 9, step: 1, message: { role: 'assistant', content: REASONING_ONLY } },
  });
  const result = serialDispatch(handlers('agent/turn-stopping'), { agent, turn: 9 });

  // The guard did steer this turn...
  assert.equal(steered.length, 1);
  // ...yet the listener registered after it still ran and the guard handed the
  // dispatcher no bail value.
  assert.deepEqual(later, [9]);
  assert.equal(result, undefined);
});

test('apply: a turn the guard leaves alone also leaves later listeners running', async (t) => {
  await featureHome(t, undefined);
  const cases = [
    {
      name: 'aborted signal',
      config: {},
      content: REASONING_ONLY,
      signal: () => {
        const controller = new AbortController();
        controller.abort();
        return controller.signal;
      },
    },
    { name: 'nudge budget exhausted', config: { maxNudges: 0 }, content: REASONING_ONLY },
    { name: 'visible reply', config: {}, content: [{ type: 'text', text: 'answer' }] },
  ];

  for (const { name, config, content, signal } of cases) {
    const { ctx, handlers } = listenerLog();
    apply(ctx, config);
    const later = [];
    ctx.on('agent/turn-stopping', ({ turn }) => {
      later.push(turn);
    });

    const { agent, steered, session } = fakeAgent();
    handlers('session/event')[0](session, {
      type: 'assistant/message',
      data: { turn: 5, step: 1, message: { role: 'assistant', content } },
    });
    const result = serialDispatch(handlers('agent/turn-stopping'), {
      agent,
      turn: 5,
      signal: signal?.(),
    });

    assert.equal(steered.length, 0, `${name}: the guard must not steer`);
    assert.deepEqual(later, [5], `${name}: the later listener must still run`);
    assert.equal(result, undefined, `${name}: nothing may bail the chain`);
  }
});
