// Subprocess fixture: exercises stdio and shutdown without contacting a provider.
import { catalog } from './catalog.mjs';
let buffer = '', mode;
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) !== -1) {
    const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    if (value.type === 'cancel') {
      if (mode !== 'wedged') { emit({ type: 'error', code: 'ABORTED' }); process.stdin.destroy(); }
      continue;
    }
    mode = value.system;
    if (value.operation === 'list-models') { emit({ type: 'models', catalog: catalog(value.contributorMode) }); emit({ type: 'exit', kind: 'cleanShutdown' }); process.stdin.destroy(); continue; }
    if (['wait', 'wedged'].includes(mode)) { emit({ type: 'ready' }); continue; }
    if (mode === 'invalid') { process.stdout.write('not JSON\n'); process.stdin.destroy(); continue; }
    if (mode === 'secret-error') { emit({ type: 'error', code: 'unknown', message: 'SECRET-DIAGNOSTIC' }); process.stdin.destroy(); continue; }
    if (mode === 'duplicate') {
      const response = { type: 'response', response: { text: '42', toolCalls: [] } };
      emit(response); emit(response); process.stdin.destroy(); continue;
    }
    const toolCalls = mode === 'tool' ? [{ id: 'fixture_1', name: 'Bash', arguments: JSON.stringify({ command: 'printf 42' }) }] : [];
    emit({ type: 'response', response: { text: mode === 'inspect-mode' ? value.contributorMode : '日本語で42', toolCalls }, tokenUsage: mode === 'usage' ? { inputTokens: 10, outputTokens: 3 } : null });
    if (mode !== 'no-clean-exit') emit({ type: 'exit', kind: 'cleanShutdown' });
    process.stdin.destroy();
  }
});
process.stdin.on('end', () => { if (mode !== 'wedged') process.stdin.destroy(); });
// An uncooperative helper keeps a handle alive after its input closes.
const keepAlive = setInterval(() => { if (mode !== 'wedged') clearInterval(keepAlive); }, 20);
