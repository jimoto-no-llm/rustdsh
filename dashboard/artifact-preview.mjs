import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const maximumArtifactBytes = 1024 * 1024;
export const maximumTextPreviewBytes = 128 * 1024;

const textExtensions = new Set([
  ".txt",
  ".log",
  ".diff",
  ".patch",
  ".md",
  ".json",
]);
const imageExtensions = new Map([
  [
    ".png",
    {
      mime: "image/png",
      signature: (bytes) =>
        bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    },
  ],
  [
    ".jpg",
    {
      mime: "image/jpeg",
      signature: (bytes) =>
        bytes.length >= 3 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff,
    },
  ],
  [
    ".jpeg",
    {
      mime: "image/jpeg",
      signature: (bytes) =>
        bytes.length >= 3 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff,
    },
  ],
  [
    ".gif",
    {
      mime: "image/gif",
      signature: (bytes) =>
        ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii")),
    },
  ],
  [
    ".webp",
    {
      mime: "image/webp",
      signature: (bytes) =>
        bytes.length >= 12 &&
        bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
        bytes.subarray(8, 12).toString("ascii") === "WEBP",
    },
  ],
]);

const privateKeyBlock = new RegExp(
  "-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----" +
    "[\\s\\S]*?(?:-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|$)",
  "gi",
);
const secretAssignment = new RegExp(
  "((?:\"|')?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|" +
    "client[_-]?secret|password|passwd|authorization|credential|secret|token)" +
    "(?:\"|')?\\s*[:=]\\s*)(?:\"[^\"\\r\\n]*\"|'[^'\\r\\n]*'|[^,;\\r\\n}]+)",
  "gi",
);

const secretPatterns = [
  [privateKeyBlock, "[REDACTED PRIVATE KEY]"],
  [secretAssignment, "$1[REDACTED]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED]"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]"],
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@"],
];

function fail(status, reason) {
  return { status, reason };
}

function redact(text) {
  let value = text;
  for (const [pattern, replacement] of secretPatterns) {
    pattern.lastIndex = 0;
    value = value.replace(pattern, replacement);
  }
  return { text: value, redacted: value !== text };
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function resolveArtifact(root, reference) {
  if (
    typeof reference !== "string" ||
    !reference ||
    reference !== reference.trim() ||
    reference.includes("\\") ||
    reference.includes("\0") ||
    reference.includes(":") ||
    path.posix.isAbsolute(reference)
  )
    return { error: fail(422, "相対パス形式の成果物だけをプレビューできます") };

  const segments = reference.split("/");
  if (
    segments.some(
      (segment) =>
        !segment || segment === "." || segment === ".." || segment.startsWith("."),
    )
  )
    return {
      error: fail(
        422,
        "隠しパスや親ディレクトリを含む参照はプレビューできません",
      ),
    };

  let rootReal;
  try {
    rootReal = await fs.realpath(root);
  } catch {
    return { error: fail(404, "許可されたproject rootを確認できません") };
  }
  let candidate = rootReal;
  try {
    for (let index = 0; index < segments.length; index++) {
      candidate = path.join(candidate, segments[index]);
      const entry = await fs.lstat(candidate);
      if (entry.isSymbolicLink())
        return {
          error: fail(422, "symlinkを含む成果物はプレビューできません"),
        };
      if (index < segments.length - 1 && !entry.isDirectory())
        return { error: fail(404, "成果物の参照先を確認できません") };
    }
    const real = await fs.realpath(candidate);
    if (!inside(rootReal, real))
      return {
        error: fail(422, "許可されたproject rootの外はプレビューできません"),
      };
    return { path: real };
  } catch {
    return { error: fail(404, "成果物が見つからないか、読み取りできません") };
  }
}

function classify(extension, bytes) {
  if (textExtensions.has(extension)) {
    if (bytes.includes(0)) return null;
    try {
      return {
        kind: "text",
        mime: "text/plain; charset=utf-8",
        text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      };
    } catch {
      return null;
    }
  }
  const image = imageExtensions.get(extension);
  if (image?.signature(bytes)) return { kind: "image", mime: image.mime };
  return null;
}

export async function createArtifactPreview(project, events, sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 1)
    return fail(404, "成果物の記録が見つかりません");
  const matches = events.filter(
    (event) =>
      event.sequence === sequence && event.type === "artifact" && event.artifact,
  );
  if (matches.length !== 1)
    return fail(404, "成果物の記録が見つからないか、参照が一意ではありません");

  const event = matches[0];
  const resolved = await resolveArtifact(project.root, event.artifact);
  if (resolved.error) return resolved.error;

  let handle;
  try {
    const noFollow = constants.O_NOFOLLOW || 0;
    handle = await fs.open(resolved.path, constants.O_RDONLY | noFollow);
    const stat = await handle.stat();
    if (!stat.isFile()) return fail(415, "通常ファイルだけをプレビューできます");
    if (stat.size > maximumArtifactBytes)
      return fail(413, "成果物が1 MiBのプレビュー上限を超えています");
    const source = Buffer.alloc(maximumArtifactBytes + 1);
    const { bytesRead } = await handle.read(source, 0, source.length, 0);
    if (bytesRead > maximumArtifactBytes)
      return fail(413, "成果物が1 MiBのプレビュー上限を超えています");
    const bytes = source.subarray(0, bytesRead);

    const extension = path.extname(event.artifact).toLowerCase();
    const type = classify(extension, bytes);
    if (!type)
      return fail(
        415,
        "対応形式はUTF-8のtext・diff・logとPNG・JPEG・GIF・WebPです",
      );

    if (type.kind === "image")
      return {
        status: 200,
        kind: type.kind,
        mime: type.mime,
        bytes,
        redacted: false,
        truncated: false,
      };

    const redacted = redact(type.text);
    const previewBytes = Buffer.from(redacted.text, "utf8");
    const truncated = previewBytes.length > maximumTextPreviewBytes;
    const preview = truncated
      ? previewBytes.subarray(0, maximumTextPreviewBytes)
      : previewBytes;
    return {
      status: 200,
      kind: type.kind,
      mime: type.mime,
      bytes: preview,
      redacted: redacted.redacted,
      truncated,
    };
  } catch {
    return fail(404, "成果物の参照先を読み取れません");
  } finally {
    await handle?.close().catch(() => {});
  }
}
