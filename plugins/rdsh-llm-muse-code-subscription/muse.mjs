import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeError, formatPrompt, parseReply, subscriptionEnvironment, tokenUsage, validateRequest } from './protocol.mjs';

// SDK injection is only for deterministic tests. Production loads the pinned SDK.
export async function runMuse(job, { sdk, signal, emit = () => {}, readAuth = readFile, env = process.env } = {}) {
  validateRequest(job);
  let handshake, host, client, session, turn, iterator, workspace, closing;
  let cancelled = signal?.aborted ?? false;
  let resolveCancellation;
  const cancellation = new Promise(resolve => { resolveCancellation = resolve; });
  const wait = promise => Promise.race([promise, cancellation.then(() => { throw new BridgeError('ABORTED'); })]);
  const close = () => {
    if (closing) return closing;
    const owner = client ?? host ?? handshake;
    if (!owner) return Promise.resolve();
    // The SDK owns the CLI process and its bounded EOF/terminate/kill sequence.
    closing = Promise.resolve().then(() => owner.close());
    return closing;
  };
  const cancel = () => {
    cancelled = true;
    resolveCancellation();
    if (host && turn) void host.connection.command('turn/cancel', { sessionId: session.sessionId, turnId: turn.turnId }).catch(() => {});
    void close().catch(() => {});
    void iterator?.return().catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (cancelled) throw new BridgeError('ABORTED');
    let auth;
    try { auth = JSON.parse(await readAuth(job.runtime?.authFile ?? join(homedir(), '.config/muse/auth.json'), 'utf8')); }
    catch { throw new BridgeError('MUSE_SUBSCRIPTION_LOGIN_REQUIRED'); }
    const metadata = auth?.providers?.meta;
    if (metadata?.subs_active !== true || metadata.mechanism !== 'oauth' || metadata.obtained_via !== 'device_code') throw new BridgeError('MUSE_SUBSCRIPTION_LOGIN_REQUIRED');
    // Credentials stay with Muse Code; auth fields are never emitted or copied.
    auth = undefined;
    workspace = await mkdtemp(join(tmpdir(), 'rdsh-muse-inference-'));
    if (cancelled) throw new BridgeError('ABORTED');
    handshake = sdk.spawnMspConnection({
      command: job.runtime?.museCommand ?? 'muse',
      args: ['serve', '--no-session-log', '--provider', 'meta', '--model', job.model, '--contributor-mode', 'off', '--disable-shell', '--disable-write'],
      cwd: workspace, env: subscriptionEnvironment(env), shutdownTimeoutMs: 3000,
    });
    host = await wait(handshake.initialize({ clientInfo: { name: 'rustdsh_muse_subscription', version: '0.1.0' } }));
    if (host.fingerprintWarning) throw new BridgeError('MUSE_SCHEMA_CHANGED');
    client = new sdk.MuseClient(host.connection, { host, durability: sdk.readSessionDurability(host.initializeResult) });
    session = await wait(client.startSession({ workspaceRoot: workspace, providerId: 'meta', modelId: job.model, approvalMode: 'denyUnmatched' }));
    session.onApproval(async pending => {
      const denied = pending.availableChoices.find(choice => /deny|reject/.test(choice.choiceId));
      if (!denied) throw new BridgeError('MUSE_NATIVE_TOOL_USED');
      return { choiceId: denied.choiceId };
    });
    emit({ type: 'ready' });
    turn = await wait(session.sendUserTurn({ input: [{ type: 'text', text: formatPrompt(job) }], reasoningEffort: job.reasoningEffort ?? 'high' }));
    iterator = turn.items();
    let answer = '', nativeToolUsed = false;
    while (true) {
      const item = await wait(iterator.next());
      if (item.done) break;
      if (item.value.kind === 'toolCall') nativeToolUsed = true;
      if (item.value.kind === 'agentMessage') answer = item.value.text ?? answer;
    }
    const outcome = await wait(turn.completed);
    if (outcome.params?.terminal === 'cancelled') throw new BridgeError('ABORTED');
    if (outcome.kind !== 'completed' || outcome.params?.terminal !== 'completed') throw new BridgeError('MUSE_UNAVAILABLE');
    if (nativeToolUsed) throw new BridgeError('MUSE_NATIVE_TOOL_USED');
    const response = parseReply(answer, job.tools);
    // Usage notifications may be absent (including on Full); never fabricate 0.
    emit({ type: 'response', response, tokenUsage: tokenUsage(outcome.params.usage) });
  } catch (error) {
    // Raw SDK exceptions can contain stderr or authentication diagnostics.
    throw cancelled ? new BridgeError('ABORTED') : error instanceof BridgeError ? error : new BridgeError('MUSE_UNAVAILABLE');
  } finally {
    signal?.removeEventListener('abort', cancel);
    try {
      await close();
      if (host) emit({ type: 'exit', kind: (await host.child.exit).kind });
    } finally {
      await iterator?.return();
      if (workspace) await rm(workspace, { recursive: true, force: true });
    }
  }
}
