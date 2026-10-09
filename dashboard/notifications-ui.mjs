const labels = {
  importance: { low: "低", normal: "通常", high: "高", critical: "最重要" },
  delivery: { ready: "通知対象", held: "静かな時間中に保留" },
  target: { question: "質問を開く", task: "タスクを開く", run: "実行イベントを確認", progress: "進捗履歴を開く", metrics: "数値詳細を開く" },
};

function node(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}

function date(value) {
  return value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString("ja-JP")
    : "日時未取得";
}

function targetId(item) {
  if (item.target.type === "question") return "question-" + item.target.id;
  if (item.target.type === "task") return "task-" + item.target.id;
  if (item.target.type === "run") return "notification-events-" + item.id;
  return item.target.id;
}

function targetLabel(item) {
  return labels.target[item.target.type] || "元の状態を開く";
}

export function createNotificationPanel({ api, refreshState, navigateTo }) {
  const panel = document.getElementById("notification-panel");
  const summary = document.getElementById("notifications-summary");
  const list = document.getElementById("notifications");
  const form = document.getElementById("notification-settings");
  const minimum = document.getElementById("notification-minimum");
  const quietEnabled = document.getElementById("notification-quiet-enabled");
  const quietStart = document.getElementById("notification-quiet-start");
  const quietEnd = document.getElementById("notification-quiet-end");
  const timeZone = document.getElementById("notification-time-zone");
  const settingsStatus = document.getElementById("notification-settings-status");
  let editing = false;

  form.addEventListener("input", () => {
    editing = true;
    settingsStatus.textContent = "未保存の設定があります。";
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const quiet_hours = quietEnabled.checked
      ? {
          start: quietStart.value,
          end: quietEnd.value,
          time_zone:
            timeZone.value.trim() ||
            Intl.DateTimeFormat().resolvedOptions().timeZone ||
            "UTC",
        }
      : null;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    settingsStatus.textContent = "設定を保存中…";
    try {
      await api("notifications/preferences", {
        minimum_importance: minimum.value,
        quiet_hours,
      });
      editing = false;
      settingsStatus.textContent = "設定を保存しました。";
      await refreshState();
    } catch (error) {
      settingsStatus.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  panel.addEventListener("click", async (event) => {
    const read = event.target.closest("button[data-notification-read]");
    if (read) {
      read.disabled = true;
      try {
        await api("notifications/read", {
          id: read.dataset.notificationRead,
          event_id: read.dataset.eventId,
        });
        await refreshState();
      } catch (error) {
        settingsStatus.textContent =
          error.message === "notification_changed"
            ? "通知の内容が更新されました。最新状態を読み直します。"
            : error.message;
        await refreshState();
      } finally {
        read.disabled = false;
      }
      return;
    }
    const target = event.target.closest("a[data-notification-target]");
    if (!target) return;
    event.preventDefault();
    navigateTo(target.dataset.notificationTarget);
  });

  return (state) => {
    const value = state?.notifications;
    if (!value) {
      summary.textContent = "通知を取得できません。人間用のプロジェクト接続で開き直してください。";
      list.replaceChildren();
      return;
    }
    summary.textContent =
      `未読 ${value.unread_count}件 · 通知対象 ${value.ready_unread_count}件 · ` +
      `静かな時間中 ${value.held_unread_count}件を保留 · ` +
      `重要度設定で ${value.filtered_unread_count}件を省略` +
      (value.source_status?.run_history !== "available"
        ? ` · 実行履歴が${value.source_status?.run_history === "incomplete" ? "不完全" : "読めず"}、実行通知は未確認`
        : "");
    if (!editing) {
      const preferences = value.preferences;
      minimum.value = preferences.minimum_importance;
      quietEnabled.checked = Boolean(preferences.quiet_hours);
      if (preferences.quiet_hours) {
        quietStart.value = preferences.quiet_hours.start;
        quietEnd.value = preferences.quiet_hours.end;
        timeZone.value = preferences.quiet_hours.time_zone;
      } else if (!timeZone.value) {
        timeZone.value = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      }
    }

    list.replaceChildren(
      ...value.items.map((item) => {
        const article = node("article", undefined, "event notification-item");
        article.dataset.deliveryState = item.delivery_state;
        const heading = node("div", undefined, "notification-heading");
        heading.append(node("strong", item.title));
        const badges = node("div", undefined, "notification-actions");
        badges.append(
          node("span", labels.importance[item.importance] || item.importance, "notification-badge"),
          node(
            "span",
            item.delivery_state === "held"
              ? labels.delivery.held
              : item.unread
                ? labels.delivery.ready
                : "既読",
            "notification-badge",
          ),
        );
        heading.append(badges);
        article.append(heading, node("p", item.summary));
        if (item.source_event_count > 1)
          article.append(
            node("p", `同じ対象の ${item.source_event_count} 件を1件にまとめています。`, "sub"),
          );
        article.append(node("p", `更新: ${date(item.created_at)}`, "sub"));
        const actions = node("div", undefined, "notification-actions");
        const link = node("a", targetLabel(item), "button");
        link.href = "#" + encodeURIComponent(targetId(item));
        link.dataset.notificationTarget = targetId(item);
        actions.append(link);
        if (item.unread) {
          const button = node("button", "既読にする");
          button.type = "button";
          button.setAttribute("aria-label", `既読にする: ${item.title}`);
          button.dataset.notificationRead = item.id;
          button.dataset.eventId = item.event_id;
          actions.append(button);
        } else {
          actions.append(node("span", `既読: ${date(item.read_at)}`, "sub"));
        }
        article.append(actions);
        if (item.source_event_ids?.length) {
          const details = node("details");
          if (item.target.type === "run") details.id = "notification-events-" + item.id;
          details.append(
            node(
              "summary",
              `元イベントID ${item.source_event_count > item.source_event_ids.length ? `（直近 ${item.source_event_ids.length}件）` : ""}`,
            ),
            node(
              "code",
              item.source_events?.length
                ? item.source_events
                    .map((source) =>
                      [
                        date(source.observed_at),
                        source.type,
                        source.state ? `→ ${source.state}` : "",
                        source.reason || "",
                        source.event_id,
                      ]
                        .filter(Boolean)
                        .join(" · "),
                    )
                    .join("\n")
                : item.source_event_ids.join("\n"),
            ),
          );
          article.append(details);
        }
        return article;
      }),
    );
    if (!value.items.length)
      list.append(node("div", "通知対象の更新はありません。", "empty"));
    if (value.truncated)
      list.append(node("p", "表示件数を200件に制限しています。重要度と新しさの高い通知を表示中です。", "sub"));
  };
}
