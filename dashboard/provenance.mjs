import { object, text, digest } from "./contracts.mjs";

const kinds = ["repository", "tool_result", "web", "agent"];
function body(value) {
  if (typeof value !== "string" || Buffer.byteLength(value) > 65536)
    throw new Error("External text must be at most 64 KiB");
  return value;
}
function seal(value) {
  Object.freeze(value.origin);
  for (const item of value.lineage) Object.freeze(item);
  Object.freeze(value.lineage);
  return Object.freeze(value);
}

// Attribution is metadata, never proof of identity or a grant. There is no
// constructor for trusted instructions or human approvals in this module.
export function externalSource(kind, reference, content) {
  if (!kinds.includes(kind)) throw new Error("Unknown external source kind");
  text(reference, "source reference", 2000);
  const content_digest = digest(body(content));
  return seal({ schema: "rdsh.external-source.v1", authority: "untrusted_data",
    origin: { kind, reference, content_digest }, content, content_digest,
    lineage: [{ action: "capture", content_digest }] });
}
export function validateExternalSource(value) {
  object(value, ["schema", "authority", "origin", "content", "content_digest", "lineage"]);
  if (value.schema !== "rdsh.external-source.v1" || value.authority !== "untrusted_data")
    throw new Error("External source cannot carry instruction authority");
  object(value.origin, ["kind", "reference", "content_digest"]);
  if (!kinds.includes(value.origin.kind)) throw new Error("Unknown external source kind");
  text(value.origin.reference, "source reference", 2000);
  const hash = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  if (!hash(value.origin.content_digest) || value.content_digest !== digest(body(value.content)) ||
      !Array.isArray(value.lineage) || !value.lineage.length || value.lineage.length > 32)
    throw new Error("Invalid external source lineage");
  for (const [index, item] of value.lineage.entries()) {
    object(item, ["action", "content_digest"]);
    if (!hash(item.content_digest) || (index === 0 ? item.action !== "capture" :
        !["summary", "forward"].includes(item.action))) throw new Error("Invalid external source lineage");
  }
  if (value.lineage[0].content_digest !== value.origin.content_digest ||
      value.lineage.at(-1).content_digest !== value.content_digest)
    throw new Error("External source lineage changed");
  return seal(structuredClone(value));
}
export function deriveExternalSource(source, action, content) {
  const original = validateExternalSource(source);
  if (!["summary", "forward"].includes(action) || original.lineage.length >= 32)
    throw new Error("Unsupported external source transformation");
  const content_digest = digest(body(content));
  return seal({ ...original, origin: { ...original.origin }, content, content_digest,
    lineage: [...original.lineage, { action, content_digest }] });
}
export function sourceMetadata(source) {
  const value = validateExternalSource(source);
  return { schema: value.schema, authority: value.authority, origin: { ...value.origin },
    content_digest: value.content_digest, lineage: value.lineage.map((item) => ({ ...item })) };
}
export function renderExternalQuote(document, source) {
  const value = validateExternalSource(source);
  const figure = document.createElement("figure"), quote = document.createElement("pre"),
    caption = document.createElement("figcaption");
  quote.textContent = value.content;
  caption.textContent = `${value.origin.kind}: ${value.origin.reference} (untrusted_data)`;
  figure.append(quote, caption);
  return figure;
}
