import { formatDateTime, text } from "./locale.mjs";

const labels = Object.fromEntries(["saved", "read", "started", "succeeded", "failed", "unknown", "unapplied", "invalidated"].map((key) => [key, text(`answer.phase.${key}`)]));
const reasons = Object.fromEntries(["native_prompt_completed", "native_prompt_cancelled", "native_prompt_refused", "native_prompt_limit", "native_result_missing"].map((key) => [key, text(`answer.reason.${key}`)]));
const observedReasons = Object.fromEntries(["registered_owner_and_native_session", "target_process_ended", "consumer_connection_unverified", "target_not_observed", "live_consumer_not_observed"].map((key) => [key, text(`answer.observed.${key}`)]));
const at = (value) => value ? formatDateTime(value) : text("date.unconfirmed");
export function renderAnswerApplications(container, state, node) {
  const commands = Object.values(state.answer_applications?.commands || {})
    .reverse()
    .slice(0, 20);
  container.parentElement.hidden = commands.length === 0;
  container.replaceChildren(
    ...commands.map((command) => {
      const message = state.feedback.find(
        (item) => item.sequence === command.feedback_sequence,
      );
      const article = node("article", undefined, "decision-card reply-card");
      article.dataset.commandId = command.command_id;
      article.setAttribute(
        "aria-label",
        text("answer.label", { id: command.question_id }),
      );
      article.append(
        node("h3", message?.question || command.question_id),
        node(
          "p",
          labels[command.display_phase],
          ["unknown", "unapplied", "invalidated", "failed"].includes(
            command.display_phase,
          )
            ? "warn"
            : "reply-state",
        ),
      );
      const detail = node("dl", undefined, "decision-details");
      const add = (label, value) =>
        detail.append(node("dt", label), node("dd", value));
      add(text("answer.savedAt"), at(command.saved_at));
      add(
        text("answer.delivery"),
        command.delivery.length
          ? command.delivery
              .map(
                (item) =>
                  `${item.status === "delivered" ? text("answer.deliveryDelivered") : item.status === "retrying" ? text("answer.deliveryRetrying") : text("answer.deliveryFailed")} · ${at(item.observed_at)}`,
              )
              .join(" / ")
          : text("answer.deliveryNone"),
      );
      add(text("answer.readAt"), at(command.read_at));
      add(text("answer.startedAt"), at(command.started_at));
      add(
        text("answer.result"),
        command.completed_at
          ? `${reasons[command.result_reason]} · ${at(command.completed_at)}`
          : command.result_reason
            ? reasons[command.result_reason]
            : text("answer.noAck"),
      );
      add(
        text("answer.observation"),
        `${observedReasons[command.target_observation.reason] || text("answer.unmatched")} · ${at(command.target_observation.observed_at)}`,
      );
      article.append(detail);
      if (command.display_phase === "unknown")
        article.append(
          node(
            "p",
            text("answer.unknownHelp"),
            "sub",
          ),
        );
      if (command.display_phase === "unapplied")
        article.append(
          node(
            "p",
            text("answer.unappliedHelp"),
            "sub",
          ),
        );
      const context = node("details");
      context.append(
        node("summary", text("answer.original", { version: command.contract_revision })),
      );
      const ids = node("dl", undefined, "decision-details");
      for (const [label, value] of [
        ["consumer", command.consumer_id],
        ["run", command.run_id],
        ["session", command.session_id],
        ["command", command.command_id],
        ["native command", command.native_command_id || text("answer.unissued")],
      ])
        ids.append(node("dt", label), node("dd", value));
      context.append(ids, node("p", message?.answer || ""));
      article.append(context);
      return article;
    }),
  );
}
