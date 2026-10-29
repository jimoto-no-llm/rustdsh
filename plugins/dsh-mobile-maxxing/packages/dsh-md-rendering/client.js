window.__ModuleLoader__.load({
  id: 'dsh-md-rendering',
  factory(require) {
    const bootMode = globalThis.__RDSH_DEVICE_MODE__;
    const attrMode = document.documentElement.getAttribute("data-rdsh-device-mode");
    const nav = typeof navigator === "object" && navigator !== null ? navigator : {};
    const ua = typeof nav.userAgent === "string" ? nav.userAgent : "";
    const platform = typeof nav.platform === "string" ? nav.platform : "";
    let hints;
    try { hints = nav.userAgentData; } catch { hints = undefined; }
    const mobile = hints?.mobile === true || /iPhone|iPod|iPad/i.test(ua) || /iPhone|iPod|iPad/i.test(platform)
      || (platform === "MacIntel" && typeof nav.maxTouchPoints === "number" && nav.maxTouchPoints > 1)
      || /Android/i.test(ua) || hints?.platform === "Android";
    const mode = bootMode === "mobile" || bootMode === "desktop" ? bootMode
      : attrMode === "mobile" || attrMode === "desktop" ? attrMode : mobile ? "mobile" : "desktop";
    if (mode !== "mobile") return { apply() {} };

    const React = require('react');
    const css = `
      html[data-rdsh-device-mode="mobile"] [data-chat-flow-kind="assistant-step"] div:has(> table),
      html[data-rdsh-device-mode="mobile"] [data-chat-flow-kind="assistant-step"] div.md-table-wide:hover,
      html[data-rdsh-device-mode="mobile"] [data-chat-flow-kind="assistant-step"] div.md-table-wide:focus-visible {
        max-width: 100%;
        overflow-x: auto;
        padding-bottom: 0;
      }
      html[data-rdsh-device-mode="mobile"] [data-chat-flow-kind="assistant-step"] div.md-table-wide {
        width: 100%;
        max-width: 100%;
        margin-left: 0;
        padding-left: 0;
        overflow-x: auto;
      }
      html[data-rdsh-device-mode="mobile"] [data-chat-flow-kind="assistant-step"] div > table {
        width: 100%;
        max-width: none;
        border-collapse: collapse;
        margin: 0 0 1.1em;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        font-size: .85rem;
        line-height: normal;
        overflow-wrap: normal;
        word-break: normal;
      }
      html[data-rdsh-device-mode="mobile"] [data-chat-flow-kind="assistant-step"] div > table th,
      html[data-rdsh-device-mode="mobile"] [data-chat-flow-kind="assistant-step"] div > table td,
      html[data-rdsh-device-mode="mobile"] [data-chat-flow-kind="assistant-step"] div > table th:first-child,
      html[data-rdsh-device-mode="mobile"] [data-chat-flow-kind="assistant-step"] div > table td:first-child,
      html[data-rdsh-device-mode="mobile"] [data-chat-flow-kind="assistant-step"] div > table th:last-child,
      html[data-rdsh-device-mode="mobile"] [data-chat-flow-kind="assistant-step"] div > table td:last-child {
        min-width: 0;
        max-width: none;
        border: 1px solid var(--dsw-alias-border-l2);
        background: var(--dsw-alias-bg-base);
        color: inherit;
        padding: .45em .8em;
        text-align: left !important;
      }
      html[data-rdsh-device-mode="mobile"] [data-chat-flow-kind="assistant-step"] div > table th {
        font-weight: 600;
      }
      html[data-rdsh-device-mode="mobile"] [data-chat-flow-kind="assistant-step"] div > table code {
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-brand-primary);
        padding: .15em .45em;
        border-radius: 4px;
        font-size: .82em;
        font-family: "SF Mono", "Fira Code", "Cascadia Code", "JetBrains Mono", Menlo, monospace;
      }
    `.replaceAll('html[data-rdsh-device-mode="mobile"]', attrMode === "mobile" ? 'html[data-rdsh-device-mode="mobile"]' : "html");
    function TableStyles() {
      return React.createElement('style', { 'data-dsh-md-rendering': '' }, css);
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'dsh-md-rendering-table-styles',
        }, TableStyles));
      },
    };
  },
});
