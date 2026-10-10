import { providerStatusView } from "./provider-status.mjs";

export function renderProviderStatuses(container, statuses, node, now = Date.now()) {
  const records = Array.isArray(statuses) ? statuses : [];
  if (!records.length) {
    container.replaceChildren(
      node("p", "provider側から利用枠・再試行情報はまだ報告されていません。", "sub"),
    );
    return;
  }
  const sorted = records.slice().sort(
    (a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at),
  );
  container.replaceChildren(...sorted.map((record) => {
    const view = providerStatusView(record, now);
    const entry = node("article", undefined, "event provider-status-entry");
    entry.append(
      node("strong", `${record.provider_id} · ${record.scope_id}`),
      node("p", `${view.label} · ${view.freshnessLabel}`),
      node("p", view.quota),
      node("p", view.retryMessage),
      node("p", view.nextAction),
      node(
        "p",
        `${record.kind === "measured" ? "provider応答" : "agent報告"} · ${record.source} · 観測 ${view.observedLabel}` +
          (record.reference ? ` · 参照 ${record.reference}` : ""),
        "sub",
      ),
    );
    if (record.reason_code)
      entry.append(node("p", `理由コード: ${record.reason_code}`, "sub"));
    return entry;
  }));
}
