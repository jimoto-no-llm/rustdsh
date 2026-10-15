import { loadRuntime } from "./runtime.mjs";
import { createOAuthManager, safeError } from "./oauth.mjs";
import { verifySeam } from "./native-seam.mjs";

const runtime = await loadRuntime(process.env.RDSH_DSH_PACKAGE);
const z = runtime.schema.default;
export const name = "rdsh-mcp-oauth";
export const inject = ["tools", "credentials"];
export const Config = z.object({
  serverName: z.string().required(),
  url: z.string().required(),
  issuer: z.string().required(),
  callbackUrl: z.string().required(),
  clientId: z.string(),
  dynamicRegistration: z.boolean(),
  clientSecretRef: z.string(),
  scopes: z.array(String).default([]),
  toolCallTimeoutMs: z.number(),
  failOnStartupError: z.boolean(),
  maxInstructionBytes: z.number(),
  reconnect: z.object({
    enabled: z.boolean(),
    initialDelayMs: z.number(),
    maxDelayMs: z.number(),
    maxAttempts: z.number(),
  }),
});
export function redactLogger(logger, redact) {
  return new Proxy(logger, {
    apply(target, self, args) {
      return redactLogger(
        Reflect.apply(target, self, args.map(redact)),
        redact,
      );
    },
    get(target, key) {
      const value = Reflect.get(target, key);
      return typeof value === "function"
        ? (...args) => Reflect.apply(value, target, args.map(redact))
        : value;
    },
  });
}
export function createPlugin(selectedRuntime) {
  return {
    name,
    inject,
    Config,
    async apply(ctx, config) {
      try {
        await verifySeam(selectedRuntime.mcpPath);
        const manager = createOAuthManager({
          config,
          credentials: ctx.credentials,
          sdk: selectedRuntime.sdk,
        });
        const native = await selectedRuntime.loadMcp();
        const nativeConfig = native.Config({
          transport: "streamable-http",
          serverName: config.serverName,
          url: manager.config.url,
          headers: {},
          toolCallTimeoutMs: config.toolCallTimeoutMs,
          failOnStartupError: config.failOnStartupError,
          maxInstructionBytes: config.maxInstructionBytes,
          reconnect: config.reconnect,
        });
        // Native connection supervisor, cancellation, namespace, tools and resource
        // sync remain responsible for the entire connection lifecycle.
        await native.apply(
          ctx.extend({
            logger: redactLogger(ctx.logger, manager.redactDiagnostic),
          }),
          nativeConfig,
          manager.transportOptions(),
        );
      } catch (error) {
        throw safeError(error);
      }
    },
  };
}
export async function apply(ctx, config) {
  return createPlugin(runtime).apply(ctx, config);
}
