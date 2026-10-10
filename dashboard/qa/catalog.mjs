// These are QA routes, not runtime capabilities or permission grants.
export const operations = [
  ["answer", "回答と結果確認", "回答を送信し、画面の回答と耐久feedbackが1件であることを確認する。"],
  ["keyboard", "キーボード操作", "マウスなしで回答欄へ移動・入力・送信し、結果とfocusを確認する。"],
  ["sse-draft", "入力中のSSE更新", "回答下書きへfocusを置いて進捗を更新し、本文・focus・未送信を確認する。"],
  ["reload", "再読込", "未送信の下書きを入力して再読込し、下書きの消失と回答の有無を記録する。"],
  ["back", "戻る操作", "未送信の下書きを入力して別ページへ移動し、戻った後の本文・回答・認証状態を確認する。"],
  ["cancel", "操作の取消", "回答下書きからコマンドパレットを開き、Escapeで閉じて本文・focus・未送信を確認する（質問取消ではない）。"],
  ["double-submit", "二度押し", "送信を保留して二度押しし、SSE更新後の再送も試す。POST数と耐久回答件数を分けて記録する。"],
  ["disconnect-before", "受理前の切断", "次の回答をサーバーへ渡す前に接続を切る。下書きとfeedback 0件を確認し、再接続後の再送で1件になるか確認する。"],
  ["disconnect-after", "保存後の応答消失", "回答保存後に応答とSSEを失わせ、再接続後の回答表示・下書き・耐久回答件数を確認する。"],
];
const routes = {
  local: "ローカルloopback",
  wsl: "WSL内サーバーへの接続",
  tailscale: "Tailscale Serve経由",
};
export const cases = [];
for (const route of Object.keys(routes)) for (const device of ["desktop", "mobile"]) {
  for (const [operation, title, procedure] of operations) cases.push({
    id: `project-${device}-${route}-${operation}`,
    surface: "Project dashboard", feature: operation === "cancel" ? "コマンドパレットと回答下書き" : "人間の質問・回答",
    device, input: operation === "answer" ? "任意（入力方法を限定しない基本回答）" :
      operation === "keyboard" || operation === "cancel" ? "keyboard" : "pointer/touch",
    route, connection: routes[route], operation, title, procedure,
    minimumLevel: route === "local" ? "browser" : "real-connection",
    prerequisites: route === "local" ? "Node 22+、隔離したproject、実ブラウザー。mobile viewportは実機phoneと区別する。" :
      route === "wsl" ? "WSL内で起動した実サーバーへブラウザーから到達できる環境。ローカルproxy試験では代用不可。" :
        "PC/端末の実Tailscale接続と認証済みServe経路。ローカルproxy試験では代用不可。",
  });
}
cases.push({id:"project-api-fixture",surface:"Project dashboard",feature:"HTTP/MCP状態とfeedback",device:"none",input:"API",route:"fixture",connection:"ローカルAPI fixture",operation:"api-regression",title:"既存API回帰",procedure:"npm testの実行結果とコマンドを保存する。ブラウザー操作の確認には使わない。",minimumLevel:"fixture",prerequisites:"Node 22+とdashboard dependencies。"});
for (const device of ["desktop", "mobile"]) cases.push({
  id:`harness-${device}-wsl-tailscale`,surface:"DSH Harness Web UI",feature:"既存Harnessの起動と接続",device,input:"pointer/touch",route:"wsl-tailscale",connection:"WSL上のDSH + Tailscale Serve",operation:"harness-connect",title:"別モードの実接続",procedure:"rdsh-dashboard harnessから元DSH Web UIを開き、対象と接続を確認する。Project質問fixtureの成功を転記しない。",minimumLevel:"real-connection",prerequisites:"既存DSH/WSL/実Tailscale経路と端末。モデル実行はこの接続確認の対象外。",
});
