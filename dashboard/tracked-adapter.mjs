// Durable control requests around an existing adapter; no agent loop or replay.
import { HistoryError } from "./run-history.mjs";

export function trackAdapter(
  adapter,
  history,
  runId,
  exitWrites,
  beforeSend = null,
) {
  const send = adapter.send.bind(adapter),
    interrupt = adapter.interrupt.bind(adapter),
    stop = adapter.stop.bind(adapter);
  const unknown = async (id) => {
    try {
      await history.commandPhase(id, "unknown");
    } catch {
      /* Preserve the last readable prefix. */
    }
    try {
      await history.transition(runId, "unknown", "operation_unconfirmed");
    } catch {}
  };
  adapter.send = async (sessionId, text) => {
    adapter.requireOperation("send", sessionId);
    if (beforeSend) await beforeSend(sessionId);
    const id = await history.recordCommand(runId, "send");
    await history.transition(runId, "running", "cli_prompt_pending");
    await history.commandPhase(id, "dispatched");
    try {
      const result = await send(sessionId, text);
      await history.commandPhase(
        id,
        "acknowledged",
        result.stop_reason === "cancelled"
          ? "cancelled_result"
          : "prompt_result_received",
      );
      if (!adapter.stopped && !adapter.stopping)
        await history.transition(runId, "waiting-human", "cli_prompt_result");
      return { ...result, command_id: id };
    } catch (error) {
      await unknown(id);
      throw error;
    }
  };
  adapter.interrupt = async (sessionId) => {
    adapter.requireOperation("interrupt", sessionId);
    const id = await history.recordCommand(runId, "interrupt");
    await history.commandPhase(id, "dispatched");
    try {
      const result = await interrupt(sessionId);
      // ACP cancel is a notification with no request ID or correlated ack.
      await history.commandPhase(id, "notification_sent");
      return { ...result, command_id: id };
    } catch (error) {
      await unknown(id);
      throw error;
    }
  };
  let stopping;
  adapter.stop = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      let id,
        writeError = null;
      if (!adapter.stopped) {
        try {
          id = await history.recordCommand(runId, "stop");
          await history.transition(runId, "stopping", "owned_stop_requested");
          await history.commandPhase(id, "dispatched");
        } catch (error) {
          writeError = error;
        }
      }
      // A log failure must never prevent cleanup of this client's owned child.
      let result;
      try {
        result = await stop();
      } catch (error) {
        if (id) await unknown(id);
        throw error;
      }
      await exitWrites.flush();
      if (exitWrites.error) writeError ||= exitWrites.error;
      if (id && !writeError) {
        try {
          await history.commandPhase(
            id,
            "acknowledged",
            "process_exit_confirmed",
          );
          await history.processExited(runId);
        } catch (error) {
          writeError = error;
        }
      }
      if (writeError) {
        const error = new HistoryError("history_unconfirmed_after_owned_stop");
        error.process_result = result;
        throw error;
      }
      return id ? { ...result, command_id: id } : result;
    })();
    return stopping;
  };
  return adapter;
}
