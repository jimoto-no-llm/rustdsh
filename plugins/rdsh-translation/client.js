window.__ModuleLoader__.load({
  id: 'rdsh-translation',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    // 表示文言はDSHのlocaleカタログへ登録する。このファイルへ訳文を直接書かない。
    const NAMESPACE = 'rdsh-translation';
    const dictionaries = {
      en: {
        'action.show': 'Show Japanese translation',
        'action.busy': 'Translating…',
        'action.again': 'Translate again',
        'action.aria': 'Show a Japanese translation of this answer',
        'status.translating': 'Translating…',
        'dialog.aria': 'Japanese translation of the answer',
        'dialog.section': 'Japanese translation (display only)',
        'dialog.title': 'Japanese translation',
        'dialog.note': 'The original answer and the conversation history are unchanged. This translation is shown only on this screen.',
        'dialog.replaceSection': 'Japanese translation (the answer is replaced in the conversation history)',
        'dialog.replaceNote': 'The next model request reads this translation instead of the original answer. The original answer stays in the session log and on this screen.',
        'action.replace': 'Replace with Japanese translation',
        'action.replaceBusy': 'Replacing…',
        'action.replaced': 'Replaced in history',
        'action.replaceAria': 'Replace this answer with its Japanese translation in the conversation history',
        'error.replace': 'The answer could not be replaced. Try again.',
        'dialog.close': 'Close',
        'error.command': 'The translation command did not run. Try again.',
        'error.result': 'No translation result was received. Try again.',
      },
      zh: {
        'action.show': '显示日文翻译',
        'action.busy': '翻译中…',
        'action.again': '重新翻译',
        'action.aria': '显示此回答的日文翻译',
        'status.translating': '正在翻译…',
        'dialog.aria': '回答的日文翻译',
        'dialog.section': '日文翻译（仅显示）',
        'dialog.title': '日文翻译',
        'dialog.note': '原文与会话历史均未更改。译文仅在此画面显示。',
        'dialog.replaceSection': '日文翻译（已在会话历史中替换回答）',
        'dialog.replaceNote': '下次模型请求将读取此译文而非原文。原文仍保留在会话日志和本画面中。',
        'action.replace': '用日文翻译替换',
        'action.replaceBusy': '替换中…',
        'action.replaced': '已替换历史',
        'action.replaceAria': '在会话历史中用日文翻译替换此回答',
        'error.replace': '无法替换回答。请重试。',
        'dialog.close': '关闭',
        'error.command': '无法执行翻译命令。请重试。',
        'error.result': '未能收到翻译结果。请重试。',
      },
      ja: {
        'action.show': '日本語訳を表示',
        'action.busy': '和訳中…',
        'action.again': 'もう一度和訳する',
        'action.aria': '回答の日本語訳を表示',
        'status.translating': '翻訳しています…',
        'dialog.aria': '回答の日本語訳',
        'dialog.section': '日本語訳（表示のみ）',
        'dialog.title': '日本語訳',
        'dialog.note': '原文と会話履歴は変更していません。訳文はこの画面でのみ表示します。',
        'dialog.replaceSection': '日本語訳（会話履歴の回答を置換済み）',
        'dialog.replaceNote': '次のモデル要求は元の回答ではなくこの訳文を読みます。元の回答は会話ログとこの画面に残ります。',
        'action.replace': '日本語訳で置き換える',
        'action.replaceBusy': '置き換えています…',
        'action.replaced': '履歴を置き換えました',
        'action.replaceAria': 'この回答を日本語訳で会話履歴上に置き換える',
        'error.replace': '回答を置き換えられませんでした。再試行してください',
        'dialog.close': '閉じる',
        'error.command': '和訳コマンドを実行できませんでした。再試行してください',
        'error.result': '和訳結果を受け取れませんでした。再試行してください',
      },
    };
    // 日本語の言語定義はrdsh-settingsが所有する。ここは辞書だけを登録し、
    // 別の日本語パックと言語idを奪い合わない。
    function hasLocale(ctx) {
      return Boolean(ctx.locale) && typeof ctx.locale.register === 'function' && typeof ctx.effect === 'function';
    }
    let thresholdPromise;
    function threshold() {
      return thresholdPromise ||= fetch('/api/rdsh-translation/config', { cache: 'no-store' })
        .then(async (response) => { const value = await response.json(); return response.ok && value?.ok && typeof value.kana_threshold === 'number' && Number.isFinite(value.kana_threshold) ? Math.min(0.5, Math.max(0.01, value.kana_threshold)) : 0.08; })
        .catch(() => 0.08);
    }
    function eligible(data, messageId, limit) {
      const final = data?.finalNode;
      if (data?.status !== 'settled' || !final || final.messageId !== messageId || final.interrupted || !Array.isArray(final.blocks) || final.blocks.some((b) => !b || !['text', 'reasoning'].includes(b.kind))) return false;
      let kana = 0, lexical = 0, fence;
      for (const line of final.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('\n').split(/\r?\n/u)) {
        const content = line.replace(/^(?: {0,3}>[ \t]?)+/u, '');
        const open = content.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
        if (!fence && open) { fence = open; continue; }
        if (fence) { const close = content.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/u)?.[1]; if (close && close[0] === fence[0] && close.length >= fence.length) fence = undefined; continue; }
        if (/^(?: {4}|\t)/u.test(content)) continue;
        for (const char of content) { if (/[\p{L}\p{N}]/u.test(char)) lexical++; if (/[\u3040-\u309f\u30a0-\u30ff\uff66-\uff9d]/u.test(char)) kana++; }
      }
      return lexical > 0 && kana / lexical < limit;
    }
    function TranslateAction(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const data = props.useChat((snapshot) => [...snapshot.nodes.values()].find((node) => node.kind === 'assistant-step' && node.data?.finalNode?.messageId === props.messageId)?.data);
      const [limit, setLimit] = React.useState(null);
      const [state, setState] = React.useState(null);
      // 置換済みの回答id。画面の再読込では失われるが、モデル履歴の置換は残る。
      const [replaced, setReplaced] = React.useState(null);
      const preview = React.useRef(null);
      const active = React.useRef({ messageId: props.messageId, pending: null });
      if (active.current.messageId !== props.messageId) active.current = { messageId: props.messageId, pending: null };
      React.useEffect(() => { let mounted = true; threshold().then((value) => { if (mounted) setLimit(value); }); return () => { mounted = false; active.current.pending = null; }; }, []);
      React.useEffect(() => {
        if (state?.messageId === props.messageId && (state.text || state.error) && preview.current && !preview.current.open) preview.current.showModal();
      }, [state, props.messageId]);
      if (limit === null || !eligible(data, props.messageId, limit)) return null;
      const view = state?.messageId === props.messageId ? state : null;
      const isReplaced = replaced === props.messageId;
      const run = async (mode) => {
        if (active.current.pending) return;
        const request = { messageId: props.messageId, mode };
        active.current.pending = request;
        setState({ messageId: props.messageId, busy: mode });
        const settle = (value) => { if (active.current.pending === request && active.current.messageId === request.messageId) setState({ messageId: request.messageId, ...value }); };
        const replacing = mode === 'replace';
        try {
          const response = await (replacing ? props.replace(request.messageId) : props.execute(request.messageId));
          if (!response?.ok) throw new Error(t(replacing ? 'error.replace' : 'error.command'));
          const result = response.value?.result;
          if (result?.kind !== 'success' || typeof result.text !== 'string' || !result.text.trim()) {
            settle({ error: result?.kind === 'error' && typeof result.text === 'string' ? result.text : t(replacing ? 'error.replace' : 'error.result') });
          } else {
            if (replacing) setReplaced(request.messageId);
            settle({ text: result.text, replaced: replacing });
          }
        } catch { settle({ error: t(replacing ? 'error.replace' : 'error.command') }); }
        finally { if (active.current.pending === request) active.current.pending = null; }
      };
      return h('div', { className: 'rdsh-translation-preview', style: { maxWidth: '100%', minWidth: 0 } },
        h('button', { type: 'button', disabled: Boolean(view?.busy), onClick: () => run('preview'), 'aria-label': t('action.aria'), 'data-testid': 'rdsh-translate-action', style: { cursor: view?.busy ? 'wait' : 'pointer', font: 'inherit' } }, view?.busy === 'preview' ? t('action.busy') : view?.text ? t('action.again') : t('action.show')),
        h('button', { type: 'button', disabled: Boolean(view?.busy) || isReplaced, onClick: () => run('replace'), 'aria-label': t('action.replaceAria'), 'data-testid': 'rdsh-translate-replace', style: { cursor: view?.busy ? 'wait' : 'pointer', font: 'inherit' } }, isReplaced ? t('action.replaced') : view?.busy === 'replace' ? t('action.replaceBusy') : t('action.replace')),
        view?.busy ? h('span', { role: 'status', 'aria-live': 'polite' }, ' ' + t('status.translating')) : null,
        view?.text || view?.error ? h('dialog', { ref: preview, 'aria-label': t('dialog.aria'), style: { width: 'min(42rem, calc(100vw - 3rem))', maxHeight: '80vh', overflow: 'auto', boxSizing: 'border-box', padding: 16, border: '1px solid currentColor', borderRadius: 8, font: 'inherit' } },
          h('button', { type: 'button', onClick: () => preview.current?.close(), style: { float: 'right', font: 'inherit' } }, t('dialog.close')),
          view.error ? h('p', { role: 'alert' }, view.error) : h('section', { 'aria-label': view.replaced ? t('dialog.replaceSection') : t('dialog.section') },
            h('strong', null, t('dialog.title')), h('p', { style: { fontSize: '0.85em' } }, view.replaced ? t('dialog.replaceNote') : t('dialog.note')),
            h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit', marginBottom: 0 } }, view.text))) : null);
    }
    return { inject: ['slots', 'remote', 'remote.commands', 'locale'], apply(ctx) {
      const localized = hasLocale(ctx);
      if (localized) for (const [id, dictionary] of Object.entries(dictionaries)) {
        ctx.effect(() => ctx.locale.register(NAMESPACE, id, dictionary), `rdsh-translation: ${id} dictionary`);
      }
      ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({ name: 'conversation.chat.assistant-actions', id: 'rdsh-translation-preview', order: 35,
        ...localized ? { locale: NAMESPACE } : {},
        inject: (sessionId) => ({
          execute: (messageId) => ctx.remote.commands.execute(sessionId, '/ja-preview ' + messageId, []),
          replace: (messageId) => ctx.remote.commands.execute(sessionId, '/ja-replace ' + messageId, []),
        }) }, TranslateAction));
    } };
  },
});
