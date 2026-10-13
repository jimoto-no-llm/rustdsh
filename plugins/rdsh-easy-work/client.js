window.__ModuleLoader__.load({
  id: 'rdsh-easy-work',
  factory(require) {
    const React = require('react');
    const errors = {
      PLAN_EXPIRED: '確認画面の有効期限が切れました。フォルダを選び直してください。',
      FILES_CHANGED: '確認後にファイルが変わりました。もう一度、整理内容を確認してください。',
      FOLDER_CHANGED: 'フォルダの場所が変わりました。選び直してください。',
      FOLDER_TOO_LARGE: '200ファイル・合計256 MBまでです。小さなフォルダを選んでください。',
      TOO_MANY_PLANS: '確認画面が多く開かれています。10分後にやり直してください。',
      OUTPUT_CHANGED: '整理先が変わったため、取り消しを止めました。フォルダを選び直してください。',
      GUI_AUTH_REQUIRED: 'DSHに接続し直してから、やり直してください。',
      COPY_FAILED: 'コピーを完了できませんでした。元ファイルは残っています。途中のコピーは保管して取り消せます。',
      WORK_IN_PROGRESS: '作業中です。終わるまでお待ちください。',
      REQUEST_FAILED: 'フォルダを開けませんでした。場所とアクセス権を確認してください。',
    };
    const css = `
    .rdsh-easy{--easy-ink:var(--dsw-alias-label-primary,#18324c);--easy-paper:var(--dsw-alias-bg-module-platform,#fff);--easy-blue:var(--dsw-alias-button-primary-fill,#245eae);--easy-line:var(--dsw-alias-border-l3,#ced9e6);font:15px/1.7 'Noto Sans CJK JP','Hiragino Kaku Gothic ProN','Yu Gothic',sans-serif;color:var(--easy-ink);text-align:left;width:min(100%,720px);margin:20px auto;padding:22px;box-sizing:border-box;border:1px solid var(--easy-line);border-radius:16px;background:var(--easy-paper)}
    .rdsh-easy *{box-sizing:border-box}.rdsh-easy h2{font-size:24px;line-height:1.4;margin:0 0 10px;letter-spacing:.01em}.rdsh-easy p{margin:8px 0}.rdsh-easy .easy-note{font-size:13px;color:var(--dsw-alias-label-secondary,#4b627a)}
    .rdsh-easy .easy-steps{display:flex;gap:16px;list-style:none;padding:0;margin:0 0 20px;font-size:13px;border-bottom:1px solid var(--easy-line);padding-bottom:12px}.rdsh-easy .easy-steps [aria-current=step]{font-weight:700;color:var(--easy-blue)}
    .rdsh-easy button{font:inherit;cursor:pointer;min-height:44px;padding:8px 16px;border:1px solid var(--easy-line);border-radius:8px;color:var(--easy-ink);background:var(--easy-paper)}.rdsh-easy button.primary{background:var(--easy-blue);color:var(--dsw-alias-label-primary-foreground,#fff);border-color:transparent}.rdsh-easy button:disabled{opacity:.55;cursor:wait}.rdsh-easy button:focus-visible,.rdsh-easy input:focus-visible,.rdsh-easy summary:focus-visible{outline:3px solid #5598df;outline-offset:3px}
    .rdsh-easy .easy-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}.rdsh-easy input{width:100%;min-height:44px;margin:8px 0;padding:8px;border:1px solid var(--easy-line);border-radius:6px;background:var(--easy-paper);color:var(--easy-ink);font:inherit}.rdsh-easy summary{cursor:pointer}.rdsh-easy .easy-path{overflow-wrap:anywhere;font-size:13px;padding:10px 0;border-bottom:1px solid var(--easy-line)}
    .rdsh-easy .easy-scroll{overflow:auto;max-height:320px;margin-top:14px}.rdsh-easy table{width:100%;border-collapse:collapse;font-size:13px;text-align:left}.rdsh-easy th,.rdsh-easy td{padding:10px 8px;border-bottom:1px solid var(--easy-line);overflow-wrap:anywhere}.rdsh-easy th{font-weight:500}.rdsh-easy td:first-child{width:60%}.rdsh-easy .easy-status{padding:12px 0;white-space:pre-wrap}.rdsh-easy [role=alert]{color:var(--dsw-alias-state-error,#a93131)}.rdsh-easy .easy-result{border-left:3px solid #236848;padding-left:16px}.rdsh-easy .easy-hidden{display:none}
    @media(max-width:480px){.rdsh-easy{padding:16px;margin:12px auto}.rdsh-easy h2{font-size:21px}.rdsh-easy .easy-actions button{width:100%}.rdsh-easy .easy-steps{gap:10px}}
    `;
    const bytes = n => n < 1048576 ? `${Math.ceil(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
    const set = (root, selector, value) => { root.querySelector(selector).textContent = value; };
    async function api(action, value, signal) {
      const response = await fetch(`/api/rdsh-easy-work/${action}`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), signal });
      const result = await response.json();
      if (!response.ok || !result.ok) throw Object.assign(new Error(result.error), { code: result.error });
      return result.result;
    }
    // The native component and browser acceptance fixture share this renderer.
    function mount(root, { request = api, pick } = {}) {
      let plan, busy = false, message = '', alert = false, disposed = false, recovered = [];
      const lifetime = new AbortController();
      // The native hero row normally contains two compact chooser buttons.
      // Keep its workspace chooser and let this larger entry use another row.
      const parent = root.parentElement;
      const previousWrap = parent?.style.flexWrap;
      const wrapParent = parent && getComputedStyle(parent).display === 'flex';
      if (wrapParent) { parent.style.flexWrap = 'wrap'; root.style.flexBasis = '100%'; root.style.minWidth = '0'; }
      function draw() {
        if (disposed) return;
        root.className = 'rdsh-easy';
        root.setAttribute('aria-busy', String(busy));
        root.innerHTML = `<style>${css}</style><ol class="easy-steps" aria-label="整理の手順"><li>1 選ぶ</li><li>2 確認する</li><li>3 完了</li></ol>
          <h2>フォルダを、すっきり。</h2><p>写真・資料・表を、種類ごとのフォルダへコピーします。</p>
          <p class="easy-note">元ファイルを残します。端末内で処理するため、AI費用は0円です。</p>
          <div class="easy-start"><div class="easy-actions"><button type="button" class="primary" data-action="pick">フォルダを選ぶ</button></div>
          <details><summary>フォルダの場所を入力</summary><label>フォルダの場所<input type="text" autocomplete="off" placeholder="フォルダの絶対パス"></label><p class="easy-note">Web版では、DSHが動いている端末のフォルダを指定します。</p><button type="button" data-action="preview">整理内容を確認</button></details></div>
          <div class="easy-plan easy-hidden"><p class="easy-path"></p><details><summary>フォルダの場所を見る</summary><p class="easy-full-path easy-path"></p></details><div class="easy-preview"><p class="easy-count"></p><p class="easy-note">フォルダ内のファイルだけが対象です。子フォルダ・隠しファイル・リンクはコピーしません。</p><div class="easy-scroll"><table><thead><tr><th>元ファイル</th><th>コピー先の分類</th></tr></thead><tbody></tbody></table></div><p class="easy-platform easy-note"></p><div class="easy-actions"><button type="button" class="primary" data-action="execute">確認した内容でコピーする</button></div></div>
          <div class="easy-result easy-hidden"><p class="easy-done"></p><p class="easy-output easy-path"></p><p class="easy-note">取り消すとコピー先を保管用フォルダへ移します。コピーや編集した内容も残ります。</p><div class="easy-actions"><button type="button" data-action="undo">整理を取り消す（コピーを保管）</button></div></div><div class="easy-actions"><button type="button" data-action="reset">別のフォルダを選ぶ</button></div></div>
          <div class="easy-recovery"></div><div class="easy-status" role="status" aria-live="polite"></div>`;
        root.querySelectorAll('button').forEach(button => button.disabled = busy);
        const step = !plan ? 0 : plan.state === 'preview' ? 1 : 2;
        root.querySelectorAll('.easy-steps li')[step].setAttribute('aria-current', 'step');
        root.querySelector('.easy-start').classList.toggle('easy-hidden', Boolean(plan));
        root.querySelector('.easy-plan').classList.toggle('easy-hidden', !plan);
        if (plan) {
          set(root, '.easy-path', `選んだフォルダ：${plan.folder.split(/[\\/]/).filter(Boolean).at(-1) || plan.folder}`);
          set(root, '.easy-full-path', plan.folder);
          const preview = plan.state === 'preview';
          root.querySelector('.easy-preview').classList.toggle('easy-hidden', !preview);
          root.querySelector('.easy-result').classList.toggle('easy-hidden', preview);
          set(root, '.easy-count', `${plan.entries.length}ファイル / ${bytes(plan.bytes)} をコピーします。対象外：${plan.skipped}件。確認は10分間有効です。`);
          const tbody = root.querySelector('tbody');
          for (const entry of plan.entries) {
            const row = document.createElement('tr');
            for (const text of [entry.name, entry.group]) { const cell = document.createElement('td'); cell.textContent = text; row.append(cell); }
            tbody.append(row);
          }
          set(root, '.easy-platform', plan.executable ? 'コピー先は新しいフォルダです。既存のファイルには上書きしません。' : 'この端末ではプレビューのみ利用できます。コピーと取り消しは現在Linuxに対応しています。');
          root.querySelector('[data-action=execute]').disabled = busy || !plan.executable || !plan.entries.length;
          set(root, '.easy-done', plan.state === 'undone' ? '整理を取り消しました。元ファイルはそのままです。' : plan.state === 'completed' ? `${plan.copied}ファイルの整理が終わりました。` : `${plan.copied}ファイルをコピー済みです。途中のコピーを保管できます。`);
          set(root, '.easy-output', `コピーの保存先：${plan.output || '未作成'}`);
          root.querySelector('[data-action=undo]').disabled = busy || !plan.executable || !['completed', 'partial', 'copying'].includes(plan.state);
        }
        for (const previous of recovered) {
          const button = document.createElement('button'); button.type = 'button'; button.disabled = busy;
          button.textContent = `前回のコピーを確認（${previous.copied}ファイル）`;
          button.onclick = () => { plan = previous; recovered = []; message = ''; draw(); };
          root.querySelector('.easy-recovery').append(button);
        }
        const status = root.querySelector('.easy-status'); status.textContent = message;
        status.setAttribute('role', alert ? 'alert' : 'status');
        root.querySelector('[data-action=pick]').onclick = () => run(async () => {
          const path = await pick?.();
          if (!path) { message = 'フォルダを選べない場合は、「フォルダの場所を入力」から指定してください。'; return; }
          await preview(path);
        });
        root.querySelector('[data-action=preview]').onclick = () => {
          const path = root.querySelector('input').value.trim();
          run(() => preview(path));
        };
        root.querySelector('[data-action=execute]').onclick = () => run(async () => {
          plan = await request('execute', { id: plan.id, confirmed: true }, lifetime.signal); message = '完了しました。';
        }, 'コピーしています。画面を閉じずにお待ちください。');
        root.querySelector('[data-action=undo]').onclick = () => run(async () => {
          plan = await request('undo', { id: plan.id, confirmed: true }, lifetime.signal); message = 'コピーを保管用フォルダへ移しました。';
        }, 'コピーを保管しています。');
        root.querySelector('[data-action=reset]').onclick = () => run(async () => {
          for (const id of new Set([plan?.id, ...recovered.map(p => p.id)].filter(Boolean))) await request('release', { id }, lifetime.signal);
          plan = null; recovered = []; message = ''; alert = false;
        }, '次の作業を準備しています。');
      }
      async function preview(path) {
        plan = await request('preview', { path }, lifetime.signal);
        recovered = await request('recover', { id: plan.id }, lifetime.signal);
        message = plan.entries.length ? '内容を確認してから実行してください。' : 'コピー対象のファイルがありません。';
      }
      async function run(operation, progress = 'フォルダを確認しています。') {
        if (busy || disposed) return;
        busy = true; alert = false; message = progress; draw();
        try { await operation(); }
        catch (error) {
          if (disposed) return;
          message = errors[error.code] || '作業を完了できませんでした。フォルダを選び直して、確認してください。'; alert = true;
          if (plan) { try { plan = await request('status', { id: plan.id }, lifetime.signal); } catch { /* keep the visible preview */ } }
        } finally { busy = false; draw(); }
      }
      draw();
      return () => {
        disposed = true; lifetime.abort(); root.replaceChildren();
        if (wrapParent && parent.style.flexWrap === 'wrap') parent.style.flexWrap = previousWrap;
      };
    }
    function Panel({ pick }) {
      const root = React.useRef(null);
      React.useEffect(() => mount(root.current, { pick }), [pick]);
      return React.createElement('section', { ref: root, 'aria-label': 'ファイル整理' });
    }
    return { inject: ['slots', 'uiWorkspace'], mount, apply(ctx) {
      const pick = async () => {
        if (globalThis.__DSH_DIRECTORY_PICKER__?.pick) return globalThis.__DSH_DIRECTORY_PICKER__.pick();
        return ctx.uiWorkspace.pickDirectory();
      };
      ctx.slots.inject('conversation.hero.agentPreset', () => ctx.slots.register({
        // This is a single native seat. A distinct priority shadows the stock
        // chooser while this opt-in plugin is active and restores it on unload.
        name: 'conversation.hero.agentPreset', priority: -20, inject: () => ({ pick }),
      }, Panel));
    } };
  },
});
