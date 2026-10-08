const labels = {
  saved: "回答を保存済み · 対象の読取は未確認",
  read: "対象consumerが読取 · 適用待ち",
  started: "適用開始 · 結果待ち",
  succeeded: "入力適用を確認 · ACP応答あり",
  failed: "入力適用が中断 · ACP応答あり",
  unknown: "適用結果は不明 · 再送を停止",
  unapplied: "対象sessionが終了 · 未適用",
  invalidated: "回答は無効 · この版には適用できません",
};
const reasons = {
  native_prompt_completed: "元のCLIがこの回答入力の処理完了を返しました",
  native_prompt_cancelled: "元のCLIが取消しを返しました",
  native_prompt_refused: "元のCLIが拒否を返しました",
  native_prompt_limit: "元のCLIが入力処理の上限到達を返しました",
  native_result_missing: "対応する入力の結果ackがありません",
};
const observedReasons = {
  registered_owner_and_native_session: "同じrun/sessionの接続を確認",
  target_process_ended: "対象プロセスの終了を確認",
  consumer_connection_unverified: "consumerとの接続は未確認",
  target_not_observed: "対象の状態を照合できません",
  live_consumer_not_observed: "接続したconsumerの確認記録がありません",
};
const at = (value) =>
  value ? new Date(value).toLocaleString("ja-JP") : "未確認";
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
        `質問 ${command.question_id} の回答適用`,
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
      add("保存", at(command.saved_at));
      add(
        "通知の配送",
        command.delivery.length
          ? command.delivery
              .map(
                (item) =>
                  `${item.status === "delivered" ? "配送成功（読取・適用のackではありません）" : item.status === "retrying" ? "配送を再試行中" : "配送失敗"} · ${at(item.observed_at)}`,
              )
              .join(" / ")
          : "配送記録なし（対象の読取は別に確認します）",
      );
      add("対象consumerの読取", at(command.read_at));
      add("適用開始", at(command.started_at));
      add(
        "入力処理の結果",
        command.completed_at
          ? `${reasons[command.result_reason]} · ${at(command.completed_at)}`
          : command.result_reason
            ? reasons[command.result_reason]
            : "結果ackなし",
      );
      add(
        "対象の観測",
        `${observedReasons[command.target_observation.reason] || "照合不能"} · ${at(command.target_observation.observed_at)}`,
      );
      article.append(detail);
      if (command.display_phase === "unknown")
        article.append(
          node(
            "p",
            "このcommand IDは再送しません。run historyの対応する入力結果を照合してください。結果が見つからない場合は、元のsessionで状況を確認してから次の判断をします。",
            "sub",
          ),
        );
      if (command.display_phase === "unapplied")
        article.append(
          node(
            "p",
            "回答原本を保持しています。必要なら同じrun/sessionへ明示的に再接続してください。別sessionには転送しません。",
            "sub",
          ),
        );
      const context = node("details");
      context.append(
        node("summary", `対象と回答原本 · 版 ${command.contract_revision}`),
      );
      const ids = node("dl", undefined, "decision-details");
      for (const [label, value] of [
        ["consumer", command.consumer_id],
        ["run", command.run_id],
        ["session", command.session_id],
        ["command", command.command_id],
        ["native command", command.native_command_id || "未発行"],
      ])
        ids.append(node("dt", label), node("dd", value));
      context.append(ids, node("p", message?.answer || ""));
      article.append(context);
      return article;
    }),
  );
}
