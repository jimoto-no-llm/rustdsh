import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LlmAdapter, LlmError, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { BridgeError } from "./protocol.mjs";
import { runWorker } from "./runner.mjs";

export const name = "llm-muse-code-subscription";
export const inject = ["llm", "sessions"];
function museLanguage() {
  let language;
  try {
    language = JSON.parse(
      readFileSync(
        join(process.env.DSH_HOME || join(homedir(), ".dsh"), "rdsh.json"),
        "utf8",
      ),
    ).general?.language;
  } catch {
    /* Metadata remains available before settings have been created. */
  }
  if (["en", "zh-CN", "ja"].includes(language)) return language;
  const system =
    [
      process.env.RDSH_LANG,
      process.env.LC_ALL,
      process.env.LC_MESSAGES,
      process.env.LANG,
    ].find((value) => value?.trim()) ||
    Intl.DateTimeFormat().resolvedOptions().locale;
  return system.toLowerCase().startsWith("zh")
    ? "zh-CN"
    : system.toLowerCase().startsWith("ja")
      ? "ja"
      : "en";
}
const museCopy = {
  provider: [
    "Muse Code · 定額契約",
    "Muse Code · Subscription",
    "Muse Code · 订阅",
  ],
  contributor: [
    "Muse Code · Contributor（学習利用）",
    "Muse Code · Contributor (training use)",
    "Muse Code · Contributor（用于训练）",
  ],
  model: [
    " · Muse Code 定額",
    " · Muse Code Subscription",
    " · Muse Code 订阅",
  ],
  modelContributor: [
    " · Contributor（学習利用）",
    " · Contributor (training use)",
    " · Contributor（用于训练）",
  ],
  description: [
    "Muse Code SDK互換経路。ツールはHarnessが実行します",
    "Muse Code SDK compatibility route; Harness executes tools",
    "Muse Code SDK 兼容路径；工具由 Harness 执行",
  ],
  unknownProvider: [
    "非対応のMuse Code providerです",
    "Unsupported Muse Code provider",
    "不支持的 Muse Code 提供商",
  ],
  unknownModel: [
    "非対応のMuse Codeモデルです",
    "Unsupported Muse Code model",
    "不支持的 Muse Code 模型",
  ],
  unavailable: [
    "Muse Codeカタログを取得できません",
    "Muse Code catalog unavailable",
    "无法获取 Muse Code 目录",
  ],
  helperFailed: [
    "Muse Codeヘルパーに失敗しました",
    "Muse Code helper failed",
    "Muse Code 辅助进程失败",
  ],
};
function museText(key, language = museLanguage()) {
  return museCopy[key][{ ja: 0, en: 1, "zh-CN": 2 }[language]];
}

const providers = ["muse-code", "muse-code-contributor"];
const mode = (provider) => {
  if (!providers.includes(provider))
    throw new LlmError(museText("unknownProvider"), "UNKNOWN_PROVIDER");
  return provider === "muse-code-contributor" ? "on" : "off";
};
const label = (row) =>
  row.displayLabel !== row.modelId
    ? row.displayLabel
    : row.modelId
        .split("-")
        .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
        .join(" ");

