import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readRoute, writeRoute, entries } from '../route.js';

// Mirrors the shape a profile gets once an agent preset is customized: the
// delegation tools live inside the preset's plugins list, not at the top level.
const NESTED = [
  '- id: preset-standard',
  "  name: '@deepseek-ai/dsh-agent-preset'",
  '  config:',
  '    id: standard',
  '    plugins:',
  '      - id: delegation',
  '        name: cordis:group',
  '        config:',
  '          - id: tool-subagent',
  "            name: '@deepseek-ai/dsh-tool-subagent'",
  '            config:',
  '              provider: spawn',
  '              toolName: subagent',
  '              modelSelectionSettings: true',
  '          - id: tool-subagent-fork',
  "            name: '@deepseek-ai/dsh-tool-subagent'",
  '            config:',
  '              provider: fork',
  '              toolName: subagent_fork',
  '',
].join('\n');

const TOP = [
  '- id: tool-subagent',
  "  name: '@deepseek-ai/dsh-tool-subagent'",
  '  config:',
  '    provider: spawn',
  '    toolName: subagent',
  '',
].join('\n');

const ROUTE = { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' };

test('finds both the nested and the top-level delegation entry', () => {
  assert.equal(entries(NESTED.split('\n')).length, 1);
  assert.equal(entries(TOP.split('\n')).length, 1);
});

test('a profile without a pin reads as nothing', () => {
  assert.equal(readRoute(NESTED), null);
  assert.equal(readRoute(''), null);
});

test('writes into the nested entry without touching anything else', () => {
  const out = writeRoute(NESTED, ROUTE);
  assert.deepEqual(readRoute(out), ROUTE);
  assert.equal(out.startsWith(NESTED.split('\n').slice(0, 11).join('\n')), true);
  // The sibling fork tool keeps its own config.
  assert.match(out, /- id: tool-subagent-fork[\s\S]*provider: fork/);
  // One blank line plus the inserted block; nothing else moved.
  assert.equal(out.split('\n').length, NESTED.split('\n').length + 4);
});

test('writes into a top-level entry too', () => {
  const out = writeRoute(TOP, { model: 'only-a-model' });
  assert.deepEqual(readRoute(out), { model: 'only-a-model' });
});

test('rewriting is idempotent and replaces the previous pin', () => {
  const once = writeRoute(NESTED, ROUTE);
  assert.equal(writeRoute(once, ROUTE), once);
  const twice = writeRoute(once, { model: 'next-model' });
  assert.deepEqual(readRoute(twice), { model: 'next-model' });
  assert.equal((twice.match(/agentOptions:/g) || []).length, 1);
});

test('clearing removes the pin and leaves the rest intact', () => {
  const pinned = writeRoute(NESTED, ROUTE);
  const cleared = writeRoute(pinned, null);
  assert.equal(readRoute(cleared), null);
  assert.equal(cleared.includes('agentOptions'), false);
  assert.equal(writeRoute(cleared, null), cleared);
  assert.match(cleared, /modelSelectionSettings: true/);
});

test('a patch without a delegation entry is left alone', () => {
  const other = ['- id: llm-pi-ai', '  config:', '    providers: {}', ''].join('\n');
  assert.equal(writeRoute(other, ROUTE), other);
  assert.equal(readRoute(other), null);
  assert.equal(writeRoute(other, null), other);
});

test('the route editor survives the real profile patch', t => {
  const path = process.env.RDSH_PROFILE_PATCH;
  if (!path) {
    t.skip('set RDSH_PROFILE_PATCH to a profile cordis.patch.yml');
    return;
  }
  const before = readFileSync(path, 'utf8');
  const pinned = writeRoute(before, ROUTE);
  assert.deepEqual(readRoute(pinned), ROUTE);
  assert.equal(writeRoute(writeRoute(pinned, null), null), writeRoute(pinned, null));
});



