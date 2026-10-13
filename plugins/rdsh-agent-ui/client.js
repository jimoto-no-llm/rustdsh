// Web client half: renders the surface the agent published, in this chat, and
// returns the human's choice to the same session.
//
// The panel replaces nothing: it sits at the turn tail, disappears when the
// agent clears the surface, and every value is rendered as text or an SVG
// element - no agent-supplied HTML or script is ever evaluated.
window.__ModuleLoader__.load({
  id: 'rdsh-agent-ui',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    // The panel belongs next to the message that presented it, so it is drawn
    // through a portal into the turn that holds the marker.
    const ReactDOM = (() => {
      try {
        return require('react-dom');
      } catch {
        return null;
      }
    })();
    const createPortal = ReactDOM && typeof ReactDOM.createPortal === 'function' ? ReactDOM.createPortal : null;
    const SURFACE_URL = '/api/rdsh-agent-ui/surface';
    const ACTION_URL = '/api/rdsh-agent-ui/action';
    const TONE = {
      ok: { color: '#2f855a', background: 'rgba(47,133,90,0.15)' },
      warn: { color: '#a8710f', background: 'rgba(168,113,15,0.16)' },
      danger: { color: '#c0392b', background: 'rgba(192,57,43,0.15)' },
      info: { color: '#3b6fd4', background: 'rgba(59,111,212,0.15)' },
      neutral: { color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-interactive-bg-hover)' },
    };
    const BAR = { ok: '#48a377', warn: '#d7a03a', danger: '#e0685a', info: '#5b8def', neutral: '#9aa0a6' };
    const OBSERVATION = {
      measured: { label: '実測', tone: 'ok' },
      agent_reported: { label: 'エージェント報告', tone: 'info' },
      estimated: { label: '推定', tone: 'warn' },
      unavailable: { label: '未取得', tone: 'neutral' },
    };
    const cssText = [
      '.rdshui-root{display:flex;flex-direction:column;gap:10px;margin:8px 0;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.rdshui-card{border:0.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l3));background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-module-platform));border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}',
      '.rdshui-head{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:baseline;justify-content:space-between}',
      '.rdshui-title{margin:0;font-size:14px;font-weight:600}',
      '.rdshui-muted{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0}',
      '.rdshui-chip{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600}',
      '.rdshui-btn{font:inherit;font-size:13px;padding:6px 14px;border-radius:9px;cursor:pointer;border:0.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary)}',
      '.rdshui-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.rdshui-btn:disabled{opacity:.45;cursor:not-allowed}',
      '.rdshui-btn-primary{border:none;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.rdshui-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.rdshui-choice{display:flex;gap:9px;align-items:flex-start;padding:9px 11px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:10px;cursor:pointer}',
      '.rdshui-choice:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.rdshui-choice[data-picked=true]{border-color:var(--dsw-alias-state-business-primary,var(--dsw-alias-button-primary-fill));background:var(--dsw-alias-interactive-bg-hover)}',
      '.rdshui-choice input{margin-top:2px;accent-color:var(--dsw-alias-button-primary-fill)}',
      '.rdshui-scroll{overflow-x:auto}',
      '.rdshui-table{width:100%;border-collapse:collapse;font-size:13px}',
      '.rdshui-table th,.rdshui-table td{padding:6px 9px;border-bottom:0.5px solid var(--dsw-alias-border-l3);text-align:left;font-variant-numeric:tabular-nums}',
      '.rdshui-table th{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary)}',
      '.rdshui-kv{display:grid;grid-template-columns:minmax(80px,max-content) minmax(0,1fr);gap:4px 14px;margin:0}',
      '.rdshui-kv dt{color:var(--dsw-alias-label-tertiary);font-size:12px}',
      '.rdshui-kv dd{margin:0;font-variant-numeric:tabular-nums}',
      '.rdshui-pre{margin:0;padding:9px 11px;border-radius:8px;background:var(--dsw-alias-bg-module-platform);border:0.5px solid var(--dsw-alias-border-l3);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;overflow-x:auto}',
      '.rdshui-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}',
      '.rdshui-chart{width:100%;height:auto;max-width:440px;display:block}',
      '.rdshui-chart text{font-size:10px;fill:var(--dsw-alias-label-tertiary)}',
      '.rdshui-status{font-size:12px;color:var(--dsw-alias-label-tertiary);margin:0}',
    ].join('');

    const picked = (block, value) => {
      if (block.kind === 'choice') return value && value.choice_id ? value.choice_id : null;
      return null;
    };
    const text = (value) =>
      value === null || value === undefined || value === '' ? '未取得' : String(value);

    function Chip({ tone, children }) {
      return h('span', { className: 'rdshui-chip', style: TONE[tone] || TONE.neutral }, children);
    }
    function Observation({ block }) {
      const meta = OBSERVATION[block.observation && block.observation.kind] || OBSERVATION.unavailable;
      const source = block.observation && block.observation.source;
      return h('p', { className: 'rdshui-muted' },
        h(Chip, { tone: meta.tone }, '観測 ' + meta.label),
        source ? ' ' + source : '');
    }

    function TestResults({ block }) {
      const cases = Array.isArray(block.data.cases) ? block.data.cases : [];
      const counts = { pass: 0, fail: 0, hold: 0 };
      for (const item of cases) if (counts[item.status] !== undefined) counts[item.status] += 1;
      const rows = [['pass', '成功', 'ok'], ['fail', '失敗', 'danger'], ['hold', '保留', 'warn']];
      const max = Math.max(counts.pass, counts.fail, counts.hold, 1);
      return h('div', null,
        h('svg', { className: 'rdshui-chart', viewBox: '0 0 420 90', role: 'img', 'aria-label': 'テスト結果の内訳' },
          rows.map((row, index) => {
            const width = Math.max(2, Math.round((counts[row[0]] / max) * 250));
            return h('g', { key: row[0] },
              h('text', { x: 0, y: index * 28 + 18 }, row[1]),
              h('rect', { x: 54, y: index * 28 + 6, width: width, height: 15, rx: 4, fill: BAR[row[2]] }),
              h('text', { x: 54 + width + 7, y: index * 28 + 18 }, String(counts[row[0]])));
          })),
        h('div', { className: 'rdshui-row' },
          rows.map((row) => h(Chip, { key: row[0], tone: row[2] }, row[1] + ' ' + counts[row[0]]))));
    }
    function BarChart({ block }) {
      const bars = Array.isArray(block.data.bars) ? block.data.bars : [];
      const known = bars.filter((bar) => typeof bar.value === 'number');
      const max = known.length ? Math.max(...known.map((bar) => bar.value), 1) : 1;
      const slot = 400 / Math.max(bars.length, 1);
      const height = 150;
      return h('svg', { className: 'rdshui-chart', viewBox: '0 0 420 ' + (height + 24), role: 'img', 'aria-label': 'カテゴリ別の値' },
        h('line', { x1: 10, y1: height, x2: 410, y2: height, stroke: 'var(--dsw-alias-border-l3)' }),
        bars.map((bar, index) => {
          const x = 10 + index * slot + slot * 0.18;
          if (typeof bar.value !== 'number')
            return h('g', { key: index },
              h('rect', { x: x, y: height - 12, width: slot * 0.64, height: 12, rx: 3, fill: BAR.neutral, opacity: 0.45 }),
              h('text', { x: x, y: height + 15 }, bar.label + ' 未取得'));
          const barHeight = Math.max(3, Math.round((bar.value / max) * (height - 40)));
          return h('g', { key: index },
            h('rect', { x: x, y: height - barHeight, width: slot * 0.64, height: barHeight, rx: 4, fill: BAR[bar.tone] || BAR.info }),
            h('text', { x: x, y: height - barHeight - 5 }, String(bar.value)),
            h('text', { x: x, y: height + 15 }, bar.label));
        }));
    }
    function LineChart({ block }) {
      const points = (Array.isArray(block.data.points) ? block.data.points : [])
        .filter((point) => Array.isArray(point) && point.length === 2);
      if (points.length === 0) return h('p', { className: 'rdshui-muted' }, '時系列は未取得です。0にはしません。');
      const xs = points.map((point) => point[0]);
      const ys = points.map((point) => point[1]);
      const [minX, maxX] = [Math.min(...xs), Math.max(...xs)];
      const [minY, maxY] = [Math.min(...ys), Math.max(...ys)];
      const spanX = maxX - minX || 1;
      const spanY = maxY - minY || 1;
      const place = (point) => [
        14 + ((point[0] - minX) / spanX) * 392,
        136 - ((point[1] - minY) / spanY) * 112,
      ];
      return h('svg', { className: 'rdshui-chart', viewBox: '0 0 420 150', role: 'img', 'aria-label': '時系列の推移' },
        h('polyline', {
          fill: 'none',
          stroke: BAR.info,
          strokeWidth: 2,
          strokeLinejoin: 'round',
          points: points.map((point) => place(point).map((value) => value.toFixed(1)).join(',')).join(' '),
        }),
        points.map((point, index) => {
          const [x, y] = place(point);
          return h('circle', { key: index, cx: x, cy: y, r: 3.5, fill: 'var(--dsw-alias-bg-module-platform)', stroke: BAR.info, strokeWidth: 2 });
        }));
    }

    function Actions({ block, busy, onAct }) {
      const actions = Array.isArray(block.actions) ? block.actions : [];
      if (actions.length === 0) return null;
      return h('div', { className: 'rdshui-row' },
        actions.map((action, index) => {
          const primary = ['submit_choice', 'submit_form', 'approve'].includes(action.kind);
          const request = typeof action.kind === 'string' && action.kind.indexOf('request') === 0;
          return h('button', {
            key: action.id || index,
            type: 'button',
            disabled: busy,
            className: 'rdshui-btn' + (primary ? ' rdshui-btn-primary' : ''),
            title: request ? '要求として記録します。実行は別の認可された経路で行います。' : undefined,
            onClick: () => onAct(block, action),
          }, action.label || action.id);
        }));
    }

    function Block({ block, busy, onAct, pickedId, onPick }) {
      const body = [];
      const data = block.data || {};
      if (block.title) body.push(h('h4', { key: 'title', className: 'rdshui-title' }, block.title));
      if (block.kind === 'text') body.push(h('p', { key: 'b', style: { margin: 0, whiteSpace: 'pre-wrap' } }, data.text));
      else if (block.kind === 'heading') body.push(h('h4', { key: 'b', className: 'rdshui-title' }, data.text));
      else if (block.kind === 'caption') body.push(h('p', { key: 'b', className: 'rdshui-muted' }, data.text));
      else if (block.kind === 'code') body.push(h('pre', { key: 'b', className: 'rdshui-pre' }, data.code));
      else if (block.kind === 'callout') body.push(h('p', { key: 'b', className: 'rdshui-chip', style: Object.assign({ display: 'block', padding: '8px 10px' }, TONE[data.tone === 'warn' ? 'warn' : data.tone === 'danger' ? 'danger' : 'info']) }, data.text));
      else if (block.kind === 'status-badge') body.push(h(Chip, { key: 'b', tone: data.tone }, data.label));
      else if (block.kind === 'key-value') {
        const items = Array.isArray(data.items) ? data.items : [];
        body.push(h('dl', { key: 'b', className: 'rdshui-kv' }, items.flatMap((item, index) => [
          h('dt', { key: 'k' + index }, item.label),
          h('dd', { key: 'v' + index }, text(item.value)),
        ])));
      } else if (block.kind === 'simple-table') {
        const columns = Array.isArray(data.columns) ? data.columns : [];
        const rows = Array.isArray(data.rows) ? data.rows : [];
        body.push(h('div', { key: 'b', className: 'rdshui-scroll' },
          h('table', { className: 'rdshui-table' },
            h('thead', null, h('tr', null, columns.map((column, index) => h('th', { key: index }, column)))),
            h('tbody', null, rows.map((row, index) => h('tr', { key: index },
              columns.map((column, cell) => h('td', { key: cell }, text(Array.isArray(row) ? row[cell] : null)))))))));
      } else if (block.kind === 'dev.test-results') body.push(h(TestResults, { key: 'b', block }));
      else if (block.kind === 'chart.bar') body.push(h(BarChart, { key: 'b', block }));
      else if (block.kind === 'chart.line') body.push(h(LineChart, { key: 'b', block }));
      else if (block.kind === 'dev.diff-split') {
        body.push(h('div', { key: 'b', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 8 } },
          h('pre', { className: 'rdshui-pre' }, '変更前\n' + text(data.before)),
          h('pre', { className: 'rdshui-pre' }, '変更後\n' + text(data.after))));
      } else if (block.kind === 'choice') {
        body.push(h('p', { key: 'p', style: { margin: 0 } }, data.prompt));
        for (const choice of (Array.isArray(data.choices) ? data.choices : [])) {
          body.push(h('label', {
            key: choice.id,
            className: 'rdshui-choice',
            'data-picked': String(pickedId === choice.id),
          },
            h('input', {
              type: 'radio',
              name: block.id,
              checked: pickedId === choice.id,
              disabled: busy,
              onChange: () => onPick(block, choice),
            }),
            h('span', null, choice.label)));
        }
      } else if (block.kind === 'agent.approval') {
        body.push(h('p', { key: 'b', style: { margin: 0 } }, '操作: ' + text(data.operation)));
      } else if (block.kind === 'button') {
        body.push(h('p', { key: 'b', style: { margin: 0 } }, text(data.label)));
      } else if (block.kind === 'form') {
        body.push(h('div', { key: 'b', style: { display: 'grid', gap: 6 } },
          (Array.isArray(data.fields) ? data.fields : []).map((field) => h('label', { key: field.id },
            h('span', { className: 'rdshui-muted' }, field.label)))));
      } else if (['card', 'row', 'column'].includes(block.kind)) {
        body.push(h('div', { key: 'b', style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          (Array.isArray(data.blocks) ? data.blocks : []).map((child, index) =>
            h(Block, { key: child.id || index, block: child, busy, onAct, pickedId: null, onPick }))));
      } else {
        body.push(h('pre', { key: 'b', className: 'rdshui-pre' }, JSON.stringify(data, null, 2)));
      }
      body.push(h(Observation, { key: 'obs', block }));
      body.push(h(Actions, { key: 'act', block, busy, onAct }));
      return h('section', { className: 'rdshui-card', 'data-block-id': block.id, 'data-kind': block.kind }, body);
    }

    function Panel(props) {
      const [surface, setSurface] = useState(undefined);
      const [visible, setVisible] = useState(false);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);
      const [status, setStatus] = useState(null);
      const [picks, setPicks] = useState({});
      const [submitted, setSubmitted] = useState(null);
      const [ownTurn, setOwnTurn] = useState(null);
      const hostRef = React.useRef(null);
      const portalHostRef = React.useRef(null);
      const [placement, setPlacement] = useState(0);
      const placeRef = React.useRef(null);
      const lastSurfaceRef = React.useRef(null);
      const sessionId = props.sessionId || (props.inject && props.inject.sessionId) || null;
      const send = props.send;

      useEffect(() => {
        let alive = true;
        // The slot does not hand us a turn number, so position comes from the
        // DOM: this panel's own turn tail versus the newest one on screen.
        const locate = () => {
          try {
            const host = hostRef.current;
            const own = host && host.closest ? host.closest('[data-turn-tail]') : null;
            const ownTurn = own ? Number(own.getAttribute('data-turn-tail')) : null;
            const turns = [...document.querySelectorAll('[data-turn-tail]')]
              .map((node) => Number(node.getAttribute('data-turn-tail')))
              .filter((value) => Number.isFinite(value));
            const newest = turns.length ? Math.max(...turns) : null;
            return {
              ownTurn: Number.isFinite(ownTurn) ? ownTurn : null,
              newest,
              isNewest: ownTurn === null || newest === null || ownTurn >= newest,
            };
          } catch {
            return { ownTurn: null, newest: null, isNewest: true };
          }
        };
        // One anchor per surface, not per revision: a new revision updates the
        // panel in place instead of moving it to the newest turn.
        // Move a host element directly in front of the tail of the turn that
        // holds the marker: the panel then scrolls with that message.
        const placePortal = (marker) => {
          try {
            if (!portalHostRef.current) portalHostRef.current = document.createElement('div');
            const host = portalHostRef.current;
            const leaves = [...document.querySelectorAll('*')]
              .filter((node) => node.children.length === 0 && (node.textContent || '').includes(marker));
            for (const leaf of leaves) {
              let node = leaf;
              for (let step = 0; step < 12 && node && node !== document.body; step += 1) {
                const tail = node.querySelector ? node.querySelector('[data-turn-tail]') : null;
                if (tail && tail.parentElement) {
                  if (host.parentElement !== tail.parentElement || host.nextSibling !== tail)
                    tail.parentElement.insertBefore(host, tail);
                  return true;
                }
                node = node.parentElement;
              }
            }
            return false;
          } catch {
            return false;
          }
        };
        placeRef.current = placePortal;
        const anchorKey = (surface) =>
          'rdsh-agent-ui:anchor:' + String(surface.surface_id || 'x');
        // The agent writes a short marker in the message that presents the
        // panel, so the panel belongs to that turn rather than the newest one.
        // The marker lives in the assistant message, which is a sibling of the
        // turn tail, so walk up from the text until exactly one tail is inside.
        const turnHoldingMarker = (marker) => {
          if (typeof marker !== 'string' || marker === '') return null;
          try {
            const leaves = [...document.querySelectorAll('*')]
              .filter((node) => node.children.length === 0 && (node.textContent || '').includes(marker));
            for (const leaf of leaves) {
              let node = leaf;
              for (let step = 0; step < 12 && node && node !== document.body; step += 1) {
                const tails = node.querySelectorAll ? node.querySelectorAll('[data-turn-tail]') : [];
                if (tails.length === 1) {
                  const turn = Number(tails[0].getAttribute('data-turn-tail'));
                  return Number.isFinite(turn) ? turn : null;
                }
                if (tails.length > 1) break;
                node = node.parentElement;
              }
            }
            return null;
          } catch {
            return null;
          }
        };
        const load = async () => {
          try {
            const response = await fetch(SURFACE_URL, { headers: { accept: 'application/json' } });
            const body = await response.json();
            if (!alive) return;
            const loaded = body.surface || null;
            lastSurfaceRef.current = loaded;
            const place = locate();
            setSurface(loaded);
            setError(body.error || null);
            setOwnTurn(place.ownTurn);
            if (!loaded) {
              setVisible(place.isNewest);
              return;
            }
            // 1) an explicit marker in the message wins, 2) otherwise the
            // surface is claimed once by the newest tail, 3) otherwise the
            // newest tail shows it. Placement survives a reload.
            const marked = turnHoldingMarker(loaded.anchor_text);
            if (marked !== null) {
              const placed = placePortal(loaded.anchor_text);
              setVisible(!placed && place.ownTurn === marked);
              if (placed) setPlacement((value) => value + 1);
              return;
            }
            // The message scrolled out of the mounted window: fall back to the
            // turn tail until it comes back on screen.
            setPlacement((value) => (value > 0 ? 0 : value));
            let anchored = null;
            try {
              // Number(null) is 0, so an absent anchor must stay null.
              const raw = sessionStorage.getItem(anchorKey(loaded));
              anchored = raw === null || raw === '' ? null : Number(raw);
              if (!Number.isFinite(anchored)) anchored = null;
            } catch {}
            if (!Number.isFinite(anchored) && place.isNewest && place.ownTurn !== null) {
              anchored = place.ownTurn;
              try {
                sessionStorage.setItem(anchorKey(loaded), String(anchored));
              } catch {}
            }
            setVisible(Number.isFinite(anchored) ? place.ownTurn === anchored : place.isNewest);
          } catch {
            if (alive) setError('unreachable');
          }
        };
        void load();
        const timer = setInterval(load, 4000);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, []);

      // Virtualised history mounts a message only while it is on screen, so
      // re-place the panel whenever the reader scrolls to it.
      useEffect(() => {
        let timer = null;
        const onScroll = () => {
          if (timer) return;
          timer = setTimeout(() => {
            timer = null;
            const loaded = lastSurfaceRef.current;
            const place = placeRef.current;
            if (!loaded || typeof loaded.anchor_text !== 'string' || typeof place !== 'function') return;
            if (place(loaded.anchor_text)) setPlacement((value) => value + 1);
          }, 250);
        };
        window.addEventListener('scroll', onScroll, { passive: true, capture: true });
        return () => {
          if (timer) clearTimeout(timer);
          window.removeEventListener('scroll', onScroll, { capture: true });
        };
      }, []);

      const storageKey = surface
        ? 'rdsh-agent-ui:done:' + String(surface.surface_id || 'x') + '@' + String(surface.revision || 0)
        : null;
      useEffect(() => {
        if (!storageKey) return;
        try {
          setSubmitted(sessionStorage.getItem(storageKey));
        } catch {
          setSubmitted(null);
        }
      }, [storageKey]);

      const onAct = useCallback(async (block, action) => {
        if (!surface || busy) return;
        const value = block.kind === 'choice'
          ? (picks[block.id] ? { choice_id: picks[block.id] } : null)
          : null;
        if (block.kind === 'choice' && value === null) {
          setStatus({ tone: 'warn', text: '選択肢を選んでください。' });
          return;
        }
        const label = block.kind === 'choice'
          ? ((block.data.choices || []).find((choice) => choice.id === picks[block.id]) || {}).label
          : block.title || action.label;
        setBusy(true);
        setStatus({ tone: 'neutral', text: '送信中…' });
        const requestId = 'ui_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
        const payload = {
          request_id: requestId,
          surface_id: surface.surface_id || null,
          surface_revision: Number.isSafeInteger(surface.revision) ? surface.revision : null,
          block_id: block.id,
          action_id: action.id,
          action_kind: action.kind || null,
          label: typeof label === 'string' ? label : null,
          value,
        };
        let mirrored = false;
        try {
          const response = await fetch(ACTION_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
          mirrored = response.ok;
        } catch {
          mirrored = false;
        }
        const line = 'UI操作: ' + (block.title || '選択') + ' → ' + (label || action.id) +
          '（surface ' + (surface.surface_id || '不明') + ' / block ' + block.id + ' / action ' + action.id + '）';
        let delivered = false;
        if (typeof send === 'function' && sessionId)
          delivered = await send(sessionId, line).catch(() => false);
        setBusy(false);
        if (delivered || mirrored) {
          const summary = (label || action.id) + (delivered ? '' : '（記録のみ・セッション未送信）');
          try {
            sessionStorage.setItem(storageKey, summary);
          } catch {}
          setSubmitted(summary);
          setStatus({
            tone: delivered ? 'ok' : 'warn',
            text: delivered
              ? '選択をセッションへ返しました。実行権限は発行していません。'
              : '記録しました。セッションへの送信は届いていません。',
          });
        } else {
          setStatus({ tone: 'danger', text: '送信できませんでした。' });
        }
      }, [surface, busy, picks, send, sessionId, storageKey]);

      // Inline visibility controls only the fallback at the turn tail. Once an
      // anchor is placed, the portal must still render while that fallback is
      // hidden; otherwise the successful placement hides its own contents.
      const portalReady = Boolean(surface && placement > 0 && portalHostRef.current && createPortal);
      if (surface === undefined || (!visible && !portalReady))
        return h('div', { ref: hostRef, className: 'rdshui-host', hidden: true });
      if (!surface) {
        if (!error || error === 'surface-unreadable') return null;
        return h('p', { className: 'rdshui-status' }, 'UIデータを読めません: ' + error);
      }
      const blocks = Array.isArray(surface.blocks) ? surface.blocks : [];
      const panel = h('div', { className: 'rdshui-root' },
        h('style', null, cssText),
        h('section', { className: 'rdshui-card' },
          h('div', { className: 'rdshui-head' },
            h('h4', { className: 'rdshui-title' }, surface.title || 'エージェントからのUI'),
            h('span', { className: 'rdshui-muted' },
              'surface ' + String(surface.surface_id || '-') + ' · 版 ' + String(surface.revision || 1))),
          submitted
            ? h('p', { className: 'rdshui-muted' }, '送信済み: ' + submitted,
              h('button', {
                type: 'button',
                className: 'rdshui-btn',
                style: { marginLeft: 8, padding: '2px 10px', fontSize: 12 },
                onClick: () => {
                  try {
                    sessionStorage.removeItem(storageKey);
                  } catch {}
                  setSubmitted(null);
                  setStatus(null);
                },
              }, '選び直す'))
            : null),
        blocks.map((block, index) => h(Block, {
          key: block.id || index,
          block,
          busy: busy || Boolean(submitted),
          onAct,
          pickedId: picks[block.id] || null,
          onPick: (target, choice) => setPicks((current) => Object.assign({}, current, { [target.id]: choice.id })),
        })),
        status ? h('p', { className: 'rdshui-status' }, status.text) : null);
      if (placement > 0 && portalHostRef.current && createPortal)
        return h(React.Fragment, null,
          h('div', { ref: hostRef, className: 'rdshui-host', hidden: true }),
          createPortal(panel, portalHostRef.current));
      return h('div', { ref: hostRef }, panel);
    }

    return {
      inject: ['slots', 'sessions', 'uiConversation', 'locale'],
      apply(ctx) {
        // The choice goes back as a normal user message, so the same session
        // continues with it; a failure is reported instead of claimed.
        const send = async (sessionId, text) => {
          const binding = ctx.sessions && typeof ctx.sessions.binding === 'function'
            ? ctx.sessions.binding(sessionId) : undefined;
          if (!binding) return false;
          const chat = ctx.uiConversation && typeof ctx.uiConversation.binding === 'function'
            ? ctx.uiConversation.binding(binding) : undefined;
          const target = chat && typeof chat.target === 'function' ? chat.target('chat') : undefined;
          if (!target || typeof target.prompt !== 'function') return false;
          const result = await target.prompt([{ type: 'text', text }], undefined, undefined);
          return !result || result.ok !== false;
        };
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'rdsh-agent-ui',
          order: 40,
          inject: (sessionId) => ({ sessionId, send }),
        }, Panel));
      },
    };
  },
});
