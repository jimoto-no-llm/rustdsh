#!/usr/bin/env node
// Reference Node.js implementations used by scripts/benchmark-node-vs-rust.py.
//
// They mirror the documented behaviour of the rdsh native fast paths so the
// harness can compare like for like on the same synthetic dataset. They are a
// benchmark reference, NOT the upstream "dsh" product: upstream "dsh" exposes no
// "tokens"/"search" subcommand, which the harness records explicitly instead of
// inventing a product ratio.
//
// Usage:
//   node benchmark-node-reference.mjs guard --deny PATTERN... [--json] [--language en]
//   node benchmark-node-reference.mjs tokens FILE...
//   node benchmark-node-reference.mjs search PATTERN --dir DIR [--max N]
//
// "guard" matches rdsh guard's stdin contract: hook JSON (or raw text) on stdin,
// deny globs matched against every string value, exit 2 on a hit, exit 0
// otherwise. The wildcard and JSON rules are a direct port of src/guard.rs.

import fs from "node:fs";
import path from "node:path";

const MAX_GUARD_INPUT = 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 2000000;
const SEARCH_SKIP_DIRS = [".git", "node_modules", "target", ".venv", "dist", "build", ".next"];
const SEARCH_LINE_CHARS = 240;

// --- src/guard.rs: wildcard_match / matches_value -----------------------------

function wildcardMatch(pattern, text) {
  if (pattern === "*" || pattern === "") {
    return true;
  }
  if (!pattern.includes("*")) {
    return text.includes(pattern);
  }
  if ([...pattern].every((byte) => byte === "*")) {
    return true;
  }
  const startsStar = pattern.startsWith("*");
  const endsStar = pattern.endsWith("*");
  const parts = pattern.split("*").filter((part) => part !== "");
  let rest = text;
  let first = true;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const last = index === parts.length - 1;
    if (first && !startsStar) {
      if (!rest.startsWith(part)) {
        return false;
      }
      rest = rest.slice(part.length);
    } else if (last && !endsStar) {
      if (!rest.endsWith(part)) {
        return false;
      }
    } else {
      const position = rest.indexOf(part);
      if (position < 0) {
        return false;
      }
      rest = rest.slice(position + part.length);
    }
    first = false;
  }
  return true;
}

function matchesValue(pattern, value) {
  if (typeof value === "string") {
    return wildcardMatch(pattern, value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => matchesValue(pattern, item));
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).some((item) => matchesValue(pattern, item));
  }
  return false;
}

function deniedPattern(raw, deny) {
  const trimmed = raw.replace(/^\s+/, "");
  const head = trimmed.slice(0, 1);
  const patterns = deny.filter((pattern) => pattern.trim() !== "");
  if (head === "{" || head === "[" || head === '"') {
    const value = JSON.parse(raw);
    return patterns.find((pattern) => matchesValue(pattern, value)) || null;
  }
  return patterns.find((pattern) => wildcardMatch(pattern, raw)) || null;
}

function block(message, jsonOut) {
  if (jsonOut) {
    process.stdout.write(JSON.stringify({ decision: "block", reason: message }) + "\n");
    return 0;
  }
  process.stderr.write(message + "\n");
  return 2;
}

function runGuard(argv) {
  let jsonOut = false;
  const deny = [];
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--json") {
      jsonOut = true;
    } else if (flag === "--deny") {
      deny.push(argv[++index]);
    } else if (flag === "--language") {
      index++; // accepted for CLI parity; the reference only emits English
    } else if (flag === "--reason") {
      index++; // the reference keeps the default reason text
    } else {
      process.stderr.write("benchmark-node-reference guard: unknown flag " + flag + "\n");
      return 2;
    }
  }
  const raw = fs.readFileSync(0, "utf8");
  if (Buffer.byteLength(raw, "utf8") > MAX_GUARD_INPUT) {
    return block("rdsh guard: unreadable or oversized input", jsonOut);
  }
  let hit;
  try {
    hit = deniedPattern(raw, deny);
  } catch {
    return block("rdsh guard: invalid JSON input", jsonOut);
  }
  if (hit !== null) {
    process.stderr.write("[rdsh guard] pattern hit: " + hit + "\n");
    return block("blocked by rdsh guard", jsonOut);
  }
  if (jsonOut) {
    process.stdout.write("{}\n");
  }
  return 0;
}

