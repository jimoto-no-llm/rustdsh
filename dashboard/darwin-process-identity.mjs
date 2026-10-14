// Read-only Darwin process observations through the documented libproc ABI.
import os from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const procBsdInfoSize = 136;
const procBsdInfo = 3;
const esrch = 3;
let nativeApi;

const digest = (value) => createHash("sha256").update(value).digest("hex");

async function scope() {
  const [uuid, boottime] = await Promise.all([
    exec("/usr/sbin/sysctl", ["-n", "kern.uuid"], {
      shell: false,
      timeout: 1000,
      maxBuffer: 4096,
    }),
    exec("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
      shell: false,
      timeout: 1000,
      maxBuffer: 4096,
    }),
  ]);
  const host = os.hostname();
  const boot = /^\{ sec = ([1-9][0-9]*), usec = ([0-9]{1,6}) \}/.exec(
    boottime.stdout,
  );
  if (
    typeof host !== "string" ||
    host.length === 0 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*$/i.test(
      uuid.stdout,
    ) ||
    !boot ||
    Number(boot[2]) >= 1_000_000
  )
    throw new Error("darwin scope unavailable");
  return digest(
    `${host}\n${uuid.stdout.trim().toLowerCase()}\n${boot[1]}\n${boot[2]}`,
  );
}

async function libproc() {
  if (!nativeApi)
    nativeApi = (async () => {
      const { default: koffi } = await import("koffi");
      const library = koffi.load("/usr/lib/libSystem.B.dylib");
      return {
        errno: () => koffi.errno(),
        procPidInfo: library.func(
          "int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int buffersize)",
        ),
      };
    })();
  return nativeApi;
}

function identity(pid, buffer, processScope) {
  if (
    buffer.length !== procBsdInfoSize ||
    buffer.readUInt32LE(12) !== pid
  )
    return null;
  const seconds = buffer.readBigUInt64LE(120);
  const microseconds = buffer.readBigUInt64LE(128);
  if (seconds === 0n || microseconds >= 1_000_000n) return null;
  const birth = (seconds * 1_000_000n + microseconds).toString();
  if (!/^[1-9][0-9]{0,29}$/.test(birth)) return null;
  return {
    identity: { platform: "darwin", pid, birth, scope: processScope },
    uid: buffer.readUInt32LE(20),
  };
}

export async function readDarwinProcess(
  pid,
  { scopeReader = scope, nativeReader = libproc } = {},
) {
  let processScope;
  try {
    processScope = await scopeReader();
    if (!/^[0-9a-f]{64}$/.test(processScope))
      throw new Error("darwin scope unavailable");
    const api = await nativeReader();
    const buffer = Buffer.alloc(procBsdInfoSize);
    const bytes = api.procPidInfo(pid, procBsdInfo, 0n, buffer, buffer.length);
    if (bytes === 0) {
      if (api.errno() === esrch)
        return {
          status: "gone",
          identity: null,
          platform: "darwin",
          scope: processScope,
        };
      return { status: "unknown", identity: null };
    }
    if (bytes !== procBsdInfoSize) return { status: "unknown", identity: null };
    const observed = identity(pid, buffer, processScope);
    return observed
      ? { status: "observed", ...observed }
      : { status: "unknown", identity: null };
  } catch {
    return { status: "unknown", identity: null };
  }
}

export async function readDarwinProcessOwner(pid) {
  const observation = await readDarwinProcess(pid);
  if (observation.status !== "observed") return observation;
  return { ...observation, owner: `uid:${observation.uid}` };
}
