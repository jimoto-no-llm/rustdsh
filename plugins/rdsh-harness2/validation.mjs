import { isAbsolute, resolve } from 'node:path';

export const MAX_BYTES = 2 * 1024 * 1024;
export function failure(code) { const error = new Error(code); error.code = code; return error; }
export function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function exact(value, keys) {
  if (!plain(value) || Object.keys(value).some(key => !keys.includes(key))) throw failure('INVALID_REQUEST');
}
export function validateRequest(value) {
  exact(value, ['version', 'role', 'workspace', 'prompt', 'harness', 'provider', 'model', 'timeoutMs', 'maxSteps', 'coding']);
  if (value.version !== 1 || !['solver', 'improver'].includes(value.role) ||
      typeof value.workspace !== 'string' || !isAbsolute(value.workspace) || resolve(value.workspace) !== value.workspace ||
      typeof value.prompt !== 'string' || !value.prompt.trim() || Buffer.byteLength(value.prompt) > 262144 ||
      !plain(value.harness) || Object.keys(value.harness).length > 32 ||
      !['provider', 'model'].every(key => typeof value[key] === 'string' && /^[\w.:/@+-]{1,160}$/.test(value[key])) ||
      !Number.isInteger(value.timeoutMs) || value.timeoutMs < 100 || value.timeoutMs > 600000 ||
      !Number.isInteger(value.maxSteps) || value.maxSteps < 1 || value.maxSteps > 32) throw failure('INVALID_REQUEST');
  let bytes = 0;
  for (const [name, text] of Object.entries(value.harness)) {
    if (!/^(?:systemprompt\.md|tool-guidance\.md|skills\/[a-z0-9][a-z0-9_-]*\/SKILL\.md)$/.test(name) || typeof text !== 'string' || text.includes('\0') || Buffer.byteLength(text) > 48000) throw failure('INVALID_HARNESS');
    bytes += Buffer.byteLength(text);
  }
  if (bytes > 96000) throw failure('INVALID_HARNESS');
  if (value.coding !== undefined) {
    exact(value.coding, ['editableFiles', 'testFiles', 'testTimeoutMs']);
    const safePath = path => typeof path === 'string' && path.length < 200 && !path.includes('\\') && !path.includes(':') &&
      path.split('/').every(part => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part));
    const list = files => Array.isArray(files) && files.length > 0 && files.length <= 32 && new Set(files).size === files.length && files.every(safePath);
    if (value.role !== 'solver' || !list(value.coding.editableFiles) || !list(value.coding.testFiles) ||
        value.coding.editableFiles.some(path => value.coding.testFiles.includes(path)) ||
        !Number.isInteger(value.coding.testTimeoutMs) || value.coding.testTimeoutMs < 100 || value.coding.testTimeoutMs > 30000)
      throw failure('INVALID_CODING_CONFIG');
  }
  return value;
}
export function permittedTools(request) {
  return request.coding ? ['harness2_read', 'harness2_edit', 'harness2_test'] : ['harness2_read'];
}
export function emptyUsage() { return { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null }; }

// Error content may contain credentials. Only these fixed labels can leave
// the diagnostic boundary; no provider message or arbitrary error code does.
export const DIAGNOSTIC_CODES = Object.freeze(['SDK_AUTH_REQUIRED', 'SDK_REQUEST_FAILED', 'SDK_NOT_INSTALLED', 'SDK_TOOL_DETECTED', 'INVALID_JSON_TURN', 'UNSUPPORTED_GENERATION_OPTION', 'INVALID_REQUEST', 'INVALID_RESPONSE', 'INPUT_LIMIT', 'OUTPUT_LIMIT', 'NO_ADAPTER', 'HTTP_400', 'HTTP_401', 'HTTP_403', 'HTTP_429', 'HTTP_5XX', 'NATIVE_TURN_FAILED']);
export function classifyDiagnostic(...parts) {
  const text = parts.filter(part => typeof part === 'string').join(' ');
  const status = text.match(/\bHTTP(?:\s+status)?\s*[:=]?\s*(400|401|403|429|5\d\d)\b/i)?.[1];
  if (status) return status.startsWith('5') ? 'HTTP_5XX' : `HTTP_${status}`;
  return DIAGNOSTIC_CODES.find(code => new RegExp(`\\b${code}\\b`).test(text));
}
