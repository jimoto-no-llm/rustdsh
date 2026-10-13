// Synthetic JSON-RPC peer: it never loads DSH profiles or calls a model.
import { createInterface } from 'node:readline';
import { existsSync, writeFileSync } from 'node:fs';

const mode = process.env.RDSH_TEST_MODE;
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  let result;
  if (request.method === 'initialize') {
    if (mode === 'exit-once' && !existsSync(process.env.RDSH_TEST_MARKER)) {
      writeFileSync(process.env.RDSH_TEST_MARKER, 'first process exited'); process.exit(23);
    }
    if (mode === 'initialize-timeout') { setInterval(() => {}, 1000); continue; }
    result = { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.2.1-alpha.2' } };
  } else if (request.method === 'fixture/drop') process.exit(17);
  else if (request.method === 'fixture/timeout') continue;
  else if (request.method === 'fixture/hang') { setInterval(() => {}, 1000); continue; }
  else if (request.method === 'fixture/error') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'synthetic invalid request' } }) + '\n'); continue;
  } else if (request.method === 'session/working-directory/get') result = { cwd: process.cwd() };
  else if (request.method === 'fixture/echo') result = request.params;
  else if (request.method === 'shutdown') { if (mode === 'ignore-shutdown') continue; result = null; }
  else throw new Error('unknown fixture request');
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
}
