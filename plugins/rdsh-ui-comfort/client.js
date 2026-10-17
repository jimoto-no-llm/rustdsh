// rdsh-ui-comfort — deliberate Enter for the DSH Web chat, bundled with rdsh.
//
// Two DOM-level behaviours, both hooked on `window` in the capture phase so the
// shell's own React/Lexical handlers receive a decision before they act:
//
//   1. composer ([data-composer-input]) — the first Enter inserts a line break;
//      a second Enter inside the window sends. The line break goes through the
//      shell's own Shift+Enter path and the send through its plain Enter path,
//      so attachments, chips, the slash menu and streaming stay stock.
//   2. goal editor ([data-goal-bar] input) — Enter never commits, including the
//      Enter that confirms an IME conversion. Ctrl/Cmd+Enter (or the save
//      button) commits, Escape still cancels.
//
// Anchors are the semantic attributes the Web client already publishes, not
// CSS-module hashes or internal stores: [data-composer-input] is the Lexical
// contenteditable, [data-goal-bar] wraps the goal strip, and
// [data-trigger-menu] exists only while a completion menu owns Enter.
//
// Settings live in localStorage and are read on every key press, so a toggle
// applies without a reload. window.__rdshUiComfort exposes the same store.
window.__ModuleLoader__.load({
  id: "rdsh-ui-comfort",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useCallback, useState } = React;

    const STORAGE_KEY = "rdsh-ui-comfort:v1";
    const DEFAULTS = Object.freeze({ doubleEnter: true, goalGuard: true, windowMs: 1500 });
    const MIN_WINDOW_MS = 200;
    const MAX_WINDOW_MS = 5000;
    const COMPOSER_SELECTOR = "[data-composer-input]";
    const GOAL_BAR_SELECTOR = "[data-goal-bar]";
    const TRIGGER_MENU_SELECTOR = "[data-trigger-menu]";
    // Marks the replayed Shift+Enter so this listener never handles its own event.
    const REPLAY_FLAG = "__rdshUiComfortReplay";

    /* ---------------------------------------------------------------- logic */

    // Merge a stored value onto the defaults. Unknown members are dropped and
    // windowMs is clamped, so a hand-edited localStorage entry cannot disable
    // the guards by accident.
    function normalizeSettings(raw) {
      const value = raw !== null && typeof raw === "object" ? raw : {};
      const windowMs = Number(value.windowMs);
      return {
        doubleEnter: value.doubleEnter === undefined ? DEFAULTS.doubleEnter : value.doubleEnter !== false,
        goalGuard: value.goalGuard === undefined ? DEFAULTS.goalGuard : value.goalGuard !== false,
        windowMs: Number.isFinite(windowMs)
          ? Math.min(MAX_WINDOW_MS, Math.max(MIN_WINDOW_MS, Math.round(windowMs)))
          : DEFAULTS.windowMs,
      };
    }

    // Pure composer decision. Returns one of:
    //   ignore     — leave the event alone (Shift/Ctrl/Meta/Alt, IME, repeat,
    //                another key, a completion menu, or the feature is off)
    //   line-break — first Enter: make the shell treat it as Shift+Enter
    //   send       — second Enter inside the window: leave it alone to send
    function composerAction(input) {
      const ignore = { action: "ignore" };
      if (!input.settings.doubleEnter) return ignore;
      if (input.key !== "Enter") return ignore;
      if (input.isComposing || input.keyCode === 229) return ignore;
      if (input.shiftKey || input.ctrlKey || input.metaKey || input.altKey) return ignore;
      if (input.repeat) return ignore;
      if (input.menuOpen) return ignore;
      const windowOpen = input.sameComposer && input.lastEnterAt > 0
        && input.now - input.lastEnterAt <= input.settings.windowMs;
      return windowOpen ? { action: "send" } : { action: "line-break" };
    }

    // Pure goal decision. Returns block (swallow) or ignore (leave the event to
    // the stock handler, which is what makes Ctrl/Cmd+Enter commit).
    function goalAction(input) {
      if (!input.settings.goalGuard) return "ignore";
      if (input.key !== "Enter") return "ignore";
      if (input.isComposing || input.keyCode === 229) return "block";
      if (input.repeat) return "block";
      if (input.ctrlKey || input.metaKey) return "ignore";
      return "block";
    }

    function readSettings() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        return normalizeSettings(raw === null ? DEFAULTS : JSON.parse(raw));
      } catch (error) {
        return normalizeSettings(DEFAULTS);
      }
    }

    function writeSettings(patch) {
      const next = normalizeSettings({ ...readSettings(), ...(patch || {}) });
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch (error) {}
      return next;
    }

    function resetSettings() {
      try {
        window.localStorage.removeItem(STORAGE_KEY);
      } catch (error) {}
      return normalizeSettings(DEFAULTS);
    }

    /* ----------------------------------------------------------------- dom */

    // Reuse the shell's Shift+Enter path instead of reimplementing a line break:
    // Lexical reads the modifier from the event, so hiding the modifier is
    // enough. The property write is the only mutation of a foreign event and it
    // is scoped to this dispatch.
    function asLineBreak(event) {
      try {
        Object.defineProperty(event, "shiftKey", { value: true, configurable: true });
        return true;
      } catch (error) {
        return false;
      }
    }

    // Fallback when the event refuses the property write: stop the real Enter
    // and replay it as Shift+Enter on the composer.
    function replayAsLineBreak(event, composer) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const replay = new KeyboardEvent("keydown", {
        key: "Enter", code: "Enter", shiftKey: true, bubbles: true, cancelable: true, composed: true,
      });
      replay[REPLAY_FLAG] = true;
      composer.dispatchEvent(replay);
    }

    function keyInput(event, settings, now, lastEnterAt, sameComposer, menuOpen) {
      return {
        key: event.key,
        isComposing: event.isComposing === true,
        keyCode: event.keyCode,
        shiftKey: event.shiftKey === true,
        ctrlKey: event.ctrlKey === true,
        metaKey: event.metaKey === true,
        altKey: event.altKey === true,
        repeat: event.repeat === true,
        menuOpen,
        settings,
        now,
        lastEnterAt,
        sameComposer,
      };
    }

    function installKeyHandler() {
      // One tracker per page; the composer element identity joins the window so
      // two sessions never share a half-pressed Enter.
      const state = { lastEnterAt: 0, lastComposer: null };
      const onKeyDown = (event) => {
        if (event[REPLAY_FLAG] === true) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        const settings = readSettings();
        const now = Date.now();

        // Goal strip: the editing form is the only input inside [data-goal-bar].
        if (target.closest(GOAL_BAR_SELECTOR) !== null && target.closest("input") !== null) {
          if (goalAction(keyInput(event, settings, now, 0, false, false)) === "block") {
            event.stopPropagation();
            event.preventDefault();
          }
          return;
        }

        const composer = target.closest(COMPOSER_SELECTOR);
        if (composer === null) return;
        const decision = composerAction(keyInput(
          event, settings, now, state.lastEnterAt, state.lastComposer === composer,
          target.ownerDocument.querySelector(TRIGGER_MENU_SELECTOR) !== null,
        ));
        if (decision.action === "ignore") return;
        if (decision.action === "send") {
          state.lastEnterAt = 0;
          return;
        }
        state.lastEnterAt = now;
        state.lastComposer = composer;
        if (!asLineBreak(event)) replayAsLineBreak(event, composer);
      };
      window.addEventListener("keydown", onKeyDown, true);
      return () => window.removeEventListener("keydown", onKeyDown, true);
    }

    /* ------------------------------------------------------------ settings */

    const card = {
      border: "0.5px solid var(--dsw-alias-settings-card-stroke)",
      background: "var(--dsw-alias-settings-card-fill)",
      borderRadius: "12px",
      padding: "12px 14px",
      display: "flex",
      flexDirection: "column",
      gap: "10px",
      color: "var(--dsw-alias-label-primary)",
    };
    const title = { margin: "0", fontSize: "16px", fontWeight: 500, color: "var(--dsw-alias-label-primary)" };
    const desc = { margin: "0", fontSize: "13px", color: "var(--dsw-alias-label-tertiary)" };
    const row = { display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--dsw-alias-label-primary)" };
    const cssText = ".rdsh-ui-comfort input[type=checkbox]{accent-color:var(--dsw-alias-button-primary-fill);width:15px;height:15px;margin:0}"
      + ".rdsh-ui-comfort input[type=number]{font:inherit;font-size:13px;padding:4px 6px;border-radius:8px;width:90px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l3)}"
      + ".rdsh-ui-comfort code{font-size:12px}";

    function ComfortSection() {
      const pair = useState(readSettings);
      const settings = pair[0];
      const setSettings = pair[1];
      const update = useCallback((patch) => { setSettings(writeSettings(patch)); }, []);
      return h("div", { className: "rdsh-ui-comfort", style: card },
        h("style", null, cssText),
        h("p", { style: title }, "入力の快適さ"),
        h("p", { style: desc }, "Enter の扱いを変えます。変更はすぐ反映され、ブラウザーに保存されます。"),
        h("label", { style: row },
          h("input", {
            type: "checkbox", checked: settings.doubleEnter,
            onChange: (event) => update({ doubleEnter: event.target.checked }),
          }),
          "チャットは Enter 2回で送信（1回目は改行、Shift+Enter は従来どおり改行）"),
        h("label", { style: row },
          h("input", {
            type: "checkbox", checked: settings.goalGuard,
            onChange: (event) => update({ goalGuard: event.target.checked }),
          }),
          "ゴール編集中は Enter で確定しない（Ctrl/Cmd+Enter か保存ボタンで確定、Esc で取消）"),
        h("label", { style: row },
          "2回目の待ち時間 (ms)",
          h("input", {
            type: "number", min: MIN_WINDOW_MS, max: MAX_WINDOW_MS, step: 100, value: settings.windowMs,
            onChange: (event) => update({ windowMs: Number(event.target.value) }),
          })),
        h("p", { style: desc }, "保存先: ", h("code", null, STORAGE_KEY), "（コンソールから window.__rdshUiComfort.set(...) でも変えられます）"),
      );
    }

    /* --------------------------------------------------------------- entry */

    return {
      inject: ["slots"],
      apply(ctx) {
        // The keyboard half is the plugin's whole value, so it is installed
        // before anything that could fail.
        ctx.effect(installKeyHandler, "rdsh-ui-comfort: composer and goal keys");
        if (typeof window !== "undefined") {
          window.__rdshUiComfort = {
            storageKey: STORAGE_KEY,
            defaults: DEFAULTS,
            get: readSettings,
            set: writeSettings,
            reset: resetSettings,
          };
        }
        ctx.slots.inject("settings.section", () => ctx.slots.register({
          name: "settings.section",
          id: "rdsh-ui-comfort",
          order: 21,
          label: () => "rdsh 入力",
          inject: () => ({}),
        }, ComfortSection));
      },
      // Pure decisions, exercised by the node:test half without a browser.
      logic: {
        DEFAULTS,
        STORAGE_KEY,
        MIN_WINDOW_MS,
        MAX_WINDOW_MS,
        normalizeSettings,
        composerAction,
        goalAction,
      },
    };
  },
});
