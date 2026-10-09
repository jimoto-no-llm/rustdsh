import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ModelRouting } from "./model-routing.mjs";
import { sameSelection, validSelection } from "./model-selection.mjs";
import { modelRuntimeHash } from "./model-runtime-source.mjs";

const code = (value) =>
  typeof value === "string" && /^[a-z][a-z0-9_]{0,100}$/.test(value)
    ? value
    : "native_assertion_unavailable";
function denial(reason, audit = false) {
  const error = new Error("Native model guard: " + code(reason));
  error.code = audit
    ? "RDSH_MODEL_GUARD_AUDIT_FAILED"
    : "RDSH_MODEL_GUARD_DENIED";
  return error;
}
export function dispatchedSelection(options) {
  const value = {
    provider: options?.provider,
    model: options?.model,
    effort: options?.reasoningEffort ?? null,
  };
  return validSelection(value) ? value : null;
}
export function nativeModelBoundary(routing, record) {
  return {
    async *stream(options, dispatch, modelInfo) {
      options.signal?.throwIfAborted();
      const selection = dispatchedSelection(options);
      let receipt;
      try {
        receipt = await routing.admitNativeCall(record, {
          selection,
          session_matched: options.sessionId === record.cli_session_id,
          effort_resolved:
            options.reasoningEffort !== undefined ||
            modelInfo?.reasoning === undefined,
        });
      } catch (error) {
        throw denial(error.code, true);
      }
      if (!receipt.allowed) throw denial(receipt.reason);
      let dispatched = false,
        outcome = "interrupted";
      try {
        options.signal?.throwIfAborted();
        // Hand-built requests belong to their caller. Recheck after durable I/O;
        // do not rewrite controls, messages, replay state or the original signal.
        if (
          options.sessionId !== record.cli_session_id ||
          !sameSelection(selection, dispatchedSelection(options))
        )
          throw denial("request_changed_before_dispatch");
        dispatched = true;
        const stream = dispatch(options);
        for await (const chunk of stream) {
          if (chunk.type === "finish")
            outcome = ["error", "aborted"].includes(chunk.reason?.kind)
              ? "failed"
              : "succeeded";
          yield chunk;
        }
      } catch (error) {
        outcome = dispatched
          ? "failed"
          : error.code === "RDSH_MODEL_GUARD_DENIED"
            ? "blocked"
            : "interrupted";
        throw error;
      } finally {
        try {
          await routing.finishNativeCall(record, receipt.call_id, {
            outcome,
            dispatch_started: dispatched,
          });
        } catch (error) {
          // Never turn an unrecorded outcome into a confirmed success or replay.
          throw denial(error.code, true);
        }
      }
    },
  };
}

export async function prepareModelAttachment(project, record, env) {
  if (record.binding !== "confirmed" || record.cli !== "dsh") return null;
  const routing = ModelRouting.open(project);
  const required = await routing.required(record);
  if (!required?.native_dispatch_required) return null;
  const policy = await routing.read(record);
  if (!policy) throw denial("route_policy_missing");
  if (record.cli_version !== "0.2.0-rc.2")
    throw denial("native_runtime_unsupported");
  const preload = new URL("./model-runtime-preload.mjs", import.meta.url).href;
  if ((env.NODE_OPTIONS || "").includes(preload))
    throw denial("nested_model_attachment_unsupported");
  const directory = await fs.mkdtemp(
    path.join(project.directory, ".model-guard-"),
  );
  await fs.chmod(directory, 0o700);
  const config = path.join(directory, "attachment.json");
  const nonce = randomBytes(32).toString("hex");
  await fs.writeFile(
    config,
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
      context_hash: policy.context_hash,
    }),
    { flag: "wx", mode: 0o600 },
  );
  let closing;
  return {
    env: {
      ...env,
      NODE_OPTIONS: `${env.NODE_OPTIONS || ""} --import="${preload}"`.trim(),
      RDSH_MODEL_GUARD_CONFIG: config,
    },
    async ready(adapter) {
      const pid = adapter.ownedScope?.root_identity?.pid || adapter.child?.pid;
      if (!Number.isSafeInteger(pid) || pid < 1)
        throw denial("native_process_unconfirmed");
      const readyFile = path.join(directory, `ready.${pid}.json`);
      for (let attempt = 0; attempt < 50; attempt++) {
        if (adapter.stopped) throw denial("native_guard_unavailable");
        let handle;
        try {
          handle = await fs.open(readyFile, "r");
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > 2048)
            throw denial("native_guard_receipt_invalid");
          const receipt = JSON.parse(await handle.readFile("utf8"));
          if (
            receipt.schema !== 1 ||
            receipt.nonce !== nonce ||
            receipt.run_id !== record.run_id ||
            receipt.context_hash !== policy.context_hash ||
            receipt.pid !== pid ||
            receipt.native_source_sha256 !== modelRuntimeHash
          )
            throw denial("native_guard_receipt_invalid");
          return {
            run_id: record.run_id,
            context_hash: policy.context_hash,
            status: "native_dispatch_guard_loaded",
            native_source_sha256: modelRuntimeHash,
          };
        } catch (error) {
          if (error.code !== "ENOENT")
            throw denial("native_guard_receipt_invalid");
        } finally {
          await handle?.close();
        }
        await delay(100);
      }
      throw denial("native_guard_unavailable");
    },
    close() {
      return (closing ||= (async () => {
        // Only these private attachment files belong to this launch. Preserve
        // unexpected contents instead of recursively deleting a computed path.
        for (const name of await fs.readdir(directory)) {
          if (name !== "attachment.json" && !/^ready\.\d+\.json$/.test(name))
            throw denial("native_attachment_cleanup_unconfirmed", true);
          await fs.unlink(path.join(directory, name));
        }
        await fs.rmdir(directory);
      })());
    },
  };
}
