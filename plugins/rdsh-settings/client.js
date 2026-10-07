window.__ModuleLoader__.load({
  id: 'rdsh-settings',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useCallback = React.useCallback;
    // 単一設定源: rdsh.json のみ。旧 rdsh-context.json はサーバ側の
    // 読み替え専用で、UIからは触らない。
    const GET_ALL = '/api/rdsh-settings';
    const SAVE_ALL = '/api/rdsh-settings/save';
    const card = { border: '0.5px solid var(--dsw-alias-settings-card-stroke)', background: 'var(--dsw-alias-settings-card-fill)', borderRadius: '12px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '10px', color: 'var(--dsw-alias-label-primary)' };
    const title = { margin: '0', fontSize: '16px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' };
    const desc = { margin: '0', fontSize: '13px', color: 'var(--dsw-alias-label-tertiary)' };
    const label = { fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' };
    const input = { font: 'inherit', fontSize: '13px', padding: '6px 8px', borderRadius: '8px', width: '100%', boxSizing: 'border-box' };
    const row = { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--dsw-alias-label-primary)' };
    const warn = { margin: '0', fontSize: '12px', color: 'var(--dsw-alias-label-warning, #b7791f)' };
    const cssText = '.rdsh-settings input,.rdsh-settings textarea,.rdsh-settings select{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l3);outline:none}.rdsh-settings input:focus,.rdsh-settings textarea:focus,.rdsh-settings select:focus{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));border-color:transparent}.rdsh-settings input::placeholder,.rdsh-settings textarea::placeholder{color:var(--dsw-alias-label-dimmed)}.rdsh-settings input[type=checkbox]{accent-color:var(--dsw-alias-button-primary-fill);width:15px;height:15px;background:none;border:none;padding:0}.rdsh-settings button{font:inherit}.rdsh-btn-pri{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border:none}.rdsh-btn-pri:hover{background:var(--dsw-alias-button-primary-hover)}.rdsh-btn-pri:disabled{opacity:.4;cursor:default}.rdsh-btn-sec{background:transparent;color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l3)}.rdsh-btn-sec:hover{background:var(--dsw-alias-interactive-bg-hover)}.rdsh-btn-sec:disabled{opacity:.4;cursor:default}.rdsh-msg{font-size:12px;color:var(--dsw-alias-label-secondary)}';
    const grid2 = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' };
    function toLines(v) { return Array.isArray(v) ? v.join('\n') : ''; }
    function fromLines(s) { return String(s || '').split('\n').map((x) => x.trim()).filter((x) => x !== ''); }
    function RdshSection() {
      const al = useState(null);
      const all = al[0]; const setAll = al[1];
      const lg = useState(false);
      const legacy = lg[0]; const setLegacy = lg[1];
      const ld = useState(true); const loading = ld[0]; const setLoading = ld[1];
      const sv = useState(false); const saving = sv[0]; const setSaving = sv[1];
      const ms = useState(''); const msg = ms[0]; const setMsg = ms[1];
      const load = useCallback(async () => {
        setLoading(true); setMsg('');
        try {
          const r2 = await fetch(GET_ALL, { cache: 'no-store' });
          const j2 = await r2.json();
          if (j2 && j2.config) { setAll(j2.config); setLegacy(!!j2.legacy_present); }
          else setMsg('読み込みに失敗しました');
        } catch (e) { setMsg('読み込みに失敗しました'); }
        setLoading(false);
      }, []);
      useEffect(() => { load(); }, [load]);
      const setPath = (sec, k, v) => setAll((c) => ({ ...c, [sec]: { ...(c ? c[sec] : {}), [k]: v } }));
      const sec = (name) => (all && all[name]) || {};
      const saveAll = async () => {
        if (!all || saving) return;
        setSaving(true); setMsg('保存中…');
        try {
          const r = await fetch(SAVE_ALL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config: all }) });
          const j = await r.json();
          if (j && j.ok) { setAll(j.config); if ('legacy_present' in j) setLegacy(!!j.legacy_present); setMsg('保存しました (rdsh.json)'); }
          else setMsg('保存に失敗しました');
        } catch (e) { setMsg('保存に失敗しました'); }
        setSaving(false);
      };
      const num = (secName, key, v, fb) => {
        const n = Number(v);
        setPath(secName, key, Number.isFinite(n) ? n : fb);
      };
      if (loading || !all) return h('div', { style: { maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 12 } }, h('p', { style: desc }, '読み込み中…'));
      const g = sec('general'); const tk = sec('tokens'); const se = sec('search');
      const co = sec('compact'); const ss = sec('sessions'); const lg2 = sec('logs');
      const svv = sec('serve'); const gu = sec('guard'); const be = sec('bench');
      const su = sec('setup'); const bt = sec('beta'); const cx = sec('context');
      const cxActive = Object.keys(cx).some((k) => {
        const v = cx[k];
        return Array.isArray(v) ? v.length > 0 : (typeof v === 'string' ? v !== '' : false);
      });
      return h('div', { className: 'rdsh-settings', style: { maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 12 } },
        h('style', null, cssText),
        h('div', { style: card },
          h('p', { style: title }, 'rdsh context engine（実験的、既定OFF）'),
          h('p', { style: desc }, '毎ターン必要な文脈だけ再構成します。全文履歴は渡しません。使うときだけONにします。設定は rdsh.json に保存され、`rdsh context` コマンドと共有されます。'),
          h('div', { style: row }, h('label', { style: row }, h('input', { type: 'checkbox', checked: !!bt.context_engine, onChange: (e) => setPath('beta', 'context_engine', e.target.checked) }), 'context engine を有効化する')),
          legacy && cxActive ? h('p', { style: warn }, '旧 rdsh-context.json があります。削除する前に、この画面で設定を保存し、rdsh.json に文脈が保存されたことを確認してください。') : null
        ),
        h('div', { style: card },
          h('p', { style: title }, 'Working Memory'),
          h('p', { style: desc }, '今のゴールと作業中だけを保持します。'),
          h('div', { style: row }, h('span', { style: label }, 'トークン予算'), h('input', { type: 'number', min: 500, max: 200000, step: 100, value: cx.token_budget, onChange: (e) => num('context', 'token_budget', e.target.value, 4000), style: { ...input, maxWidth: 140 } })),
          h('div', { style: grid2 },
            h('label', { style: row }, h('input', { type: 'checkbox', checked: !!cx.enable_retriever, onChange: (e) => setPath('context', 'enable_retriever', e.target.checked) }), 'Retriever（検索）'),
            h('label', { style: row }, h('input', { type: 'checkbox', checked: !!cx.enable_packer, onChange: (e) => setPath('context', 'enable_packer', e.target.checked) }), 'Packer（圧縮）'),
            h('label', { style: row }, h('input', { type: 'checkbox', checked: !!cx.enable_verifier, onChange: (e) => setPath('context', 'enable_verifier', e.target.checked) }), 'Verifier（確認）'),
            h('label', { style: row }, h('input', { type: 'checkbox', checked: !!cx.include_git_diff, onChange: (e) => setPath('context', 'include_git_diff', e.target.checked) }), 'git差分を含める')),
          h('div', { style: grid2 },
            h('div', { style: row }, h('span', { style: label }, 'コード取得上限'), h('input', { type: 'number', min: 1, max: 100, value: cx.max_code_hits, onChange: (e) => num('context', 'max_code_hits', e.target.value, 20), style: { ...input, maxWidth: 110 } })),
            h('div', { style: row }, h('span', { style: label }, 'セッション参照数'), h('input', { type: 'number', min: 0, max: 100, value: cx.max_sessions, onChange: (e) => num('context', 'max_sessions', e.target.value, 10), style: { ...input, maxWidth: 110 } }))),
          h('div', null, h('div', { style: label }, 'ゴール'), h('input', { value: cx.goal || '', placeholder: '例: dsh互換性を維持する', onChange: (e) => setPath('context', 'goal', e.target.value), style: input })),
          h('div', null, h('div', { style: label }, '作業中ファイル (1行1件)'), h('textarea', { value: toLines(cx.working_files), rows: 3, onChange: (e) => setPath('context', 'working_files', fromLines(e.target.value)), style: { ...input, minHeight: 56 } })),
          h('div', null, h('div', { style: label }, '未解決タスク (1行1件)'), h('textarea', { value: toLines(cx.open_tasks), rows: 3, onChange: (e) => setPath('context', 'open_tasks', e.target.value), style: { ...input, minHeight: 56 } }))
        ),
        h('div', { style: card },
          h('p', { style: title }, 'Long-term Memory'),
          h('p', { style: desc }, '全文ではなく決定・制約だけ残します。'),
          h('div', null, h('div', { style: label }, '決定事項 (1行1件)'), h('textarea', { value: toLines(cx.decisions), rows: 3, onChange: (e) => setPath('context', 'decisions', fromLines(e.target.value)), style: { ...input, minHeight: 56 } })),
          h('div', null, h('div', { style: label }, '制約 (1行1件)'), h('textarea', { value: toLines(cx.constraints), rows: 3, onChange: (e) => setPath('context', 'constraints', fromLines(e.target.value)), style: { ...input, minHeight: 56 } }))
        ),
        h('div', { style: card },
          h('p', { style: title }, '全体設定 (rdsh.json)'),
          h('p', { style: desc }, 'rdsh 全体の動作を切り替えます。context engine 以外もここで変えられます。'),
          h('div', { style: label }, '全般 (general)'),
          h('div', { style: grid2 },
            h('label', { style: row }, h('input', { type: 'checkbox', checked: !!g.slim, onChange: (e) => setPath('general', 'slim', e.target.checked) }), 'スリム出力'),
            h('label', { style: row }, h('input', { type: 'checkbox', checked: !!g.passthrough, onChange: (e) => setPath('general', 'passthrough', e.target.checked) }), 'パススルー'),
            h('label', { style: row }, h('input', { type: 'checkbox', checked: !!g.dry_run, onChange: (e) => setPath('general', 'dry_run', e.target.checked) }), 'ドライラン')),
          h('div', null, h('div', { style: label }, '既定プロファイル'), h('input', { value: g.default_profile || '', placeholder: '未指定', onChange: (e) => setPath('general', 'default_profile', e.target.value), style: input })),
          h('div', { style: label }, 'トークン (tokens)'),
          h('div', { style: row }, h('span', { style: label }, '既定予算'), h('input', { type: 'number', min: 500, max: 200000, step: 100, value: tk.default_budget, onChange: (e) => num('tokens', 'default_budget', e.target.value, 4000), style: { ...input, maxWidth: 140 } })),
          h('div', { style: label }, '検索 (search)'),
          h('div', null, h('div', { style: label }, '対象ディレクトリ'), h('input', { value: se.dir || '', onChange: (e) => setPath('search', 'dir', e.target.value), style: input })),
          h('div', { style: grid2 },
            h('div', { style: row }, h('span', { style: label }, '最大件数'), h('input', { type: 'number', min: 1, max: 100, value: se.max, onChange: (e) => num('search', 'max', e.target.value, 100), style: { ...input, maxWidth: 110 } })),
            h('div', { style: row }, h('span', { style: label }, 'Web上限'), h('input', { type: 'number', min: 1, max: 100, value: se.web_limit, onChange: (e) => num('search', 'web_limit', e.target.value, 10), style: { ...input, maxWidth: 110 } }))),
          h('div', null, h('div', { style: label }, 'SearxNG URL'), h('input', { value: se.searxng_url || '', placeholder: '未設定', onChange: (e) => setPath('search', 'searxng_url', e.target.value), style: input })),
          h('div', { style: label }, '圧縮 (compact)'),
          h('div', { style: row }, h('span', { style: label }, '上限トークン'), h('input', { type: 'number', min: 500, max: 200000, step: 100, value: co.max_tokens, onChange: (e) => num('compact', 'max_tokens', e.target.value, 8000), style: { ...input, maxWidth: 140 } })),
          h('div', { style: label }, 'セッション (sessions)'),
          h('div', { style: grid2 },
            h('div', { style: row }, h('span', { style: label }, '保持数'), h('input', { type: 'number', min: 1, max: 100, value: ss.limit, onChange: (e) => num('sessions', 'limit', e.target.value, 20), style: { ...input, maxWidth: 110 } })),
            h('label', { style: row }, h('input', { type: 'checkbox', checked: !!ss.with_tokens, onChange: (e) => setPath('sessions', 'with_tokens', e.target.checked) }), 'トークン付き')),
          h('div', { style: label }, 'ログ (logs)'),
          h('div', { style: row }, h('span', { style: label }, '末尾行数'), h('input', { type: 'number', min: 1, max: 500, value: lg2.tail, onChange: (e) => num('logs', 'tail', e.target.value, 50), style: { ...input, maxWidth: 110 } })),
          h('div', { style: label }, 'サーバ (serve)'),
          h('div', { style: row }, h('span', { style: label }, 'ポート'), h('input', { type: 'number', min: 1, max: 65535, value: svv.port, onChange: (e) => num('serve', 'port', e.target.value, 3080), style: { ...input, maxWidth: 110 } })),
          h('div', { style: label }, 'ガード (guard)'),
          h('div', null, h('div', { style: label }, '拒否パス (1行1件)'), h('textarea', { value: toLines(gu.deny), rows: 2, onChange: (e) => setPath('guard', 'deny', fromLines(e.target.value)), style: { ...input, minHeight: 44 } })),
          h('div', null, h('div', { style: label }, '理由'), h('input', { value: gu.reason || '', onChange: (e) => setPath('guard', 'reason', e.target.value), style: input })),
          h('div', { style: label }, 'ベンチ (bench)'),
          h('div', { style: row }, h('span', { style: label }, '回数'), h('input', { type: 'number', min: 1, max: 20, value: be.n, onChange: (e) => num('bench', 'n', e.target.value, 5), style: { ...input, maxWidth: 110 } })),
          h('div', { style: label }, 'セットアップ (setup)'),
          h('div', { style: row }, h('span', { style: label }, 'Webポート (0=ランダム)'), h('input', { type: 'number', min: 0, max: 65535, value: su.web_port, onChange: (e) => num('setup', 'web_port', e.target.value, 0), style: { ...input, maxWidth: 110 } }))
        ),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('button', { className: 'rdsh-btn-pri', onClick: saveAll, disabled: saving, style: { padding: '8px 16px', borderRadius: 8, cursor: 'pointer', fontSize: 14 } }, saving ? '保存中…' : '保存する'),
          h('button', { className: 'rdsh-btn-sec', onClick: load, disabled: saving, style: { padding: '8px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 13 } }, '再読み込み'),
          h('span', { className: 'rdsh-msg' }, msg))
      );
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'rdsh',
          order: 20,
          label: () => 'rdsh',
          inject: () => ({}),
        }, RdshSection));
      },
    };
  },
});
