// Settings section for the route every new child agent starts with.
//
// The value lives in the profile's loader patch, so DSH itself applies it when
// it composes the delegation tool. This section only reads and rewrites that
// file through /api/rdsh-subagent-route; a child that is already running keeps
// its own route.
window.__ModuleLoader__.load({
  id: "rdsh-subagent-route",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const ENDPOINT = "/api/rdsh-subagent-route";
    const LABELS = {
      title: "サブエージェントのモデルと effort",
      hint: "新しく起動する子エージェントの既定値です。空欄は親の設定を継承します。変更は次に起動する子から反映されます。",
      provider: "provider",
      model: "model",
      effort: "effort（reasoning effort）",
      save: "保存",
      clear: "継承に戻す",
      loading: "読み込み中…",
      saved: "保存しました。次に起動する子から反映されます。",
      cleared: "継承に戻しました。",
      unsupported: "このプロファイルには cordis.patch.yml がありません。",
      failed: "保存できませんでした",
    };

    async function callRoute(method, body) {
      const response = await fetch(ENDPOINT, {
        method,
        cache: "no-store",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const value = await response.json().catch(() => null);
      if (!response.ok || !value || value.ok !== true) {
        throw new Error((value && value.error) || "request-failed");
      }
      return value;
    }

    function Row(props) {
      return h("label", { style: { display: "grid", gap: 4, marginBottom: 10 } },
        h("span", { style: { fontSize: 12, opacity: 0.75 } }, props.label),
        props.children);
    }

    const field = {
      width: "100%", boxSizing: "border-box", padding: "6px 8px",
      borderRadius: 6, border: "1px solid var(--dsw-alias-border-l3, #30363d)",
      background: "var(--dsw-alias-bg-module-platform, #161b22)", color: "inherit", fontSize: 13,
    };

    function SubagentRouteSection() {
      const [state, setState] = useState({ status: "loading", route: null, efforts: [] });
      const [provider, setProvider] = useState("");
      const [model, setModel] = useState("");
      const [effort, setEffort] = useState("");
      const [notice, setNotice] = useState("");

      const adopt = useCallback((route) => {
        setProvider(route?.provider || "");
        setModel(route?.model || "");
        setEffort(route?.reasoningEffort || "");
      }, []);

      useEffect(() => {
        let live = true;
        callRoute("GET").then((value) => {
          if (!live) return;
          if (value.supported === false) {
            setState({ status: "unsupported", route: null, efforts: [] });
            return;
          }
          adopt(value.route);
          setState({ status: "ready", route: value.route, efforts: value.efforts || [] });
        }).catch((error) => {
          if (live) setState({ status: "error", route: null, efforts: [], error: String(error.message || error) });
        });
        return () => { live = false; };
      }, [adopt]);

      const save = useCallback(async (clear) => {
        setNotice("");
        try {
          const value = await callRoute("POST", clear
            ? { clear: true }
            : { provider, model, reasoningEffort: effort });
          adopt(value.route);
          setState((current) => ({ ...current, route: value.route }));
          setNotice(clear ? LABELS.cleared : LABELS.saved);
        } catch (error) {
          setNotice(LABELS.failed + ": " + String(error.message || error));
        }
      }, [adopt, effort, model, provider]);

      if (state.status === "loading") return h("div", { style: { padding: 12, opacity: 0.7 } }, LABELS.loading);
      if (state.status === "unsupported") return h("div", { style: { padding: 12, opacity: 0.7 } }, LABELS.unsupported);
      if (state.status === "error") {
        return h("div", { style: { padding: 12 } }, LABELS.failed + ": " + state.error);
      }

      const efforts = [""].concat(state.efforts);
      return h("div", { style: { display: "grid", gap: 4, maxWidth: 520, padding: "4px 0" } },
        h("h3", { style: { margin: "0 0 4px", fontSize: 15 } }, LABELS.title),
        h("p", { style: { margin: "0 0 12px", fontSize: 12, opacity: 0.7 } }, LABELS.hint),
        h(Row, { label: LABELS.provider },
          h("input", { style: field, value: provider, placeholder: "（継承）",
            onChange: (event) => setProvider(event.target.value) })),
        h(Row, { label: LABELS.model },
          h("input", { style: field, value: model, placeholder: "（継承）",
            onChange: (event) => setModel(event.target.value) })),
        h(Row, { label: LABELS.effort },
          h("select", { style: field, value: effort, onChange: (event) => setEffort(event.target.value) },
            efforts.map((value) => h("option", { key: value, value }, value || "（継承）")))),
        h("div", { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 6 } },
          h("button", { type: "button", onClick: () => save(false) }, LABELS.save),
          h("button", { type: "button", onClick: () => save(true) }, LABELS.clear),
          notice ? h("span", { style: { fontSize: 12, opacity: 0.75 } }, notice) : null));
    }

    return {
      inject: ["slots"],
      apply(ctx) {
        ctx.slots.inject("settings.section", () => ctx.slots.register({
          name: "settings.section",
          id: "rdsh-subagents",
          order: 21,
          label: () => "サブエージェント",
          inject: () => ({}),
        }, SubagentRouteSection));
      },
    };
  },
});
