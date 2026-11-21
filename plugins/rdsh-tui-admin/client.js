window.__ModuleLoader__.load({
  id: 'rdsh-tui-admin',
  factory() {
    return {
      inject: ['uiWorkspace', 'sidebarRight', 'remote', 'remote.workspaceFiles', 'layout', 'sessions'],
      apply(ctx) {
        if (globalThis.__RDSH_TUI_BRIDGE_ENABLED__ !== true) return;
        const valid = id => typeof id === 'string' && id.length > 0 && id.length <= 512 && !/[\u0000-\u001f\u007f]/.test(id);
        const validPath = path => typeof path === 'string' && path.length > 0 && path.length <= 32768 && !/[\u0000-\u001f\u007f]/.test(path);
        const selected = () => {
          const id = ctx.sidebarRight.mounted.getSnapshot();
          return valid(id) ? id : null;
        };
        const navigationReady = id => {
          if (id !== undefined && !valid(id)) return false;
          const snapshot = ctx.sessions.list.getSnapshot();
          return snapshot.phase === 'ready' && (id === undefined || Object.hasOwn(snapshot.byId, id));
        };
        const sessionAddress = (id, path) => `dsh-resource://file/session/${encodeURIComponent(id)}/${path.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '')
          .split('/').map(segment => encodeURIComponent(segment).replaceAll('%3A', ':')).join('/')}`;
        const requireSameSession = id => { if (selected() !== id) throw new Error('表示中のセッションが変更されました。もう一度開いてください。'); };
        const readFileStat = async (id, path) => {
          const result = await ctx.remote.workspaceFiles.stat(id, path);
          requireSameSession(id);
          if (!result?.ok) return result;
          if (!validPath(result.value?.absolutePath)) throw new Error('ファイルの場所を確認できません。');
          return result;
        };
        const preview = (id, path) => {
          requireSameSession(id);
          ctx.sidebarRight.openResource(sessionAddress(id, path));
        };
        let closeDirectory = () => {};
        async function showDirectory(id, path, revealPath) {
          closeDirectory();
          const dialog = document.createElement('dialog');
          dialog.setAttribute('aria-label', 'ファイルとフォルダ');
          dialog.style.cssText = 'width:min(900px,90vw);max-height:85vh;padding:20px;border:2px solid #00a0b0;background:Canvas;color:CanvasText;overflow:auto;';
          const heading = document.createElement('h2');
          heading.textContent = 'ファイルとフォルダ';
          const location = document.createElement('p');
          location.style.overflowWrap = 'anywhere';
          const notice = document.createElement('p');
          notice.setAttribute('role', 'status');
          const crumbs = document.createElement('nav');
          crumbs.setAttribute('aria-label', '親フォルダ');
          const rows = document.createElement('div');
          const close = document.createElement('button');
          close.textContent = '閉じる';
          let alive = true, generation = 0, controller;
          closeDirectory = () => {
            if (!alive) return;
            alive = false;
            controller?.abort();
            dialog.close();
            dialog.remove();
          };
          close.addEventListener('click', closeDirectory);
          dialog.addEventListener('cancel', event => { event.preventDefault(); closeDirectory(); });
          dialog.append(heading, location, notice, crumbs, rows, close);
          if (revealPath) {
            const target = document.createElement('p');
            target.textContent = `表示対象: ${revealPath}`;
            target.style.overflowWrap = 'anywhere';
            const openTarget = document.createElement('button');
            openTarget.textContent = '表示対象のファイルを開く';
            openTarget.addEventListener('click', () => {
              try { preview(id, revealPath); closeDirectory(); }
              catch { notice.textContent = 'ファイルを開けません。セッションと表示対応を確認してください。'; }
            });
            dialog.append(target, openTarget);
          }
          const button = (text, onClick) => {
            const element = document.createElement('button');
            element.textContent = text;
            element.style.cssText = 'display:block;max-width:100%;margin:4px 0;overflow-wrap:anywhere;';
            element.addEventListener('click', onClick);
            return element;
          };
          async function navigate(next) {
            const current = ++generation;
            controller?.abort();
            controller = new AbortController();
            notice.textContent = '読込み中…';
            try {
              requireSameSession(id);
              let listing, files;
              try { listing = await ctx.uiWorkspace.listDirectory(next, controller.signal); }
              catch (error) {
                // Desktop profiles commonly compose the native-only picker.
                // Its explicit capability refusal is not a filesystem denial:
                // use the existing workspace-scoped listing authority instead.
                if ((error?.rpcError?.code ?? error?.code) !== 'directory-picker/unavailable') throw error;
                files = await ctx.remote.workspaceFiles.list(id, next, controller.signal);
                if (!files?.ok || !Array.isArray(files.value?.entries)) throw new Error('Workspace directory listing unavailable');
                const cwd = ctx.sessions.list.getSnapshot().byId[id]?.cwd;
                const base = validPath(cwd) && typeof files.value.path === 'string'
                  ? `${cwd.replaceAll('\\', '/').replace(/\/$/, '')}/${files.value.path}`.replace(/\/$/, '') || '/'
                  : next.replaceAll('\\', '/').replace(/\/$/, '') || '/';
                if (!validPath(base) || !/^(?:\/|[A-Za-z]:\/)/.test(base)) throw new Error('Workspace root unavailable');
                let parent = base.slice(0, base.lastIndexOf('/')) || '/';
                if (/^[A-Za-z]:$/.test(parent)) parent += '/';
                const childName = name => typeof name === 'string' && name.length > 0 && !/[\\/\u0000-\u001f]/.test(name);
                listing = { path: base, crumbs: [{ name: '親フォルダ', path: parent }, { name: base, path: base }],
                  entries: files.value.entries.filter(entry => entry.type === 'directory' && childName(entry.name))
                    .map(entry => ({ name: entry.name, path: `${base.replace(/\/$/, '')}/${entry.name}` })),
                  truncated: files.value.truncated === true };
              }
              if (!alive || current !== generation) return;
              requireSameSession(id);
              if (!validPath(listing?.path) || !Array.isArray(listing.crumbs) || !Array.isArray(listing.entries)) throw new Error();
              location.textContent = listing.path;
              crumbs.replaceChildren();
              rows.replaceChildren();
              for (const crumb of listing.crumbs.slice(0, 256))
                if (validPath(crumb.path)) crumbs.append(button(crumb.name, () => { void navigate(crumb.path); }));
              for (const entry of listing.entries.slice(0, 4096))
                if (validPath(entry.path)) rows.append(button(`フォルダ: ${entry.name}`, () => { void navigate(entry.path); }));
              notice.textContent = listing.truncated ? 'フォルダ一覧は一部省略されています。' : '';
              files ??= await ctx.remote.workspaceFiles.list(id, listing.path, controller.signal);
              if (!alive || current !== generation) return;
              requireSameSession(id);
              if (!files?.ok) { notice.textContent += ' ファイル一覧はこのワークスペース内だけで利用できます。'; return true; }
              for (const entry of files.value.entries.slice(0, 4096)) {
                if (entry.type !== 'file' || typeof entry.name !== 'string' || /[\\/\u0000-\u001f]/.test(entry.name)) continue;
                const filePath = `${listing.path.replace(/[\\/]$/, '')}/${entry.name}`;
                rows.append(button(`ファイル: ${entry.name}`, async () => {
                  try {
                    const result = await readFileStat(id, filePath);
                    if (!alive || !result?.ok) throw new Error();
                    preview(id, result.value.absolutePath);
                    closeDirectory();
                  } catch { if (alive) notice.textContent = 'ファイルを開けません。権限と表示対応を確認してください。'; }
                }));
              }
              if (files.value.truncated) notice.textContent += ' ファイル一覧は一部省略されています。';
              return true;
            } catch {
              if (alive && current === generation) notice.textContent = 'フォルダを開けません。権限と表示中のセッションを確認してください。';
              return false;
            }
          }
          document.body.append(dialog);
          dialog.showModal();
          if (await navigate(path) !== true) throw new Error('フォルダの表示を完了できません。');
        }
        const bridge = Object.freeze({
          navigationReady(id) { return navigationReady(id); },
          openSession(id) {
            if (!valid(id)) throw new TypeError('Invalid session identity');
            if (!navigationReady(id)) throw new Error('対象セッションの一覧同期を待ってから開いてください。');
            // Cancel an earlier asynchronous workspace restoration before
            // retaining this explicit navigation, through the public owner.
            ctx.layout.beginNavigation();
            ctx.uiWorkspace.openSession(id);
            return { requestedSessionId: id };
          },
          selectedSessionId() { return selected(); },
          async openWorkspacePath(request) {
            if (!request || typeof request !== 'object' || Array.isArray(request)
              || Object.keys(request).some(key => !['path', 'action', 'application'].includes(key))
              || !validPath(request.path) || (request.action !== undefined && request.action !== 'reveal')
              || (request.application !== undefined && !validPath(request.application))) throw new TypeError('Invalid workspace path request');
            const id = selected();
            if (!id) throw new Error('表示中のセッションがありません。');
            const result = await readFileStat(id, request.path);
            if (result?.ok) {
              const path = result.value.absolutePath;
              if (request.action === 'reveal') {
                const normalized = path.replaceAll('\\', '/');
                let parent = normalized.slice(0, normalized.lastIndexOf('/')) || '/';
                if (/^[A-Za-z]:$/.test(parent)) parent += '/';
                await showDirectory(id, parent, path);
                return { opened: true, view: 'directory', requestedPath: request.path, revealedPath: path };
              }
              preview(id, path);
              return { opened: true, view: 'document', requestedPath: request.path };
            }
            if (result?.error?.code !== 'workspace-file/not-regular-file' || result.error.details?.kind !== 'directory')
              throw new Error('指定されたファイルまたはフォルダを開けません。');
            await showDirectory(id, request.path);
            return { opened: true, view: 'directory', requestedPath: request.path };
          },
        });
        return ctx.effect(() => {
          Object.defineProperty(globalThis, '__RDSH_TUI_WORKSPACE__', { configurable: true, value: bridge });
          return () => {
            closeDirectory();
            if (globalThis.__RDSH_TUI_WORKSPACE__ === bridge) delete globalThis.__RDSH_TUI_WORKSPACE__;
          };
        });
      },
    };
  },
});