// --- src/tokens.rs: estimate_tokens (byte-level twin) -------------------------

function estimateTokensBytes(buffer) {
  let tokens = 0;
  let asciiRun = 0;
  for (const byte of buffer) {
    if (byte < 0x80) {
      asciiRun += 1;
      if (asciiRun === 4) {
        tokens += 1;
        asciiRun = 0;
      }
    } else if ((byte & 0xc0) !== 0x80) {
      if (asciiRun > 0) {
        tokens += Math.ceil(asciiRun / 4);
        asciiRun = 0;
      }
      tokens += 1;
    }
  }
  return tokens + Math.ceil(asciiRun / 4);
}

function runTokens(files) {
  if (files.length === 0) {
    process.stderr.write("benchmark-node-reference tokens: no files\n");
    return 2;
  }
  for (const file of files) {
    const buffer = fs.readFileSync(file);
    const count = estimateTokensBytes(buffer);
    process.stdout.write(String(count).padStart(8) + "  " + file + "\n");
  }
  return 0;
}

// --- src/search.rs: recursive grep -------------------------------------------

function isSkipDirName(name) {
  return name.startsWith(".") || SEARCH_SKIP_DIRS.includes(name);
}

function collectFiles(root, out) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile()) {
      out.push(full);
    } else if (entry.isDirectory() && !isSkipDirName(entry.name)) {
      collectFiles(full, out);
    }
  }
}

function truncateLine(line) {
  const chars = [...line];
  if (chars.length <= SEARCH_LINE_CHARS) {
    return line;
  }
  return chars.slice(0, SEARCH_LINE_CHARS).join("") + ">";
}

function runSearch(argv) {
  const pattern = argv[0];
  let dir = null;
  let max = 100;
  for (let index = 1; index < argv.length; index++) {
    if (argv[index] === "--dir") {
      dir = argv[++index];
    } else if (argv[index] === "--max") {
      max = Number(argv[++index]);
    } else if (argv[index] === "--language") {
      index++;
    } else {
      process.stderr.write("benchmark-node-reference search: unknown flag " + argv[index] + "\n");
      return 2;
    }
  }
  if (pattern === undefined || dir === null) {
    process.stderr.write("benchmark-node-reference search: pattern and --dir are required\n");
    return 2;
  }
  const root = fs.realpathSync(dir);
  const files = [];
  collectFiles(root, files);
  let shown = 0;
  for (const file of files) {
    if (shown >= max) {
      break;
    }
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (stat.size > MAX_SEARCH_FILE_BYTES) {
      continue;
    }
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const relative = path.relative(root, file);
    const display = path.join(dir, relative);
    const lines = text.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].endsWith("\r") ? lines[index].slice(0, -1) : lines[index];
      if (line.includes(pattern)) {
        process.stdout.write(display + ":" + (index + 1) + ": " + truncateLine(line) + "\n");
        shown += 1;
        if (shown >= max) {
          break;
        }
      }
    }
  }
  process.stderr.write("[rdsh] " + shown + " hit(s) in " + files.length + " file(s)\n");
  return 0;
}

const [subcommand, ...rest] = process.argv.slice(2);
let exitCode;
if (subcommand === "guard") {
  exitCode = runGuard(rest);
} else if (subcommand === "tokens") {
  exitCode = runTokens(rest);
} else if (subcommand === "search") {
  exitCode = runSearch(rest);
} else {
  process.stderr.write("usage: benchmark-node-reference.mjs <guard|tokens|search> ...\n");
  exitCode = 2;
}
process.exit(exitCode);
