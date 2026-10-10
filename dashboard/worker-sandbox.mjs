import { spawn } from "node:child_process";
import { constants, closeSync, openSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import https from "node:https";
import { networkDenyFilter } from "../security/seccomp.mjs";
import { contains, destination, digest, storedDirectoryUnchanged } from "./contracts.mjs";
import { parseOperation } from "./policy.mjs";

const MAX_INPUT = 64 * 1024;
const MAX_OUTPUT = 64 * 1024;
const MAX_WRITABLE_FILES = 50_000;
const EXECUTION_TIMEOUT_MS = 5 * 60 * 1000;
const SYSTEM_LIBS = ["/lib", "/lib64", "/usr/lib", "/usr/lib64"];
const HELPERS = {
  prlimit: "/usr/bin/prlimit",
  cat: "/usr/bin/cat",
  tee: "/usr/bin/tee",
};
const sandboxWriteReasons = new Set([
  "sandbox_write_root_too_large", "sandbox_symlink_in_write_root",
  "sandbox_hardlink_in_write_root", "sandbox_special_file_in_write_root",
]);
function safeReason(error, fallback) {
  const value = typeof error?.message === "string" ? error.message : "";
  return /^[a-z][a-z0-9_]{0,119}$/.test(value) ? value : fallback;
}

function linuxContains(root, candidate) {
  const relative = path.posix.relative(root, candidate);
  return relative === "" || (!path.posix.isAbsolute(relative) && relative !== ".." &&
    !relative.startsWith("../"));
}

export function nestedMountPath(root, mountInfo) {
  const canonicalRoot = path.posix.resolve(root);
  for (const line of mountInfo.split("\n")) {
    const fields = line.split(" ");
    if (fields.length < 6) continue;
    const decoded = fields[4].replace(/\\([0-7]{3})/g,
      (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
    if (!path.posix.isAbsolute(decoded)) continue;
    const mountPoint = path.posix.resolve(decoded);
    if (mountPoint !== canonicalRoot && linuxContains(canonicalRoot, mountPoint))
      return mountPoint;
  }
  return null;
}

async function rejectNestedMounts(root) {
  const mountInfo = await fs.readFile("/proc/self/mountinfo", "utf8");
  if (!mountInfo.trim()) throw new Error("sandbox_mount_table_unavailable");
  if (nestedMountPath(root, mountInfo))
    throw new Error("sandbox_nested_mount_in_root");
}

const privateIpv4 = (address) => {
  if (isIP(address) !== 4) return true;
  const octets = address.split(".").map(Number);
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)) ) ||
    (a === 203 && b === 0 && c === 113);
};

export async function sandboxCapability({ platform = process.platform, arch = process.arch,
  bwrap = "/usr/bin/bwrap", prlimit = HELPERS.prlimit, access = fs.access } = {}) {
  if (platform !== "linux" || arch !== "x64")
    return { supported: false, reason: "unsupported_platform" };
  try {
    await access(bwrap);
    await access(prlimit);
    await access(HELPERS.cat);
    await access(HELPERS.tee);
    return { supported: true, backend: "bubblewrap+seccomp", bwrap, prlimit };
  } catch {
    return { supported: false, reason: "sandbox_runner_unavailable" };
  }
}

function workspacePath(repository, absolute) {
  if (!path.isAbsolute(absolute) || !contains(repository, absolute))
    throw new Error("path_outside_contract");
  const relative = path.relative(repository, absolute).split(path.sep).join("/");
  return relative ? `/workspace/${relative}` : "/workspace";
}

