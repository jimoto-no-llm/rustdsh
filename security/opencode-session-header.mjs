// Always-on DSH preload injected by rdsh on delegated boots.
//
// DSH builds custom pi-ai routes with its own `createProvider`
// (`@deepseek-ai/dsh-llm-pi-ai/lib/index.js`), which does not attach OpenCode's
// required per-conversation routing header. Any route that points at an OpenCode
// zen endpoint (e.g. a custom route with `api: openai-completions` and
// `baseURL: https://opencode.ai/zen/go/v1`) therefore fails with
// `400 MissingSessionID`. The built-in `opencode` / `opencode-go` providers only
// work because they wrap their protocol streams; a custom route never gets that
// wrapper.
//
// Fix it by endpoint: when the request base URL host is `opencode.ai`, inject
// `x-opencode-session` from the request's `sessionId`. A caller-supplied header
// wins, and no session id is fabricated when none is given.
import * as nodeModule from 'node:module';

const MARKER = '/* __RDSH_OPENCODE_SESSION_HEADER__ */';
const TARGET = '@deepseek-ai/dsh-llm-pi-ai/lib/index.js';
const ANCHOR = 'function createProvider(input) {';
const STREAM = 'stream: (model, context, options) => input.api.stream(model, context, options),';
const STREAM_PATCHED =
  'stream: (model, context, options) => input.api.stream(model, context, __rdshWithOpenCodeSession(options, input.baseUrl)),';
const SIMPLE = 'streamSimple: (model, context, options) => input.api.streamSimple(model, context, options)';
const SIMPLE_PATCHED =
  'streamSimple: (model, context, options) => input.api.streamSimple(model, context, __rdshWithOpenCodeSession(options, input.baseUrl))';

const HELPER = `${MARKER}
const __rdshOpenCodeSessionHeader = "x-opencode-session";
function __rdshIsOpenCodeEndpoint(url) {
\tif (typeof url !== "string" || url.length === 0) return false;
\ttry { return new URL(url).host === "opencode.ai"; } catch { return false; }
}
function __rdshWithOpenCodeSession(options, baseUrl) {
\tif (!options || !options.sessionId || !__rdshIsOpenCodeEndpoint(baseUrl)) return options;
\tif (Object.keys(options.headers ?? {}).some((key) => key.toLowerCase() === __rdshOpenCodeSessionHeader)) return options;
\treturn { ...options, headers: { ...options.headers, [__rdshOpenCodeSessionHeader]: options.sessionId } };
}
`;

/**
 * Attach the OpenCode session header to DSH's custom-route provider builder.
 * Idempotent (marker-guarded) and a no-op on any unexpected source shape.
 * @param {string} source - the `@deepseek-ai/dsh-llm-pi-ai/lib/index.js` source.
 * @returns {string} the patched source, or the input unchanged.
 */
export function patchSource(source) {
  if (typeof source !== 'string' || source.includes(MARKER)) return source;
  if (source.split(ANCHOR).length !== 2) return source;
  if (source.split(STREAM).length !== 2) return source;
  if (source.split(SIMPLE).length !== 2) return source;
  return source.replace(ANCHOR, HELPER + ANCHOR).replace(STREAM, STREAM_PATCHED).replace(SIMPLE, SIMPLE_PATCHED);
}

if (process.env.RDSH_OPENCODE_SESSION_HEADER !== '0' && typeof nodeModule.registerHooks === 'function') {
  nodeModule.registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (!url.includes(TARGET)) return loaded;
      const source =
        typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString('utf8');
      const patched = patchSource(source);
      if (patched === source) return loaded;
      return { ...loaded, source: patched };
    },
  });
}
