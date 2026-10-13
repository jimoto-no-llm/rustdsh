window.__ModuleLoader__.load({
  id: 'rdsh-translation',
  factory(require) {
    const React = require('react');
    const { MarkdownText } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const DEFAULT_THRESHOLD = 0.08;
    const ENDPOINT = '/api/rdsh-translation/config';
    const LOCALE = {
      code: { copyLabel: 'コードをコピー', copiedLabel: 'コピーしました' },
      footnotes: '脚注',
    };
    let thresholdPromise;

    function loadThreshold() {
      if (!thresholdPromise) {
        thresholdPromise = fetch(ENDPOINT, { cache: 'no-store' })
          .then(async (response) => {
            const value = await response.json();
            const threshold = Number(value?.kana_threshold);
            if (!response.ok || !value?.ok || !Number.isFinite(threshold)) return DEFAULT_THRESHOLD;
            return Math.min(0.5, Math.max(0.01, threshold));
          })
          .catch(() => DEFAULT_THRESHOLD);
      }
      return thresholdPromise;
    }

    function assistantData(useChat, messageId) {
      return useChat((snapshot) => {
        for (const node of snapshot.nodes.values()) {
          if (node.kind === 'assistant-step' && node.data?.finalNode?.messageId === messageId) return node.data;
        }
        return null;
      });
    }

    function eligible(data, messageId, threshold) {
      const finalNode = data?.finalNode;
      if (data?.status !== 'settled' || !finalNode || finalNode.messageId !== messageId || finalNode.interrupted === true) return false;
      const blocks = finalNode.blocks;
      if (!Array.isArray(blocks) || blocks.length === 0 || blocks.some((block) => !block || !['text', 'reasoning'].includes(block.type))) return false;
      const textBlocks = blocks.filter((block) => block.type === 'text' && typeof block.text === 'string');
      if (textBlocks.length === 0) return false;
      let kana = 0;
      let lexical = 0;
      let inFence = null;
      for (const line of textBlocks.map((block) => block.text).join('\n').match(/[^\n]*(?:\n|$)/gu) || []) {
        const open = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/u)?.[1];
        if (!inFence && open) { inFence = { char: open[0], length: open.length }; continue; }
        if (inFence) {
          const close = line.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*(?:\n|$)/u)?.[1];
          if (close && close[0] === inFence.char && close.length >= inFence.length) inFence = null;
          continue;
        }
        for (const character of line) {
          if (/^[\p{L}\p{N}]$/u.test(character)) lexical += 1;
          if (/^[\u3040-\u309f\u30a0-\u30ff\uff66-\uff9d]$/u.test(character)) kana += 1;
        }
      }
      return lexical > 0 && kana / lexical < threshold;
    }

    function TranslateAction(props) {
      const data = assistantData(props.useChat, props.messageId);
      const [threshold, setThreshold] = useState(null);
      const [busy, setBusy] = useState(false);
      const [result, setResult] = useState(null);
      useEffect(() => {
        let active = true;
        loadThreshold().then((value) => { if (active) setThreshold(value); });
        return () => { active = false; };
      }, []);
      if (threshold === null || !eligible(data, props.messageId, threshold)) return null;
      const run = async () => {
        if (busy) return;
        setBusy(true); setResult(null);
        try {
          const response = await props.execute(props.messageId);
          if (!response?.ok) throw new Error(response?.error?.message || '和訳コマンドを実行できませんでした');
          const outcome = response.value?.result;
          if (!outcome) throw new Error('和訳コマンドの結果を受け取れませんでした');
          setResult({ ok: outcome.kind === 'success', text: outcome.text || (outcome.kind === 'success' ? '和訳に置き換えました' : '和訳に失敗しました') });
        } catch (error) {
          setResult({ ok: false, text: error instanceof Error ? error.message : '和訳に失敗しました' });
        } finally { setBusy(false); }
      };
      return h('span', { className: 'rdsh-ja-action' },
        h('button', {
          type: 'button',
          'data-testid': 'rdsh-translate-action',
          'aria-label': '回答を日本語に翻訳して置き換える',
          disabled: busy,
          onClick: run,
          style: { border: 0, background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: busy ? 'wait' : 'pointer', font: 'inherit', padding: '4px 8px' },
        }, busy ? '和訳中…' : '和訳して置換'),
        result ? h('span', { role: result.ok ? 'status' : 'alert', style: { marginLeft: 8, color: result.ok ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-state-error-primary)' } }, result.text) : null);
    }

    function assistantNodeKey(turn, step) {
      // DSH 0.2.0-rc.2 conversationContextKey() format for the built-in assistant-step Definition.
      const kind = 'assistant-step';
      return `${kind.length}:${kind}${turn}:${step}`;
    }

    function TranslationNode({ node }) {
      const data = node.data || {};
      const hideSelector = data.originalAssistantNodeKey
        ? `[data-chat-node-key="${data.originalAssistantNodeKey}"]{display:none!important}`
        : '';
      return h('article', { className: 'rdsh-ja-translation', 'data-testid': 'rdsh-translation-node', style: { maxWidth: 'min(748px,100%)', color: 'var(--dsw-alias-label-primary)', lineHeight: 1.6 } },
        hideSelector ? h('style', null, hideSelector) : null,
        h(MarkdownText, { text: data.translatedText || '', labels: LOCALE, variant: 'body' }),
        data.originalText ? h('details', { style: { marginTop: 8, color: 'var(--dsw-alias-label-tertiary)', fontSize: '13px' } },
          h('summary', { style: { cursor: 'pointer' } }, '元の回答を表示'),
          h('div', { style: { padding: '8px 0', color: 'var(--dsw-alias-label-secondary)' } },
            h(MarkdownText, { text: data.originalText, labels: LOCALE, variant: 'compact' }))) : null);
    }

    function eventValue(event) {
      if (event.type === 'assistant/message') {
        const message = event.data.message;
        return {
          originalText: (message.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('\n'),
          translatedText: null,
          originalAssistantNodeKey: assistantNodeKey(event.data.turn, event.data.step),
          anchorSeq: event.seq,
        };
      }
      const message = event.data;
      const source = message.source || {};
      if (message.content?.some((block) => block.type !== 'text')) return null;
      return {
        originalText: typeof source.originalText === 'string' ? source.originalText : '',
        translatedText: message.content?.filter((block) => block.type === 'text').map((block) => block.text).join('\n') || '',
        originalAssistantNodeKey: Number.isSafeInteger(source.originalTurn) && Number.isSafeInteger(source.originalStep)
          ? assistantNodeKey(source.originalTurn, source.originalStep) : null,
        anchorSeq: event.seq,
      };
    }

    const translationDefinition = {
      kind: 'rdsh-ja-translation',
      target: 'chat',
      match(event) {
        if (event.type === 'assistant/message' && typeof event.data.message?.id === 'string') {
          return { id: event.data.message.id, role: 'start' };
        }
        if (event.type === 'user/message' && event.surfaceOp !== 'append' && event.data.source?.rdshTranslation === true && typeof event.data.source.originalMessageId === 'string') {
          return { id: event.data.source.originalMessageId, role: 'start' };
        }
        return null;
      },
      start(_context, match) { return eventValue(match.event); },
      update(context, match) {
        const next = eventValue(match.event);
        if (!next) return context.state;
        return match.event.type === 'assistant/message'
          ? { ...context.state, ...next, translatedText: context.state.translatedText }
          : { ...context.state, ...next };
      },
      buildViewNode(context) {
        const state = context.state;
        if (!state?.translatedText) return null;
        const match = [...context.matches].reverse().find((item) => item.event.type === 'user/message' && item.event.data.source?.rdshTranslation === true);
        if (!match) return null;
        return {
          key: context.key,
          kind: 'rdsh-ja-translation',
          id: context.id,
          target: 'chat',
          anchorSeq: match.event.seq,
          location: match.location,
          visibility: 'visible',
          data: state,
        };
      },
    };

    return {
      inject: ['slots', 'remote', 'remote.commands'],
      apply(ctx) {
        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions',
          id: 'rdsh-ja-translation',
          order: 35,
          inject: (sessionId) => ({
            execute: (messageId) => ctx.remote.commands.execute(sessionId, `/ja ${messageId}`, []),
          }),
        }, TranslateAction));
        ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
          name: 'conversation.chat.node',
          key: 'rdsh-ja-translation',
        }, TranslationNode));
        ctx.effect(() => ctx.uiConversation.events.register(translationDefinition), 'rdsh-translation: chat replacement view');
      },
    };
  },
});