export class MuseSubscriptionAdapter extends LlmAdapter {
  constructor(ctx, config = {}) {
    super();
    this.ctx = ctx;
    this.config = config;
    this.active = new Map();
    this.catalogs = new Map();
    this.pending = new Map();
  }
  providerInfo(provider) {
    return {
      id: provider,
      name:
        mode(provider) === "on"
          ? museText("contributor")
          : museText("provider"),
    };
  }
  providerRetryPolicy() {
    return resolveRetryPolicy({ mode: "normal", maxRetries: 0 }, "muse-code");
  }
  runtime() {
    return {
      museCommand: this.config.museCommand,
      authFile: this.config.authFile,
    };
  }
  async listModels(provider) {
    const contributorMode = mode(provider);
    const language = museLanguage();
    const cacheKey = provider + ":" + language;
    const cached = this.catalogs.get(cacheKey);
    if (cached?.expires > Date.now()) return cached.models;
    if (this.pending.has(cacheKey)) return this.pending.get(cacheKey);
    const controller = new AbortController();
    const request = runWorker(
      { operation: "list-models", contributorMode, runtime: this.runtime() },
      this.config,
      controller.signal,
    );
    this.active.set(
      controller,
      request.then(
        () => {},
        () => {},
      ),
    );
    const pending = request
      .then(({ catalog }) => {
        const models = catalog.models.map((row) => ({
          provider,
          id: row.modelId,
          name:
            label(row) +
            (contributorMode === "on"
              ? museText("modelContributor", language)
              : museText("model", language)),
          inputModalities: ["text"],
          description: row.description ?? museText("description", language),
          ...(row.contextLimit !== null
            ? { context: { contextWindow: row.contextLimit } }
            : {}),
          ...(row.outputLimit !== null
            ? { defaultMaxTokens: row.outputLimit }
            : {}),
          ...(Array.isArray(row.variants) && row.variants.length
            ? {
                reasoning: {
                  defaultEffort: row.defaultReasoningEffort,
                  efforts: row.variants.map((id) => ({ id, name: id })),
                },
              }
            : {}),
        }));
        this.catalogs.set(cacheKey, { models, expires: Date.now() + 60000 });
        return models;
      })
      .catch((error) => {
        throw new LlmError(
          error instanceof BridgeError
            ? error.message
            : museText("unavailable"),
          error instanceof BridgeError ? error.code : "MUSE_UNAVAILABLE",
        );
      })
      .finally(() => {
        this.pending.delete(cacheKey);
        this.active.delete(controller);
      });
    this.pending.set(cacheKey, pending);
    return pending;
  }
  async resolveModel(provider, model) {
    const resolved = (await this.listModels(provider)).find(
      (item) => item.id === model,
    );
    if (!resolved)
      throw new LlmError(museText("unknownModel"), "UNKNOWN_MODEL");
    return resolved;
  }
  async *stream(options) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    let complete;
    const completed = new Promise((resolve) => {
      complete = resolve;
    });
    this.active.set(controller, completed);
    try {
      const session = options.sessionId
        ? this.ctx.sessions.get(options.sessionId)
        : null;
      const result = await runWorker(
        {
          model: options.model,
          reasoningEffort: options.reasoningEffort,
          system: options.system,
          messages: options.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          tools: options.tools ?? [],
          executionWorkspace: session?.header.cwd,
          contributorMode: mode(options.provider ?? "muse-code"),
          runtime: this.runtime(),
        },
        this.config,
        controller.signal,
      );
      // The helper has exited. Disposal must not wait for a consumer paused at
      // a yield while rendering the already buffered answer.
      this.active.delete(controller);
      complete();
      let index = 0;
      if (result.response.text) {
        yield { type: "block-start", index, blockType: "text" };
        yield { type: "text-delta", index, text: result.response.text };
        yield {
          type: "block-end",
          index: index++,
          block: { type: "text", text: result.response.text },
        };
      }
      for (const call of result.response.toolCalls) {
        yield { type: "block-start", index, blockType: "tool-call" };
        yield {
          type: "tool-call-delta",
          index,
          id: call.id,
          name: call.name,
          argumentsDelta: call.arguments,
        };
        yield {
          type: "block-end",
          index: index++,
          block: { type: "tool-call", ...call },
        };
      }
      if (result.tokenUsage) yield { type: "usage", usage: result.tokenUsage };
      yield {
        type: "finish",
        reason: {
          kind: result.response.toolCalls.length ? "tool-calls" : "stop",
        },
      };
    } catch (error) {
      this.active.delete(controller);
      complete();
      if (error instanceof BridgeError && error.code === "ABORTED") {
        yield {
          type: "finish",
          reason: {
            kind: "aborted",
            failure: { code: "ABORTED", message: error.message },
          },
        };
      } else
        throw new LlmError(
          error instanceof BridgeError
            ? error.message
            : museText("helperFailed"),
          error instanceof BridgeError ? error.code : "MUSE_UNAVAILABLE",
        );
    } finally {
      options.signal?.removeEventListener("abort", abort);
      this.active.delete(controller);
      complete();
    }
  }
  async dispose() {
    const requests = [...this.active];
    for (const [controller] of requests) controller.abort();
    await Promise.all(requests.map(([, completed]) => completed));
    this.catalogs.clear();
  }
}

export function apply(ctx, config) {
  const adapter = new MuseSubscriptionAdapter(ctx, config);
  const unregister = ctx.llm.registerAdapter(providers, adapter);
  ctx.on("dispose", async () => {
    unregister();
    await adapter.dispose();
  });
}
