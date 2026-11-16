import assert from 'node:assert/strict';
import test from 'node:test';
import { replaceInstruction, splitConfig, withInstructions } from '../engine.mjs';

const UPSTREAM_INSTRUCTION = 'UPSTREAM INSTRUCTION';

// Mimics the documented upstream contract: replay the history, append one
// user text message with the instruction, and call ctx.llm.stream once.
class FakeBase {
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.received = config;
    this.kept = 'own-state';
  }

  async summarize(input, _agent, _signal) {
    const options = {
      provider: 'prov',
      model: 'mod',
      purpose: 'compaction',
      maxTokens: 1000,
      messages: [
        ...input.messages,
        Object.freeze({ role: 'user', content: [{ type: 'text', text: UPSTREAM_INSTRUCTION }] }),
      ],
    };
    const chunks = [];
    for await (const chunk of this.ctx.llm.stream(options)) chunks.push(chunk);
    return { chunks, kept: this.kept };
  }
}

function fakeContext() {
  const seen = [];
  const llm = {
    label: 'real-llm',
    async *stream(options) {
      seen.push(options);
      yield { type: 'text-delta', index: 0, text: 'SUMMARY' };
    },
  };
  return { ctx: { llm, logger: { info() {} } }, llm, seen };
}

const history = [
  Object.freeze({ role: 'system', content: [{ type: 'text', text: 'system prompt' }] }),
  Object.freeze({ role: 'user', content: [{ type: 'text', text: 'hello' }] }),
];

test('without instructions the upstream request is left untouched', async () => {
  const { ctx, seen } = fakeContext();
  const Engine = withInstructions(FakeBase);
  const engine = new Engine(ctx, { auto: false });
  const result = await engine.summarize({ messages: history }, {}, undefined);
  assert.deepEqual(engine.received, { auto: false });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].messages.at(-1).content[0].text, UPSTREAM_INSTRUCTION);
  assert.deepEqual(result.chunks, [{ type: 'text-delta', index: 0, text: 'SUMMARY' }]);
});

test('instructions replace only the final message', async () => {
  const { ctx, llm, seen } = fakeContext();
  const original = llm.stream;
  const Engine = withInstructions(FakeBase);
  const engine = new Engine(ctx, { auto: false, instructions: 'Keep file paths.' });
  const result = await engine.summarize({ messages: history }, {}, undefined);

  // The option never reaches the upstream constructor, which rejects unknown keys.
  assert.deepEqual(engine.received, { auto: false });

  const sent = seen[0];
  assert.equal(sent.messages.length, history.length + 1);
  assert.equal(sent.messages[0], history[0]);
  assert.equal(sent.messages[1], history[1]);
  assert.deepEqual(sent.messages.at(-1), {
    role: 'user',
    content: [{ type: 'text', text: 'Keep file paths.' }],
  });
  assert.equal(sent.provider, 'prov');
  assert.equal(sent.model, 'mod');
  assert.equal(sent.purpose, 'compaction');
  assert.equal(sent.maxTokens, 1000);

  // Upstream still runs on the engine's own state and returns its own result.
  assert.equal(result.kept, 'own-state');
  assert.deepEqual(result.chunks, [{ type: 'text-delta', index: 0, text: 'SUMMARY' }]);

  // The shared llm service is not patched.
  assert.equal(llm.stream, original);
  assert.equal(ctx.llm, llm);
});

test('a request without an appended instruction is refused, not overwritten', async () => {
  // If upstream ever stops appending its instruction, the final message is the
  // user's own last message. It must not be replaced.
  class ChangedBase extends FakeBase {
    async summarize(input) {
      const options = { purpose: 'compaction', messages: [...input.messages] };
      for await (const _chunk of this.ctx.llm.stream(options)) {
        // never reached
      }
      return {};
    }
  }
  const { ctx, seen } = fakeContext();
  const Engine = withInstructions(ChangedBase);
  const engine = new Engine(ctx, { instructions: 'Keep file paths.' });
  await assert.rejects(engine.summarize({ messages: history }, {}, undefined), {
    code: 'RDSH_COMPACTION_SHAPE',
  });
  assert.equal(seen.length, 0);
});

test('replaceInstruction only touches the appended compaction instruction', () => {
  const instruction = { role: 'user', content: [{ type: 'text', text: UPSTREAM_INSTRUCTION }] };
  const request = { purpose: 'compaction', messages: [...history, instruction] };
  const refused = { code: 'RDSH_COMPACTION_SHAPE' };

  // Another purpose, a missing history, a rebuilt history, or extra messages.
  assert.throws(() => replaceInstruction({ ...request, purpose: 'chat' }, 'x', history), refused);
  assert.throws(() => replaceInstruction(request, 'x', undefined), refused);
  assert.throws(() => replaceInstruction(request, 'x', history.map((m) => ({ ...m }))), refused);
  assert.throws(() => replaceInstruction(request, 'x', history.slice(0, 1)), refused);
  assert.throws(
    () => replaceInstruction({ purpose: 'compaction', messages: [] }, 'x', []),
    refused,
  );

  const replaced = replaceInstruction(request, 'x', history);
  assert.equal(replaced.messages.at(-1).content[0].text, 'x');
  assert.equal(replaced.messages[0], history[0]);
  assert.equal(instruction.content[0].text, UPSTREAM_INSTRUCTION);
  assert.ok(Object.isFrozen(replaced.messages.at(-1)));
});

test('splitConfig separates the option and rejects blank text', () => {
  assert.deepEqual(splitConfig(undefined), { instructions: undefined, base: {} });
  assert.deepEqual(splitConfig({ auto: false, instructions: null }), {
    instructions: undefined,
    base: { auto: false },
  });
  assert.deepEqual(splitConfig({ thresholdRatio: 1, instructions: 'Keep file paths.' }), {
    instructions: 'Keep file paths.',
    base: { thresholdRatio: 1 },
  });
  assert.throws(() => splitConfig({ instructions: '  \n' }), TypeError);
  assert.throws(() => splitConfig({ instructions: 42 }), TypeError);
});
