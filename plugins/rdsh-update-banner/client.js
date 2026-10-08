window.__ModuleLoader__.load({
  id: "rdsh-update-banner",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useCallback = React.useCallback;
    const useRef = React.useRef;
    const ENDPOINT = "/api/rdsh-update";
    const DISMISS_KEY = "rdsh-update-dismissed";
    const DISMISS_PREFIX = DISMISS_KEY + ":v2:";
    // Shared across overlay remounts even when browser storage is unavailable.
    const dismissedUpdates = new Set();
    const updateKey = (j) => JSON.stringify([j.kind || "update", j.to || ""]);
    function acknowledge(j) {
      return fetch(ENDPOINT + "/dismiss", {
        method: "POST", cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: j.to, kind: j.kind || "update" }),
      }).catch(() => {});
    }
    function remember(j) {
      const key = updateKey(j);
      dismissedUpdates.add(key);
      try { localStorage.setItem(DISMISS_PREFIX + key, "1"); } catch (e) {}
    }
    function isDismissed(j) {
      if (!j) return false;
      const key = updateKey(j);
      if (j.dismissed || dismissedUpdates.has(key)) return true;
      try {
        if (localStorage.getItem(DISMISS_PREFIX + key) === "1") {
          dismissedUpdates.add(key);
          return true;
        }
        // Migrate the previous timestamp-based record, including expired ones.
        const old = JSON.parse(localStorage.getItem(DISMISS_KEY) || "null");
        const separator = typeof old?.key === "string" ? old.key.lastIndexOf("@") : -1;
        if (separator > 0 && old.key.slice(0, separator) === j.to) {
          remember(j);
          // Once assigned to this component, the legacy wildcard must not hide
          // a future update of a different component with the same version.
          try { localStorage.removeItem(DISMISS_KEY); } catch (e) {}
          return true;
        }
      } catch (e) {}
      return false;
    }
    const CSS = ".rub-wrap{position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:900;" +
      "width:min(400px,calc(100vw - 24px));box-sizing:border-box;" +
      "background:rgba(20,20,24,.55);-webkit-backdrop-filter:blur(28px) saturate(200%);backdrop-filter:blur(28px) saturate(200%);" +
      "border-radius:26px;color:#fff;font-size:13px;" +
      "box-shadow:0 16px 48px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.35),inset 0 -0.5px 0 rgba(255,255,255,.08);" +
      "border:0.5px solid rgba(255,255,255,.25);overflow:hidden}" +
      ".rub-pop{animation:rub-pop .45s cubic-bezier(.2,.9,.25,1.2)}" +
      ".rub-mini{display:flex;align-items:center;gap:10px;padding:7px 18px 7px 8px;cursor:pointer;white-space:nowrap}" +
      ".rub-card{padding:12px 12px 12px 12px;position:relative}" +
      ".rub-row1{display:flex;gap:10px;align-items:flex-start;cursor:pointer}" +
      ".rub-ico{width:40px;height:40px;border-radius:10px;flex:none}" +
      ".rub-mini .rub-ico{width:24px;height:24px}" +
      ".rub-tt{flex:1;min-width:0;font-weight:600;font-size:14px;display:flex;align-items:baseline;gap:8px}" +
      ".rub-time{margin-left:auto;font-size:12px;font-weight:400;color:rgba(255,255,255,.55);white-space:nowrap}" +
      ".rub-x{position:absolute;top:6px;right:8px;background:none;border:0;color:rgba(255,255,255,.6);font-size:15px;padding:4px 8px;cursor:pointer}" +
      ".rub-body{margin-top:6px;overflow-wrap:anywhere}" +
      ".rub-ver{font-family:monospace;font-size:12px;background:rgba(255,255,255,.12);" +
      "border-radius:6px;padding:0 6px;margin:0 2px;white-space:nowrap}" +
      ".rub-sub{color:rgba(255,255,255,.6);font-size:12px;margin-top:4px;overflow-wrap:anywhere}" +
      ".rub-acts{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:8px}" +
      ".rub-tbtn{background:none;border:0;padding:2px 0;cursor:pointer;font-size:13px;color:#0A84FF}" +
      ".rub-tbtn.dim{color:rgba(255,255,255,.6)}" +
      ".rub-tbtn:disabled{opacity:.5;cursor:wait}";
    const KEYFRAMES = "@keyframes rub-pop{from{top:-40px;transform:translateX(-50%) scale(.6);opacity:0}" +
      "to{transform:translateX(-50%) scale(1);opacity:1}}";
    function Icon() {
      return h("svg", { className: "rub-ico", width: 40, height: 40, viewBox: "0 0 38 38", style: { flex: "none" } },
        h("defs", null,
          h("linearGradient", { id: "rub-g", x1: "0", y1: "0", x2: "0", y2: "1" },
            h("stop", { offset: "0", stopColor: "#34C759" }),
            h("stop", { offset: "1", stopColor: "#248A3D" }))),
        h("rect", { width: 38, height: 38, rx: 9, fill: "url(#rub-g)" }),
        h("path", { d: "M22 5 L11 21 h7 l-4 12 L27 16 h-7 z", fill: "#fff" }));
    }
    function Banner() {
      const dataPair = useState(null);
      const data = dataPair[0];
      const setData = dataPair[1];
      const detailPair = useState(false);
      const showDetail = detailPair[0];
      const setShowDetail = detailPair[1];
      const expPair = useState(true);
      const expanded = expPair[0];
      const setExpanded = expPair[1];
      const runPair = useState("idle");
      const running = runPair[0];
      const setRunning = runPair[1];
      const resPair = useState("");
      const result = resPair[0];
      const setResult = resPair[1];
      const loadGeneration = useRef(0);
      const load = useCallback(async () => {
        const generation = ++loadGeneration.current;
        try {
          const r = await fetch(ENDPOINT, { cache: "no-store" });
          if (!r.ok) return;
          const j = await r.json();
          if (!j || !j.ok || generation !== loadGeneration.current) return;
          // Clear a visible banner too, including a response arriving after close.
          const hidden = j.updated && isDismissed(j);
          if (hidden && !j.dismissed) acknowledge(j);
          setData(hidden ? null : j);
        } catch (e) {}
      }, []);
      useEffect(() => {
        load();
        const t = setInterval(load, 60000);
        const onStorage = (event) => {
          if (event.key?.startsWith(DISMISS_PREFIX) && event.newValue === "1") {
            dismissedUpdates.add(event.key.slice(DISMISS_PREFIX.length));
          }
          if (event.key === DISMISS_KEY || event.key?.startsWith(DISMISS_PREFIX)) {
            setData((current) => isDismissed(current) ? null : current);
          }
        };
        window.addEventListener("storage", onStorage);
        return () => {
          clearInterval(t);
          window.removeEventListener("storage", onStorage);
          ++loadGeneration.current;
        };
      }, [load]);
      const dismiss = () => {
        if (data) {
          remember(data);
          // Account-wide acknowledgement also spans GUI ports and browsers.
          acknowledge(data);
        }
        setData(null);
      };
      const runUpdate = useCallback(async () => {
        if (running !== "idle") return;
        setRunning("busy");
        setResult("");
        try {
          const r = await fetch(ENDPOINT + "/run", { method: "POST", cache: "no-store" });
          const j = await r.json();
          setRunning("done");
          setResult(j && j.message ? j.message : (j && j.ok ? "done" : "failed"));
          setExpanded(true);
          load();
        } catch (e) {
          setRunning("done");
          setResult("request failed");
        }
      }, [running, load]);
      if (!data || !data.updated) return null;
      const inner = expanded ? h("div", { className: "rub-card" },
        h("button", { className: "rub-x", onClick: dismiss, "aria-label": "close" }, "x"),
        h("div", { className: "rub-row1", onClick: () => setExpanded(false) },
          h(Icon, null),
          h("div", { className: "rub-tt" },
            h("b", null, "rdsh updated!"),
            h("span", { className: "rub-time" }, "now"))),
        h("div", { className: "rub-body" },
          h("span", { className: "rub-ver" }, data.from || "?"),
          " to ",
          h("span", { className: "rub-ver" }, data.to || "?"),
          showDetail ? h("div", { className: "rub-sub" },
            "applied: " + (data.at ? new Date(data.at).toLocaleString() : "?"),
            data.demo ? " (demo)" : "") : null,
          result ? h("div", { className: "rub-sub" }, result) : null,
          h("div", { className: "rub-acts" },
            h("button", { className: "rub-tbtn", disabled: running === "busy", onClick: runUpdate },
              running === "busy" ? "updating..." : running === "done" ? "update again" : "update"),
            h("button", { className: "rub-tbtn dim", onClick: () => setShowDetail(!showDetail) }, "details"),
            h("button", { className: "rub-tbtn dim", onClick: dismiss }, "dismiss"))))
        : h("div", { className: "rub-mini", onClick: () => setExpanded(true) },
          h(Icon, null),
          h("b", null, "rdsh updated!"));
      return h("div", { className: "rub-wrap rub-pop", role: "alert", "data-testid": "rdsh-update" },
        h("style", null, CSS + KEYFRAMES),
        inner);
    }
    return {
      inject: ["slots"],
      apply(ctx) {
        ctx.slots.inject("shell.overlay", () => ctx.slots.register({
          name: "shell.overlay", id: "rdsh-update-banner", order: 90,
        }, Banner));
      },
    };
  },
});