async function openPinnedDirectory(directory) {
  const handle = await fs.open(directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const [real, stat] = await Promise.all([
      fs.realpath(`/proc/self/fd/${handle.fd}`), handle.stat(),
    ]);
    if (real !== directory || !stat.isDirectory())
      throw new Error("sandbox_root_changed");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function openPinnedFile(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const [real, stat] = await Promise.all([
      fs.realpath(`/proc/self/fd/${handle.fd}`), handle.stat(),
    ]);
    if (real !== file || !stat.isFile())
      throw new Error("sandbox_executable_changed");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function verifyWritableTree(root) {
  const pending = [root];
  let entries = 0;
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const stat = await fs.lstat(target);
      if (++entries > MAX_WRITABLE_FILES) throw new Error("sandbox_write_root_too_large");
      if (stat.isSymbolicLink()) throw new Error("sandbox_symlink_in_write_root");
      if (stat.isDirectory()) {
        pending.push(target);
      } else if (stat.isFile()) {
        if (stat.nlink !== 1) throw new Error("sandbox_hardlink_in_write_root");
      } else throw new Error("sandbox_special_file_in_write_root");
    }
  }
}

function addMountDirectories(args, targets) {
  const directories = new Set(["/workspace", "/__rdsh", "/usr", "/etc", "/lib", "/lib64", "/tmp"]);
  for (const target of targets) {
    let current = path.posix.dirname(target);
    while (current !== "/" && current !== ".") {
      directories.add(current);
      current = path.posix.dirname(current);
    }
  }
  const ordered = [...directories].sort((a, b) => a.length - b.length);
  for (const directory of ordered) args.push("--dir", directory);
  for (const directory of ordered) args.push("--chmod", "0555", directory);
}

function buildWorkspaceMounts(repository, readRoots, writeRoots) {
  const roots = new Map();
  for (const root of readRoots) roots.set(workspacePath(repository, root), { path: root, writable: false });
  for (const root of writeRoots) roots.set(workspacePath(repository, root), { path: root, writable: true });
  return [...roots.entries()]
    .map(([target, value]) => ({ ...value, target, depth: target.split("/").length }))
    .sort((a, b) => a.depth - b.depth || a.target.localeCompare(b.target));
}

function collect(child, input, onLimit) {
  const output = [];
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let interrupted = false;
    const consume = (chunks) => (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) {
        interrupted = true;
        onLimit();
      } else chunks.push(chunk);
    };
    child.stdout.on("data", consume(output));
    const errors = [];
    child.stderr.on("data", consume(errors));
    child.on("error", (error) => reject(new Error(`sandbox_runner_unavailable:${error.code || "spawn"}`)));
    child.on("close", (code, signal) => resolve({
      exit_code: code,
      signal,
      timed_out: interrupted,
      stdout: Buffer.concat(output).toString("utf8"),
      stderr: Buffer.concat(errors).toString("utf8"),
    }));
    if (input === null) child.stdin.end();
    else child.stdin.end(input);
  });
}

async function runBwrap({ repository, operation, readRoots, writeRoots, bwrap, prlimit,
  timeoutMs = EXECUTION_TIMEOUT_MS }) {
  const handles = [];
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-worker-seccomp-"));
  const filterPath = path.join(temp, "filter");
  let filterFd;
  let child;
  let timer;
  try {
    await fs.writeFile(filterPath, networkDenyFilter(), { mode: 0o600, flag: "wx" });
    filterFd = openSync(filterPath, "r");
    const mounts = buildWorkspaceMounts(repository, readRoots, writeRoots);
    const helperFiles = {
      prlimit: await fs.realpath(prlimit),
      cat: await fs.realpath(HELPERS.cat),
      tee: await fs.realpath(HELPERS.tee),
    };
    const commandFile = operation.tool === "process.exec"
      ? await fs.realpath(operation.executable)
      : null;
    const sources = [];
    for (const mount of mounts) {
      const handle = await openPinnedDirectory(mount.path);
      handles.push(handle);
      sources.push({ fd: handle.fd, target: mount.target, writable: mount.writable });
    }
    for (const [name, file] of Object.entries(helperFiles)) {
      const handle = await openPinnedFile(file);
      handles.push(handle);
      sources.push({ fd: handle.fd, target: `/__rdsh/${name}`, writable: false, file: true });
    }
    if (commandFile) {
      const handle = await openPinnedFile(commandFile);
      handles.push(handle);
      sources.push({ fd: handle.fd, target: "/__rdsh/command", writable: false, file: true });
    }

    const args = ["--die-with-parent", "--new-session", "--unshare-all", "--cap-drop", "ALL", "--clearenv"];
    const targets = [...sources.map((source) => source.target), ...SYSTEM_LIBS];
    addMountDirectories(args, targets);
    args.push("--proc", "/proc", "--dev", "/dev");
    for (const directory of SYSTEM_LIBS) {
      try {
        const stat = await fs.stat(directory);
        if (stat.isDirectory()) args.push("--ro-bind", directory, directory);
      } catch { /* optional runtime library directory */ }
    }
    try {
      const cache = "/etc/ld.so.cache";
      const stat = await fs.stat(cache);
      if (stat.isFile()) args.push("--ro-bind", cache, cache);
    } catch { /* the dynamic loader can use its default paths */ }
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index];
      // The *-fd forms close each source descriptor after mounting. A plain
      // /proc/self/fd bind would leak the host directory descriptor to the
      // sandboxed command, which could then walk to its host-side parent.
      args.push(source.writable ? "--bind-fd" : "--ro-bind-fd",
        String(3 + index), source.target);
    }
    const seccompChildFd = 3 + handles.length;
    const cwd = operation.tool === "process.exec"
      ? workspacePath(repository, operation.cwd)
      : "/workspace";
    const command = operation.tool === "file.read" ? "/__rdsh/cat"
      : operation.tool === "file.write" ? "/__rdsh/tee"
        : "/__rdsh/command";
    const commandArgs = operation.tool === "file.read"
      ? [workspacePath(repository, operation.path)]
      : operation.tool === "file.write"
        ? ["--", workspacePath(repository, operation.path)]
        : operation.args;
    const input = operation.tool === "file.write" ? operation.content : null;
    args.push("--setenv", "HOME", "/tmp", "--setenv", "PATH", "/__rdsh",
      "--chdir", cwd, "--seccomp", String(seccompChildFd), "--",
      "/__rdsh/prlimit", "--as=1073741824", "--cpu=60", "--nproc=64",
      "--nofile=128", "--fsize=67108864", "--", command, ...commandArgs);
    child = spawn(bwrap, args, {
      env: { PATH: "/usr/bin:/bin" },
      stdio: ["pipe", "pipe", "pipe", ...handles.map((handle) => handle.fd), filterFd],
      windowsHide: true,
    });
    const execution = collect(child, input, () => child.kill("SIGKILL"));
    timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const result = await execution;
    clearTimeout(timer);
    if (result.timed_out || result.signal)
      return { execution: "unknown", reason: "sandbox_interrupted", ...result };
    return { execution: result.exit_code === 0 ? "completed" : "failed", ...result };
  } catch (error) {
    if (child && !child.killed) child.kill("SIGKILL");
    return { execution: "unknown", reason: "sandbox_runner_failed" };
  } finally {
    if (timer) clearTimeout(timer);
    if (filterFd !== undefined) closeSync(filterFd);
    await Promise.allSettled(handles.map((handle) => handle.close()));
    await fs.rm(temp, { recursive: true, force: true });
  }
}

