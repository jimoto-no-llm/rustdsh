import fs from "node:fs/promises";
import path from "node:path";
import { spawnOwnedProcess } from "./process-scope.mjs";
import {
  matchProcessIdentity,
  readProcessIdentity,
  validProcessIdentity,
} from "./process-identity.mjs";
import { ResourceAdmissionError } from "./resource-admission.mjs";

function invalid() {
  throw new ResourceAdmissionError("resource_command_invalid");
}

export async function validateResourceCommand(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !["command", "args", "cwd"].includes(key)) ||
    typeof input.command !== "string" ||
    !input.command.trim() ||
    input.command.length > 4096 ||
    input.command.includes("\0") ||
    !Array.isArray(input.args) ||
    input.args.length > 256 ||
    input.args.some(
      (arg) =>
        typeof arg !== "string" || arg.length > 8192 || arg.includes("\0"),
    ) ||
    (input.cwd !== undefined &&
      (typeof input.cwd !== "string" || !path.isAbsolute(input.cwd)))
  )
    invalid();
  const cwd = await fs.realpath(input.cwd || process.cwd()).catch(() => null);
  if (!cwd || !(await fs.stat(cwd)).isDirectory()) invalid();
  return {
    command: input.command,
    args: [...input.args],
    cwd,
  };
}

function commandWithReservedPort(command, port) {
  const placeholder = "{{RDSH_RESERVED_PORT}}";
  if (port === null && command.some((arg) => arg.includes(placeholder)))
    throw new ResourceAdmissionError("resource_port_required_for_command");
  return [
    command[0],
    ...command.slice(1).map((arg) =>
      arg.includes(placeholder)
        ? arg.split(placeholder).join(String(port))
        : arg,
    ),
  ];
}

function signalExitCode(signal) {
  return signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1;
}

export async function runResourceCommand(
  admission,
  request,
  commandInput,
  {
    stdout = process.stdout,
    stderr = process.stderr,
    readIdentity = readProcessIdentity,
    stopTimeout = 3000,
    onReserved = () => {},
  } = {},
) {
  const command = await validateResourceCommand(commandInput);
  const lease = await admission.reserve(request);
  const ownerIdentity = lease.owner_identity;
  let owned = null;
  let processIdentity = null;
  let bound = false;
  let finished = false;
  let stopping = null;
  const stop = () =>
    (stopping ??= owned.stop({
      gracefulTimeout: stopTimeout,
      killTimeout: stopTimeout,
    }));
  const onSignal = () => {
    void stop().catch(() => {});
  };
  const stdoutPipe = (chunk) => stdout.write(chunk);
  const stderrPipe = (chunk) => stderr.write(chunk);

  try {
    onReserved(lease);
    const env = {
      ...process.env,
      RDSH_RESOURCE_LEASE_ID: lease.lease_id,
    };
    if (lease.port === null) delete env.RDSH_RESERVED_PORT;
    else env.RDSH_RESERVED_PORT = String(lease.port);
    const argv = commandWithReservedPort(
      [command.command, ...command.args],
      lease.port,
    );
    owned = await spawnOwnedProcess({
      command: argv,
      cwd: command.cwd,
      env,
      deferStart: true,
    });
    processIdentity = owned.descriptor.root_identity;
    if (!validProcessIdentity(owned.supervisor_identity))
      throw new ResourceAdmissionError(
        "resource_process_identity_unavailable",
        {
          root_identity_observed: validProcessIdentity(processIdentity),
          supervisor_identity_observed: validProcessIdentity(
            owned.supervisor_identity,
          ),
          scope_kind: owned.descriptor.kind,
        },
      );
    await admission.bind(lease.lease_id, ownerIdentity, processIdentity, {
      supervisorIdentity: owned.supervisor_identity,
      scopeKind: owned.descriptor.kind,
      scopeId: String(owned.descriptor.kernel_id),
      scopePath: owned.scope_path,
    });
    bound = true;
    await admission.activate(lease.lease_id, ownerIdentity, processIdentity);
    owned.child.stdout.on("data", stdoutPipe);
    owned.child.stderr.on("data", stderrPipe);
    let resolveExit, rejectExit;
    const exitPromise = new Promise((resolve, reject) => {
      resolveExit = resolve;
      rejectExit = reject;
    });
    owned.child.once("exit", (code, signal) => resolveExit({ code, signal }));
    owned.child.once("error", rejectExit);
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    await owned.release();
    processIdentity = owned.descriptor.root_identity;
    if (validProcessIdentity(processIdentity))
      await admission.attachProcess(
        lease.lease_id,
        ownerIdentity,
        processIdentity,
      );
    const outcome = await exitPromise;
    const proof = await stop();
    const identityStatus = validProcessIdentity(processIdentity)
      ? matchProcessIdentity(
          processIdentity,
          await readIdentity(processIdentity.pid),
        )
      : "unknown";
    if (
      !proof.confirmed ||
      !proof.resources_released ||
      (validProcessIdentity(processIdentity) &&
        !["gone", "pid_reused"].includes(identityStatus))
    ) {
      await admission.finish(lease.lease_id, processIdentity, {
        confirmed: false,
        resources_released: false,
      });
      throw new ResourceAdmissionError("resource_exit_unverified", {
        scope_status: proof.status,
        identity_status: identityStatus,
      });
    }
    const result = await admission.finish(lease.lease_id, processIdentity, {
      confirmed: true,
      resources_released: true,
    });
    finished = result.released;
    if (!finished)
      throw new ResourceAdmissionError("resource_exit_unverified", result);
    return outcome.signal
      ? signalExitCode(outcome.signal)
      : Number.isInteger(outcome.code)
        ? outcome.code
        : 1;
  } catch (error) {
    if (owned && bound && !finished) {
      const proof = await stop().catch(() => null);
      const processIdentity = owned.descriptor.root_identity;
      if (proof?.confirmed && proof.resources_released) {
        const identityStatus = validProcessIdentity(processIdentity)
          ? matchProcessIdentity(
              processIdentity,
              await readIdentity(processIdentity.pid),
            )
          : "unknown";
        if (
          !validProcessIdentity(processIdentity) ||
          ["gone", "pid_reused"].includes(identityStatus)
        ) {
          await admission
            .finish(lease.lease_id, processIdentity, {
              confirmed: true,
              resources_released: true,
            })
            .catch(() => {});
        }
      }
    } else if (!bound) {
      if (owned) {
        const proof = await stop().catch(() => null);
        if (proof?.confirmed && proof.resources_released)
          await admission.abandon(lease.lease_id, ownerIdentity).catch(() => {});
        else
          await admission.markUnknown(lease.lease_id, ownerIdentity).catch(
            () => {},
          );
      } else {
        await admission.abandon(lease.lease_id, ownerIdentity).catch(() => {});
      }
    }
    throw error;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (owned) {
      owned.child.stdout.off("data", stdoutPipe);
      owned.child.stderr.off("data", stderrPipe);
    }
  }
}

export function resourceRunSummary(lease) {
  return {
    event: "resource-reservation-acquired",
    lease_id: lease.lease_id,
    kind: lease.kind,
    cpu_cores_reserved: lease.cpu_cores,
    memory_mib_reserved: lease.memory_mib,
    requested_port: lease.requested_port,
    selected_port: lease.port,
    recommendation: lease.host.recommendation,
    enforced_limits: lease.host.enforced_limits,
  };
}
