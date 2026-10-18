import assert from 'node:assert/strict';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { summarizeJournals } from './deepinfra-burst-journal.mjs';

function journal(t, tail = '') {
  const dir = mkdtempSync(join(tmpdir(), 'rdsh-journal-'));
  const path = join(dir, '0.jsonl');
  t.after(() => { unlinkSync(path); rmdirSync(dir); });
  writeFileSync(path, [
    { type: 'header', model: 'test/model', count: 3 },
    { type: 'start', id: 0, started: 10 },
    { type: 'start', id: 1, started: 11 },
    { type: 'result', id: 0, started: 10, ended: 20, outcome: 'http200', costUsd: 0.001 },
  ].map((item) => JSON.stringify(item) + '\n').join('') + tail);
  return { journalDir: dir, plans: [{ model: 'test/model', count: 3, reserveUsd: 0.01 }] };
}

test('stopped worker retains cost and distinguishes interrupted from unstarted', (t) => {
  const result = summarizeJournals(journal(t), [], { workersStopped: true });
  assert.equal(result.http200, 1);
  assert.equal(result.knownCostUsd, 0.001);
  assert.equal(result.interruptedUnknown, 1);
  assert.equal(result.notStarted, 1);
  assert.equal(result.unknownReserveUsd, 0.01);
});

test('torn journal tail does not turn missing requests into safe no-sends', (t) => {
  const result = summarizeJournals(journal(t, '{"type":"start"'), [], { workersStopped: true });
  assert.equal(result.http200, 1);
  assert.equal(result.interruptedUnknown, 2);
  assert.equal(result.notStarted, 0);
  assert.equal(result.unknownReserveUsd, 0.02);
  assert.equal(result.byModel['test/model'].journalComplete, false);
});

test('offline snapshot does not assume workers have stopped', (t) => {
  const result = summarizeJournals(journal(t));
  assert.equal(result.interruptedUnknown, 2);
  assert.equal(result.notStarted, 0);
});
