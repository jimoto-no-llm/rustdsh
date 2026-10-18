#!/usr/bin/env node
// One model, one process. Started by deepinfra-burst-10000.mjs over IPC.
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { createBurstTransport, classifyResponse } from './deepinfra-burst-transport.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => {
  if (i % 2 === 0) pairs.push([value, all[i + 1]]);
  return pairs;
}, []));
const model = args['--model'];
const count = Number(args['--count']);
const reserveUsd = Number(args['--reserve-usd']);
const keyFile = args['--key-file'];
const journalFile = args['--journal'];
const connectMs = Number(args['--connect-timeout-ms']);
const requestMs = Number(args['--request-timeout-ms']);
if (!model || !keyFile || !Number.isSafeInteger(count) || count < 1 || count > 200 ||
    !journalFile || !Number.isSafeInteger(connectMs) || connectMs < 1 ||
    !Number.isSafeInteger(requestMs) || requestMs < connectMs ||
    !Number.isFinite(reserveUsd) || reserveUsd < 0) throw new Error('Invalid burst worker arguments');
const line = readFileSync(keyFile, 'utf8').split(/\r?\n/)
  .find((item) => /^\s*DEEPINFRA_API_KEY=/.test(item));
const key = line?.split('=').slice(1).join('=').trim().replace(/^(['"])(.*)\1$/, '$2');
if (!key) throw new Error('DeepInfra key file is unavailable or empty');

const body = JSON.stringify({ model, messages: [{ role: 'user', content: '1' }],
  max_tokens: 1, temperature: 0 });
const fd = openSync(journalFile, 'wx');
function append(item) {
  const bytes = Buffer.from(`${JSON.stringify(item)}\n`);
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}
append({ type: 'header', version: 1, model, count });
const transport = createBurstTransport({ concurrency: count, connectMs, requestMs });
let launched = 0;

async function one(id) {
  const started = Date.now();
  // Persist intent BEFORE invoking the transport. A crash in the small gap remains
  // conservatively unknown, and is never grounds for automatic replay.
  append({ type: 'start', id, started });
  launched++;
  const response = await transport.post({ key, body });
  append({ type: 'result', id, ...classifyResponse(response, model) });
}

let started = false;
let startTimer;
let finished = false;
process.on('disconnect', () => {
  if (finished) return;
  clearTimeout(startTimer);
  transport.close();
  if (!started || launched === 0) { closeSync(fd); process.exit(1); }
});
process.on('message', (message) => {
  if (message?.type !== 'start' || started) return;
  started = true;
  startTimer = setTimeout(async () => {
    const requests = Array.from({ length: count }, (_, id) => one(id));
    if (process.connected) process.send({ type: 'launched', count: launched });
    const settled = await Promise.allSettled(requests);
    const failed = settled.some((item) => item.status === 'rejected');
    // Disk failures are not communication failures. Preserve the journal and exit
    // nonzero; the parent will classify every missing result as interrupted.
    if (!failed) append({ type: 'done', resourceUsage: process.resourceUsage() });
    closeSync(fd);
    transport.close();
    finished = true;
    process.exitCode = failed ? 1 : 0;
    if (process.connected) process.disconnect();
  }, Math.max(0, message.startAt - Date.now()));
});
process.send?.({ type: 'ready' });
