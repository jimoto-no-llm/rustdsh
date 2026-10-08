// Private code snapshots only; native homes, sessions and credentials stay outside.
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const MAX_BYTES = 1024 * 1024 * 1024;
const MAX_FILES = 50000;
const MAX_MANIFEST = 16 * 1024 * 1024;
// Bound open streams/copies, and drain all owned IO before cleanup on failure.
async function eachFile(items, operation) {
  let cursor = 0;
  let failure = null;
  const workers = Array.from(
    { length: Math.min(8, items.length) },
    async () => {
      while (cursor < items.length && failure === null) {
        const item = items[cursor++];
        try {
          await operation(item);
        } catch (error) {
          failure ??= error;
        }
      }
    },
  );
  await Promise.all(workers);
  if (failure !== null) throw failure;
}
const supportedDsh = "0.2.0-rc.2";
export class ReleaseError extends Error {
  constructor(code) {
    super("Managed release: " + code);
    this.code = code;
  }
}
export const releaseId = (id) => /^rel_[a-f0-9]{64}$/.test(id || "");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const relative = (value) =>
  typeof value === "string" &&
  value.length <= 1024 &&
  /^[a-zA-Z0-9@_.+ /()-]+$/.test(value) &&
  !value.split("/").some((part) => !part || part === "." || part === "..");
export async function fileDigest(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
async function json(file, limit = MAX_MANIFEST) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size > limit)
    throw new ReleaseError("invalid_artifact_file");
  const bytes = await fs.readFile(file);
  if (bytes.length > limit) throw new ReleaseError("invalid_artifact_file");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ReleaseError("invalid_artifact_file");
  }
}
const text = (value) =>
  typeof value === "string" &&
  value.trim() &&
  value.length <= 2000 &&
  !/[\x00-\x1f\x7f]/.test(value);
export function compatible(manifest) {
  if (
    manifest.schema !== 1 ||
    manifest.tuple?.dsh !== supportedDsh ||
    manifest.tuple?.adapter_contract !== "acp-stdio-v1" ||
    manifest.tuple?.probe_contract !== 1 ||
    manifest.tuple?.dashboard !== "0.1.0" ||
    manifest.tuple?.platform !== process.platform ||
    manifest.tuple?.arch !== process.arch ||
    !/^v(?:2[2-9]|[3-9][0-9])\.[0-9]+\.[0-9]+$/.test(manifest.tuple?.node || "")
  )
    throw new ReleaseError("incompatible_tuple_wait_for_compatible_runtime");
}
export async function readReleaseManifest(home, id) {
  if (!releaseId(id)) throw new ReleaseError("exact_release_id_required");
  // The configured state root can use Windows case/short-name aliases. Resolve
  // that root once; slots and their contents must still be canonical, unlinked.
  const slot = path.join(await fs.realpath(home), "slots", id);
  if (
    !(await fs.lstat(slot)).isDirectory() ||
    (await fs.realpath(slot)) !== slot
  )
    throw new ReleaseError("artifact_path_changed");
  const file = path.join(slot, "release.json");
  if ((await fs.lstat(file)).mode & 0o222)
    throw new ReleaseError("artifact_manifest_changed");
  const manifest = await json(file);
  const { release_id, ...content } = manifest;
  if (
    release_id !== id ||
    "rel_" + hash(JSON.stringify(content)) !== id ||
    !Array.isArray(content.files) ||
    content.files.length > MAX_FILES ||
    !relative(content.entrypoint) ||
    !relative(content.executable) ||
    !text(content.changes) ||
    !text(content.rollback) ||
    !text(content.provenance)
  )
    throw new ReleaseError("artifact_manifest_changed");
  return { slot, manifest };
}
export async function verifyRelease(home, id) {
  const { slot, manifest } = await readReleaseManifest(home, id);
  const content = manifest;
  compatible(manifest);
  let size = 0;
  const expected = new Set(["release.json"]);
  for (const item of content.files) {
    if (
      !relative(item.path) ||
      expected.has(item.path) ||
      !Number.isSafeInteger(item.size) ||
      item.size < 0 ||
      ![0o444, 0o555].includes(item.mode) ||
      !/^[a-f0-9]{64}$/.test(item.sha256)
    )
      throw new ReleaseError("artifact_manifest_changed");
    expected.add(item.path);
    size += item.size;
    if (size > MAX_BYTES) throw new ReleaseError("artifact_too_large");
  }
  await eachFile(content.files, async (item) => {
    const file = path.join(slot, ...item.path.split("/"));
    const stat = await fs.lstat(file);
    if (
      !stat.isFile() ||
      stat.size !== item.size ||
      (stat.mode & 0o222) !== 0 ||
      (process.platform !== "win32" && (stat.mode & 0o777) !== item.mode) ||
      (await fileDigest(file)) !== item.sha256
    )
      throw new ReleaseError("artifact_changed_wait_restore_pinned_bytes");
  });
  if (
    ![
      content.executable,
      content.entrypoint,
      "adapter/dashboard/cli.mjs",
      "adapter/dashboard/session-ledger.mjs",
      "adapter/plugins/rdsh-release-probe/index.js",
    ].every((file) => expected.has(file))
  )
    throw new ReleaseError("artifact_incomplete");
  const inspect = async (dir, prefix = "") => {
    // The canonical slot and this complete regular-file/directory walk reject
    // linked parents too, without resolving every shared parent for every file.
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory())
        await inspect(path.join(dir, entry.name), name + "/");
      else if (!entry.isFile() || !expected.has(name))
        throw new ReleaseError("artifact_has_unrecorded_files");
    }
  };
  await inspect(slot);
  return {
    slot,
    manifest,
    command: [
      path.join(slot, content.executable),
      path.join(slot, content.entrypoint),
    ],
  };
}

