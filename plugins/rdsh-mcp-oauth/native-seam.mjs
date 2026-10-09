import { createHash } from "node:crypto";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";

export const ORIGINAL_SHA256 =
  "758d8fc473b700b5d351158d06ce9f9e92c16e8b25497b08bb7bd2122a87f5dd";
const replacements = [
  [
    "function createTransport(config) {",
    "function createTransport(config, httpOptions) {",
  ],
  [
    "{ requestInit: { headers: config.headers } });",
    "{ ...httpOptions, requestInit: { headers: config.headers } });",
  ],
  [
    "function startConnection(ctx, config, policy) {",
    "function startConnection(ctx, config, policy, httpOptions) {",
  ],
  [
    "transport = createTransport(config);",
    "transport = createTransport(config, httpOptions);",
  ],
  [
    "async function apply(ctx, config) {",
    "async function apply(ctx, config, httpOptions) {",
  ],
  [
    "startConnection(ctx, config, reconnect);",
    "startConnection(ctx, config, reconnect, httpOptions);",
  ],
];
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
export function patchSource(source) {
  if (sha256(source) !== ORIGINAL_SHA256)
    throw new Error("MCP OAuth: unaudited native source; no files changed");
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2)
      throw new Error("MCP OAuth: ambiguous native seam; no files changed");
    source = source.replace(before, after);
  }
  return source;
}
function originalSource(source) {
  for (const [before, after] of replacements) {
    if (source.split(after).length !== 2) return;
    source = source.replace(after, before);
  }
  if (sha256(source) === ORIGINAL_SHA256) return source;
}
export async function verifySeam(filename) {
  const source = await readFile(filename, "utf8");
  if (!originalSource(source))
    throw new Error(
      "MCP OAuth: install the audited native HTTP seam before enabling this bundle",
    );
  return sha256(source);
}
// Explicit local maintenance command only. No DSH boot patching, no network,
// no profile edits; both install and revert reject unknown compiled sources.
export async function changeSeam(filename, action) {
  const source = await readFile(filename, "utf8");
  const original = originalSource(source);
  const next =
    action === "install"
      ? original
        ? source
        : patchSource(source)
      : action === "revert"
        ? (original ??
          (sha256(source) === ORIGINAL_SHA256 ? source : undefined))
        : undefined;
  if (!next)
    throw new Error("MCP OAuth: native source changed; refusing to overwrite");
  if (next !== source) {
    const temporary = `${filename}.rdsh-oauth-${process.pid}.tmp`;
    try {
      await writeFile(temporary, next, { flag: "wx", mode: 0o644 });
      // Detect another updater between preparation and replacement.
      if ((await readFile(filename, "utf8")) !== source)
        throw new Error(
          "MCP OAuth: native source changed; refusing to overwrite",
        );
      await rename(temporary, filename);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  return { action, sha256: sha256(next), changed: next !== source };
}
