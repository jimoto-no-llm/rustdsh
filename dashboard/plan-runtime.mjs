import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ExecutionPlans, PlanError } from "./execution-plan.mjs";
import { planRuntimeHashes } from "./plan-runtime-source.mjs";

export function nativePlanBoundary(plans, binding) {
  const context = new AsyncLocalStorage();
  const providers = new WeakSet();
  const denial = (reason) => {
    throw new PlanError(reason);
  };
  return {
    register(provider) {
      providers.add(provider);
      return provider;
    },
    unplanned: () => denial("explicit_workflow_task_required"),
    async workflow(parent) {
      const v = await plans.read(),
        p = plans.find(v, binding.definition.plan_id);
      const reason = plans.stopReason(v, p);
      if (p.context_hash !== binding.context_hash)
        denial("plan_context_changed");
      if (reason) denial(reason);
      if ((await plans.problems(p)).length) denial("plan_graph_invalid");
      if (
        parent?.session?.id !== p.binding.session_id &&
        !v.claims.some(
          (c) =>
            c.plan_id === p.definition.plan_id &&
            c.child_session_id === parent?.session?.id &&
            c.phase === "running",
        )
      )
        denial("workflow_parent_unconfirmed");
    },
    child(task_id, parent, start) {
      return context.run({ task_id, parent }, start);
    },
    async subagent(request, native_depth, start, provider) {
      const c = context.getStore();
      if (!c || c.parent !== request.parent)
        denial("explicit_workflow_task_required");
      if (!providers.has(provider)) denial("in_process_provider_required");
      const depth = () =>
        typeof native_depth === "function" ? native_depth() : native_depth;
      request.signal?.throwIfAborted();
      const claim = await plans.admit(
        binding.definition.plan_id,
        binding.context_hash,
        {
          task_id: c.task_id,
          parent_session_id: request.parent?.session?.id,
          native_depth: depth(),
        },
      );
      let dispatched = false,
        run;
      try {
        await plans.beforeDispatch(claim);
        request.signal?.throwIfAborted();
        if (
          request.parent !== c.parent ||
          request.parent?.session?.id !== claim.parent_session_id ||
          depth() !== claim.native_depth
        )
          denial("native_context_changed_before_start");
        // No await between the final signal/deadline check and native factory.
        if (Date.parse(binding.definition.limits.stop_at) <= Date.now())
          denial("plan_expired");
        dispatched = true;
        run = await context.run(null, start);
        await plans.update(claim.claim_id, "started", run.id);
      } catch (error) {
        if (run) {
          run.result.catch(() => {});
          await run.dispose().catch(() => {});
        }
        await plans
          .update(claim.claim_id, dispatched ? "unknown" : "not_dispatched")
          .catch(() => {});
        throw error;
      }
      let settled = false;
      const result = Promise.resolve(run.result).then(
        async (value) => {
          const outcome = ["completed", "error", "cancelled"].includes(
            value?.stopReason,
          )
            ? value.stopReason
            : "unknown";
          await plans.update(claim.claim_id, "outcome", outcome);
          settled = true;
          return value;
        },
        async (error) => {
          await plans.update(claim.claim_id, "unknown");
          throw error;
        },
      );
      result.catch(() => {});
      let disposal;
      return {
        ...run,
        id: run.id,
        localAgent: run.localAgent,
        result,
        dispose() {
          return (disposal ||= (async () => {
            try {
              await run.dispose();
              await result;
              if (!settled) denial("child_result_unconfirmed");
              await plans.update(claim.claim_id, "disposed");
            } catch (error) {
              await plans.update(claim.claim_id, "unknown").catch(() => {});
              throw error;
            }
          })());
        },
      };
    },
  };
}

export async function preparePlanAttachment(project, record, env) {
  const plans = ExecutionPlans.open(project),
    binding = await plans.required(record);
  if (!binding) return null;
  if (
    record.binding !== "confirmed" ||
    record.cli_session_id !== binding.binding.session_id ||
    record.cli_version !== "0.2.0-rc.2"
  )
    throw new PlanError("plan_native_context_unconfirmed");
  const reason = plans.stopReason(await plans.read(), binding);
  if (reason) throw new PlanError(reason);
  const preload = new URL("./plan-runtime-preload.mjs", import.meta.url).href;
  if ((env.NODE_OPTIONS || "").includes(preload))
    throw new PlanError("nested_plan_attachment_unsupported");
  const directory = await fs.mkdtemp(
    path.join(project.directory, ".plan-guard-"),
  );
  await fs.chmod(directory, 0o700);
  const filename = path.join(directory, "attachment.json"),
    nonce = randomBytes(32).toString("hex");
  await fs.writeFile(
    filename,
    JSON.stringify({
      schema: 1,
      nonce,
      directory,
      project: {
        id: project.id,
        root: project.root,
        directory: project.directory,
      },
      run_id: record.run_id,
      context_hash: binding.context_hash,
    }),
    { flag: "wx", mode: 0o600 },
  );
  let closing;
  return {
    env: {
      ...env,
      NODE_OPTIONS: `${env.NODE_OPTIONS || ""} --import="${preload}"`.trim(),
      RDSH_PLAN_GUARD_CONFIG: filename,
    },
    async ready(adapter) {
      const pid = adapter.ownedScope?.root_identity?.pid || adapter.child?.pid;
      if (!Number.isSafeInteger(pid) || pid < 1)
        throw new PlanError("native_process_unconfirmed");
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          const filename = path.join(directory, `ready.${pid}.json`),
            stat = await fs.lstat(filename);
          if (!stat.isFile() || stat.size > 2048)
            throw new PlanError("plan_guard_receipt_invalid");
          const r = JSON.parse(await fs.readFile(filename, "utf8"));
          if (
            r.schema !== 1 ||
            r.nonce !== nonce ||
            r.pid !== pid ||
            r.context_hash !== binding.context_hash ||
            r.run_id !== record.run_id ||
            JSON.stringify(r.native_sources) !==
              JSON.stringify(planRuntimeHashes)
          )
            throw new PlanError("plan_guard_receipt_invalid");
          return {
            status: "native_workflow_admission_loaded",
            context_hash: binding.context_hash,
            native_sources: planRuntimeHashes,
          };
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (adapter.stopped)
          throw new PlanError("native_plan_guard_unavailable");
        await delay(100);
      }
      throw new PlanError("native_plan_guard_unavailable");
    },
    close() {
      return (closing ||= (async () => {
        await plans.attachmentEnded(
          binding.definition.plan_id,
          binding.context_hash,
        );
        for (const name of await fs.readdir(directory)) {
          if (name !== "attachment.json" && !/^ready\.\d+\.json$/.test(name))
            throw new PlanError("plan_attachment_cleanup_unconfirmed");
          await fs.unlink(path.join(directory, name));
        }
        await fs.rmdir(directory);
      })());
    },
  };
}
