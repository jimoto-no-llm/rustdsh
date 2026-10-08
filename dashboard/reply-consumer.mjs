import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  replyCheck,
  finalReplyPhases,
  replyPrompt,
} from "./answer-applications.mjs";

// A transport consumer around the original ACP client, not an agent loop.
// Native result history and the dashboard claim use a shared preallocated ID.
export class ReplyConsumer {
  static async open({ project, attached, fetchImpl = fetch }) {
    const runtime = JSON.parse(
      await fs.readFile(path.join(project.directory, "runtime.json"), "utf8"),
    );
    const url = new URL(runtime.local_url);
    replyCheck(
      runtime.schema === 1 &&
        runtime.kind === "project" &&
        runtime.project_id === project.id &&
        url.protocol === "http:" &&
        url.hostname === "127.0.0.1" &&
        url.port &&
        url.pathname === "/" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        /^[0-9a-f]{64}$/.test(runtime.token),
      "Local dashboard runtime does not match this project",
      400,
    );
    const client = new ReplyConsumer(project, attached, url.href, fetchImpl);
    const result = await client.request(
      "register",
      {
        run_id: attached.record.run_id,
        session_id: attached.record.cli_session_id,
        owner_id: attached.history.owner_id,
      },
      { authorization: `Bearer ${runtime.token}` },
    );
    client.consumer = result.consumer;
    client.token = result.token;
    return client;
  }
  constructor(project, attached, url, fetchImpl) {
    this.project = project;
    this.attached = attached;
    this.url = url;
    this.fetch = fetchImpl;
    this.cursor = 0;
    this.controlIntervalMs = 500;
  }
  async request(route, input, headers) {
    const response = await this.fetch(`${this.url}api/replies/${route}`, {
      method: input ? "POST" : "GET",
      headers: {
        "content-type": "application/json",
        ...(headers || { "x-rdsh-consumer-token": this.token }),
      },
      body: input ? JSON.stringify(input) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    replyCheck(
      response.ok,
      result.error || "Answer consumer request failed",
      response.status,
    );
    return result;
  }
  read(after = this.cursor) {
    return this.request(
      `read?consumer_id=${encodeURIComponent(this.consumer.consumer_id)}&after=${after}`,
    );
  }
  ack(commandId, phase, extra = {}) {
    return this.request("ack", {
      consumer_id: this.consumer.consumer_id,
      command_id: commandId,
      phase,
      ...extra,
    });
  }
  control(commandId, phase, extra = {}) {
    return this.request("control", {
      consumer_id: this.consumer.consumer_id,
      command_id: commandId,
      phase,
      ...extra,
    });
  }
  async watchInterrupt(commandId, nativeId, signal) {
    while (!signal.aborted) {
      await delay(this.controlIntervalMs, undefined, { signal }).catch(
        () => {},
      );
      if (signal.aborted) break;
      try {
        const read = await this.read();
        for (const control of read.controls || []) {
          if (signal.aborted) break;
          if (
            control.target_command_id !== commandId ||
            control.target_native_command_id !== nativeId ||
            control.phase !== "pending"
          )
            continue;
          // This monitor only controls its own awaited prompt. A stale target
          // cannot cancel a subsequent prompt after the current one returns.
          if (!this.attached.adapter.prompts.has(this.consumer.session_id))
            continue;
          const cancelId = "cmd_" + randomUUID();
          const claim = await this.control(control.command_id, "begin", {
            native_command_id: cancelId,
          });
          if (!claim.claimed) continue;
          if (
            signal.aborted ||
            !this.attached.adapter.prompts.has(this.consumer.session_id)
          ) {
            await this.control(control.command_id, "unknown");
            continue;
          }
          try {
            await this.attached.adapter.interrupt(this.consumer.session_id, {
              command_id: cancelId,
            });
            await this.control(control.command_id, "reconcile");
          } catch {
            await this.control(control.command_id, "unknown").catch(() => {});
          }
        }
      } catch {
        // Losing the control response never grants a second cancel effect.
        // The durable claim remains pending/unknown for exact reconciliation.
      }
    }
  }
  async apply(message) {
    replyCheck(
      message.consumer_id === this.consumer.consumer_id &&
        message.target?.run_id === this.attached.record.run_id &&
        message.target?.session_id === this.attached.record.cli_session_id,
      "Answer targets a different native session",
    );
    const id = message.reply_command_id;
    if (
      message.source_kind === "instruction" &&
      message.effective_mode === "interrupt"
    )
      await this.control(id, "reconcile");
    if (message.contract_validity !== "current") {
      if (["started", "unknown"].includes(message.application.phase)) {
        const result = await this.ack(id, "reconcile");
        return {
          ...result.command,
          phase: finalReplyPhases.includes(result.command.phase)
            ? "invalidated"
            : "unknown",
        };
      }
      return { command_id: id, phase: "invalidated" };
    }
    if (
      ["started", "unknown", ...finalReplyPhases].includes(
        message.application.phase,
      )
    ) {
      const result = await this.ack(id, "reconcile");
      return {
        ...result.command,
        phase: finalReplyPhases.includes(result.command.phase)
          ? result.command.phase
          : "unknown",
      };
    }
    await this.ack(id, "read");
    const attempt = "attempt_" + randomUUID(),
      nativeId = "cmd_" + randomUUID();
    let claim;
    try {
      claim = await this.ack(id, "begin", {
        attempt_id: attempt,
        native_command_id: nativeId,
      });
    } catch {
      // A successful commit followed by response loss must not cause a send.
      await this.ack(id, "unknown", { attempt_id: attempt }).catch(() => {});
      return {
        command_id: id,
        phase: "unknown",
        result_reason: "claim_response_unverified",
      };
    }
    if (!claim.claimed) {
      if (claim.waiting_for)
        return {
          command_id: id,
          phase: "queued",
          waiting_for: claim.waiting_for,
          result_reason: claim.reason,
        };
      const result = await this.ack(id, "reconcile");
      return {
        ...result.command,
        phase: finalReplyPhases.includes(result.command.phase)
          ? result.command.phase
          : "unknown",
      };
    }
    const prompt = replyPrompt(message, this.consumer);
    const controller = new AbortController();
    const monitor = this.watchInterrupt(id, nativeId, controller.signal);
    try {
      await this.attached.adapter.send(this.consumer.session_id, prompt, {
        command_id: nativeId,
      });
    } catch {
      await this.ack(id, "unknown", { attempt_id: attempt }).catch(() => {});
      return {
        command_id: id,
        phase: "unknown",
        result_reason: "native_result_missing",
      };
    } finally {
      controller.abort();
      await monitor;
    }
    try {
      return (await this.ack(id, "reconcile")).command;
    } catch {
      return {
        command_id: id,
        phase: "unknown",
        result_reason: "result_ack_missing",
      };
    }
  }
  async poll() {
    const result = await this.read(),
      processed = [];
    for (const message of result.messages) {
      const applied = await this.apply(message);
      processed.push({
        command_id: applied.command_id,
        phase: applied.phase,
        native_command_id: applied.native_command_id || null,
        result_reason: applied.result_reason || null,
        ...(applied.waiting_for ? { waiting_for: applied.waiting_for } : {}),
      });
      if (["unknown", "queued"].includes(applied.phase))
        return { processed, next_cursor: this.cursor, blocked: true };
      this.cursor = message.sequence;
    }
    this.cursor = Math.max(this.cursor, result.next_cursor);
    return { processed, next_cursor: this.cursor, blocked: false };
  }
}
