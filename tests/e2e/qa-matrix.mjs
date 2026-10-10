import fs from 'node:fs/promises';
import path from 'node:path';

export const qaCases = [
  { id: 'desktop.sse-draft', device: 'Desktop browser · 1280×900', input: 'Keyboard', action: 'Edit a reply while another state update arrives over SSE', connection: 'Loopback project dashboard', mode: 'browser' },
  { id: 'desktop.double-submit', device: 'Desktop browser · 1280×900', input: 'Mouse double-click', action: 'Submit one reply twice in quick succession', connection: 'Loopback project dashboard', mode: 'browser' },
  { id: 'desktop.offline-retry', device: 'Desktop browser · 1280×900', input: 'Keyboard', action: 'Disconnect before submit, reconnect, then retry the retained draft', connection: 'Browser offline simulation', mode: 'browser' },
  { id: 'desktop.lost-response', device: 'Desktop browser · 1280×900', input: 'Keyboard', action: 'Lose the response after the server commits a reply', connection: 'Loopback response fault fixture', mode: 'browser' },
  { id: 'desktop.answer-reload', device: 'Desktop browser · 1280×900', input: 'Keyboard', action: 'Reload after a saved answer and confirm exactly one answer remains', connection: 'Loopback project dashboard', mode: 'browser' },
  { id: 'desktop.cancel', device: 'Desktop browser · 1280×900', input: 'Keyboard', action: 'Cancel a typed decision and confirm it stays cancelled', connection: 'Loopback project dashboard', mode: 'browser' },
  { id: 'desktop.back', device: 'Desktop browser · 1280×900', input: 'Keyboard', action: 'Use browser Back and return to the same task/question', connection: 'Loopback project dashboard', mode: 'browser' },
  { id: 'desktop.keyboard-only', device: 'Desktop browser · 1280×900', input: 'Keyboard only', action: 'Navigate and submit without a pointer', connection: 'Loopback project dashboard', mode: 'browser' },
  { id: 'mobile.viewport', device: 'Mobile-sized browser viewport · 390×844', input: 'Touch emulation', action: 'Open the project dashboard without horizontal overflow', connection: 'Loopback project dashboard', mode: 'browser' },
  { id: 'mobile.sse-draft', device: 'Mobile-sized browser viewport · 390×844', input: 'Touch emulation', action: 'Retain a draft while an SSE update arrives', connection: 'Loopback project dashboard', mode: 'browser' },
  { id: 'mobile.double-submit', device: 'Mobile-sized browser viewport · 390×844', input: 'Touch emulation', action: 'Double-tap submit without creating duplicate answers', connection: 'Loopback project dashboard', mode: 'browser' },
  { id: 'mobile.offline-retry', device: 'Mobile-sized browser viewport · 390×844', input: 'Touch emulation', action: 'Reconnect after a failed send and retry the retained draft', connection: 'Browser offline simulation', mode: 'browser' },
  { id: 'phone.real-device', device: 'Physical phone', input: 'Touch keyboard', action: 'Retain and submit a draft during a real phone session', connection: 'Real phone connection', mode: 'device' },
  { id: 'connection.wsl', device: 'Windows + WSL', input: 'Browser and terminal', action: 'Disconnect/reconnect through the WSL proxy', connection: 'Real WSL bridge', mode: 'connection' },
  { id: 'connection.tailscale', device: 'Remote phone or computer', input: 'Browser and touch/keyboard', action: 'Reconnect and submit through a real Tailscale path', connection: 'Real Tailscale network', mode: 'connection' },
];

const allowedStatuses = new Set(['pass', 'fail', 'blocked', 'not-run']);
const statusLabels = { pass: 'Pass', fail: 'Fail', blocked: 'Blocked', 'not-run': 'Not run' };
const statusNotes = {
  'phone.real-device': 'Physical-device evidence is required; a viewport capture does not count.',
  'connection.wsl': 'No WSL bridge test ran in this browser job; fixture results do not count.',
  'connection.tailscale': 'No Tailscale connection test ran in this browser job; fixture results do not count.',
};

export function buildQaMatrix(report) {
  const sha = typeof report?.source_sha === 'string' && /^[a-f0-9]{40}$/i.test(report.source_sha)
    ? report.source_sha.toLowerCase() : null;
  const latest = new Map();
  for (const result of report?.qa_results || []) latest.set(result.case_id, result);
  return qaCases.map((definition) => {
    const evidence = latest.get(definition.id);
    let status = 'not-run';
    let reason = statusNotes[definition.id] || 'No matching evidence recorded for this path.';
    let previousResult = null;
    if (evidence && allowedStatuses.has(evidence.status)) {
      previousResult = evidence.status;
      if (!sha || evidence.source_sha !== sha) {
        reason = 'Evidence belongs to a different or unknown source SHA.';
      } else if (evidence.mode !== definition.mode) {
        reason = `${statusNotes[definition.id] || ''} Evidence mode ${evidence.mode || 'unknown'} cannot establish ${definition.mode} coverage.`.trim();
      } else {
        status = evidence.status;
        reason = evidence.reason || '';
      }
    }
    return {
      ...definition,
      status,
      reason,
      previous_result: status === 'not-run' ? previousResult : null,
      tested_at: status === 'not-run' ? null : evidence.tested_at,
      source_sha: status === 'not-run' ? null : evidence.source_sha,
      evidence_ref: status === 'not-run' ? null : evidence.evidence_ref,
    };
  });
}

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

