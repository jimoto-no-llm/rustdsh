import { execFile } from 'node:child_process';

// Only counts and prices cross this bridge. No messages, credentials or tool data.
export function decideWithRust(binary, input, signal) {
  return new Promise((resolve, reject) => {
    const child = execFile(binary, ['compaction', 'decide', '--input-file', '-'],
      { windowsHide: true, timeout: 5000, maxBuffer: 16384, signal },
      (error, stdout) => {
        if (error) return reject(new Error('rdsh-compaction: cost bridge failed'));
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new Error('rdsh-compaction: invalid cost bridge response')); }
      });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

export function policyOptions(config = {}) {
  const { rdshRoutes = [], rdshEarly, rdshBinary, ...base } = config;
  if (!Array.isArray(rdshRoutes) || rdshRoutes.length > 200) throw new TypeError('invalid rdshRoutes');
  const seen = new Set();
  for (const route of rdshRoutes) {
    if (!route || typeof route.provider !== 'string' || !route.provider.trim()
      || typeof route.model !== 'string' || !route.model.trim()
      || !['dsh_summary', 'off'].includes(route.method)) {
      throw new TypeError('rdsh-compaction: unsupported route or native compaction method');
    }
    const key = JSON.stringify([route.provider, route.model]);
    if (seen.has(key)) throw new TypeError('rdsh-compaction: duplicate route');
    seen.add(key);
  }
  if (rdshEarly != null && (!Number.isFinite(rdshEarly.expected_turns)
    || rdshEarly.expected_turns <= 0 || !Number.isSafeInteger(rdshEarly.min_tokens)
    || rdshEarly.min_tokens <= 0 || typeof rdshBinary !== 'string' || !rdshBinary)) {
    throw new TypeError('rdsh-compaction: invalid early policy or Rust binary');
  }
  return { base, routes: rdshRoutes, early: rdshEarly, binary: rdshBinary };
}

export async function earlyConfig(engine, agent, signal, services) {
  const options = engine.rdshPolicy;
  const header = agent.session.requestHeader()?.config;
  if (!options?.early || !header || !services.prices) return undefined;
  const measurement = engine.ctx.tokenMeter.measure(agent.session);
  if (measurement.totalTokens < options.early.min_tokens) return undefined;
  const override = engine.config.modelPolicies.find(p => p.provider === header.provider && p.model === header.model) ?? {};
  const policy = { ...engine.config, ...override };
  // A separate summarizer cannot reuse this route's price or cache assumptions.
  if ((policy.summarizationProvider && policy.summarizationProvider !== header.provider)
    || (policy.summarizationModel && policy.summarizationModel !== header.model)) return undefined;
  const info = await engine.ctx.llm.resolveModelInfo(header.provider, header.model, signal);
  const window = info.context?.contextWindow;
  const reserve = header.maxTokens ?? info.defaultMaxTokens ?? 0;
  if (!Number.isSafeInteger(window) || window <= reserve) return undefined;
  const threshold = Math.floor(Math.min(window * policy.thresholdRatio, window - reserve - policy.headroomTokens));
  // Required pressure/overflow compaction never waits for the economics bridge.
  if (measurement.totalTokens >= threshold) return undefined;
  const retain = override.retainTokens ?? (override.retainRatio !== undefined
    ? Math.floor((window - reserve) * override.retainRatio)
    : (policy.retainTokens ?? Math.floor((window - reserve) * policy.retainRatio)));
  if (measurement.totalTokens <= retain) return undefined;
  const price = await services.prices(header.provider, header.model);
  if (!price || !['input', 'output', 'cacheRead', 'cacheWrite'].every(k => Number.isFinite(price[k]) && price[k] >= 0)) return undefined;
  const nodes = measurement.nodes;
  if (!nodes?.length || !services.balanced || nodes.length !== agent.session.surface.nodes.length
    || nodes.some((n, i) => n.seq !== agent.session.surface.nodes[i])) return undefined;
  const start = agent.session.eventAt(nodes[0].seq).type === 'system/message' ? 1 : 0;
  let end = nodes.length;
  let retained = 0;
  while (end > start) {
    retained += nodes[--end].tokens;
    if (retained >= retain) break;
  }
  // Price the same balanced surface boundary that upstream will select.
  while (end > start && !services.balanced(agent.session, nodes[end].seq)) end--;
  if (end <= start) return undefined;
  const replaced = nodes.slice(start, end).reduce((n, node) => n + node.tokens, 0);
  const tail = nodes.slice(end).reduce((n, node) => n + node.tokens, 0);
  const result = await (services.decide ?? decideWithRust)(options.binary, {
    current: measurement.totalTokens, trigger: threshold,
    prefix: Math.max(0, measurement.totalTokens - replaced - tail),
    replaced, summary: policy.maxTokens, tail,
    instruction: Math.ceil((engine.rdshInstructions?.length ?? 1024) / 2),
    summarizer_reuses_prefix: true, expected_turns: options.early.expected_turns,
    prices: { input: price.input / 1e6, output: price.output / 1e6,
      cache_read: price.cacheRead / 1e6, cache_write: price.cacheWrite / 1e6 },
  }, signal);
  if (result?.compact !== true) return undefined;
  // Re-enter the upstream algorithm with a request-local threshold. It still
  // owns pruning, balanced cuts, retries, journaling and commit/rollback.
  const adjusted = { ...override, provider: header.provider, model: header.model,
    thresholdRatio: 1, headroomTokens: Math.max(0, window - reserve - measurement.totalTokens),
    retainTokens: retain, maxTokens: policy.maxTokens };
  return { ...engine.config, modelPolicies: [
    ...engine.config.modelPolicies.filter(p => p.provider !== header.provider || p.model !== header.model), adjusted,
  ] };
}
