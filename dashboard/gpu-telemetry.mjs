// Read-only NVIDIA inventory. Device indices are deliberately not identifiers.
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const devicePattern =
  /^GPU-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validDeviceId = (id) =>
  typeof id === "string" && devicePattern.test(id);
export const deviceId = (id) => {
  if (!validDeviceId(id)) throw new GpuError("gpu_uuid_required");
  return "GPU-" + id.slice(4).toLowerCase();
};
export class GpuError extends Error {
  constructor(code, report = null) {
    super(code);
    this.code = code;
    this.report = report;
  }
}
export function gpuRequest(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "device_id,mode,requested_vram_mib" ||
    !Number.isSafeInteger(value.requested_vram_mib) ||
    value.requested_vram_mib < 1 ||
    value.requested_vram_mib > 16777216 ||
    !["exclusive", "shared"].includes(value.mode)
  )
    throw new GpuError("invalid_gpu_request");
  return {
    device_id: deviceId(value.device_id),
    requested_vram_mib: value.requested_vram_mib,
    mode: value.mode,
  };
}
export function parseGpuInventory(
  text,
  observed_at = new Date().toISOString(),
) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 16384)
    throw new GpuError("gpu_inventory_invalid");
  const rows = text.trim().split(/\r?\n/);
  if (!text.trim() || rows.length > 64)
    throw new GpuError("gpu_inventory_invalid");
  const seen = new Set();
  const devices = rows.map((row) => {
    const fields = row.split(",").map((v) => v.trim());
    if (fields.length !== 4) throw new GpuError("gpu_inventory_invalid");
    const id = deviceId(fields[0]);
    if (seen.has(id)) throw new GpuError("gpu_inventory_invalid");
    seen.add(id);
    const memory = fields.slice(1).map((value) => {
      if (value === "N/A" || value === "[N/A]") return null;
      if (!/^\d+$/.test(value)) throw new GpuError("gpu_inventory_invalid");
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number > 16777216)
        throw new GpuError("gpu_inventory_invalid");
      return number;
    });
    const [total_mib, used_mib, free_mib] = memory;
    if (
      total_mib !== null &&
      (total_mib === 0 ||
        memory.slice(1).some((n) => n !== null && n > total_mib))
    )
      throw new GpuError("gpu_inventory_invalid");
    return { device_id: id, total_mib, used_mib, free_mib };
  });
  return {
    status: "observed",
    source: "nvidia-smi",
    units: "MiB",
    observed_at,
    devices,
  };
}
export async function observeGpu({
  env = process.env,
  execImpl = exec,
  now = Date.now,
} = {}) {
  const observed_at = new Date(now()).toISOString();
  const executable =
    process.platform === "win32"
      ? path.join(env.SystemRoot || "C:\\Windows", "System32", "nvidia-smi.exe")
      : "/usr/bin/nvidia-smi";
  try {
    const result = await execImpl(
      executable,
      [
        "--query-gpu=uuid,memory.total,memory.used,memory.free",
        "--format=csv,noheader,nounits",
      ],
      {
        env,
        shell: false,
        windowsHide: true,
        timeout: 3000,
        maxBuffer: 16384,
        encoding: "utf8",
      },
    );
    return parseGpuInventory(result.stdout, observed_at);
  } catch {
    // Never echo the command's stderr, environment, or arbitrary error strings.
    return {
      status: "unavailable",
      source: "nvidia-smi",
      units: "MiB",
      observed_at,
      reason: "gpu_inventory_unavailable",
      devices: [],
    };
  }
}
