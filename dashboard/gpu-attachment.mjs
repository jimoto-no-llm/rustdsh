import path from "node:path";
import { stateHome } from "./state.mjs";
import { GpuLeases, runGpuRequest } from "./gpu-leases.mjs";
import { GpuError, observeGpu } from "./gpu-telemetry.mjs";

function visible(env, request) {
  for (const key of ["CUDA_VISIBLE_DEVICES", "NVIDIA_VISIBLE_DEVICES"]) {
    const mask = env[key];
    if (
      mask === undefined ||
      (key === "NVIDIA_VISIBLE_DEVICES" && mask === "all")
    )
      continue;
    if (
      !mask
        .split(",")
        .some(
          (id) => id.trim().toLowerCase() === request.device_id.toLowerCase(),
        )
    )
      throw new GpuError("gpu_visibility_unverified");
  }
}
class GpuAttachment {
  constructor(leases, lease) {
    this.leases = leases;
    this.lease = lease;
    this.active = true;
    this.queue = Promise.resolve();
    this.adapter = null;
    this.schedule();
  }
  enqueue(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  schedule() {
    if (!this.active || this.closed) return;
    this.timer = setTimeout(async () => {
      try {
        await this.enqueue(async () => {
          if (!this.active) return;
          if (this.adapter?.ownedScope) await this.checkScope();
          if (this.active) await this.leases.heartbeat(this.lease.lease_id);
        });
      } catch (error) {
        this.lastError = error.code || "gpu_heartbeat_unconfirmed";
      }
      this.schedule();
    }, 10000);
    this.timer.unref();
  }
  connect(adapter) {
    this.adapter = adapter;
  }
  beginLaunch() {
    return this.enqueue(() => this.leases.beginLaunch(this.lease.lease_id));
  }
  bind(scope) {
    return this.enqueue(() => this.leases.bind(this.lease.lease_id, scope));
  }
  async checkScope() {
    if (!this.active || !this.adapter?.ownedScope) return null;
    const result = await this.leases.releaseFromScope(
      this.lease.lease_id,
      this.adapter.ownedScope,
    );
    if (result.status === "released") {
      this.active = false;
      clearTimeout(this.timer);
    }
    return result;
  }
  observe() {
    return this.enqueue(() => this.checkScope());
  }
  ready() {
    return this.enqueue(async () => {
      if (!this.active || this.closed) throw new GpuError("gpu_lease_released");
      await this.checkScope();
      if (!this.active) throw new GpuError("gpu_lease_released");
      // Re-read the durable reservation before every native send. Losing the
      // ledger cannot authorize further work through a cached lease object.
      await this.leases.assertHeld(this.lease.lease_id);
      this.lastError = null;
    });
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    return this.enqueue(async () => {
      if (!this.active) return { status: "released" };
      let result;
      if (!this.adapter?.launchAttempted)
        result = await this.leases.cancelUnstarted(this.lease.lease_id);
      else result = await this.checkScope();
      if (result?.status === "released") this.active = false;
      if (this.active)
        throw new GpuError("gpu_release_unconfirmed", {
          status: "reservation_retained",
          lease_id: this.lease.lease_id,
          request: this.lease.request,
          reason: result?.reason || "kernel_scope_unavailable",
        });
      return result;
    });
  }
}
export async function prepareGpuAttachment(
  project,
  record,
  history,
  requested,
  env,
  leases = null,
  recordedRequest = undefined,
) {
  const request = await runGpuRequest(
    project,
    record.run_id,
    requested,
    recordedRequest,
  );
  if (request === null) return null;
  await history.gpuRequirement(record.run_id, request);
  visible(env, request);
  leases ||= new GpuLeases({
    home: path.join(stateHome(env), "gpu-resources"),
    observe: () => observeGpu({ env }),
  });
  const result = await leases.acquire({
    project,
    run_id: record.run_id,
    owner_id: history.owner_id,
    request,
  });
  if (result.status !== "reserved") {
    await history.transition(
      record.run_id,
      "waiting-resource",
      "external_wait",
    );
    throw new GpuError("gpu_waiting_resource", result);
  }
  // Explicitly restrict the owned native process to the requested UUID. This
  // cooperative environment selector is not a driver memory quota/security boundary.
  env.CUDA_VISIBLE_DEVICES = request.device_id;
  return new GpuAttachment(leases, result.lease);
}
