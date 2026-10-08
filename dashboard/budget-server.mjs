import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { BudgetError } from "./budget-admission.mjs";

const equal = (a, b) =>
  typeof a === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export class BudgetAdmissionServer {
  constructor(mutate) {
    this.mutate = mutate;
    this.grants = new Map();
  }
  async launch(input) {
    if (
      !input ||
      Object.keys(input).some(
        (k) => !["run_id", "worker_id", "cli", "version"].includes(k),
      ) ||
      input.cli !== "dsh" ||
      input.version !== "0.2.0-rc.2"
    )
      throw new BudgetError("budget_adapter_unsupported");
    const job_id = randomUUID();
    const result = await this.mutate("job", {
      job_id,
      run_id: input.run_id,
      worker_id: input.worker_id,
    });
    if (!result.allowed) return result;
    const key = randomBytes(32).toString("hex");
    this.grants.set(job_id, { key, ready: false });
    return { ...result, key };
  }
  grant(jobId, key) {
    const grant = this.grants.get(jobId);
    if (!grant || !equal(key, grant.key)) {
      const e = new BudgetError("budget_producer_unauthorized");
      e.status = 403;
      throw e;
    }
    return grant;
  }
  async producer(operation, input, key) {
    const grant = this.grant(input?.job_id, key);
    if (operation === "ready") {
      if (
        input.hook_version !== 1 ||
        input.cli_version !== "0.2.0-rc.2" ||
        Object.keys(input).some(
          (k) => !["job_id", "hook_version", "cli_version"].includes(k),
        )
      )
        throw new BudgetError("budget_hook_incompatible");
      if (grant.ready) throw new BudgetError("budget_hook_replay_conflict");
      await this.mutate("ready", { job_id: input.job_id });
      grant.ready = true;
      return { ready: true, job_id: input.job_id };
    }
    if (operation === "status")
      return { ready: grant.ready, job_id: input.job_id };
    if (!["call", "finish"].includes(operation) || !grant.ready)
      throw new BudgetError("budget_hook_unavailable");
    return this.mutate(operation, input);
  }
  async revoke(input) {
    if (!input || Object.keys(input).some((k) => k !== "job_id"))
      throw new BudgetError("budget_invalid_input");
    this.grants.delete(input.job_id);
    return this.mutate("close", input);
  }
  observations() {
    return Object.fromEntries(
      [...this.grants].map(([id, grant]) => [id, grant.ready]),
    );
  }
}
