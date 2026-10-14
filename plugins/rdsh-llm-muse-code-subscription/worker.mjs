import * as sdk from '@muse-code/sdk';
import { runMuse } from './muse.mjs';
import { BridgeError, MAX_BYTES } from './protocol.mjs';

const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
const controller = new AbortController();
let input = '', received = false, resolveRequest, rejectRequest;
const request = new Promise((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; });
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (Buffer.byteLength(input) > MAX_BYTES) { rejectRequest(new BridgeError('MUSE_INPUT_TOO_LARGE')); controller.abort(); return; }
  let end;
  while ((end = input.indexOf('\n')) !== -1) {
    const line = input.slice(0, end); input = input.slice(end + 1);
    try {
      const value = JSON.parse(line);
      if (!received) { received = true; resolveRequest(value); }
      else if (value.type === 'cancel') controller.abort();
      else controller.abort();
    } catch { rejectRequest(new BridgeError('MUSE_PROTOCOL_ERROR')); controller.abort(); }
  }
});
process.stdin.once('end', () => { rejectRequest(new BridgeError('ABORTED')); controller.abort(); });
process.on('SIGTERM', () => controller.abort());
process.stdout.on('error', () => controller.abort());
try {
  await runMuse(await request, { sdk, signal: controller.signal, emit });
} catch (error) {
  const failure = error instanceof BridgeError ? error : new BridgeError('MUSE_UNAVAILABLE');
  emit({ type: 'error', code: failure.code });
  process.exitCode = 1;
} finally { process.stdin.destroy(); }
