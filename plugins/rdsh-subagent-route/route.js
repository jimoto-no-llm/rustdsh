// Read and write the delegated-children route in a profile's cordis.patch.yml.
//
// DSH composes the subagent tool from a loader entry (`- id: tool-subagent`).
// Its `agentOptions` config pins the provider, model and adapter reasoning
// effort every child starts with; without it each child inherits the parent's
// route. A profile with an agent-preset override carries that entry nested
// inside the preset's `plugins` list, so a top-level entry alone does not reach
// the tool that actually loads. This module edits whatever entry is there and
// leaves every other line byte-identical.

const ENTRY = /^(\s*)-\s+id:\s*["']?tool-subagent["']?\s*$/;
const KEY = /^(\s*)([A-Za-z0-9_.-]+):\s*$/;

export const ROUTE_KEYS = Object.freeze(["provider", "model", "reasoningEffort"]);

const indentOf = (line) => line.length - line.trimStart().length;
const isBlank = (line) => line.trim() === "" || line.trimStart().startsWith("#");

function blockEnd(lines, start) {
  const depth = indentOf(lines[start]);
  for (let i = start + 1; i < lines.length; i += 1) {
    if (isBlank(lines[i])) continue;
    const indent = indentOf(lines[i]);
    if (indent < depth) return i;
    if (indent === depth && /^\s*-\s/.test(lines[i])) return i;
  }
  return lines.length;
}

function childIndent(lines, from, until) {
  for (let i = from; i < until; i += 1) {
    if (!isBlank(lines[i])) return indentOf(lines[i]);
  }
  return null;
}

/** Every (start, end) pair of a `- id: tool-subagent` loader entry. */
export function entries(lines) {
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!ENTRY.test(lines[i])) continue;
    found.push([i, blockEnd(lines, i)]);
  }
  return found;
}

/** The key line of `key` directly inside [from, until), if any. */
function findKey(lines, from, until, indent, key) {
  for (let i = from; i < until; i += 1) {
    if (isBlank(lines[i])) continue;
    if (indentOf(lines[i]) !== indent) continue;
    const match = KEY.exec(lines[i]);
    if (match && match[2] === key) return i;
  }
  return -1;
}

function parseScalar(value) {
  const text = value.trim();
  if (!text) return "";
  if (text.startsWith('"') && text.endsWith('"') && text.length > 1) return text.slice(1, -1);
  if (text.startsWith("'") && text.endsWith("'") && text.length > 1) return text.slice(1, -1);
  return text;
}

/** The route a patch text pins for children, or null when it pins nothing. */
export function readRoute(patches) {
  const lines = String(patches).split("\n");
  let route = null;
  for (const [start, end] of entries(lines)) {
    const configIndent = childIndent(lines, start + 1, end);
    if (configIndent === null) continue;
    const config = findKey(lines, start + 1, end, configIndent, "config");
    if (config < 0) continue;
    const configEnd = blockEnd(lines, config);
    const optionIndent = childIndent(lines, config + 1, configEnd);
    if (optionIndent === null) continue;
    const options = findKey(lines, config + 1, configEnd, optionIndent, "agentOptions");
    if (options < 0) continue;
    const optionsIndent = indentOf(lines[options]);
    const found = {};
    for (let i = options + 1; i < end; i += 1) {
      if (isBlank(lines[i])) continue;
      if (indentOf(lines[i]) <= optionsIndent) break;
      const match = /^\s*([A-Za-z0-9_.-]+):\s*(.*)$/.exec(lines[i]);
      if (match && ROUTE_KEYS.includes(match[1])) found[match[1]] = parseScalar(match[2]);
    }
    if (Object.keys(found).length === 0) continue;
    // The last entry wins: Cordis applies patches in order.
    route = { ...route, ...found };
  }
  return route;
}

function routeLines(route, indent) {
  const pad = " ".repeat(indent);
  const out = [`${pad}agentOptions:`];
  for (const key of ROUTE_KEYS) {
    const value = route[key];
    if (value === undefined || value === null || value === "") continue;
    out.push(`${pad}  ${key}: ${JSON.stringify(String(value))}`);
  }
  return out;
}

/**
 * Return `patches` with every subagent entry pinning `route`, or with the
 * pin removed when `route` is null. Entries that already match are untouched.
 */
export function writeRoute(patches, route) {
  const lines = String(patches).split("\n");
  const wanted = route ? Object.fromEntries(ROUTE_KEYS.filter(key => route[key]).map(key => [key, String(route[key])])) : null;
  const targets = entries(lines).reverse();
  if (targets.length === 0) return String(patches);
  for (const [start, end] of targets) {
    const configIndent = childIndent(lines, start + 1, end);
    const config = configIndent === null ? -1 : findKey(lines, start + 1, end, configIndent, "config");
    if (config < 0) continue;
    const configEnd = blockEnd(lines, config);
    const childIndentValue = childIndent(lines, config + 1, configEnd);
    const options = childIndentValue === null ? -1 : findKey(lines, config + 1, configEnd, childIndentValue, "agentOptions");
    if (wanted === null) {
      if (options < 0) continue;
      const optionsIndent = indentOf(lines[options]);
      let stop = options + 1;
      while (stop < end && (isBlank(lines[stop]) || indentOf(lines[stop]) > optionsIndent)) stop += 1;
      while (stop - 1 > options && isBlank(lines[stop - 1])) stop -= 1;
      lines.splice(options, stop - options);
      continue;
    }
    const optionsIndent = options >= 0 ? indentOf(lines[options]) : childIndentValue ?? indentOf(lines[config]) + 2;
    if (options >= 0) {
      const before = readRoute(lines.slice(start, end).join("\n"));
      if (before && ROUTE_KEYS.every(key => (before[key] ?? "") === (wanted[key] ?? ""))) continue;
      let stop = options + 1;
      while (stop < configEnd && (isBlank(lines[stop]) || indentOf(lines[stop]) > optionsIndent)) stop += 1;
      while (stop - 1 > options && isBlank(lines[stop - 1])) stop -= 1;
      lines.splice(options, stop - options, ...routeLines(wanted, optionsIndent));
    } else {
      lines.splice(config + 1, 0, ...routeLines(wanted, childIndentValue ?? indentOf(lines[config]) + 2));
    }
  }
  return lines.join("\n");
}
