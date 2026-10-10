import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQaMatrix, classifyBrowserConsoleError, qaCases, renderQaMatrixHtml } from './qa-matrix.mjs';

const sha = 'a'.repeat(40);
const report = (qa_results, source_sha = sha) => ({
  source_sha,
  tested_at: '2026-10-10T00:00:00.000Z',
  result: 'PASS',
  environment: { platform: 'linux', browser: 'Chromium 140' },
  qa_results,
});
const result = (case_id, status, mode, source_sha = sha) => ({
  case_id, status, mode, source_sha, tested_at: '2026-10-10T00:00:00.000Z',
  evidence_ref: 'browser-results.json#qa_results',
});

test('matrix accepts only evidence with the current SHA and required evidence mode', () => {
  const matrix = buildQaMatrix(report([
    result('desktop.sse-draft', 'pass', 'browser'),
    result('desktop.double-submit', 'pass', 'fixture'),
    result('connection.tailscale', 'pass', 'browser'),
    result('desktop.answer-reload', 'pass', 'browser', 'b'.repeat(40)),
  ]));
  const byId = new Map(matrix.map((item) => [item.id, item]));
  assert.equal(byId.get('desktop.sse-draft').status, 'pass');
  assert.equal(byId.get('desktop.double-submit').status, 'not-run');
  assert.match(byId.get('desktop.double-submit').reason, /cannot establish browser coverage/);
  assert.equal(byId.get('connection.tailscale').status, 'not-run');
  assert.match(byId.get('connection.tailscale').reason, /No Tailscale connection test ran/);
  assert.equal(byId.get('desktop.answer-reload').status, 'not-run');
  assert.equal(byId.get('desktop.answer-reload').previous_result, 'pass');
  assert.match(byId.get('desktop.answer-reload').reason, /different .* source SHA/);
});

test('missing evidence stays not-run and HTML exposes an accessible not-run filter', () => {
  const matrix = buildQaMatrix(null);
  assert.equal(matrix.length, qaCases.length);
  assert.ok(matrix.every((item) => item.status === 'not-run'));
  const html = renderQaMatrixHtml(matrix, {});
  assert.match(html, /id="status-filter"/);
  assert.match(html, /未実施のみ/);
  assert.match(html, /Real Tailscale network/);
  assert.match(html, /viewport試験は実機スマホ/);
});

test('only the deliberate offline and dropped-response network errors are expected', () => {
  assert.equal(classifyBrowserConsoleError({
    case_id: 'desktop.offline-retry',
    path: '/api/update/answer',
    text: 'Failed to load resource: net::ERR_INTERNET_DISCONNECTED',
  }), 'expected');
  assert.equal(classifyBrowserConsoleError({
    case_id: 'desktop.lost-response',
    path: '/api/update/answer',
    text: 'Failed to load resource: net::ERR_FAILED',
  }), 'expected');
  assert.equal(classifyBrowserConsoleError({
    case_id: 'desktop.offline-retry',
    path: '/api/update/answer',
    text: 'TypeError: unexpected response',
  }), 'error');
  assert.equal(classifyBrowserConsoleError({
    case_id: null,
    path: '/api/state',
    text: 'Failed to load resource: net::ERR_INTERNET_DISCONNECTED',
  }), 'error');
});
