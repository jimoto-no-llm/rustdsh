import { levels, reportRows, statuses } from "./report.mjs";

const escapeHTML = value => String(value).replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);
const stateLabels = { pass: "確認済み", fail: "不具合あり", blocked: "実施できず", "not-run": "未実施" };
const deviceLabels = { desktop: "PC", mobile: "Phone / mobile viewport", none: "端末なし（API）" };
const levelLabels = { fixture: "fixture（API / 模擬）", browser: "browser（実ブラウザー）", "real-connection": "real-connection（実接続）" };
const unknown = "未取得";

function select(id, title, choices) {
  return `<label for="${id}">${title}<select id="${id}" name="${id}"><option value="">すべて</option>${choices.map(([value, label]) => `<option value="${escapeHTML(value)}">${escapeHTML(label)}</option>`).join("")}</select></label>`;
}

function measurement(value, boolean = false) {
  if (value === undefined || value === null) return unknown;
  return boolean ? (value ? "あり" : "なし") : `${value}件`;
}

function details(row) {
  const observation = row.observations || {};
  const environment = row.environment ? `<dl class="environment">${Object.entries(row.environment).map(([key, value]) => `<dt>${escapeHTML(key)}</dt><dd>${escapeHTML(value)}</dd>`).join("")}</dl>` : unknown;
  const evidence = row.evidence?.length ? `<ul>${row.evidence.map(reference => `<li><a href="${escapeHTML(reference)}">${escapeHTML(reference)}</a></li>`).join("")}</ul>` : unknown;
  return `<details><summary>手順・観測・証拠</summary><div class="details-body">
    <p class="case-id">${escapeHTML(row.id)}</p>
    <dl class="detail-list">
      <dt>前提条件</dt><dd>${escapeHTML(row.prerequisites)}</dd>
      <dt>確認手順</dt><dd>${escapeHTML(row.procedure)}</dd>
      <dt>必要な証拠の水準</dt><dd>${escapeHTML(levelLabels[row.minimumLevel])}</dd>
      <dt>実際に確認した経路</dt><dd>${escapeHTML(row.observed_route ?? unknown)}</dd>
      <dt>実施日時（UTC）</dt><dd>${row.tested_at ? `<time datetime="${escapeHTML(row.tested_at)}">${escapeHTML(row.tested_at)}</time>` : unknown}</dd>
      <dt>実行環境</dt><dd>${environment}</dd>
      <dt>実行コマンド</dt><dd><pre>${escapeHTML(row.command ?? unknown)}</pre></dd>
      <dt>入力消失</dt><dd>${measurement(observation.input_lost, true)}</dd>
      <dt>重複回答</dt><dd>${measurement(observation.duplicate_answers)}</dd>
      <dt>回答POST数</dt><dd>${measurement(observation.answer_requests)}</dd>
      <dt>耐久feedback件数</dt><dd>${measurement(observation.feedback_count)}</dd>
      <dt>Focus保持</dt><dd>${observation.focus_preserved === undefined || observation.focus_preserved === null ? unknown : observation.focus_preserved ? "保持" : "保持されず"}</dd>
      <dt>観測メモ</dt><dd>${escapeHTML(observation.detail ?? unknown)}</dd>
      <dt>証拠ファイル（このHTMLからの相対リンク）</dt><dd>${evidence}</dd>
    </dl>
  </div></details>`;
}

function resultRow(row) {
  return `<tr class="result-row" data-status="${escapeHTML(row.status)}" data-device="${escapeHTML(row.device)}" data-operation="${escapeHTML(row.operation)}" data-route="${escapeHTML(row.route)}" data-level="${escapeHTML(row.level ?? "unrecorded")}">
    <td><strong>${escapeHTML(row.connection)}</strong><div class="sub">${escapeHTML(deviceLabels[row.device])}</div><div class="sub">${escapeHTML(row.surface)}</div></td>
    <td>${escapeHTML(row.feature)}</td>
    <td>${escapeHTML(row.title)}<div class="sub">入力: ${escapeHTML(row.input)}</div></td>
    <td><span class="status ${escapeHTML(row.status)}">${escapeHTML(stateLabels[row.status])}</span><div class="sub">${escapeHTML(row.status)}</div></td>
    <td>${escapeHTML(row.level ? levelLabels[row.level] : unknown)}</td>
    <td>入力消失: ${measurement(row.observations?.input_lost, true)}<br>重複回答: ${measurement(row.observations?.duplicate_answers)}</td>
    <td><p class="reason">${escapeHTML(row.reason)}</p>${details(row)}</td>
  </tr>`;
}

