import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { withInstructions } from '../engine.mjs';

// Runs against the real upstream backend when its entry file is given:
//   RDSH_DSH_COMPACTION_BASIC=/path/to/@deepseek-ai/dsh-compaction-basic/lib/index.js
// Skipped otherwise, so the suite stays green without a DSH install.
const upstreamPath = process.env.RDSH_DSH_COMPACTION_BASIC;

// The upstream engine is a Cordis service; build it without a Cordis context
// so the test exercises only `summarize` and the upstream summarizer.
function engineFor(Engine, llm, instructions) {
  const engine = Object.create(Engine.prototype);
  Object.defineProperty(engine, 'ctx', { value: { llm }, configurable: true });
  Object.defineProperty(engine, 'config', {
    configurable: true,
    value: {
      thresholdRatio: 0.8,
      headroomTokens: 65536,
      retainRatio: 0.16,
      summarizationProvider: '',
      summarizationModel: '',
      maxTokens: 4096,
      compactionRetries: 1,
      maxOverflowRetries: 1,
      modelPolicies: [],
      auto: false,
    },
  });
  engine.rdshInstructions = instructions;
  return engine;
}

function recordingLlm() {
  const seen = [];
  return {
    seen,
    async *stream(options) {
      seen.push(options);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'SUMMARY' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}

const agent = {
  options: { provider: 'prov', model: 'mod' },
  session: {
    id: 'session-1',
    requestHeader: () => ({ config: { provider: 'prov', model: 'mod' } }),
    toolHistory: () => [],
  },
};

const input = {
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'system prompt' }] },
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  ],
};

test(
  'the real upstream request differs only in the instruction',
  { skip: upstreamPath ? false : 'RDSH_DSH_COMPACTION_BASIC is not set' },
  async () => {
    const upstream = await import(pathToFileURL(upstreamPath).href);
    const Engine = withInstructions(upstream.default);

    const plain = recordingLlm();
    const plainResult = await engineFor(Engine, plain, undefined).summarize(input, agent);

    const custom = recordingLlm();
    const customResult = await engineFor(Engine, custom, 'Keep file paths.').summarize(
      input,
      agent,
    );

    assert.equal(plain.seen.length, 1);
    assert.equal(custom.seen.length, 1);
    const [before] = plain.seen;
    const [after] = custom.seen;

    // The upstream instruction is the final user message.
    const upstreamText = before.messages.at(-1).content[0].text;
    assert.match(upstreamText, /compaction engine/);

    // Everything except the final message is the same request.
    assert.deepEqual({ ...after, messages: undefined }, { ...before, messages: undefined });
    assert.equal(after.messages.length, before.messages.length);
    assert.deepEqual(after.messages.slice(0, -1), before.messages.slice(0, -1));
    assert.deepEqual(after.messages.at(-1), {
      ...before.messages.at(-1),
      content: [{ type: 'text', text: 'Keep file paths.' }],
    });
    assert.equal(after.purpose, 'compaction');

    // The upstream summarizer still turns the stream into its own result.
    assert.deepEqual(customResult, plainResult);
    assert.deepEqual(customResult.summary, [{ type: 'text', text: 'SUMMARY' }]);
    assert.equal(customResult.llmStreamCall, true);
  },
);
