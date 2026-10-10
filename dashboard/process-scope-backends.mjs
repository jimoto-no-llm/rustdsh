// Kernel ownership, never process-name matching or a persisted PID kill list.
import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const maxMembers = 256;
const execFileAsync = promisify(execFile);

async function systemdCommand(file, args, options = {}) {
  try {
    return await execFileAsync(file, args, {
      timeout: 5000,
      maxBuffer: 64 * 1024,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      ...options,
    });
  } catch {
    throw new Error("ownership_unavailable");
  }
}

async function systemdUnit(unit) {
  const { stdout } = await systemdCommand("/usr/bin/systemctl", [
    "show",
    "--no-pager",
    "--property=LoadState",
    "--property=ActiveState",
    "--property=SubState",
    "--property=ControlGroup",
    "--property=InvocationID",
    unit,
  ]);
  return Object.fromEntries(
    stdout
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return separator < 0
          ? ["", ""]
          : [line.slice(0, separator), line.slice(separator + 1)];
      })
      .filter(([key]) => key),
  );
}

function systemdScopePath(controlGroup, unit) {
  if (
    typeof controlGroup !== "string" ||
    !controlGroup.startsWith("/") ||
    controlGroup.includes("..") ||
    controlGroup.split("/").at(-1) !== unit
  )
    throw new Error("ownership_unavailable");
  const directory = path.resolve("/sys/fs/cgroup", controlGroup.slice(1));
  if (!directory.startsWith("/sys/fs/cgroup/"))
    throw new Error("ownership_unavailable");
  return directory;
}

