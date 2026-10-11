#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { constants, accessSync, readFileSync, realpathSync, mkdirSync, writeFileSync, renameSync, chmodSync, copyFileSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, delimiter } from "node:path";
import { pathToFileURL } from "node:url";
import { buildProviders, parseModels } from "./opencode-models.mjs";

const ref = "RDSH_OPENCODE_ZEN_API_KEY";
const begin = "# BEGIN RDSH OPENCODE MODELS";
const end = "# END RDSH OPENCODE MODELS";

function command(bin, args) {
  try { return execFileSync(bin, args, { encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }); }
  catch { throw new Error("Discovery command failed; check OpenCode and original dsh installation"); }
}

function executable(name) {
  if (name.includes("/")) return realpathSync(name);
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    const path = join(dir, name);
    try { accessSync(path, constants.X_OK); return realpathSync(path); } catch {}
  }
  throw new Error("Original dsh executable not found; set DSH_ORIG_BIN");
}

function optionalText(path) {
  try { return readFileSync(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw new Error("Cannot read a configuration file"); }
}

export function replaceManagedBlock(text, row) {
  const block = `${begin}\n- ${JSON.stringify(row)}\n${end}\n`;
  const start = text.indexOf(begin);
  if (start >= 0) {
    const finish = text.indexOf(end, start);
    if (finish < 0 || text.indexOf(begin, start + begin.length) >= 0)
      throw new Error("Malformed managed model block; no files changed");
    return text.slice(0, start) + block + text.slice(finish + end.length).replace(/^\r?\n/, "");
  } else if (text.includes(end)) throw new Error("Malformed managed model block; no files changed");
  return text + (text.endsWith("\n") ? "\n" : "\n\n") + block;
}

export function replaceRef(text, value) {
  const lines = text.split("\n");
  const start = lines.findIndex(line => /^refs:\s*(?:#.*)?$/.test(line));
  if (start < 0) {
    if (lines.some(line => /^refs:/.test(line))) throw new Error("Unsupported inline credential refs; no files changed");
    return text.trimEnd() + `\nrefs:\n  ${ref}: ${JSON.stringify(value)}\n`;
  }
  let finish = start + 1;
  while (finish < lines.length && (!lines[finish].trim() || /^\s|^#/.test(lines[finish]))) finish++;
  const at = lines.findIndex((line, i) => i > start && i < finish && line.startsWith(`  ${ref}:`));
  if (at >= 0) {
    let next = at + 1;
    while (next < finish && /^\s{3,}\S/.test(lines[next])) next++;
    lines.splice(at, next - at, `  ${ref}: ${JSON.stringify(value)}`);
  } else lines.splice(finish, 0, `  ${ref}: ${JSON.stringify(value)}`);
  return lines.join("\n");
}

function atomic(path, text) {
  const tmp = `${path}.rdsh-${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export async function sync(profiles) {
  if (!profiles.length || profiles.some(p => !/^[a-zA-Z0-9_-]+$/.test(p)))
    throw new Error("Provide existing profile names (for example web tui)");
  const orig = executable(process.env.DSH_ORIG_BIN || "dsh-orig");
  const require = createRequire(orig);
  const includePath = require.resolve("@deepseek-ai/cordis-plugin-include");
  const yaml = createRequire(includePath)("js-yaml");
  const { entryListSchema } = await import(pathToFileURL(includePath).href);
  const load = text => yaml.load(text, { schema: entryListSchema });
  const opencode = process.env.RDSH_OPENCODE_BIN || "opencode";
  const metadata = parseModels(command(opencode, ["models", "opencode", "--verbose"]));
  let config;
  try { config = JSON.parse(command(opencode, ["debug", "config"])); }
  catch { throw new Error("Cannot read effective OpenCode configuration"); }
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  const credsPath = join(home, ".credentials.yaml");
  const credsOriginal = optionalText(credsPath);
  const oldCreds = credsOriginal || "version: 1\nrecords:\nrefs:\n";
  const creds = load(oldCreds);
  if (creds?.version !== 1) throw new Error("Unsupported credential store version; no files changed");
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const authText = optionalText(join(data, "opencode", "auth.json"));
  let auth;
  try { auth = authText ? JSON.parse(authText).opencode : undefined; }
  catch { throw new Error("Cannot read OpenCode authentication store"); }
  const key = config.provider?.opencode?.options?.apiKey || process.env.OPENCODE_API_KEY ||
    process.env.OPENCODE_ZEN_API_KEY || (auth?.type === "api" ? auth.key : undefined) || creds.refs?.[ref];
  if (key !== undefined && (typeof key !== "string" || !key.trim()))
    throw new Error("Unsupported OpenCode credential; no files changed");
  const providers = key && key !== "public" ? buildProviders(metadata, true) : {};
  const snapshots = [];
  for (const profile of [...new Set(profiles)]) {
    const patchPath = join(home, "profiles", profile, "cordis.patch.yml");
    const old = optionalText(patchPath);
    if (old === undefined) throw new Error("Requested profile does not exist; no files changed");
    if (!Array.isArray(load(old))) throw new Error("Profile patch must be a YAML list; no files changed");
    const tree = load(command(orig, ["--profile", profile, "--dump-config"]));
    function find(rows) {
      for (const row of rows) {
        if (row.id === "llm-pi-ai") return row;
        if (row.group && Array.isArray(row.config)) { const hit = find(row.config); if (hit) return hit; }
      }
    }
    const adapter = find(tree);
    if (!adapter) throw new Error("Profile has no pi-ai adapter; no files changed");
    snapshots.push({ patchPath, old, adapter });
  }
  // Go already has a native pi-ai catalog. Share an existing authenticated
  // route between the requested profiles without copying its secret into config.
  for (const { adapter } of snapshots) {
    const go = adapter.config?.providers?.["opencode-go"];
    if (go && (process.env[go.apiKeyEnv] || creds.refs?.[go.apiKeyEnv])) {
      providers["opencode-go"] = go;
      break;
    }
  }
  if (!Object.keys(providers).length)
    throw new Error("OpenCode Zen needs an API key, or configure an authenticated OpenCode Go route; no files changed");
  const updates = [];
  for (const { patchPath, old, adapter } of snapshots) {
    const previous = { ...adapter.config?.providers };
    for (const id of Object.keys(previous)) if (id.startsWith("rdsh-opencode-zen")) delete previous[id];
    const row = { id: "llm-pi-ai", config: { ...adapter.config, providers: { ...previous, ...providers } } };
    const next = replaceManagedBlock(old, row);
    if (!Array.isArray(load(next))) throw new Error("Generated patch validation failed; no files changed");
    updates.push([patchPath, next, old]);
  }
  const nextCreds = key && key !== "public" ? replaceRef(oldCreds, key) :
    creds.refs?.[ref] === "public" ? oldCreds.split("\n").filter(line => !line.startsWith(`  ${ref}:`)).join("\n") : oldCreds;
  if (key && key !== "public" && load(nextCreds).refs?.[ref] !== key)
    throw new Error("Credential reference validation failed; no files changed");
  const writes = [[credsPath, nextCreds, credsOriginal], ...updates].filter(([, next, original]) => next !== original);
  const originals = writes.map(([, , original]) => original);
  if (writes.some(([path], i) => optionalText(path) !== originals[i]))
    throw new Error("Configuration changed during discovery; no files changed");
  const backup = join(home, "backups", `opencode-models-${Date.now()}-${process.pid}`);
  if (writes.length) mkdirSync(backup, { recursive: true, mode: 0o700 });
  writes.forEach(([path], i) => { if (originals[i] !== undefined) { copyFileSync(path, join(backup, `${i}.bak`)); chmodSync(join(backup, `${i}.bak`), 0o600); } });
  try { writes.forEach(([path, text]) => atomic(path, text)); }
  catch {
    writes.forEach(([path], i) => { if (originals[i] !== undefined) atomic(path, originals[i]); else try { unlinkSync(path); } catch {} });
    throw new Error("Could not save model settings; restored existing files");
  }
  const count = Object.values(providers).reduce((n, p) => n + (p.models?.length || 0), 0);
  console.log(`Synced ${count} explicit Zen models${providers["opencode-go"] ? " and the native OpenCode Go catalog" : ""} to ${profiles.join(", ")}; credentials were not printed.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await sync(process.argv.slice(2)); }
  catch { console.error("OpenCode model sync failed. Check the original dsh, OpenCode and existing profile configuration; secrets were not printed."); process.exitCode = 1; }
}
