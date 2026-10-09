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
    const discordDesc = { ...desc, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 };
    const defaultDiscordId = '1557873849280888903';
    const defaultDiscordImage = 'https://cdn.discordapp.com/app-icons/1557873849280888903/3abd404070c831dcaa59310cc29982df.png?size=256';
    // Scope the host layout adjustment to this mounted section; use semantic anchors, not generated CSS names.
    const narrowCss = '@media(max-width:640px){[data-shortcut-modal=settings]:has(.rdsh-settings){flex-direction:column}[data-shortcut-modal=settings]:has(.rdsh-settings)>nav{width:100%;padding:16px 12px 0;gap:8px}[data-shortcut-modal=settings]:has(.rdsh-settings)>nav>div:last-child{flex-direction:row;overflow-x:auto;overflow-y:hidden}[data-shortcut-modal=settings]:has(.rdsh-settings)>nav button{flex:none}[data-shortcut-modal=settings]:has(.rdsh-settings)>nav+div{min-height:0}[data-shortcut-modal=settings]:has(.rdsh-settings)>nav+div>div:first-child{height:48px;padding:8px 12px}[data-shortcut-modal=settings]:has(.rdsh-settings)>nav+div>div:last-child{padding:0 12px 16px}}';
    const discordCss = '.rdsh-discord{min-width:0;overflow-wrap:anywhere}.rdsh-discord fieldset{border:0;padding:0;margin:0;min-width:0;display:flex;flex-direction:column;gap:12px}.rdsh-discord label{line-height:1.6}.rdsh-discord summary{cursor:pointer;padding:8px 0;min-height:32px;box-sizing:border-box}.rdsh-discord summary:focus-visible,.rdsh-settings button:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:3px}.rdsh-discord-fields{display:flex;flex-direction:column;gap:12px;padding:8px 0}.rdsh-discord-preview{margin:0;padding:12px 0;border-block:1px solid var(--dsw-alias-border-l3);display:flex;flex-direction:column;gap:6px;font-size:13px}.rdsh-discord-preview p{margin:0}.rdsh-discord-preview strong{font-size:15px}.rdsh-discord-meta{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6}.rdsh-discord-actions{display:flex;align-items:center;flex-wrap:wrap;gap:10px}.rdsh-discord-actions button{padding:9px 12px;min-height:36px;border-radius:8px;cursor:pointer;font-size:13px}.rdsh-discord-pill{font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l3);border-radius:12px;padding:3px 9px}.rdsh-discord-link{align-self:flex-start;font-size:12px;padding:6px 12px;background:var(--dsw-alias-interactive-bg-hover);border-radius:8px}.rdsh-discord input,.rdsh-discord select{min-height:34px}.rdsh-discord input[type=checkbox]{min-height:15px;flex-shrink:0}.rdsh-discord select{width:100%}.rdsh-discord ::selection{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}';
    function wireText(value) {
      let result = '';
      for (const char of value) { if (new TextEncoder().encode(result + char).length > 128) break; result += char; }
      return result;
    }
    function validUrl(value) {
      try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
      catch { return false; }
    }
    function toLines(v) { return Array.isArray(v) ? v.join('\n') : ''; }
    function fromLines(s) { return String(s || '').split('\n').map((x) => x.trim()).filter((x) => x !== ''); }
    function RdshSection() {
      const al = useState(null);
      const all = al[0]; const setAll = al[1];
      const lg = useState(false);
      const legacy = lg[0]; const setLegacy = lg[1];
      const ld = useState(true); const loading = ld[0]; const setLoading = ld[1];
      const sv = useState(false); const saving = sv[0]; const setSaving = sv[1];
      const ds = useState(null); const discordStatus = ds[0]; const setDiscordStatus = ds[1];
      const sd = useState(null); const savedDiscord = sd[0]; const setSavedDiscord = sd[1];
      const dm = useState(''); const discordMsg = dm[0]; const setDiscordMsg = dm[1];
      const ms = useState(''); const msg = ms[0]; const setMsg = ms[1];
      const load = useCallback(async () => {
        setLoading(true); setMsg(''); setAll(null);
        try {
          const r2 = await fetch(GET_ALL, { cache: 'no-store' });
          const j2 = await r2.json();
          if (r2.ok && j2 && j2.config) { setAll(j2.config); setSavedDiscord(j2.config.discord || {}); setDiscordMsg(''); setLegacy(!!j2.legacy_present); }
          else setMsg(j2?.error === 'invalid-settings'
            ? '設定ファイルを読み込めません。元の設定を確認してから再読み込みしてください。'
            : '読み込みに失敗しました。接続と権限を確認してから再読み込みしてください。');
        } catch (e) { setMsg('読み込みに失敗しました'); }
        setLoading(false);
      }, []);
      useEffect(() => { load(); }, [load]);
      useEffect(() => {
        let active = true;
        const poll = async () => {
          try {
            const response = await fetch('/api/rdsh-discord', { cache: 'no-store' });
            const value = await response.json();
            if (active) setDiscordStatus(response.ok && value.ok ? value : null);
          } catch { if (active) setDiscordStatus(null); }
        };
        poll(); const timer = setInterval(poll, 5000);
        return () => { active = false; clearInterval(timer); };
      }, []);
      const setPath = (sec, k, v) => setAll((c) => ({ ...c, [sec]: { ...(c ? c[sec] : {}), [k]: v } }));
      const sec = (name) => (all && all[name]) || {};
      const saveAll = async (discordOnly = false) => {
        if (!all || saving) return;
        const showMsg = discordOnly ? setDiscordMsg : setMsg;
        setSaving(true); showMsg('保存中…');
        try {
          const r = await fetch(SAVE_ALL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config: discordOnly ? { discord: all.discord } : all }) });
          const j = await r.json();
          if (r.ok && j && j.ok) {
            setAll(c => discordOnly ? { ...c, discord: j.config.discord } : j.config);
            setSavedDiscord(j.config.discord || {});
            if ('legacy_present' in j) setLegacy(!!j.legacy_present);
            showMsg(discordOnly ? '保存しました。Discordへの反映を待っています。' : '保存しました (rdsh.json)');
          } else showMsg('保存できませんでした。接続を確認して、もう一度保存してください。');
        } catch (e) { showMsg('保存できませんでした。接続を確認して、もう一度保存してください。'); }
        setSaving(false);
      };
      const num = (secName, key, v, fb) => {
        const n = String(v).trim() === '' ? NaN : Number(v);
        setPath(secName, key, Number.isFinite(n) ? n : fb);
      };
      if (loading) return h('div', { style: { maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 12 } }, h('p', { style: desc }, '読み込み中…'));
      if (!all) return h('div', { style: { maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 12 } },
        h('p', { role: 'alert', style: warn }, msg || '読み込みに失敗しました'),
        h('button', { className: 'rdsh-btn-sec', onClick: load, style: { padding: '8px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 13, alignSelf: 'flex-start' } }, '再読み込み'));
      const g = sec('general'); const tk = sec('tokens'); const se = sec('search');
      const co = sec('compact'); const ss = sec('sessions'); const lg2 = sec('logs');
      const svv = sec('serve'); const gu = sec('guard'); const be = sec('bench');
      const dc = sec('discord');
      const discordDirty = JSON.stringify(dc) !== JSON.stringify(savedDiscord);
      const detailsText = wireText(dc.details?.trim() ? dc.details : 'dshで作業中');
      const agentText = discordStatus?.running_agents > 0 ? `agent稼働中 (${discordStatus.running_agents})` : '待機中';
      const commonApp = !dc.application_id?.trim() || dc.application_id.trim() === defaultDiscordId;
      const appName = commonApp ? 'rdsh' : '独自のアプリ名';
      const previewImage = dc.show_image === false ? '' : dc.large_image?.trim() ? (validUrl(dc.large_image.trim()) ? dc.large_image.trim() : '') : commonApp ? '/api/rdsh-discord/icon' : '';
      const memberText = dc.status_display === 'name' ? appName : dc.status_display === 'state' && dc.show_agent_status !== false ? agentText : detailsText;
      const assetValid = !dc.large_image || /^[a-z0-9_-]+$/.test(dc.large_image.trim()) || validUrl(dc.large_image.trim());
      const idValid = !dc.application_id?.trim() || /^[1-9][0-9]{16,19}$/.test(dc.application_id.trim());
      const buttonValid = !dc.button_url?.trim() || validUrl(dc.button_url.trim());
      const buttonComplete = !!dc.button_url?.trim() === !!dc.button_label?.trim();
      const discordValid = assetValid && idValid && buttonValid && buttonComplete;
      const connectionText = ({ disabled: '接続状態: OFF', needs_application_id: 'Application IDを確認してください', connecting: 'Discordに接続中…', connected: 'Discordに接続済み', disconnected: 'Discordに接続できません', invalid_settings: '設定ファイルを読み込めません' })[discordStatus?.state] || '接続状態を確認中…';
      const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - (discordStatus?.started_at || Math.floor(Date.now() / 1000)));
      const elapsedText = `${Math.floor(elapsed / 3600).toString().padStart(2, '0')}:${Math.floor(elapsed / 60 % 60).toString().padStart(2, '0')}:${(elapsed % 60).toString().padStart(2, '0')} 経過`;
      const published = discordStatus?.published_activity;
      const expectedDisplay = dc.status_display === 'name' ? 0 : dc.status_display === 'state' && dc.show_agent_status !== false ? 1 : 2;
      const reflected = discordStatus?.state === 'connected' && published?.details === detailsText && published?.status_display_type === expectedDisplay
        && published?.state === (dc.show_agent_status === false ? undefined : agentText)
        && !!published?.timestamps === (dc.show_elapsed !== false)
        && (published?.assets?.large_image || '') === (dc.show_image === false ? '' : dc.large_image?.trim() || (commonApp ? discordStatus?.default_image || defaultDiscordImage : ''))
        && (published?.assets?.large_text || '') === (dc.show_image !== false && (dc.large_image?.trim() || commonApp) ? wireText(dc.large_text || 'dsh') : '')
        && (published?.buttons?.[0]?.label || '') === (dc.button_label?.trim() || '') && (published?.buttons?.[0]?.url || '') === (dc.button_url?.trim() || '');
      const discordFeedback = discordMsg.includes('保存できません') ? discordMsg : discordDirty ? '変更はまだ反映されていません'
        : !dc.enabled && discordStatus?.state === 'disabled' ? '保存済み。表示はOFFです。'
        : reflected ? 'Discordに反映しました' : discordMsg || '保存済み';
      const su = sec('setup'); const bt = sec('beta'); const cx = sec('context');
      const cxActive = Object.keys(cx).some((k) => {
        const v = cx[k];
        return Array.isArray(v) ? v.length > 0 : (typeof v === 'string' ? v !== '' : false);
      });
      return h('div', { className: 'rdsh-settings', style: { maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 12 } },
        h('style', null, cssText + discordCss + narrowCss),
        h('section', { className: 'rdsh-discord', style: card, 'aria-label': 'Discord Rich Presence' },
          h('div', { style: { ...row, justifyContent: 'space-between', flexWrap: 'wrap' } }, h('h3', { style: title }, 'Discord Rich Presence'), h('span', { className: 'rdsh-discord-pill' }, discordDirty ? '未保存' : dc.enabled ? '表示 ON' : '表示 OFF')),
          h('p', { style: discordDesc }, 'Discordで、dshの作業状態を共有します。変更は保存すると反映されます。'),
          h('fieldset', { disabled: saving },
          h('label', { style: row }, h('input', { type: 'checkbox', checked: !!dc.enabled, onChange: (e) => setPath('discord', 'enabled', e.target.checked) }), 'Discordに作業状態を表示する'),
          h('label', { style: label }, '表示文', h('input', { style: input, value: dc.details ?? 'dshで作業中', maxLength: 128, placeholder: 'dshで作業中', onChange: (e) => setPath('discord', 'details', e.target.value) })),
          detailsText !== (dc.details?.trim() ? dc.details : 'dshで作業中') ? h('p', { style: warn }, 'Discordの文字数制限に合わせ、プレビューの長さで送信します。') : null,
          h('label', { style: row }, h('input', { type: 'checkbox', checked: dc.show_agent_status !== false, onChange: (e) => setPath('discord', 'show_agent_status', e.target.checked) }), 'agentの稼働状態・稼働数を表示する'),
          h('label', { style: row }, h('input', { type: 'checkbox', checked: dc.show_elapsed !== false, onChange: (e) => setPath('discord', 'show_elapsed', e.target.checked) }), '経過時間を表示する'),
          h('figure', { className: 'rdsh-discord-preview', 'aria-label': 'Discord表示プレビュー' },
            h('figcaption', { className: 'rdsh-discord-meta' }, '表示プレビュー', discordDirty ? '（未保存）' : ''),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
              previewImage ? h('img', { src: previewImage, width: 48, height: 48, alt: '', referrerPolicy: 'no-referrer', style: { borderRadius: 8, objectFit: 'cover', flexShrink: 0 }, onError: e => { e.currentTarget.hidden = true; } }) : null,
              h('div', null, h('strong', null, appName), h('p', null, detailsText))),
            dc.show_agent_status !== false ? h('p', null, agentText) : null,
            dc.show_elapsed !== false ? h('p', { className: 'rdsh-discord-meta' }, elapsedText) : null,
            dc.button_label?.trim() && dc.button_url?.trim() && buttonValid ? h('span', { className: 'rdsh-discord-link' }, dc.button_label.trim()) : null,
            h('p', { className: 'rdsh-discord-meta' }, 'メンバー一覧: ', memberText),
            h('p', { className: 'rdsh-discord-meta' }, dc.enabled ? '現在のagent数を使った表示例です。Discord側の見た目は環境によって異なります。' : 'OFFのため公開されません。ONにして保存すると、この内容を表示します。'),
            dc.show_image !== false && dc.large_image ? h('p', { className: 'rdsh-discord-meta' }, '画像はDiscord上で確認できます。') : null),
          h('details', null,
            h('summary', { style: label }, '詳細設定（一覧の表示・画像・リンク）'),
            h('div', { className: 'rdsh-discord-fields' },
              h('label', { style: label }, 'メンバー一覧に表示する内容', h('select', { style: input, value: dc.status_display || 'details', onChange: e => setPath('discord', 'status_display', e.target.value) }, h('option', { value: 'details' }, '表示文'), h('option', { value: 'state', disabled: dc.show_agent_status === false }, 'agentの状態'), h('option', { value: 'name' }, 'アプリ名'))),
              dc.status_display === 'state' && dc.show_agent_status === false ? h('p', { style: discordDesc }, 'agentの表示がOFFの間は、一覧に表示文を使います。') : null,
              h('label', { style: row }, h('input', { type: 'checkbox', checked: dc.show_image !== false, onChange: e => setPath('discord', 'show_image', e.target.checked) }), 'アプリの画像を表示する'),
              h('label', { style: label }, '画像キー / 画像URL', h('input', { style: input, value: dc.large_image || '', maxLength: 512, placeholder: '例: dsh_logo または https://…/logo.png', onChange: e => setPath('discord', 'large_image', e.target.value), 'aria-invalid': !assetValid })),
              h('p', { style: discordDesc }, 'Art Assetsの画像キー、または公開画像のURLを使います。空欄では共通アプリのアイコンを表示します。独自アプリなら画像なし。'),
              !assetValid ? h('p', { role: 'alert', style: warn }, '画像キーは半角英小文字・数字・_・-、画像URLはhttp / httpsを使ってください。') : null,
              h('label', { style: label }, '画像にカーソルを合わせたときの説明', h('input', { style: input, value: dc.large_text || '', maxLength: 128, placeholder: 'dsh', onChange: e => setPath('discord', 'large_text', e.target.value) })),
              h('label', { style: label }, 'リンクボタンの名前', h('input', { style: input, value: dc.button_label || '', maxLength: 32, placeholder: '例: dshについて', onChange: e => setPath('discord', 'button_label', e.target.value) })),
              h('label', { style: label }, 'リンク先', h('input', { style: input, type: 'url', value: dc.button_url || '', maxLength: 512, placeholder: 'https://…', onChange: e => setPath('discord', 'button_url', e.target.value), 'aria-invalid': !buttonValid })),
              !buttonValid || !buttonComplete ? h('p', { role: 'alert', style: warn }, '名前とhttp / httpsのURLを両方入力するか、両方を空欄にしてください。') : null,
              h('p', { style: discordDesc }, 'リンクボタンは他の人に表示されます。自分のプロフィールには表示されません。'))),
          h('details', null,
            h('summary', { style: label }, '独自のDiscordアプリを使う'),
            h('div', { className: 'rdsh-discord-fields' },
              h('p', { style: discordDesc }, '通常は変更不要です。共通アプリ（rdsh）を使います。アプリ名はDeveloper PortalのGeneral Informationで設定します。'),
              h('label', { style: label }, 'Application ID', h('input', { style: input, value: dc.application_id || '', inputMode: 'numeric', maxLength: 20, placeholder: 'Discord Application ID', onChange: (e) => setPath('discord', 'application_id', e.target.value), 'aria-invalid': !idValid })),
              !idValid ? h('p', { role: 'alert', style: warn }, 'Application IDは17〜20桁の数字です。空欄で共通アプリに戻せます。') : null,
              h('p', { style: discordDesc }, '空欄で保存すると共通アプリに戻ります。Bot tokenやClient secretは不要です。')))),
          h('div', { className: 'rdsh-discord-actions' }, h('button', { className: 'rdsh-btn-pri', disabled: saving || !discordDirty || !discordValid, onClick: () => saveAll(true) }, saving ? '保存中…' : 'Discord設定を保存'), h('span', { role: discordMsg.includes('保存できません') ? 'alert' : 'status', className: 'rdsh-discord-meta' }, discordFeedback)),
          h('p', { role: 'status', className: 'rdsh-discord-meta' }, connectionText, discordStatus?.state === 'connected' && discordStatus.updated_at ? ` / 最終反映 ${new Date(discordStatus.updated_at).toLocaleTimeString()}` : ''),
          discordStatus?.state === 'disconnected' || discordStatus?.state === 'connecting' ? h('p', { style: discordDesc }, 'Discordデスクトップアプリを起動してください。WSLからWindows側にも接続します。5秒ごとに自動再接続します。') : null,
          discordStatus?.state === 'connected' ? h('p', { style: discordDesc }, '表示が見えない場合は、Discordの「アクティビティのプライバシー」で共有設定を確認してください。') : null,
          h('p', { style: discordDesc }, 'プロンプト、ファイル名、プロジェクトのパスは送信しません。'),
        ),
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
            h('div', { style: row }, h('span', { style: label }, '旧履歴参照数（自動取り込みは無効）'), h('input', { type: 'number', min: 0, max: 100, value: cx.max_sessions, onChange: (e) => num('context', 'max_sessions', e.target.value, 0), style: { ...input, maxWidth: 110 } }))),
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
          h('div', { style: row }, h('span', { style: label }, 'ポート'), h('input', { type: 'number', min: 1, max: 65535, value: svv.port, onChange: (e) => num('serve', 'port', e.target.value, 38080), style: { ...input, maxWidth: 110 } })),
          h('div', { style: label }, 'ガード (guard)'),
          h('div', null, h('div', { style: label }, '拒否パス (1行1件)'), h('textarea', { value: toLines(gu.deny), rows: 2, onChange: (e) => setPath('guard', 'deny', fromLines(e.target.value)), style: { ...input, minHeight: 44 } })),
          h('div', null, h('div', { style: label }, '理由'), h('input', { value: gu.reason || '', onChange: (e) => setPath('guard', 'reason', e.target.value), style: input })),
          h('div', { style: label }, 'ベンチ (bench)'),
          h('div', { style: row }, h('span', { style: label }, '回数'), h('input', { type: 'number', min: 1, max: 20, value: be.n, onChange: (e) => num('bench', 'n', e.target.value, 5), style: { ...input, maxWidth: 110 } })),
          h('div', { style: label }, 'セットアップ (setup)'),
          h('div', { style: row }, h('span', { style: label }, 'Webポート (0=ランダム)'), h('input', { type: 'number', min: 0, max: 65535, value: su.web_port, onChange: (e) => num('setup', 'web_port', e.target.value, 0), style: { ...input, maxWidth: 110 } }))
        ),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('button', { className: 'rdsh-btn-pri', onClick: () => saveAll(), disabled: saving || !discordValid, style: { padding: '8px 16px', borderRadius: 8, cursor: 'pointer', fontSize: 14 } }, saving ? '保存中…' : '保存する'),
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