async function linuxSystemdScope(config, stdio) {
  const suffix = config.owner_id.slice("owner_".length).replaceAll("-", "");
  const unitName = `rdsh-${suffix}`;
  const unit = unitName + ".scope";
  const before = await systemdUnit(unit);
  if (before.LoadState !== "not-found")
    throw new Error("ownership_unavailable");

  const childProcess = spawn(
    "/usr/bin/systemd-run",
    [
      "--scope",
      "--quiet",
      "--unit",
      unitName,
      "--",
      "/bin/sh",
      "-c",
      'printf "RDSH_SCOPE_PID:%s\\n" "$$"; IFS= read -r gate || exit 125; test "$gate" = GO || exit 125; exec "$@"',
      "rdsh-owned",
      ...config.command,
    ],
    {
      cwd: config.cwd,
      env: config.env ?? process.env,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const child = new EventEmitter();
  child.on("error", () => {});
  child.stdin = childProcess.stdin;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  childProcess.stderr.pipe(child.stderr);
  childProcess.stderr.once("end", () => child.stderr.end());
  let outputPrefix = Buffer.alloc(0);
  let rootPid = null;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  childProcess.stdout.on("data", (chunk) => {
    if (rootPid !== null) {
      child.stdout.write(chunk);
      return;
    }
    outputPrefix = Buffer.concat([outputPrefix, chunk]);
    if (outputPrefix.length > 256) {
      readyReject(new Error("ownership_unavailable"));
      return;
    }
    const newline = outputPrefix.indexOf(10);
    if (newline < 0) return;
    const firstLine = outputPrefix.subarray(0, newline).toString("ascii");
    const match = /^RDSH_SCOPE_PID:([1-9][0-9]*)$/.exec(firstLine);
    if (!match) {
      readyReject(new Error("ownership_unavailable"));
      return;
    }
    rootPid = Number(match[1]);
    if (!Number.isSafeInteger(rootPid) || rootPid > 2147483647) {
      readyReject(new Error("ownership_unavailable"));
      return;
    }
    child.pid = rootPid;
    const remainder = outputPrefix.subarray(newline + 1);
    if (remainder.length) child.stdout.write(remainder);
    outputPrefix = Buffer.alloc(0);
    readyResolve();
  });
  childProcess.stdout.once("end", () => {
    child.stdout.end();
    if (rootPid === null) readyReject(new Error("ownership_unavailable"));
  });
  childProcess.once("error", (error) => {
    readyReject(error);
    child.emit("error", error);
  });
  childProcess.once("exit", (code, signal) => {
    child.exitOutcome = { code, signal };
    child.emit("exit", code, signal);
  });

  const terminateUnit = async (signal) => {
    const props = await systemdUnit(unit);
    if (
      props.LoadState !== "loaded" ||
      props.InvocationID !== invocationId ||
      props.ControlGroup !== controlGroup
    )
      throw new Error("ownership_unavailable");
    await systemdCommand("/usr/bin/systemctl", [
      "kill",
      "--kill-whom=all",
      `--signal=${signal}`,
      unit,
    ]);
    return {
      status: "requested",
      reason:
        signal === "SIGTERM"
          ? "systemd_scope_sigterm"
          : "systemd_scope_sigkill",
    };
  };

  let invocationId = null;
  let controlGroup = null;
  let scopeDirectory = null;
  let scopeBound = false;
  const confirmedExit = () => ({
    status: "exit_confirmed",
    remaining_pids: [],
    remaining_count: 0,
    members_truncated: false,
  });
  const snapshot = async () => {
    const props = await systemdUnit(unit);
    if (props.LoadState === "not-found") {
      if (
        invocationId &&
        props.ControlGroup === "" &&
        props.ActiveState === "inactive" &&
        scopeDirectory &&
        !(await fs.stat(scopeDirectory).then(() => true, () => false))
      )
        return confirmedExit();
      throw new Error("ownership_unavailable");
    }
    if (
      props.LoadState !== "loaded" ||
      props.InvocationID !== invocationId ||
      (props.ControlGroup && props.ControlGroup !== controlGroup)
    )
      throw new Error("ownership_unavailable");
    if (props.ActiveState === "inactive" || props.ActiveState === "failed") {
      const populated = await fs
        .readFile(path.join(scopeDirectory, "cgroup.events"), "utf8")
        .then((contents) => contents.match(/^populated ([01])$/m)?.[1] ?? null)
        .catch((error) => (error.code === "ENOENT" ? "0" : null));
      if (
        (!props.ControlGroup || props.ControlGroup === controlGroup) &&
        populated === "0"
      )
        return confirmedExit();
      throw new Error("ownership_unavailable");
    }
    if (
      !["active", "activating", "deactivating"].includes(props.ActiveState) ||
      props.ControlGroup !== controlGroup
    )
      throw new Error("ownership_unavailable");
    const events = await fs.readFile(
      path.join(scopeDirectory, "cgroup.events"),
      "utf8",
    );
    const populated = events.match(/^populated ([01])$/m)?.[1];
    if (populated === undefined) throw new Error("ownership_unavailable");
    if (populated === "0")
      return {
        status: "running",
        remaining_pids: [],
        remaining_count: null,
        members_truncated: true,
      };
    const pids = new Set();
    const groups = [];
    const visit = async (directory) => {
      if (groups.length >= 128) throw new Error("ownership_unavailable");
      groups.push(directory);
      for (const entry of await fs.readdir(directory, { withFileTypes: true }))
        if (entry.isDirectory()) await visit(path.join(directory, entry.name));
    };
    await visit(scopeDirectory);
    for (const directory of groups) {
      const members = await fs.readFile(path.join(directory, "cgroup.procs"), "utf8");
      for (const line of members.trim().split("\n"))
        if (/^[1-9][0-9]*$/.test(line)) pids.add(Number(line));
    }
    const remaining = [...pids];
    return {
      status: "running",
      remaining_pids: remaining.slice(0, maxMembers),
      remaining_count: remaining.length,
      members_truncated: remaining.length > maxMembers,
    };
  };

  const cleanupFailedLaunch = async () => {
    try {
      const props = await systemdUnit(unit);
      if (
        scopeBound &&
        invocationId &&
        props.LoadState === "loaded" &&
        props.ActiveState !== "inactive" &&
        props.InvocationID === invocationId &&
        props.ControlGroup === controlGroup
      ) {
        const failedPath = scopeDirectory;
        const members = await fs.readFile(
          path.join(failedPath, "cgroup.events"),
          "utf8",
        );
        if (/^populated 1$/m.test(members)) {
          await systemdCommand("/usr/bin/systemctl", [
            "kill",
            "--kill-whom=all",
            "--signal=SIGKILL",
            unit,
          ]);
          for (let attempt = 0; attempt < 100; attempt++) {
            const after = await systemdUnit(unit);
            if (
              after.ActiveState === "inactive" &&
              !after.ControlGroup &&
              !(await fs.stat(failedPath).then(() => true, () => false))
            )
              break;
            await pause(20);
          }
        }
      }
    } catch {
      // Never broaden cleanup beyond this unique systemd scope.
    }
    childProcess.stdin.destroy();
  };

  try {
    await Promise.race([
      ready,
      pause(5000).then(() => {
        throw new Error("ownership_unavailable");
      }),
    ]);
    const props = await systemdUnit(unit);
    if (
      props.LoadState !== "loaded" ||
      props.ActiveState !== "active" ||
      !/^[a-f0-9]{32}$/.test(props.InvocationID ?? "")
    )
      throw new Error("ownership_unavailable");
    invocationId = props.InvocationID;
    controlGroup = props.ControlGroup;
    scopeDirectory = systemdScopePath(controlGroup, unit);
    const member = (await fs.readFile(`/proc/${rootPid}/cgroup`, "utf8")).match(
      /^0::([^\n]+)$/m,
    )?.[1];
    if (
      member !== controlGroup &&
      !member?.startsWith(controlGroup + "/")
    )
      throw new Error("ownership_unavailable");
    scopeBound = true;
    if ((await snapshot()).status !== "running")
      throw new Error("ownership_unavailable");
    return {
      child,
      release: async () => {
        await new Promise((resolve, reject) =>
          child.stdin.write("GO\n", (error) => (error ? reject(error) : resolve())),
        );
      },
      kind: "linux_systemd_scope",
      kernel_id: unitName,
      snapshot,
      term: async () => {
        if ((await snapshot()).status === "exit_confirmed")
          return { status: "requested", reason: "systemd_scope_already_exited" };
        return terminateUnit("SIGTERM");
      },
      kill: async () => {
        if ((await snapshot()).status === "exit_confirmed")
          return { status: "requested", reason: "systemd_scope_already_exited" };
        return terminateUnit("SIGKILL");
      },
      close: async () => (await snapshot()).status === "exit_confirmed",
    };
  } catch {
    await cleanupFailedLaunch();
    throw new Error("ownership_unavailable");
  }
}

// Membership and accounting are separate kernel queries. A process can exit or
// spawn between them; neither observation may override contradictory evidence.
export function windowsJobObservation(assigned, pids, accountingEmpty) {
  const membershipEmpty = assigned === 0 && pids.length === 0;
  const empty = membershipEmpty && accountingEmpty;
  return {
    status: empty ? "exit_confirmed" : "running",
    remaining_pids: pids,
    remaining_count:
      membershipEmpty && !accountingEmpty
        ? null
        : Math.max(assigned, pids.length),
    members_truncated:
      assigned > pids.length || (membershipEmpty && !accountingEmpty),
  };
}

export async function linuxScope(config, stdio) {
  // Default to the caller's delegated cgroup, without mounts/controller changes.
  const current = (await fs.readFile("/proc/self/cgroup", "utf8")).match(
    /^0::([^\n]+)$/m,
  )?.[1];
  if (!current || current.includes(".."))
    throw new Error("ownership_unavailable");
  // WSL's systemd init scope is not delegated to the harness. A transient
  // systemd scope is the manager-owned boundary available in that environment.
  if (current === "/init.scope") return linuxSystemdScope(config, stdio);
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
    try {
      await fs.mkdir(directory);
    } catch (error) {
      if (["EACCES", "EPERM", "EROFS"].includes(error.code))
        return await linuxSystemdScope(config, stdio);
      throw error;
    }
    const { default: koffi } = await import("koffi");
    const libc = koffi.load("libc.so.6");
    const openPid = libc.func("int pidfd_open(int pid, unsigned int flags)");
    const signalPid = libc.func(
      "int pidfd_send_signal(int fd, int sig, void *info, unsigned int flags)",
    );
    const closePid = libc.func("int close(int fd)");
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
    return windowsJobObservation(assigned, pids, win.isJobEmpty(api, info.job));
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
