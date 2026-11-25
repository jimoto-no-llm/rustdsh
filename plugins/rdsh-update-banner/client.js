window.__ModuleLoader__.load({
  id: "rdsh-update-banner",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useRef = React.useRef;
    const useCallback = React.useCallback;
    const ENDPOINT = "/api/rdsh-update";
    const NS = "rdsh-update-banner";
    const CLOSE_KEY = "rdsh-update-dismissals:v4";
    const APPLIED_KEY = "rdsh-update-applied:v4";
    const RESTART_KEY = "rdsh-update-restart:v4";
    const LEGACY_KEYS = ["rdsh-update-close:v3", "rdsh-update-close:dsh:v3"];
    const RDSH_RELEASES = "https://github.com/jimoto-no-llm/rustdsh/releases";
    const APPLIED_VISIBLE_MS = 8000;
    const UP_TO_DATE_VISIBLE_MS = 5000;
    const RESTART_TTL_MS = 24 * 60 * 60 * 1000;
    const POLL_MS = 5000;

    const DICTIONARIES = {
      en: {
        "card.title": "Update notices",
        "card.region": "Update notifications",
        "card.close": "Dismiss all update notifications",
        "kind.rdsh": "rdsh",
        "kind.dsh": "dsh",
        "kind.rustxng": "rustxng sidecar",
        "kind.update": "Update",
        "phase.available": "Update available",
        "phase.applied": "Updated",
        "phase.applying": "Updating…",
        "phase.restartRequired": "Restart required",
        "phase.error": "Failed",
        "phase.upToDate": "Up to date",
        "title.available": "{kind} update available",
        "title.applied": "{kind} updated",
        "title.applying": "Updating {kind}…",
        "title.restartRequired": "Restart required",
        "title.error": "Update failed",
        "title.checkError": "Could not check for updates",
        "title.upToDate": "You’re up to date",
        "version.fromTo": "{from} → {to}",
        "version.toOnly": "Latest {to}",
        "checked.justNow": "Checked just now",
        "checked.minutes": "Checked {count} min ago",
        "checked.hours": "Checked {count} h ago",
        "checked.days": "Checked {count} d ago",
        "updated.justNow": "Updated just now",
        "updated.minutes": "Updated {count} min ago",
        "updated.hours": "Updated {count} h ago",
        "updated.days": "Updated {count} d ago",
        "channel.stable": "Stable",
        "channel.prerelease": "Prerelease",
        "channel.next": "Next (prerelease)",
        "action.update": "Update",
        "action.updating": "Updating…",
        "action.retry": "Retry",
        "action.dismiss": "Dismiss",
        "action.releaseNotes": "Release notes",
        "applied.message": "{from} was updated to {to}.",
        "restart.message": "dsh {to} is installed. Restart the DSH web service to use it.",
        "error.check": "Update check failed. Check the connection and retry.",
        "error.update": "The update could not be completed.",
        "upToDate.message": "No updates are available.",
        "install.command": "Command: {command}",
        "a11y.expand": "Show details for the {kind} update",
        "a11y.collapse": "Hide details for the {kind} update",
        "a11y.busy": "Updating {kind}",
        "a11y.dismissKind": "Dismiss the {kind} update",
        "label.channel": "Channel",
        "label.checked": "Checked",
        "label.install": "Install command",
      },
      ja: {
        "card.title": "更新のお知らせ",
        "card.region": "更新通知",
        "card.close": "更新のお知らせをすべて閉じる",
        "kind.rdsh": "rdsh",
        "kind.dsh": "dsh",
        "kind.rustxng": "rustxng サイドカー",
        "kind.update": "更新",
        "phase.available": "アップデートがあります",
        "phase.applied": "更新しました",
        "phase.applying": "更新中…",
        "phase.restartRequired": "再起動が必要です",
        "phase.error": "失敗",
        "phase.upToDate": "最新です",
        "title.available": "{kind} のアップデートがあります",
        "title.applied": "{kind} を更新しました",
        "title.applying": "{kind} を更新中…",
        "title.restartRequired": "再起動が必要です",
        "title.error": "更新に失敗しました",
        "title.checkError": "更新を確認できませんでした",
        "title.upToDate": "最新の状態です",
        "version.fromTo": "{from} → {to}",
        "version.toOnly": "最新 {to}",
        "checked.justNow": "たった今確認",
        "checked.minutes": "{count} 分前に確認",
        "checked.hours": "{count} 時間前に確認",
        "checked.days": "{count} 日前に確認",
        "updated.justNow": "たった今更新",
        "updated.minutes": "{count} 分前に更新",
        "updated.hours": "{count} 時間前に更新",
        "updated.days": "{count} 日前に更新",
        "channel.stable": "安定版",
        "channel.prerelease": "プレリリース",
        "channel.next": "次期版（プレリリース）",
        "action.update": "更新",
        "action.updating": "更新中…",
        "action.retry": "再試行",
        "action.dismiss": "閉じる",
        "action.releaseNotes": "リリースノート",
        "applied.message": "{from} から {to} に更新しました。",
        "restart.message": "dsh {to} をインストールしました。DSH Web サービスを再起動すると反映されます。",
        "error.check": "更新を確認できませんでした。接続を確認して再試行してください。",
        "error.update": "更新を完了できませんでした。",
        "upToDate.message": "利用可能な更新はありません。",
        "install.command": "実行コマンド: {command}",
        "a11y.expand": "{kind} の更新の詳細を表示",
        "a11y.collapse": "{kind} の更新の詳細を隠す",
        "a11y.busy": "{kind} を更新中",
        "a11y.dismissKind": "{kind} の更新を閉じる",
        "label.channel": "チャンネル",
        "label.checked": "確認",
        "label.install": "インストールコマンド",
      },
      zh: {
        "card.title": "更新通知",
        "card.region": "更新通知",
        "card.close": "关闭所有更新通知",
        "kind.rdsh": "rdsh",
        "kind.dsh": "dsh",
        "kind.rustxng": "rustxng 附属程序",
        "kind.update": "更新",
        "phase.available": "有可用更新",
        "phase.applied": "已更新",
        "phase.applying": "正在更新…",
        "phase.restartRequired": "需要重启",
        "phase.error": "失败",
        "phase.upToDate": "已是最新",
        "title.available": "{kind} 有可用更新",
        "title.applied": "{kind} 已更新",
        "title.applying": "正在更新 {kind}…",
        "title.restartRequired": "需要重启",
        "title.error": "更新失败",
        "title.checkError": "无法检查更新",
        "title.upToDate": "已是最新版本",
        "version.fromTo": "{from} → {to}",
        "version.toOnly": "最新版本 {to}",
        "checked.justNow": "刚刚检查",
        "checked.minutes": "{count} 分钟前检查",
        "checked.hours": "{count} 小时前检查",
        "checked.days": "{count} 天前检查",
        "updated.justNow": "刚刚更新",
        "updated.minutes": "{count} 分钟前更新",
        "updated.hours": "{count} 小时前更新",
        "updated.days": "{count} 天前更新",
        "channel.stable": "稳定版",
        "channel.prerelease": "预发布版",
        "channel.next": "下一个版本（预发布）",
        "action.update": "更新",
        "action.updating": "正在更新…",
        "action.retry": "重试",
        "action.dismiss": "关闭",
        "action.releaseNotes": "发行说明",
        "applied.message": "已将 {from} 更新到 {to}。",
        "restart.message": "已安装 dsh {to}。请重启 DSH Web 服务以使用新版本。",
        "error.check": "无法检查更新。请检查连接后重试。",
        "error.update": "无法完成更新。",
        "upToDate.message": "没有可用更新。",
        "install.command": "命令：{command}",
        "a11y.expand": "显示 {kind} 更新的详细信息",
        "a11y.collapse": "隐藏 {kind} 更新的详细信息",
        "a11y.busy": "正在更新 {kind}",
        "a11y.dismissKind": "关闭 {kind} 更新",
        "label.channel": "渠道",
        "label.checked": "检查",
        "label.install": "安装命令",
      },
    };

    const interpolate = (template, params) => params
      ? String(template).replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match)
      : String(template);

    function normalizeLocale(value) {
      const text = String(value || "").toLowerCase();
      if (text.startsWith("ja")) return "ja";
      if (text.startsWith("zh")) return "zh";
      return "en";
    }

    function activeLocale(ctx) {
      try {
        const active = ctx && ctx.locale && typeof ctx.locale.getLocale === "function"
          ? ctx.locale.getLocale() : null;
        if (active && typeof active.active === "string") return normalizeLocale(active.active);
      } catch (error) {}
      // A plain browser has no DSH locale service: follow the browser's own
      // preference list, then the document language as a last resort.
      try {
        if (typeof navigator !== "undefined") {
          const list = Array.isArray(navigator.languages) && navigator.languages.length
            ? navigator.languages : [navigator.language];
          if (list && list[0]) return normalizeLocale(list[0]);
        }
      } catch (error) {}
      try {
        const lang = typeof document !== "undefined" && document.documentElement
          ? document.documentElement.lang : "";
        if (lang) return normalizeLocale(lang);
      } catch (error) {}
      return "en";
    }

    function createTranslator(ctx) {
      const bound = ctx && ctx.locale && typeof ctx.locale.bind === "function" ? ctx.locale.bind(NS) : null;
      return (key, params) => {
        if (bound) {
          try {
            const value = bound(key, params);
            if (typeof value === "string" && value !== key) return value;
          } catch (error) {}
        }
        const dictionary = DICTIONARIES[activeLocale(ctx)] || DICTIONARIES.en;
        return interpolate(dictionary[key] !== undefined ? dictionary[key] : DICTIONARIES.en[key] || key, params);
      };
    }

    const occurrence = (kind, from, to, at) =>
      at ? JSON.stringify([kind || "update", from || "", to, at]) : JSON.stringify([kind || "update", from || "", to]);
    const short = (value) => typeof value === "string" && value.length > 0 && value.length <= 512;
    const validAt = (value) => {
      const timestamp = Number(value);
      return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
    };
    const noticeKey = (kind, from, to, at) => occurrence(kind, from, to, kind === "dsh" ? null : at);

    function makeNotice(type, kind, from, to, at) {
      if (!short(to) || typeof kind !== "string" || !kind || kind.length > 64) return null;
      const source = short(from) ? from : null;
      if (source !== null && source === to) return null;
      const timestamp = validAt(at);
      return {
        type: type,
        kind: kind,
        from: source,
        to: to,
        at: timestamp,
        id: noticeKey(kind, source, to, timestamp),
      };
    }

    function matchesTarget(record, notice) {
      if (!record || !notice || record.kind !== notice.kind || record.to !== notice.to) return false;
      const left = short(record.from) ? record.from : null;
      const right = short(notice.from) ? notice.from : null;
      if (!(left === null || right === null || left === right)) return false;
      if (notice.kind === "dsh") return true;
      const recordAt = validAt(record.at);
      const noticeAt = validAt(notice.at);
      if (recordAt !== null && noticeAt !== null) return recordAt === noticeAt;
      if (recordAt === null && noticeAt !== null) {
        const closedAt = validAt(record.closedAt);
        return closedAt !== null && closedAt >= noticeAt;
      }
      return recordAt === noticeAt;
    }

    function storageGet(key) {
      try { return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null; } catch (error) { return null; }
    }
    function storageSet(key, value) {
      try { if (typeof localStorage !== "undefined") localStorage.setItem(key, value); } catch (error) {}
    }
    function storageRemove(key) {
      try { if (typeof localStorage !== "undefined") localStorage.removeItem(key); } catch (error) {}
    }
    function parseStore(key) {
      try {
        const value = JSON.parse(storageGet(key) || "null");
        return Array.isArray(value) ? value : [];
      } catch (error) { return []; }
    }

    let dismissalsCache = null;
    function validDismissal(record) {
      return record && short(record.kind) && record.kind.length <= 64 && short(record.to) &&
        (record.from === undefined || record.from === null || short(record.from));
    }
    function loadDismissals() {
      if (dismissalsCache) return dismissalsCache;
      const list = [];
      for (const record of parseStore(CLOSE_KEY)) {
        const value = {
          kind: record && record.kind,
          from: record && short(record.from) ? record.from : null,
          to: record && record.to,
          at: record && record.kind !== "dsh" ? validAt(record.at) : null,
          closedAt: Number(record && record.closedAt) || 0,
        };
        if (validDismissal(value) && !list.some((item) => matchesTarget(item, value))) list.push(value);
      }
      let migrated = false;
      for (const key of LEGACY_KEYS) {
        try {
          const raw = storageGet(key);
          if (!raw) continue;
          const old = JSON.parse(raw);
          const kind = key.endsWith(":dsh:v3") ? "dsh" : old && old.kind;
          const value = old && short(old.to) && (kind === "dsh" || short(kind))
            ? { kind: kind, from: null, to: old.to, at: kind !== "dsh" ? validAt(old.at) : null, closedAt: Number(old.at) || 0 } : null;
          if (value && !list.some((item) => matchesTarget(item, value))) list.push(value);
          storageRemove(key);
          migrated = true;
        } catch (error) {}
      }
      dismissalsCache = list.slice(-50);
      if (migrated) saveDismissals(dismissalsCache);
      return dismissalsCache;
    }
    function saveDismissals(list) {
      dismissalsCache = list.slice(-50);
      storageSet(CLOSE_KEY, JSON.stringify(dismissalsCache));
    }
    function isDismissed(notice) {
      return loadDismissals().some((record) => matchesTarget(record, notice));
    }
    function addDismissal(notice) {
      if (!notice || notice.kind === "error" || notice.kind === "check") return;
      const record = {
        kind: notice.kind,
        from: notice.from || null,
        to: notice.to,
        at: notice.kind !== "dsh" ? validAt(notice.at) : null,
        closedAt: Date.now(),
      };
      if (!validDismissal(record)) return;
      const list = loadDismissals().filter((item) => !matchesTarget(item, record));
      list.push(record);
      saveDismissals(list);
    }
    function replaceDismissals(list) {
      const valid = (Array.isArray(list) ? list : []).filter(validDismissal).map((record) => ({
        kind: record.kind,
        from: short(record.from) ? record.from : null,
        to: record.to,
        at: record.kind !== "dsh" ? validAt(record.at) : null,
        closedAt: Number(record.closedAt) || 0,
      }));
      saveDismissals(valid);
    }

    let appliedCache = null;
    function loadApplied() {
      if (appliedCache) return appliedCache;
      appliedCache = parseStore(APPLIED_KEY).filter((item) => item && short(item.id) &&
        Number.isFinite(Number(item.seenAt)) && Number(item.seenAt) > 0)
        .map((item) => ({ id: item.id, seenAt: Number(item.seenAt) }));
      return appliedCache;
    }
    function markApplied(id) {
      if (!short(id)) return false;
      const list = loadApplied();
      if (list.some((item) => item.id === id)) return false;
      list.push({ id: id, seenAt: Date.now() });
      appliedCache = list.slice(-50);
      storageSet(APPLIED_KEY, JSON.stringify(appliedCache));
      return true;
    }
    function appliedSeenAt(id) {
      const found = loadApplied().find((item) => item.id === id);
      return found ? found.seenAt : 0;
    }

    let restartCache = null;
    function loadRestart() {
      if (restartCache) return restartCache;
      const now = Date.now();
      restartCache = parseStore(RESTART_KEY).filter((item) => item && short(item.id) && short(item.to) &&
        Number(item.at) > 0 && now - Number(item.at) < RESTART_TTL_MS)
        .map((item) => ({
          id: item.id, kind: item.kind === "dsh" ? "dsh" : "dsh", from: short(item.from) ? item.from : null,
          to: item.to, at: Number(item.at), channel: typeof item.channel === "string" ? item.channel : null,
        }));
      return restartCache;
    }
    function saveRestart(record) {
      if (!record || !short(record.id) || !short(record.to)) return;
      const list = loadRestart().filter((item) => item.id !== record.id);
      list.push(record);
      restartCache = list.slice(-20);
      storageSet(RESTART_KEY, JSON.stringify(restartCache));
    }
    function removeRestart(id) {
      const list = loadRestart().filter((item) => item.id !== id);
      restartCache = list;
      storageSet(RESTART_KEY, JSON.stringify(restartCache));
    }

    const kindLabel = (kind, t) => {
      const key = "kind." + kind;
      const value = t(key);
      return value === key ? kind : value;
    };

    const phaseKey = (phase) => phase === "restart-required" ? "restartRequired"
      : phase === "up-to-date" ? "upToDate" : phase;

    function shortHash(value) {
      let hash = 0;
      const text = String(value);
      for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
      return Math.abs(hash).toString(36);
    }

    function relativeTime(prefix, at, now, t) {
      if (!at) return "";
      const difference = Math.max(0, now - at);
      if (difference < 60000) return t(prefix + ".justNow");
      if (difference < 3600000) return t(prefix + ".minutes", { count: Math.floor(difference / 60000) });
      if (difference < 86400000) return t(prefix + ".hours", { count: Math.floor(difference / 3600000) });
      return t(prefix + ".days", { count: Math.floor(difference / 86400000) });
    }

    function channelLabel(channel, t) {
      if (!channel) return "";
      const key = "channel." + channel;
      const value = t(key);
      return value === key ? "" : value;
    }

    function releaseUrl(notice) {
      if (notice.kind === "dsh") {
        const value = notice.details;
        if (typeof value === "string" && /^https:\/\/www\.npmjs\.com\/package\/@deepseek-ai\/dsh\/v\/[0-9A-Za-z.+-]+$/.test(value)) return value;
        return "https://www.npmjs.com/package/@deepseek-ai/dsh";
      }
      return RDSH_RELEASES;
    }

    const CSS = ".rub-wrap{position:fixed;z-index:900;left:50%;transform:translateX(-50%);" +
      "top:calc(var(--dsh-frame-overlay-top,var(--dsh-frame-chrome-top,64px)) + 12px);" +
      "width:min(420px,calc(100vw - 24px));max-height:calc(100dvh - var(--dsh-frame-overlay-top,64px) - 80px);" +
      "display:flex;flex-direction:column;box-sizing:border-box;pointer-events:none;color:var(--dsw-alias-label-primary,#f5f5f7);" +
      "font:14px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif}" +
      ".rub-card{pointer-events:auto;box-sizing:border-box;max-height:inherit;overflow-y:auto;overscroll-behavior:contain;" +
      "background:var(--dsw-alias-bg-layer-1,rgba(28,28,30,.96));border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.18));" +
      "border-radius:18px;box-shadow:var(--dsw-elevation-panel,0 16px 48px rgba(0,0,0,.4));" +
      "animation:rub-in .2s ease-out}" +
      "@keyframes rub-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}" +
      ".rub-head{display:flex;align-items:center;gap:8px;padding:10px 8px 8px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12))}" +
      ".rub-heading{display:flex;align-items:center;gap:8px;flex:1;min-width:0;font-size:13px;font-weight:600}" +
      ".rub-rows{display:flex;flex-direction:column}" +
      ".rub-row{padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1))}" +
      ".rub-row:last-child{border-bottom:0}" +
      ".rub-row-head{display:flex;align-items:flex-start;gap:10px}" +
      ".rub-row-toggle{display:flex;align-items:flex-start;gap:10px;flex:1;min-width:0;min-height:44px;" +
      "margin:-6px 0;padding:6px 0;background:none;border:0;color:inherit;font:inherit;text-align:left;cursor:pointer}" +
      ".rub-row-toggle:focus-visible,.rub-close:focus-visible,.rub-btn:focus-visible,.rub-link:focus-visible{" +
      "outline:2px solid var(--dsw-alias-state-business-primary,#4da3ff);outline-offset:2px;border-radius:6px}" +
      ".rub-row-text{display:flex;flex-direction:column;gap:2px;min-width:0}" +
      ".rub-title{font-size:14px;font-weight:600;overflow-wrap:anywhere}" +
      ".rub-sub{font-size:12px;color:var(--dsw-alias-label-secondary,#b9b9c0);overflow-wrap:anywhere}" +
      ".rub-badge{flex:none;align-self:flex-start;margin-top:2px;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;" +
      "border:1px solid currentColor;white-space:nowrap}" +
      ".rub-badge[data-phase=available]{color:var(--dsw-alias-state-business-primary,#7cb8ff)}" +
      ".rub-badge[data-phase=applied]{color:var(--dsw-alias-state-success-primary,#6ee7a8)}" +
      ".rub-badge[data-phase=applying]{color:var(--dsw-alias-state-business-primary,#7cb8ff)}" +
      ".rub-badge[data-phase=restart-required]{color:var(--dsw-alias-state-warn-label,#ffd60a)}" +
      ".rub-badge[data-phase=error]{color:var(--dsw-alias-state-error-primary,#ff8a84)}" +
      ".rub-badge[data-phase=up-to-date]{color:var(--dsw-alias-label-secondary,#b9b9c0)}" +
      ".rub-details{margin-top:10px;padding:10px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));" +
      "font-size:12px;display:flex;flex-direction:column;gap:6px;overflow-wrap:anywhere}" +
      ".rub-acts{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin-top:10px}" +
      ".rub-btn,.rub-link{display:inline-flex;align-items:center;justify-content:center;min-height:44px;min-width:44px;" +
      "padding:0 12px;border-radius:10px;font:inherit;font-size:13px;font-weight:600;cursor:pointer;box-sizing:border-box}" +
      ".rub-btn{background:var(--dsw-alias-button-primary-fill,#0a84ff);color:var(--dsw-alias-label-primary-foreground,#fff);border:0}" +
      ".rub-btn.secondary{background:transparent;color:var(--dsw-alias-label-primary,#f5f5f7);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.28))}" +
      ".rub-btn:disabled{opacity:.65;cursor:wait}" +
      ".rub-link{color:var(--dsw-alias-state-business-primary,#7cb8ff);text-decoration:none;border:0;background:none}" +
      ".rub-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;" +
      "margin:-4px -4px -4px 0;background:none;border:0;border-radius:10px;color:var(--dsw-alias-label-secondary,#b9b9c0);font-size:22px;cursor:pointer}" +
      ".rub-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}" +
      "@media (max-width:480px){.rub-wrap{top:auto;bottom:0;left:0;right:0;transform:none;width:auto;" +
      "max-height:min(82dvh,calc(100dvh - 24px))}" +
      ".rub-card{border-radius:18px 18px 0 0;padding-bottom:env(safe-area-inset-bottom,0px);max-height:82dvh}}" +
      "@media (prefers-reduced-motion:reduce){.rub-card{animation:none!important;transition:none!important}.rub-btn,.rub-link,.rub-close{transition:none!important}}" +
      "@media (prefers-reduced-transparency:reduce){.rub-card{background:var(--dsw-alias-bg-layer-1,#1c1c1e)!important;backdrop-filter:none!important}}" +
      "@media (prefers-contrast:more){.rub-card{border-color:currentColor}.rub-sub{color:inherit}}";

    function Icon(props) {
      return h("svg", {
        width: props.size || 22, height: props.size || 22, viewBox: "0 0 24 24",
        "aria-hidden": "true", focusable: "false", style: { flex: "none", marginTop: "1px" },
      }, h("path", {
        d: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4.2a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4ZM10.9 11h2.2v6h-2.2z",
        fill: "currentColor",
      }));
    }

    function Banner(props) {
      const t = (key, params) => {
        if (typeof props.t === "function") {
          try {
            const value = props.t(key, params);
            if (typeof value === "string" && value !== key) return value;
          } catch (error) {}
        }
        return typeof props.fallbackT === "function" ? props.fallbackT(key, params) : key;
      };
      const [payload, setPayload] = useState(null);
      const [failure, setFailure] = useState(null);
      const [upToDateUntil, setUpToDateUntil] = useState(0);
      const [now, setNow] = useState(Date.now());
      const [expanded, setExpanded] = useState({});
      const [, setVersion] = useState(0);
      const stateRef = useRef(null);
      const noticesRef = useRef([]);
      const runtime = useRef(new Map());
      // Applied confirmations already shown in this page session: a reload or a
      // later poll never re-announces an update that already happened.
      const freshApplied = useRef(new Set());
      const failures = useRef(0);
      const loadGeneration = useRef(0);
      const updating = useRef(false);
      const previousFocus = useRef(null);
      const wasVisible = useRef(false);
      const force = useCallback(() => setVersion((value) => value + 1), []);

      const buildNotices = useCallback((value, problem, currentTime) => {
        const list = [];
        if (problem) {
          list.push({ type: "check-error", id: "check-error", kind: "check", phase: "error", message: t(problem.key) });
        }
        if (value && value.ok && value.updated) {
          const base = makeNotice("applied", value.kind || "update", value.from, value.to, value.at);
          if (base && !isDismissed(base) && freshApplied.current.has(base.id)) {
            const seenAt = appliedSeenAt(base.id);
            if (seenAt && currentTime - seenAt < APPLIED_VISIBLE_MS) list.push({ ...base, phase: "applied" });
          }
        }
        if (value && value.ok && value.dsh && value.dsh.available) {
          const dsh = value.dsh;
          const base = makeNotice("dsh", "dsh", dsh.from, dsh.to, dsh.at);
          if (base && !isDismissed(base)) {
            const state = runtime.current.get(base.id);
            const restart = loadRestart().find((item) => item.id === base.id);
            const phase = state && state.phase ? state.phase : restart ? "restart-required" : "available";
            list.push({
              ...base, type: "dsh", phase: phase,
              message: state && state.message ? state.message : restart ? t("restart.message", { to: base.to }) : "",
              channel: dsh.channel || restart && restart.channel || null,
              command: dsh.command || null, details: dsh.details || null,
            });
          }
        }
        for (const record of loadRestart()) {
          if (list.some((item) => item.id === record.id)) continue;
          const base = makeNotice("dsh", "dsh", record.from, record.to, record.at);
          if (!base || isDismissed(base)) continue;
          const state = runtime.current.get(base.id);
          list.push({
            ...base, type: "dsh", syntheticRestart: true,
            phase: state && state.phase ? state.phase : "restart-required",
            message: state && state.message ? state.message : t("restart.message", { to: base.to }),
            channel: record.channel || null,
          });
        }
        if (list.length === 0 && upToDateUntil > currentTime) {
          list.push({ type: "up-to-date", id: "up-to-date", kind: "check", phase: "up-to-date", message: t("upToDate.message") });
        }
        const priority = { error: 0, available: 1, applying: 1, "restart-required": 1, applied: 2, "up-to-date": 3 };
        list.sort((left, right) => (priority[left.phase] ?? 9) - (priority[right.phase] ?? 9));
        return list;
      }, [t, upToDateUntil]);

      const accept = useCallback((value) => {
        if (!value || value.ok !== true) return false;
        stateRef.current = value;
        failures.current = 0;
        setFailure(null);
        if (value.updated) {
          const base = makeNotice("applied", value.kind || "update", value.from, value.to, value.at);
          if (base && !isDismissed(base) && markApplied(base.id)) freshApplied.current.add(base.id);
        }
        if (value.dsh) {
          for (const record of loadRestart()) {
            if (!runtime.current.has(record.id) && value.dsh.from === record.to && !value.dsh.available) removeRestart(record.id);
          }
        }
        setPayload(value);
        return true;
      }, []);

      const load = useCallback(async (manual) => {
        const generation = ++loadGeneration.current;
        try {
          const response = await fetch(ENDPOINT, { cache: "no-store" });
          if (!response.ok) throw new Error("status");
          const value = await response.json();
          if (generation !== loadGeneration.current) return;
          if (!accept(value)) throw new Error("state");
          if (manual && !(value.updated || (value.dsh && value.dsh.available) || loadRestart().length)) {
            setUpToDateUntil(Date.now() + UP_TO_DATE_VISIBLE_MS);
            setNow(Date.now());
          }
        } catch (error) {
          if (generation !== loadGeneration.current) return;
          failures.current += 1;
          if (failures.current >= 2) setFailure({ key: "error.check" });
        }
      }, [accept]);

      useEffect(() => {
        let disposed = false, connected = false, retry;
        const controller = new AbortController();
        load(false);
        const poll = setInterval(() => { if (!connected) load(false); }, POLL_MS);
        const onStorage = (event) => {
          if (event.key !== CLOSE_KEY) return;
          try {
            const value = event.newValue ? JSON.parse(event.newValue) : [];
            replaceDismissals(value);
            force();
          } catch (error) {}
        };
        const wake = () => {
          if (stateRef.current) accept(stateRef.current);
          load(false);
        };
        const visible = () => { if (document.visibilityState === "visible") wake(); };
        async function listen() {
          let reader;
          try {
            const response = await fetch(ENDPOINT + "/events", { cache: "no-store", signal: controller.signal });
            if (!response.ok || !response.body || !response.body.getReader || disposed) return;
            connected = true;
            reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            while (!disposed) {
              const chunk = await reader.read();
              if (disposed || chunk.done) break;
              buffer += decoder.decode(chunk.value, { stream: true });
              if (buffer.length > 16384) throw new Error("notification frame too large");
              let separator;
              while ((separator = buffer.indexOf("\n\n")) !== -1) {
                const frame = buffer.slice(0, separator);
                buffer = buffer.slice(separator + 2);
                const event = frame.split("\n").find((line) => line.startsWith("event: "));
                const payloadLine = frame.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
                if (!payloadLine) continue;
                try {
                  const value = JSON.parse(payloadLine);
                  if (event && event.slice(7) === "state") {
                    ++loadGeneration.current;
                    accept(value);
                  } else if (event && event.slice(7) === "close" && value && value.kind && value.to) {
                    addDismissal(value);
                    force();
                  }
                } catch (error) {}
              }
            }
          } catch (error) {}
          finally {
            connected = false;
            if (reader) await reader.cancel().catch(() => {});
            if (!disposed) retry = setTimeout(listen, 1000);
          }
        }
        listen();
        window.addEventListener("storage", onStorage);
        window.addEventListener("focus", wake);
        document.addEventListener("visibilitychange", visible);
        return () => {
          disposed = true;
          controller.abort();
          clearInterval(poll);
          clearTimeout(retry);
          window.removeEventListener("storage", onStorage);
          window.removeEventListener("focus", wake);
          document.removeEventListener("visibilitychange", visible);
          ++loadGeneration.current;
        };
      }, [load, accept, force]);

      useEffect(() => {
        const tick = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(tick);
      }, []);

      const dismissNotice = useCallback((notice) => {
        if (!notice) return;
        if (notice.type === "check-error") {
          failures.current = 0;
          setFailure(null);
          return;
        }
        if (notice.type === "up-to-date") {
          setUpToDateUntil(0);
          return;
        }
        addDismissal(notice);
        if (notice.type === "dsh") removeRestart(notice.id);
        fetch(ENDPOINT + "/dismiss", {
          method: "POST",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: notice.kind, from: notice.from || null, to: notice.to }),
        }).catch(() => {});
      }, []);

      const notices = buildNotices(payload, failure, now, t);
      noticesRef.current = notices;

      const dismissAll = useCallback(() => {
        const list = noticesRef.current;
        if (!list.length) return;
        for (const notice of list) dismissNotice(notice);
        force();
      }, [dismissNotice, force]);

      useEffect(() => {
        const onKey = (event) => {
          if (!event || event.key !== "Escape") return;
          if (!noticesRef.current.length) return;
          if (event.preventDefault) event.preventDefault();
          dismissAll();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [dismissAll]);

      useEffect(() => {
        const visible = noticesRef.current.length > 0;
        if (visible && !wasVisible.current) {
          try { previousFocus.current = document.activeElement; } catch (error) {}
        }
        if (!visible && wasVisible.current) {
          const target = previousFocus.current;
          previousFocus.current = null;
          try { if (target && typeof target.focus === "function") target.focus(); } catch (error) {}
        }
        wasVisible.current = visible;
      }, [notices.length]);

      const applyDsh = useCallback(async (notice) => {
        if (!notice || updating.current) return;
        updating.current = true;
        runtime.current.set(notice.id, { phase: "applying" });
        force();
        try {
          const response = await fetch(ENDPOINT + "/dsh/run", { method: "POST", cache: "no-store" });
          const value = await response.json().catch(() => ({}));
          if (!response.ok || !value || value.ok !== true) throw new Error(value && value.message ? value.message : t("error.update"));
          if (value.restartRequired) {
            runtime.current.set(notice.id, { phase: "restart-required", message: t("restart.message", { to: notice.to }) });
            saveRestart({ id: notice.id, kind: "dsh", from: notice.from || null, to: notice.to, at: Date.now(), channel: notice.channel || null });
          } else {
            runtime.current.set(notice.id, { phase: "applied", message: value.message || t("applied.message", { from: notice.from || "", to: notice.to }) });
            // The confirmation is transient: hide it after a few seconds instead
            // of leaving a permanent "updated" row for the running release.
            setTimeout(() => { runtime.current.delete(notice.id); addDismissal(notice); force(); }, APPLIED_VISIBLE_MS);
          }
        } catch (error) {
          runtime.current.set(notice.id, { phase: "error", message: error && error.message ? error.message : t("error.update") });
        } finally {
          updating.current = false;
          force();
          load(false);
        }
      }, [force, load, t]);

      if (!notices.length) return null;

      const anyApplying = notices.some((notice) => notice.phase === "applying");
      const hasError = notices.some((notice) => notice.phase === "error");
      const role = hasError ? "alert" : "status";
      const live = hasError ? "assertive" : "polite";
      const toggle = (id) => setExpanded((value) => ({ ...value, [id]: !value[id] }));

      const renderRow = (notice) => {
        const label = kindLabel(notice.kind, t);
        const open = Boolean(expanded[notice.id]);
        const isApplying = notice.phase === "applying";
        const phase = notice.phase;
        const title = phase === "error" ? (notice.type === "check-error" ? t("title.checkError") : t("title.error"))
          : phase === "up-to-date" ? t("title.upToDate")
          : phase === "restart-required" ? t("title.restartRequired")
          : phase === "applying" ? t("title.applying", { kind: label })
          : phase === "applied" ? t("title.applied", { kind: label })
          : t("title.available", { kind: label });
        const version = notice.from && notice.to && notice.from !== notice.to
          ? t("version.fromTo", { from: notice.from, to: notice.to })
          : notice.to ? t("version.toOnly", { to: notice.to }) : "";
        const time = relativeTime(notice.phase === "applied" ? "updated" : "checked", notice.at, now, t);
        const channel = channelLabel(notice.channel, t);
        const detailsId = "rub-details-" + String(notice.kind).replace(/[^a-zA-Z0-9_-]/g, "") + "-" + shortHash(notice.id);
        const phaseLabel = t("phase." + phaseKey(phase));
        const buttonsId = detailsId + "-actions";
        const showUpdate = notice.kind === "dsh" && (phase === "available" || phase === "error");
        const showRetry = phase === "error" && notice.type === "check-error";
        const release = notice.type === "check-error" || notice.type === "up-to-date" ? null : releaseUrl(notice);
        return h("section", {
          key: notice.id,
          className: "rub-row",
          "data-testid": "update-row-" + notice.kind,
          "aria-busy": isApplying ? "true" : undefined,
        },
          h("div", { className: "rub-row-head" },
            h("button", {
              type: "button",
              className: "rub-row-toggle",
              "aria-expanded": open,
              "aria-controls": buttonsId,
              "aria-label": t(open ? "a11y.collapse" : "a11y.expand", { kind: label }),
              "data-testid": "toggle-" + notice.kind,
              onClick: () => toggle(notice.id),
            },
              h(Icon, null),
              h("span", { className: "rub-row-text" },
                h("span", { className: "rub-title" }, title),
                version ? h("span", { className: "rub-sub" }, version) : null,
                time ? h("span", { className: "rub-sub" }, time) : null,
                channel ? h("span", { className: "rub-sub" }, t("label.channel") + ": " + channel) : null,
                (phase === "restart-required" || phase === "error") && notice.message
                  ? h("span", { className: "rub-sub" }, notice.message) : null)),
            h("span", { className: "rub-badge", "data-phase": phase }, phaseLabel)),
          open ? h("div", { className: "rub-details", id: detailsId },
            version ? h("div", null, version) : null,
            channel ? h("div", null, t("label.channel") + ": " + channel) : null,
            notice.phase === "applied" && notice.from
              ? h("div", null, t("applied.message", { from: notice.from, to: notice.to })) : null,
            phase === "restart-required" ? h("div", null, notice.message || t("restart.message", { to: notice.to })) : null,
            phase === "error" && notice.message ? h("div", null, notice.message) : null,
            notice.command ? h("div", null, t("label.install") + ": ", h("code", null, notice.command)) : null,
            release ? h("a", {
              className: "rub-link", href: release, target: "_blank", rel: "noopener noreferrer",
              "data-testid": "release-" + notice.kind,
            }, t("action.releaseNotes")) : null) : null,
          h("div", { className: "rub-acts", id: buttonsId },
            showUpdate ? h("button", {
              type: "button", className: "rub-btn", "data-testid": "update-" + notice.kind,
              disabled: isApplying || anyApplying, "aria-busy": isApplying ? "true" : undefined,
              "aria-label": isApplying ? t("a11y.busy", { kind: label }) : phase === "error" ? t("action.retry") : t("action.update"),
              onClick: () => applyDsh(notice),
            }, isApplying ? t("action.updating") : phase === "error" ? t("action.retry") : t("action.update")) : null,
            showRetry ? h("button", {
              type: "button", className: "rub-btn", "data-testid": "retry-" + notice.kind,
              onClick: () => load(true),
            }, t("action.retry")) : null,
            h("button", {
              type: "button", className: "rub-btn secondary", "data-testid": "dismiss-" + notice.kind,
              "aria-label": t("a11y.dismissKind", { kind: label }),
              onClick: () => dismissNotice(notice),
            }, t("action.dismiss"))));
      };

      return h("div", {
        className: "rub-wrap",
        "data-testid": "update-card",
        role: role,
        "aria-live": live,
        "aria-busy": anyApplying ? "true" : undefined,
        "aria-label": t("card.region"),
      },
        h("style", null, CSS),
        h("div", { className: "rub-card" },
          h("div", { className: "rub-head" },
            h("div", { className: "rub-heading" }, h(Icon, { size: 18 }), h("span", null, t("card.title"))),
            h("button", {
              type: "button", className: "rub-close", "data-testid": "close-notices",
              "aria-label": t("card.close"), title: t("card.close"), onClick: dismissAll,
            }, h("span", { "aria-hidden": "true" }, "×"))),
          h("div", { className: "rub-rows" }, notices.map(renderRow))));
    }

    function apply(ctx) {
      const hasLocale = Boolean(ctx && ctx.locale && typeof ctx.locale.register === "function" &&
        typeof ctx.locale.bind === "function");
      if (hasLocale) {
        for (const id of Object.keys(DICTIONARIES)) {
          const register = () => ctx.locale.register(NS, id, DICTIONARIES[id]);
          if (typeof ctx.effect === "function") ctx.effect(register, "rdsh-update-banner: " + id + " dictionary");
          else register();
        }
      }
      const fallbackT = createTranslator(ctx);
      function Localized(props) {
        return h(Banner, { ...props, fallbackT: fallbackT });
      }
      ctx.slots.inject("shell.overlay", () => ctx.slots.register({
        name: "shell.overlay", id: "rdsh-update-banner", order: 90,
        ...(hasLocale ? { locale: NS } : {}),
      }, Localized));
    }

    return {
      inject: ["slots", "locale"],
      apply: apply,
      __internals: {
        dictionaries: DICTIONARIES,
        occurrence: occurrence,
        compareRelative: relativeTime,
      },
    };
  },
});
