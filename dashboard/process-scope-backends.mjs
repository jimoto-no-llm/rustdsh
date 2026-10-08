// Kernel ownership, never process-name matching or a persisted PID kill list.
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const maxMembers = 256;

export async function linuxScope(config, stdio) {
  const { default: koffi } = await import("koffi");
  const libc = koffi.load("libc.so.6");
  const openPid = libc.func("int pidfd_open(int pid, unsigned int flags)");
  const signalPid = libc.func(
    "int pidfd_send_signal(int fd, int sig, void *info, unsigned int flags)",
  );
  const closePid = libc.func("int close(int fd)");
  // Default to the caller's delegated cgroup, without mounts/controller changes.
  const current = (await fs.readFile("/proc/self/cgroup", "utf8")).match(
    /^0::([^\n]+)$/m,
  )?.[1];
  if (!current || current.includes(".."))
    throw new Error("ownership_unavailable");
  const parent = config.cgroup_parent ?? path.join("/sys/fs/cgroup", current);
  const parentReal = await fs.realpath(parent);
  if (
    !(
      parentReal === "/sys/fs/cgroup" ||
      parentReal.startsWith("/sys/fs/cgroup/")
    )
  )
    throw new Error("ownership_unavailable");
  const directory = path.join(parentReal, "rdsh-" + config.owner_id);
  let dir, kill, events;
  try {
    await fs.mkdir(directory);
    dir = await fs.open(directory, "r");
    const held = "/proc/self/fd/" + dir.fd;
    // Held kernel descriptors cannot turn into a replacement cgroup by path reuse.
    kill = await fs.open(path.join(held, "cgroup.kill"), "w");
    events = await fs.open(path.join(held, "cgroup.events"), "r");
    const ino = String((await dir.stat()).ino);
    const groups = async () => {
      const found = [];
      const visit = async (root) => {
        if (found.length >= 128) throw new Error("membership_unverifiable");
        found.push(root);
        for (const entry of await fs.readdir(root, { withFileTypes: true }))
          if (entry.isDirectory()) await visit(path.join(root, entry.name));
      };
      await visit(held);
      return found;
    };
    const members = async () => {
      const ids = new Set();
      for (const group of await groups())
        for (const line of (
          await fs.readFile(path.join(group, "cgroup.procs"), "utf8")
        )
          .trim()
          .split("\n"))
          if (/^[1-9][0-9]*$/.test(line)) ids.add(Number(line));
      return [...ids];
    };
    const snapshot = async () => {
      const buf = Buffer.alloc(1024);
      const { bytesRead } = await events.read(buf, 0, buf.length, 0);
      const populated = buf
        .subarray(0, bytesRead)
        .toString()
        .match(/^populated ([01])$/m)?.[1];
      if (populated === undefined) throw new Error("membership_unverifiable");
      let ids = [],
        enumerationKnown = true;
      try {
        ids = await members();
      } catch {
        enumerationKnown = false;
      }
      return {
        status: populated === "0" ? "exit_confirmed" : "running",
        remaining_pids: populated === "0" ? [] : ids.slice(0, maxMembers),
        remaining_count:
          populated === "0"
            ? 0
            : enumerationKnown && ids.length > 0
              ? ids.length
              : null,
        members_truncated: !enumerationKnown || ids.length > maxMembers,
      };
    };
    const term = async () => {
      let sent = 0;
      for (const pid of (await members()).slice(0, maxMembers)) {
        const fd = openPid(pid, 0);
        if (fd < 0) continue; // Exit race; no numeric-PID fallback.
        try {
          const membership = (
            await fs.readFile(`/proc/${pid}/cgroup`, "utf8")
          ).match(/^0::([^\n]+)$/m)?.[1];
          const expected = directory.slice("/sys/fs/cgroup".length);
          if (
            !membership ||
            !(membership === expected || membership.startsWith(expected + "/"))
          )
            continue;
          if (signalPid(fd, 15, null, 0) === 0) sent++;
        } catch {
        } finally {
          closePid(fd);
        }
      }
      return {
        status: "requested",
        reason: "pidfd_sigterm_owned_members",
        signals_sent: sent,
      };
    };
    // Fixed launcher moves itself before exec; operator argv is positional data.
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        'printf "%s\\n" "$$" > "$1/cgroup.procs" || exit 125; printf "ready\\n" >&3; read -r gate <&3 || exit 125; test "$gate" = GO || exit 125; exec 3>&-; shift; exec "$@"',
        "rdsh-owned",
        directory,
        ...config.command,
      ],
      {
        cwd: config.cwd,
        env: config.env ?? process.env,
        stdio: [...stdio, "pipe"],
        shell: false,
      },
    );
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("ownership_unavailable")),
        5000,
      );
      child.once("error", reject);
      child.once("exit", () => reject(new Error("ownership_unavailable")));
      child.stdio[3].once("data", (data) => {
        clearTimeout(timeout);
        if (data.toString() === "ready\n") resolve();
        else reject(new Error("ownership_unavailable"));
      });
    });
    const emptyCleanup = async () => {
      if ((await snapshot()).status !== "exit_confirmed") return false;
      const paths = await groups();
      // Only rmdir empty kernel groups, never recursively delete user files.
      for (const group of paths.reverse()) {
        if (group !== held) await fs.rmdir(group);
      }
      await kill.close();
      await events.close();
      await dir.close();
      kill = events = dir = null;
      await fs.rmdir(directory);
      return true;
    };
    return {
      child,
      release: async () => {
        child.stdio[3].end("GO\n");
      },
      kind: "linux_cgroup_v2",
      kernel_id: ino,
      snapshot,
      term,
      kill: async () => {
        await kill.write("1", 0, "utf8");
        return { status: "requested", reason: "cgroup_kill_held_descriptor" };
      },
      close: emptyCleanup,
    };
  } catch (error) {
    await kill?.write("1", 0, "utf8").catch(() => {});
    await kill?.close();
    await events?.close();
    await dir?.close();
    await fs.rmdir(directory).catch(() => {});
    throw error;
  }
}