export async function captureRelease(
  home,
  {
    executable,
    dsh_root,
    entrypoint = "lib/bin.js",
    adapter_root = fileURLToPath(new URL("../", import.meta.url)),
    changes,
    rollback,
    provenance,
  } = {},
) {
  if (
    ![changes, rollback, provenance].every(text) ||
    !relative(entrypoint) ||
    !path.isAbsolute(executable || "") ||
    !path.isAbsolute(dsh_root || "") ||
    !path.isAbsolute(adapter_root || "")
  )
    throw new ReleaseError("explicit_code_roots_and_change_notes_required");
  const node = await fs.realpath(executable);
  const dsh = await fs.realpath(dsh_root);
  const adapter = await fs.realpath(adapter_root);
  const pkg = await json(path.join(dsh, "package.json"));
  const dashboard = await json(path.join(adapter, "dashboard", "package.json"));
  const nodeVersion = (
    await exec(node, ["--version"], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 1024,
      env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
    })
  ).stdout.trim();
  const tuple = {
    dashboard: dashboard.version,
    adapter_contract: "acp-stdio-v1",
    dsh: pkg.version,
    node: nodeVersion,
    platform: process.platform,
    arch: process.arch,
    probe_contract: 1,
  };
  if (pkg.name !== "@deepseek-ai/dsh")
    throw new ReleaseError("original_dsh_package_required");
  compatible({ schema: 1, tuple });
  const slots = path.resolve(home, "slots");
  await fs.mkdir(slots, { recursive: true, mode: 0o700 });
  const temp = path.join(slots, ".stage-" + randomUUID());
  await fs.mkdir(temp, { mode: 0o700 });
  const files = [];
  const inputs = [];
  let total = 0;
  const copy = async (source, dest) => {
    if (!relative(dest)) throw new ReleaseError("unsafe_code_path");
    const stat = await fs.lstat(source);
    // Mutable links to global installs are never part of a pinned release.
    if (!stat.isFile())
      throw new ReleaseError("regular_code_files_required_no_links");
    total += stat.size;
    if (total > MAX_BYTES || files.length >= MAX_FILES)
      throw new ReleaseError("artifact_too_large");
    const target = path.join(temp, ...dest.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.copyFile(source, target);
    const mode = stat.mode & 0o111 || source === node ? 0o555 : 0o444;
    const sha256 = await fileDigest(target);
    if (
      stat.size !== (await fs.stat(target)).size ||
      sha256 !== (await fileDigest(source))
    )
      throw new ReleaseError("source_changed_during_capture");
    await fs.chmod(target, mode);
    files.push({ path: dest, size: stat.size, mode, sha256 });
  };
  const tree = async (source, dest) => {
    for (const entry of (
      await fs.readdir(source, { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      if ([".bin", ".git", ".cache"].includes(entry.name)) continue;
      if (
        /^(?:\.env(?:\..*)?|credentials\.json|sessions\.json|runtime\.json|events\.jsonl)$/.test(
          entry.name,
        )
      )
        throw new ReleaseError("private_data_in_code_root");
      if (entry.isDirectory())
        await tree(path.join(source, entry.name), dest + "/" + entry.name);
      else {
        inputs.push([path.join(source, entry.name), dest + "/" + entry.name]);
        if (inputs.length >= MAX_FILES)
          throw new ReleaseError("artifact_too_large");
      }
    }
  };
  try {
    const executablePath =
      "runtime/" + (process.platform === "win32" ? "node.exe" : "node");
    await copy(node, executablePath);
    await tree(dsh, "dsh");
    // Only the repository's runtime modules/dependencies and managed plugins.
    // Tests, evidence, project state and the rest of the checkout are excluded.
    const dash = path.join(adapter, "dashboard");
    for (const file of (await fs.readdir(dash)).sort())
      if (
        file.endsWith(".mjs") ||
        ["package.json", "package-lock.json"].includes(file)
      )
        inputs.push([path.join(dash, file), "adapter/dashboard/" + file]);
    await tree(
      path.join(dash, "node_modules"),
      "adapter/dashboard/node_modules",
    );
    for (const name of ["rdsh-budget-guard", "rdsh-release-probe"])
      await tree(
        path.join(adapter, "plugins", name),
        "adapter/plugins/" + name,
      );
    if (inputs.length + files.length > MAX_FILES)
      throw new ReleaseError("artifact_too_large");
    await eachFile(inputs, ([source, dest]) => copy(source, dest));
    files.sort((a, b) => a.path.localeCompare(b.path));
    const content = {
      schema: 1,
      tuple,
      executable: executablePath,
      entrypoint: "dsh/" + entrypoint,
      changes,
      rollback,
      provenance,
      files,
    };
    const id = "rel_" + hash(JSON.stringify(content));
    if (
      Buffer.byteLength(
        JSON.stringify({ release_id: id, ...content }, null, 2) + "\n",
      ) > MAX_MANIFEST
    )
      throw new ReleaseError("artifact_manifest_too_large");
    await fs.writeFile(
      path.join(temp, "release.json"),
      JSON.stringify({ release_id: id, ...content }, null, 2) + "\n",
      { mode: 0o444 },
    );
    const slot = path.join(slots, id);
    try {
      await fs.rename(temp, slot);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code)) throw error;
      await verifyRelease(path.resolve(home), id);
      await removeOwnedStage(temp, slots);
    }
    return await verifyRelease(path.resolve(home), id);
  } catch (error) {
    await removeOwnedStage(temp, slots);
    throw error;
  }
}
async function removeOwnedStage(temp, slots) {
  if (
    path.dirname(path.resolve(temp)) !== path.resolve(slots) ||
    !path.basename(temp).startsWith(".stage-")
  )
    throw new ReleaseError("invalid_owned_cleanup");
  const unlock = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await unlock(file);
      else if (entry.isFile()) await fs.chmod(file, 0o600);
    }
  };
  try {
    await unlock(temp);
    await fs.rm(temp, { recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
