import { readFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { prepareDeepInfra, prepareOpenRouter } from './cloud-api-burst-transport.mjs';
import { classifyResponse } from './deepinfra-burst-transport.mjs';
import { readProviderKey } from './cloud-api-burst-plan.mjs';

const [manifestFile, indexText] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
const index = Number(indexText);
const plan = manifest.plans[index];
const key = readProviderKey(manifest.keyFiles[plan.provider], plan.provider);
const fd = openSync(`${manifest.journalDir}/${index}.jsonl`, 'wx');
const append = (item) => {
  const bytes = Buffer.from(`${JSON.stringify(item)}\n`);
  for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset);
};
append({ type: 'header', version: 1, model: plan.model, provider: plan.provider, count: plan.count });
let transport;
let running = false;
let finished = false;
let startTimer;
process.on('disconnect', () => {
  if (finished) return;
  clearTimeout(startTimer);
  transport?.close();
  if (!running) process.exit(1);
});
try {
  transport = plan.provider === 'openrouter' ? await prepareOpenRouter(plan.count) : await prepareDeepInfra(plan.count);
} catch {
  closeSync(fd);
  process.exit(1);
}
const body = JSON.stringify(plan.body);
let launched = false;
process.on('message', (message) => {
  if (message?.type === 'check') {
    process.send({ type: 'checked', ready: transport.ready() }); return;
  }
  if (message?.type !== 'start' || launched) return;
  launched = true;
  startTimer = setTimeout(async () => {
    running = true;
    const work = Array.from({ length: plan.count }, async (_, id) => {
      append({ type: 'start', id, started: Date.now() });
      const response = await transport.post({ key, body });
      append({ type: 'result', id, ...classifyResponse(response, plan.allowedModels, plan.provider) });
    });
    if (process.connected) process.send({ type: 'launched', count: work.length });
    const result = await Promise.allSettled(work);
    if (result.every((item) => item.status === 'fulfilled')) append({ type: 'done' });
    closeSync(fd);
    transport.close();
    finished = true;
    process.exitCode = result.some((item) => item.status === 'rejected') ? 1 : 0;
    if (process.connected) process.disconnect();
  }, Math.max(0, message.startAt - Date.now()));
});
if (process.connected) process.send({ type: 'ready', connections: transport.connectionCount });