export function renderReport(report) {
  const rows = reportRows(report);
  const counts = Object.fromEntries(statuses.map(status => [status, rows.filter(row => row.status === status).length]));
  const uniqueChoices = (key, label) => [...new Map(rows.map(row => [row[key], label(row)])).entries()];
  const inputObservations = rows.filter(row => typeof row.observations?.input_lost === "boolean");
  const duplicateObservations = rows.filter(row => Number.isSafeInteger(row.observations?.duplicate_answers));
  const inputSummary = inputObservations.length ? `${inputObservations.filter(row => row.observations.input_lost).length}セルで消失 / ${inputObservations.length}セルを観測` : unknown;
  const duplicateSummary = duplicateObservations.length ? `${duplicateObservations.filter(row => row.observations.duplicate_answers > 0).length}セルで発生 / ${duplicateObservations.length}セルを観測` : unknown;
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>QA確認レポート — Project dashboard / DSH Harness</title>
  <style>
    :root { color-scheme: light; --bg: #f7f7f4; --card: #fff; --line: #deded8; --fg: #22231f; --mut: #62655c; --green: #39714d; --red: #a23828; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    body { margin: 0; color: var(--fg); background: var(--bg); font: 15px/1.6 system-ui, -apple-system, "Segoe UI", "Yu Gothic", sans-serif; }
    main { max-width: 1600px; margin: auto; padding: 32px; }
    h1 { margin: 4px 0 10px; font-size: 28px; letter-spacing: -.02em; }
    h2 { font-size: 20px; margin: 0 0 14px; }
    p { margin: 0 0 12px; }
    .eyebrow { color: var(--mut); font-size: 12px; font-weight: 700; letter-spacing: .12em; }
    .sub { color: var(--mut); font-size: 13px; }
    .panel { padding: 22px; border: 1px solid var(--line); border-radius: 14px; background: var(--card); margin-top: 22px; }
    .target { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 18px; margin: 0; }
    dt { color: var(--mut); font-weight: 600; }
    dd { margin: 0; min-width: 0; }
    code, pre, .case-id { font-family: ui-monospace, "Cascadia Code", monospace; font-size: 13px; }
    code, dd, p, td { overflow-wrap: anywhere; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
    .cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; margin: 18px 0; }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px 20px; }
    .value { display: block; font-size: 32px; font-weight: 700; line-height: 1.4; }
    .status { display: inline-block; border: 1px solid var(--line); border-radius: 6px; padding: 1px 8px; white-space: nowrap; font-size: 14px; }
    .card .status { white-space: normal; overflow-wrap: anywhere; }
    .pass { color: var(--green); background: #edf5ef; }
    .fail { color: var(--red); background: #fff0eb; }
    .blocked { color: #795115; background: #fff5df; }
    .not-run { color: #585b53; background: #f1f2ef; }
    .measurements { display: flex; flex-wrap: wrap; gap: 12px 32px; }
    .measurements p { margin: 0; }
    fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
    legend { font-size: 20px; font-weight: 700; padding: 0; margin-bottom: 14px; }
    .filters { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; }
    label { display: block; color: var(--mut); font-size: 14px; }
    select { display: block; width: 100%; min-width: 0; margin-top: 5px; padding: 9px; border: 1px solid var(--line); border-radius: 8px; color: var(--fg); background: white; font: inherit; }
    button { padding: 9px 15px; border: 1px solid var(--green); border-radius: 8px; background: var(--green); color: white; font: inherit; cursor: pointer; }
    button:hover { background: #2d5b3d; }
    button:disabled { cursor: default; opacity: .55; }
    button:focus-visible, select:focus-visible, a:focus-visible, summary:focus-visible, .table-box:focus-visible { outline: 3px solid #386ed6; outline-offset: 3px; }
    .filter-footer { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; margin-top: 16px; }
    .filter-footer p { margin: 0; }
    .table-box { overflow-x: auto; border: 1px solid var(--line); border-radius: 14px; background: white; margin-top: 22px; }
    table { border-collapse: collapse; width: 100%; min-width: 1120px; text-align: left; table-layout: fixed; }
    caption { text-align: left; padding: 16px 18px; font-weight: 700; }
    th, td { border-top: 1px solid var(--line); padding: 13px 16px; vertical-align: top; }
    th { color: var(--mut); font-size: 14px; background: #fafaf8; }
    th:nth-child(1) { width: 15%; } th:nth-child(2) { width: 12%; } th:nth-child(3) { width: 12%; } th:nth-child(4) { width: 10%; } th:nth-child(5) { width: 12%; } th:nth-child(6) { width: 12%; } th:nth-child(7) { width: 27%; }
    .reason { white-space: pre-wrap; }
    summary { cursor: pointer; color: var(--green); border-top: 1px solid var(--line); padding-top: 8px; }
    .details-body { margin-top: 12px; }
    .detail-list { margin: 0; }
    .detail-list > dt { margin-top: 14px; }
    .detail-list > dd { margin-top: 3px; white-space: pre-wrap; }
    .environment { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 2px 10px; margin: 0; }
    ul { padding-left: 20px; margin: 0; }
    a { color: var(--green); text-underline-offset: 3px; }
    .empty { padding: 22px; }
    footer { margin-top: 20px; color: var(--mut); font-size: 13px; }
    @media (max-width: 900px) { main { padding: 20px; } .filters { grid-template-columns: repeat(2, minmax(0, 1fr)); } .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 520px) { main { padding: 14px; } h1 { font-size: 24px; } .panel { padding: 16px; } .filters { grid-template-columns: minmax(0, 1fr); } .target { grid-template-columns: minmax(0, 1fr); gap: 2px; } .target dd { margin-bottom: 12px; } .cards { gap: 8px; } .card { padding: 12px; } }
    @media print { main { padding: 0; } .filter-panel { display: none; } .table-box { overflow: visible; } table { min-width: 0; font-size: 10px; } th, td { padding: 6px; } .card { break-inside: avoid; } }
  </style>
</head>
<body>
<main>
  <header>
    <div class="eyebrow">QA REPORT / 検証記録</div>
    <h1>Project dashboard / DSH Harness 確認レポート</h1>
    <p class="sub">開発用のQAレポートです。対象版・接続経路・証拠の水準ごとに確認結果を記録します。</p>
  </header>
  <section class="panel" aria-labelledby="target-heading">
    <h2 id="target-heading">対象版</h2>
    <dl class="target">
      <dt>Git SHA</dt><dd><code>${escapeHTML(report.target.sha)}</code></dd>
      <dt>作業ツリー</dt><dd>${report.target.dirty ? "dirty: true — 未コミットの変更を含む" : "dirty: false — 記載SHAのcheckout"}</dd>
      <dt>対象の補足</dt><dd>${escapeHTML(report.target.note)}</dd>
    </dl>
  </section>
  <section class="panel" aria-labelledby="scope-heading">
    <h2 id="scope-heading">証拠の読み方</h2>
    <p>fixtureはAPI・模擬環境の回帰確認、browserは実ブラウザーの操作確認、real-connectionは記載経路の実接続確認です。通常のログやfixtureの成功だけで、実ブラウザー・WSL・Tailscale・Phoneを確認済みにはできません。</p>
    <p>mobile viewportはPCブラウザーの表示幅による確認です。実機Phoneの実接続とは区別し、実行環境を詳細に記録します。Project dashboardとDSH Harness Web UIは別の対象です。</p>
    <p class="sub">確認済み（pass）には対象経路に必要な証拠を伴います。実施できず（blocked）と未実施（not-run）は未確認です。観測値の未取得を「消失なし」「重複0件」として扱いません。</p>
  </section>
  <section aria-labelledby="summary-heading">
    <h2 id="summary-heading" style="margin-top:24px">全${rows.length}セルの状態</h2>
    <div class="cards">${statuses.map(status => `<div class="card"><span class="status ${escapeHTML(status)}">${escapeHTML(stateLabels[status])} / ${escapeHTML(status)}</span><span class="value">${counts[status]}</span><span class="sub">セル</span></div>`).join("")}</div>
    <div class="panel measurements">
      <p><strong>入力消失: ${inputSummary}</strong><br><span class="sub">未取得 ${rows.length - inputObservations.length}セル</span></p>
      <p><strong>重複回答: ${duplicateSummary}</strong><br><span class="sub">未取得 ${rows.length - duplicateObservations.length}セル</span></p>
      <p><strong>未確認: ${counts.blocked + counts["not-run"]}セル</strong><br><span class="sub">blocked + not-run</span></p>
    </div>
  </section>
  <section class="panel filter-panel" aria-label="結果の絞り込み">
    <fieldset id="filter-controls" disabled>
      <legend>結果を絞り込む</legend>
      <div class="filters">
        ${select("status", "状態", [["unconfirmed", "未確認（blocked + not-run）"], ...statuses.map(status => [status, `${stateLabels[status]} / ${status}`])])}
        ${select("device", "端末", uniqueChoices("device", row => deviceLabels[row.device]))}
        ${select("operation", "操作", uniqueChoices("operation", row => row.title))}
        ${select("route", "接続経路", uniqueChoices("route", row => row.connection))}
        ${select("level", "取得した証拠の水準", [...levels.map(level => [level, levelLabels[level]]), ["unrecorded", unknown]])}
      </div>
      <div class="filter-footer"><button id="reset-filters" type="button">すべて表示</button><p id="shown-count" role="status" aria-live="polite">${rows.length} / ${rows.length}セルを表示</p><span class="sub">すべての条件を満たす結果を表示します。</span></div>
    </fieldset>
    <noscript><p>JavaScriptが無効なため絞り込みは使えません。未実施を含む全${rows.length}セルを下に表示しています。</p></noscript>
  </section>
  <div class="table-box" role="region" aria-label="QA結果一覧。狭い画面では左右にスクロールできます" tabindex="0">
    <table>
      <caption>確認結果一覧 — 未実施を含む全経路（${rows.length}セル）</caption>
      <thead><tr><th scope="col">経路・端末・画面</th><th scope="col">対象機能</th><th scope="col">操作</th><th scope="col">状態</th><th scope="col">証拠の水準</th><th scope="col">実測値</th><th scope="col">理由・実施詳細</th></tr></thead>
      <tbody>${rows.map(resultRow).join("\n")}</tbody>
    </table>
    <p id="no-results" class="empty" hidden>条件に合う結果はありません。「すべて表示」で絞り込みを解除できます。</p>
  </div>
  <footer>このHTMLは保存されたQA記録から生成した静的レポートです。状態と件数は対象版全体の記録、絞り込みは表示のみに適用されます。証拠ファイルはJSON・HTMLと同じディレクトリを基準に開きます。</footer>
</main>
<script>
(() => {
  const keys = ["status", "device", "operation", "route", "level"];
  const controls = keys.map(key => document.getElementById(key));
  const rows = Array.from(document.querySelectorAll(".result-row"));
  const update = () => {
    let count = 0;
    for (const row of rows) {
      const matches = controls.every((control, index) => {
        const value = control.value;
        if (!value) return true;
        const actual = row.dataset[keys[index]];
        return keys[index] === "status" && value === "unconfirmed" ? actual === "blocked" || actual === "not-run" : actual === value;
      });
      row.hidden = !matches;
      if (matches) count++;
    }
    document.getElementById("shown-count").textContent = count + " / " + rows.length + "セルを表示";
    document.getElementById("no-results").hidden = count !== 0;
  };
  controls.forEach(control => control.addEventListener("change", update));
  document.getElementById("reset-filters").addEventListener("click", () => {
    controls.forEach(control => { control.value = ""; });
    update();
  });
  document.getElementById("filter-controls").disabled = false;
})();
</script>
</body>
</html>`;
}