export function renderQaMatrixHtml(matrix, report = {}) {
  const counts = Object.fromEntries([...allowedStatuses].map((status) => [
    status, matrix.filter((item) => item.status === status).length,
  ]));
  const rows = matrix.map((item) => `<tr data-status="${escapeHtml(item.status)}">
    <td><span class="status status-${escapeHtml(item.status)}">${escapeHtml(statusLabels[item.status])}</span>${item.previous_result ? `<span class="stale">Previous result: ${escapeHtml(statusLabels[item.previous_result])}</span>` : ''}</td>
    <td>${escapeHtml(item.device)}</td><td>${escapeHtml(item.input)}</td><td>${escapeHtml(item.action)}</td>
    <td>${escapeHtml(item.connection)}</td><td>${escapeHtml(item.mode)}</td>
    <td>${escapeHtml(item.reason)}${item.evidence_ref ? `<br><a href="${escapeHtml(item.evidence_ref)}">${escapeHtml(item.evidence_ref)}</a>` : ''}${item.source_sha ? `<br><code>${escapeHtml(item.source_sha)}</code>` : ''}${item.tested_at ? `<br>${escapeHtml(item.tested_at)}` : ''}</td>
  </tr>`).join('\n');
  return `<!doctype html>
<html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>rustdsh QA route matrix</title>
<style>
body{font:15px/1.55 system-ui,sans-serif;margin:24px;color:#222;background:#f7f7f4}main{max-width:1500px;margin:auto}h1{font-size:1.6rem}.meta,.note{color:#555}table{border-collapse:collapse;width:100%;background:white}th,td{text-align:left;vertical-align:top;border:1px solid #ccc;padding:9px}th{background:#eee;position:sticky;top:0}.status{font-weight:700;padding:2px 7px;border-radius:5px}.status-pass{background:#dff2e4;color:#17552b}.status-fail{background:#ffe1dd;color:#7a2016}.status-blocked,.status-not-run{background:#eee;color:#444}.stale{display:block;font-size:.85em;color:#824900}code{overflow-wrap:anywhere}select{font:inherit;min-height:42px;margin:6px 0 12px;padding:6px}td{overflow-wrap:anywhere}a{color:#174ea6}
@media(max-width:800px){body{margin:12px}table,tbody,tr,td{display:block}thead{position:absolute;clip:rect(0 0 0 0);height:1px;overflow:hidden}tr{margin:12px 0;border:1px solid #aaa}td{border:0;border-bottom:1px solid #ddd}td:first-child:before{content:'Status: ';font-weight:700}td:nth-child(2):before{content:'Device: ';font-weight:700}td:nth-child(3):before{content:'Input: ';font-weight:700}td:nth-child(4):before{content:'Action: ';font-weight:700}td:nth-child(5):before{content:'Connection: ';font-weight:700}td:nth-child(6):before{content:'Evidence mode: ';font-weight:700}td:nth-child(7):before{content:'Evidence: ';font-weight:700}}
</style><main><h1>利用経路 QA マトリクス</h1>
<p class="meta">対象 SHA: <code>${escapeHtml(report.source_sha || 'unknown')}</code> · browser run: ${escapeHtml(report.tested_at || 'unknown')} · ${escapeHtml(report.environment?.platform || 'unknown')} / ${escapeHtml(report.environment?.browser || 'browser unknown')}</p>
<p class="note">fixture・ブラウザー・実機・接続の証拠を区別します。古いSHAや異なる証拠種別の結果は現在のPassにしません。viewport試験は実機スマホ、ローカル接続はWSL/Tailscaleの実接続を証明しません。</p>
<p>Pass ${counts.pass} · Fail ${counts.fail} · Blocked ${counts.blocked} · Not run ${counts['not-run']}</p>
<label for="status-filter">状態で絞り込み</label><br><select id="status-filter"><option value="all">すべて</option><option value="not-run">未実施のみ</option><option value="blocked">Blockedのみ</option><option value="fail">Failのみ</option><option value="pass">Passのみ</option></select>
<table><thead><tr><th>状態</th><th>端末</th><th>入力</th><th>操作経路</th><th>接続経路</th><th>必要な証拠種別</th><th>根拠</th></tr></thead><tbody>${rows}</tbody></table>
<script>const filter=document.querySelector('#status-filter');const rows=[...document.querySelectorAll('tbody tr')];filter.addEventListener('change',()=>{for(const row of rows)row.hidden=filter.value!=='all'&&row.dataset.status!==filter.value;});</script></main></html>`;
}

export async function writeQaMatrix(report, outputDirectory) {
  const matrix = buildQaMatrix(report);
  await fs.mkdir(outputDirectory, { recursive: true });
  await fs.writeFile(path.join(outputDirectory, 'qa-matrix.json'), JSON.stringify({
    schema: 1,
    source_sha: report.source_sha || null,
    tested_at: report.tested_at || null,
    result: report.result || 'not-run',
    counts: Object.fromEntries([...allowedStatuses].map((status) => [status,
      matrix.filter((item) => item.status === status).length,
    ])),
    cases: matrix,
  }, null, 2) + '\n');
  await fs.writeFile(path.join(outputDirectory, 'qa-matrix.html'), renderQaMatrixHtml(matrix, report));
  return matrix;
}
