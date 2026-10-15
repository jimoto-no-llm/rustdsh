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
  MUSE_INPUT_INVALID: ["Muse CodeはこのアダプターでテキストとHarnessツールに対応します。", "Muse Code supports text and Harness tools in this adapter.", "此适配器中的 Muse Code 支持文本和 Harness 工具。"],
  MUSE_INPUT_TOO_LARGE: ["Muse Code互換リクエストが32 MiBを超えています。", "The Muse Code compatibility request exceeds 32 MiB.", "Muse Code 兼容请求超过 32 MiB。"],
  MUSE_UNKNOWN_MODEL: ["非対応のMuse Codeモデルまたは推論レベルです。", "Unsupported Muse Code model or reasoning effort.", "不支持的 Muse Code 模型或推理级别。"],
  MUSE_SUBSCRIPTION_LOGIN_REQUIRED: ["Muse Code CLIで有効な定額契約にログインしてください。", "Sign in to an active subscription with the Muse Code CLI.", "请通过 Muse Code CLI 登录有效订阅。"],
  MUSE_AUTH_STORE_MISMATCH: ["認証ファイルはMuse Codeヘルパーのホームと一致する必要があります。別の認証ストアは非対応です。", "The auth file must match the Muse Code helper home; alternate auth stores are unsupported.", "认证文件必须与 Muse Code 辅助进程的主目录匹配；不支持其他认证存储。"],
  MUSE_PROTOCOL_ERROR: ["ローカルのMuse Codeヘルパーが不正な応答を返しました。", "The local Muse Code helper returned an invalid response.", "本地 Muse Code 辅助进程返回了无效响应。"],
  MUSE_SCHEMA_CHANGED: ["Muse CodeとSDKのスキーマが異なります。互換性のあるSDKを確認してください。", "Muse Code and SDK schemas differ; verify a compatible SDK before use.", "Muse Code 与 SDK 的架构不同；请先确认 SDK 兼容性。"],
  MUSE_NATIVE_TOOL_USED: ["Muse Code独自のツールが使用されたため、応答を拒否しました。", "Muse Code used its own tool; the response was rejected.", "Muse Code 使用了自带工具；响应已被拒绝。"],
  MUSE_UNAVAILABLE: ["Muse Codeが正常終了しませんでした。ローカルCLIと定額契約を確認してください。", "Muse Code did not complete cleanly; check the local CLI and subscription.", "Muse Code 未正常完成；请检查本地 CLI 和订阅。"],
  MUSE_TIMEOUT: ["Muse Codeリクエストが制限時間を超えました。", "The Muse Code request exceeded its time limit.", "Muse Code 请求超时。"],
  ABORTED: ["Muse Codeリクエストをキャンセルしました。", "Muse Code request cancelled.", "Muse Code 请求已取消。"],
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
            ? museText(error.code, language)
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
    const language = museLanguage();
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
            failure: { code: "ABORTED", message: museText(error.code, language) },
          },
        };
      } else
        throw new LlmError(
          error instanceof BridgeError
            ? museText(error.code, language)
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