export async function windowsScope(config) {
  const win = await import("@deepseek-ai/dsh-win32-process");
  const api = win.loadWin32ProcessBindings();
  const info = win.spawnCurrentTokenJobProcess(api, {
    command: config.command[0],
    applicationName: config.command[0],
    args: config.command.slice(1),
    cwd: config.cwd,
    env: config.env ?? process.env,
    stdio: { stdin: 3, stdout: 4, stderr: 5 },
  });
  const child = new EventEmitter();
  child.pid = info.pid;
  const timer = setInterval(() => {
    try {
      const code = win.pollProcessExit(api, info.process);
      if (code !== undefined) {
        clearInterval(timer);
        child.emit("exit", code, null);
      }
    } catch {
      clearInterval(timer);
      child.emit("error", new Error("monitor_lost"));
    }
  }, 20);
  let closed = false;
  const snapshot = async () => {
    if (closed) throw new Error("monitor_lost");
    // BASIC_PROCESS_ID_LIST uses pointer-sized IDs; this pinned API is 64-bit.
    const buffer = Buffer.alloc(16 + maxMembers * 8);
    if (
      !api.queryInformationJobObject(info.job, 3, buffer, buffer.length, null)
    ) {
      if (api.getLastError() === 234)
        return {
          status: "running",
          remaining_pids: [],
          remaining_count: null,
          members_truncated: true,
        };
      throw new Error("monitor_lost");
    }
    const assigned = buffer.readUInt32LE(0),
      count = buffer.readUInt32LE(4);
    if (count > maxMembers) throw new Error("membership_unverifiable");
    const pids = Array.from({ length: count }, (_, i) =>
      Number(buffer.readBigUInt64LE(8 + i * 8)),
    );
    return {
      status: win.isJobEmpty(api, info.job) ? "exit_confirmed" : "running",
      remaining_pids: pids,
      remaining_count: assigned,
      members_truncated: assigned > count,
    };
  };
  return {
    child,
    release: async () => {},
    kind: "windows_job",
    kernel_id: config.owner_id,
    snapshot,
    term: async () => ({
      status: "unsupported",
      reason: "windows_graceful_uses_protocol_and_stdin_eof",
    }),
    kill: async () => {
      win.terminateJob(api, info.job, 137);
      return { status: "requested", reason: "terminate_owned_job_handle" };
    },
    close: async () => {
      if ((await snapshot()).status !== "exit_confirmed") return false;
      closed = true;
      clearInterval(timer);
      win.closeHandleChecked(api, info.process, "owned process");
      win.closeHandleChecked(api, info.job, "owned job");
      return true;
    },
  };
}

export async function cleanupScope(scope) {
  try {
    if ((await scope.snapshot()).status !== "exit_confirmed")
      await scope.kill();
    for (let i = 0; i < 50; i++) {
      if ((await scope.snapshot()).status === "exit_confirmed") {
        await scope.close();
        return;
      }
      await pause(20);
    }
  } catch {} // A lost monitor is never reported as confirmed to the client.
}
