const protocols = {
  "@ai-sdk/openai-compatible": "openai-completions",
  "@ai-sdk/openai": "openai-responses",
  "@ai-sdk/anthropic": "anthropic-messages",
};

// OpenCode prints a provider/model line followed by one JSON object per model.
// Scan balanced objects, respecting braces and escaped quotes inside strings.
export function parseModels(text) {
  const models = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (start < 0) {
      if (c === "{") { start = i; depth = 1; }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try { models.push(JSON.parse(text.slice(start, i + 1))); }
      catch { throw new Error("Invalid OpenCode model metadata"); }
      start = -1;
    }
  }
  if (start >= 0 || models.length === 0)
    throw new Error("Incomplete OpenCode model metadata");
  return models;
}

export function buildProviders(models, authenticated) {
  if (!authenticated)
    throw new Error("OpenCode Zen requires an API key outside OpenCode");
  const providers = {};
  for (const model of models) {
    if (model.providerID !== "opencode") continue;
    const api = protocols[model.api?.npm];
    if (!api || !model.capabilities?.toolcall) continue;
    const endpoint = new URL(model.api?.url);
    if (endpoint.protocol !== "https:" || endpoint.hostname !== "opencode.ai" ||
        endpoint.pathname !== "/zen/v1" || endpoint.username || endpoint.password ||
        endpoint.search || endpoint.hash)
      throw new Error("Unexpected OpenCode Zen endpoint");
    const route = api === "openai-completions" ? "rdsh-opencode-zen" :
      api === "openai-responses" ? "rdsh-opencode-zen-responses" : "rdsh-opencode-zen-anthropic";
    const contextWindow = model.limit?.context;
    const maxTokens = model.limit?.output;
    if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0 ||
        !Number.isSafeInteger(maxTokens) || maxTokens <= 0 ||
        typeof model.api.id !== "string" || model.api.id.length === 0)
      throw new Error("Invalid OpenCode model capabilities");
    const provider = providers[route] ||= {
      displayName: api === "openai-completions" ? "OpenCode Zen" : `OpenCode Zen (${api})`,
      api, baseURL: endpoint.href, apiKeyEnv: "RDSH_OPENCODE_ZEN_API_KEY", models: [],
      ...(api === "openai-completions" ? { compat: {
        supportsStore: false, supportsDeveloperRole: false,
        supportsReasoningEffort: false, maxTokensField: "max_tokens",
      } } : {}),
    };
    if (provider.models.some(item => item.id === model.api.id))
      throw new Error("Duplicate OpenCode model ID");
    provider.models.push({
      id: model.api.id, name: model.name || model.id, contextWindow, maxTokens,
      input: model.capabilities.input?.image ? ["text", "image"] : ["text"],
      // Do not invent reasoning-effort levels absent from OpenCode metadata.
      reasoningEfforts: false,
      ...(api === "openai-completions" && model.capabilities.interleaved?.field === "reasoning_content"
        ? { compat: { requiresReasoningContentOnAssistantMessages: true } } : {}),
    });
  }
  if (Object.keys(providers).length === 0) throw new Error("No compatible OpenCode Zen models");
  return providers;
}
