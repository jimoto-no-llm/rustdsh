const labels = {
  ready: "確認済み",
  observed: "成功を観測",
  failed: "失敗を観測",
  unconfirmed: "未確認",
  stopped: "停止を観測",
  stale_credentials: "古い認証を保持",
  unreachable: "到達できない",
  not_ready: "準備未完了",
  disabled: "共有無効",
  not_installed: "未インストール",
  login_required: "ログイン待ち",
  dns_required: "DNS設定待ち",
  route_missing: "共有経路なし",
};
const time = (value) =>
  value ? new Date(value).toLocaleString("ja-JP") : "未取得";
export function diagnosticRows(report) {
  const browser = report.browser,
    dot = report.dot;
  return [
    {
      group: "スマホ閲覧",
      label: "dashboard",
      value: { ...browser.dashboard, observed_at: report.observed_at },
      recovery: "このPCのdashboardは応答しています。",
    },
    {
      group: "スマホ閲覧",
      label: "閲覧の認証",
      value: browser.authentication,
      recovery:
        browser.authentication.state === "failed"
          ? "最新のQRまたは rdsh-dashboard open から開き直してください。"
          : "観測した端末の経路を表示します。端末の種類は判定しません。",
    },
    {
      group: "スマホ閲覧",
      label: "Tailscale Serve",
      value: browser.tailscale,
      recovery:
        browser.tailscale.state === "ready"
          ? "このPCの共有設定を確認済み。スマホ側のTailscale接続は別途確認してください。"
          : "スマホとこのPCのTailscale接続を確認し、共有が必要なら「接続を更新」を使ってください。",
    },
    {
      group: "スマホ閲覧",
      label: "実際のスマホ到達",
      value: browser.phone,
      recovery: "スマホでQRを開き、対象と最新の表示を確認してください。",
    },
    {
      group: "Dot連携",
      label: "Secure MCP Tunnel",
      value: dot.tunnel,
      recovery:
        dot.tunnel.state === "stale_credentials"
          ? "dashboard再起動で認証が更新されています。実行中のTunnelを止め、同じ tunnel コマンドを再実行してください。"
          : dot.tunnel.state === "ready"
            ? "ローカルの /healthz と /readyz が200。Dotの応答はまだ確認できません。"
            : "dashboardを先に起動し、Tunnelコマンドとローカルのヘルス状態を確認してください。",
    },
    {
      group: "Dot連携",
      label: "MCPの認証",
      value: dot.authentication,
      recovery:
        dot.authentication.state === "failed"
          ? "Tunnelを再起動し、手動設定したMCPクライアントは最新の接続設定を読み直してください。"
          : "認証成功はMCPクライアントの観測です。Dotかどうかは判定しません。",
    },
    {
      group: "Dot連携",
      label: "MCPの発見",
      value: dot.discovery,
      recovery: "ChatGPTの接続からサーバーの発見を実行してください。",
    },
    {
      group: "Dot連携",
      label: "tools/list",
      value: dot.tools,
      recovery:
        "接続からツールを取得してください。既存の6ツールを維持しています。",
    },
    {
      group: "Dot連携",
      label: "events/list",
      value: dot.events,
      recovery: "Events対応の接続からイベントを取得してください。",
    },
    {
      group: "Dot連携",
      label: "コールバックの検証",
      value: dot.verification,
      recovery:
        "失敗時は受信先のHTTPS・署名検証・challenge応答を確認して購読し直してください。",
    },
    {
      group: "Dot連携",
      label: "署名付きイベントの配送",
      value: dot.callback,
      recovery:
        "2xxは受信先の受付です。失敗時は受信先、署名鍵、購読期限を確認してください。",
    },
    {
      group: "Dot連携",
      label: "Dotの実際の応答",
      value: dot.response,
      recovery:
        "実際の質問→人の回答→署名付きイベント→Dotの応答を、対象の会話で確認してください。",
    },
  ];
}
export function renderConnectionDiagnostics(container, report, node) {
  container.replaceChildren();
  container.append(
    node(
      "p",
      `取得日時: ${time(report.observed_at)} · 接続全体: 未確認`,
      "notice",
    ),
  );
  for (const group of ["スマホ閲覧", "Dot連携"]) {
    const section = node("section", undefined, "card");
    section.append(node("h3", group));
    for (const row of diagnosticRows(report).filter(
      (item) => item.group === group,
    )) {
      const block = node("div", undefined, "diagnostic-stage");
      block.append(
        node("strong", `${row.label} · ${labels[row.value.state] || "未確認"}`),
        node("p", row.recovery, "sub"),
        node(
          "p",
          `観測: ${time(row.value.observed_at)}${row.value.channel ? " · 経路: " + row.value.channel : ""}${row.value.reason ? " · " + row.value.reason : ""}`,
          "sub",
        ),
      );
      if (row.value.last_success !== undefined)
        block.append(
          node(
            "p",
            `最後の成功: ${time(row.value.last_success)} · 最後の失敗: ${time(row.value.last_failure)}`,
            "sub",
          ),
        );
      section.append(block);
    }
    if (group === "Dot連携") {
      const subscriptions = report.dot.subscriptions;
      section.append(
        node(
          "p",
          `イベント購読: 有効 ${subscriptions.active}件 · 期限切れ ${subscriptions.expired}件（取得時点）`,
        ),
      );
      for (const item of subscriptions.items)
        section.append(
          node(
            "p",
            `${item.event} · ${item.state === "active" ? "有効" : "期限切れ"} · 期限: ${time(item.expires_at)}`,
            "sub",
          ),
        );
    }
    container.append(section);
  }
}
