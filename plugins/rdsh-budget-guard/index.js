import { randomUUID } from "node:crypto";

export const inject = ["llm"];
export const name = "rdsh-budget-guard";
export function createBudgetHook({ base, key, job_id, fetchImpl = fetch }) {
  const url = new URL(base);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !/^[a-f0-9]{64}$/.test(key) ||
    !/^[a-zA-Z0-9_.:-]{1,160}$/.test(job_id)
  )
    throw new Error("Budget guard requires a scoped loopback credential");
  async function request(action, body) {
    const response = await fetchImpl(
      new URL(`api/budget/producer/${action}`, url),
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: {
          "content-type": "application/json",
          "x-rdsh-budget-token": key,
        },
        body: JSON.stringify({ job_id, ...body }),
      },
    );
    if (!response.ok)
      throw new Error("Budget coordinator unavailable; new model call blocked");
    return response.json();
  }
  let ready;
  const initialize = () =>
    (ready ||= request("ready", {
      hook_version: 1,
      cli_version: "0.2.0-rc.2",
    }).then((receipt) => {
      if (receipt.ready !== true || receipt.job_id !== job_id)
        throw new Error("Budget hook registration not confirmed");
      return receipt;
    }));
  async function* stream(options, next) {
    // No prompt, message, credential or provider response content leaves the hook.
    // No retries: a lost admission response retains its reservation.
    await initialize();
    options.signal?.throwIfAborted();
    const call_id = randomUUID();
    const admission = await request("call", {
      call_id,
      session_id: options.sessionId ?? null,
      provider: options.provider,
      model: options.model,
      purpose: options.purpose ?? null,
    });
    if (admission.allowed !== true || admission.call_id !== call_id) {
      const error = new Error(`New model call blocked: ${admission.reason}`);
      error.code = "RDSH_BUDGET_DENIED";
      throw error; // middleware throw ends this native turn; no provider retry/downgrade
    }
    let outcome = "interrupted",
      tokens = null;
    try {
      options.signal?.throwIfAborted();
      for await (const chunk of next()) {
        if (chunk.type === "usage") {
          const usage = chunk.usage;
          tokens = {
            input: usage.inputTokens ?? null,
            cached_input: usage.cacheReadTokens ?? null,
            cache_write: usage.cacheWriteTokens ?? null,
            output: usage.outputTokens ?? null,
          };
        }
        if (chunk.type === "finish")
          outcome = ["error", "aborted"].includes(chunk.reason.kind)
            ? "failed"
            : "finished";
        yield chunk; // same request goes to next; chunks are passed through unchanged
      }
    } catch (error) {
      outcome = "failed";
      throw error;
    } finally {
      // Provider token usage does not imply a dollar price or a settled bill.
      // Failure here never releases money and never replays the original call.
      await request("finish", { call_id, outcome, tokens }).catch(() => {});
    }
  }
  return { initialize, stream };
}
export function apply(ctx) {
  const hook = createBudgetHook({
    base: process.env.RDSH_BUDGET_BASE,
    key: process.env.RDSH_BUDGET_KEY,
    job_id: process.env.RDSH_BUDGET_JOB,
  });
  ctx.on("llm/stream", hook.stream, { prepend: true });
  void hook.initialize().catch(() => {});
}