export function approvedNetworkOrigin(urlText, allowedOrigins) {
  let url;
  try { url = new URL(urlText); } catch { throw new Error("network_url_invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash ||
      !allowedOrigins.includes(url.origin)) throw new Error("network_origin_outside_policy");
  return url;
}

async function runNetworkRequest(operation, allowedOrigins, { resolve = lookup, request = https.request,
  timeoutMs = 10000 } = {}) {
  const url = approvedNetworkOrigin(operation.url, allowedOrigins);
  if (!isIP(url.hostname) && (url.hostname === "localhost" || url.hostname.endsWith(".localhost")))
    throw new Error("network_destination_not_public");
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname, family: isIP(url.hostname) }]
    : await resolve(url.hostname, { all: true, verbatim: true });
  const ipv4 = addresses.filter((item) => item.family === 4 && !privateIpv4(item.address));
  if (!ipv4.length || ipv4.length !== addresses.length)
    throw new Error("network_destination_not_public");
  const address = ipv4[0].address;
  return new Promise((resolveResult, reject) => {
    let responseBytes = 0;
    const chunks = [];
    const options = {
      hostname: url.hostname,
      port: Number(url.port || 443),
      path: `${url.pathname}${url.search}`,
      method: operation.method,
      family: 4,
      autoSelectFamily: false,
      servername: isIP(url.hostname) ? undefined : url.hostname,
      lookup: (_hostname, _options, callback) => callback(null, address, 4),
      rejectUnauthorized: true,
      maxHeaderSize: 16 * 1024,
    };
    const req = request(options, (res) => {
      res.on("data", (chunk) => {
        responseBytes += chunk.length;
        if (responseBytes > MAX_OUTPUT) {
          req.destroy(new Error("network_response_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolveResult({
        execution: "completed",
        status: res.statusCode || 0,
        content_type: String(res.headers["content-type"] || "").slice(0, 200),
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("network_request_timed_out")));
    req.on("error", (error) => reject(new Error(safeReason(error, "network_request_failed"))));
    if (operation.body) req.write(operation.body);
    req.end();
  });
}

function operationFromInput(input, evaluated = {}) {
  const parsed = parseOperation(input);
  const raw = input.tool_input;
  const operation = {
    tool: parsed.tool,
    cwd: evaluated.cwd || parsed.cwd,
  };
  if (parsed.tool.startsWith("file.")) {
    operation.path = evaluated.path || path.resolve(operation.cwd, raw.path);
    if (parsed.tool === "file.write") operation.content = raw.content;
  } else if (parsed.tool === "process.exec") {
    operation.executable = evaluated.executable || raw.executable;
    operation.args = raw.args;
  } else {
    operation.url = raw.url;
    operation.method = raw.method;
    operation.body = raw.body;
  }
  return operation;
}

export async function executeSandboxedOperation({ repository, contract, workerRole, input,
  evaluated, capability = sandboxCapability(), networkOptions } = {}) {
  const result = await capability;
  if (!result.supported) return { execution: "not_started", reason: result.reason };
  if (repository !== contract.repository ||
      await fs.realpath(repository).catch(() => null) !== repository)
    return { execution: "not_started", reason: "repository_outside_contract" };
  const policy = contract.operation_policy || { read_roots: [], executables: [], network_origins: [] };
  const readRoots = [...new Set(policy.read_roots || [])];
  const workerRoles = contract.worker_roles || ["review"];
  if (!workerRoles.includes(workerRole))
    return { execution: "not_started", reason: "worker_role_outside_contract" };
  const writeRoots = workerRole === "implementation" ? [...new Set(contract.write_roots || [])] : [];
  let operation;
  try { operation = operationFromInput(input, evaluated); }
  catch { return { execution: "not_started", reason: "operation_unparsed" }; }
  try { operation.cwd = await fs.realpath(operation.cwd); }
  catch { return { execution: "not_started", reason: "sandbox_cwd_unavailable" }; }
  if (!contains(repository, operation.cwd))
    return { execution: "not_started", reason: "cwd_outside_contract" };

  for (const root of new Set([...readRoots, ...writeRoots])) {
    if (!contains(repository, root) || !await storedDirectoryUnchanged(root))
      return { execution: "not_started", reason: "sandbox_root_changed" };
    try { await rejectNestedMounts(root); }
    catch (error) {
      return { execution: "not_started", reason: safeReason(error, "sandbox_mount_table_unavailable") };
    }
  }

  if (workerRole === "review" && operation.tool !== "file.read")
    return { execution: "not_started", reason: "review_worker_read_only" };
  if (operation.tool.startsWith("file.")) {
    try { operation.path = await destination(operation.path, operation.cwd, repository); }
    catch { return { execution: "not_started", reason: "file_target_unavailable" }; }
  }
  if (operation.tool === "file.read" &&
      !readRoots.some((root) => contains(root, operation.path)))
    return { execution: "not_started", reason: "read_outside_policy" };
  if (operation.tool === "file.write" &&
      !writeRoots.some((root) => contains(root, operation.path)))
    return { execution: "not_started", reason: "write_outside_policy" };
  if (["file.read", "file.write", "process.exec"].includes(operation.tool)) {
    if (operation.tool === "process.exec") {
      if (workerRole !== "implementation")
        return { execution: "not_started", reason: "review_worker_read_only" };
      if (!readRoots.some((root) => contains(root, operation.cwd)) &&
          !writeRoots.some((root) => contains(root, operation.cwd)))
        return { execution: "not_started", reason: "cwd_outside_policy" };
      if (!policy.executables?.some((rule) => rule.file === operation.executable &&
          rule.argument_count === operation.args.length &&
          rule.arguments_digest === digest(operation.args)))
        return { execution: "not_started", reason: "executable_or_arguments_outside_policy" };
    }
    if (operation.tool === "file.write") {
      if (typeof operation.content !== "string" || Buffer.byteLength(operation.content) > MAX_INPUT)
        return { execution: "not_started", reason: "write_input_too_large" };
    }
    try {
      for (const root of writeRoots) await verifyWritableTree(root);
    } catch (error) {
      return { execution: "not_started", reason: sandboxWriteReasons.has(error?.message)
        ? error.message : "sandbox_write_root_unavailable" };
    }
    return runBwrap({
      repository, operation, readRoots, writeRoots,
      bwrap: result.bwrap, prlimit: result.prlimit,
    });
  }
  if (operation.tool === "network.request") {
    if (workerRole !== "implementation")
      return { execution: "not_started", reason: "review_worker_read_only" };
    try {
      return await runNetworkRequest(operation, policy.network_origins || [], networkOptions);
    } catch (error) {
      return { execution: "not_started", reason: safeReason(error, "network_request_failed") };
    }
  }
  return { execution: "not_started", reason: "operation_unsupported" };
}

export async function probeSandbox(capability = sandboxCapability()) {
  const available = await capability;
  if (!available.supported) return available;
  let root;
  try {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-sandbox-probe-"));
    const marker = path.join(root, "probe.txt");
    await fs.writeFile(marker, "rdsh-sandbox-ready\n", { mode: 0o600, flag: "wx" });
    const result = await runBwrap({
      repository: root,
      operation: { tool: "file.read", cwd: root, path: marker },
      readRoots: [root], writeRoots: [], bwrap: available.bwrap,
      prlimit: available.prlimit, timeoutMs: 5000,
    });
    if (result.execution !== "completed" || result.stdout !== "rdsh-sandbox-ready\n")
      return { supported: false, reason: "sandbox_probe_failed" };
    return { ...available, probed: true };
  } catch {
    return { supported: false, reason: "sandbox_probe_failed" };
  } finally {
    if (root) await fs.rm(root, { recursive: true, force: true });
  }
}
