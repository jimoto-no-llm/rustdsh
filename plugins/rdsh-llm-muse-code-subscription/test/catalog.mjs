export function catalog(mode = 'off') {
  return { providerId: 'meta', source: 'providerCatalog', models: [
    ['muse-wonder-1.0', ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['muse-wonder-full-1.0', ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['muse-spark-1.3', ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['muse-spark-1.2', ['minimal', 'low', 'medium', 'high', 'xhigh']],
  ].map(([modelId, variants]) => ({ providerId: 'meta', modelId, displayLabel: modelId, description: null,
    contextLimit: 1007997, outputLimit: 128000, variants, defaultReasoningEffort: mode === 'on' && modelId === 'muse-spark-1.3' ? 'max' : 'high' })) };
}
