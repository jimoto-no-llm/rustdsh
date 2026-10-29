#!/usr/bin/env node
/**
 * Real-touch regression for the right-panel tab strip.
 *
 * Loads the actual client bundle in a Chrome page whose DOM/CSS follows the
 * installed dockkit strip (touch-action:none, overflow-x:auto,
 * scroll-behavior:smooth) and drives Input.dispatchTouchEvent. It proves the
 * plugin's CSS_PHONE reopens the four strip layers to pan-y; scrollLeft changes
 * from the tab body, inter-tab caret and strip fill; vertical/desktop never pan.
 *
 * The target lives in its own browser context created with
 * Target.createBrowserContext; both the target and context are closed in
 * finally. It never reuses an existing tab.
 *
 *   CDP_URL=http://127.0.0.1:9333 node tests/tab-pan.e2e.mjs
 */
import { readFileSync } from "node:fs";

const CDP = process.env.CDP_URL || "http://127.0.0.1:9333";
const CLIENT = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
const check = (name, ok, detail) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`);
	if (!ok) failures.push(name);
};

class CdpSocket {
	constructor(socket) {
		this.socket = socket;
		this.id = 0;
		this.pending = new Map();
		socket.onmessage = (event) => {
			const message = JSON.parse(event.data);
			if (message.id === undefined) return;
			const pending = this.pending.get(message.id);
			this.pending.delete(message.id);
			if (message.error) pending.reject(new Error(message.error.message));
			else pending.resolve(message.result);
		};
	}
	static async connect(url) {
		const socket = new WebSocket(url);
		await new Promise((resolve, reject) => {
			socket.onopen = resolve;
			socket.onerror = reject;
		});
		return new CdpSocket(socket);
	}
	send(method, params = {}) {
		const id = ++this.id;
		this.socket.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
	}
	close() { try { this.socket.close(); } catch { /* gone */ } }
}

class Page {
	constructor(socket, target, browser, browserContextId) {
		this.socket = socket;
		this.target = target;
		this.browser = browser;
		this.browserContextId = browserContextId;
	}
	static async open() {
		const version = await (await fetch(`${CDP}/json/version`)).json();
		const browser = await CdpSocket.connect(version.webSocketDebuggerUrl);
		const { browserContextId } = await browser.send("Target.createBrowserContext", { disposeOnDetach: false });
		const { targetId } = await browser.send("Target.createTarget", { url: "about:blank", browserContextId });
		const list = await (await fetch(`${CDP}/json/list`)).json();
		const target = list.find((entry) => entry.id === targetId);
		if (target === undefined) throw new Error("browser-context target not listed");
		const socket = await CdpSocket.connect(target.webSocketDebuggerUrl);
		const page = new Page(socket, target, browser, browserContextId);
		await page.send("Page.enable");
		await page.send("Runtime.enable");
		await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
		await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
		return page;
	}
	send(method, params = {}) { return this.socket.send(method, params); }
	async eval(expression) {
		const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "evaluation failed");
		return result.result.value;
	}
	async close() {
		this.socket.close();
		try {
			await this.browser.send("Target.disposeBrowserContext", { browserContextId: this.browserContextId });
		} catch {
			/* context may already be gone */
		}
		this.browser.close();
	}
}

const fixture = (mode) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><style>
html,body{margin:0;height:1000px}
[data-sidebar-right-panel]{position:absolute;top:0;left:0;width:390px;height:700px}
#panel{position:absolute;inset:0;width:390px;height:700px;background:#fff}
/* Installed dockkit strip CSS: none on the scroll chain; fill has no rule. */
[data-dockkit-strip]{display:flex;flex:none;align-items:center;height:28px;padding:10px 6px 0 10px;overflow:visible;touch-action:none;width:390px}
[data-dockkit-strip-tabs]{display:flex;flex:0 1 auto;align-items:center;min-width:0;overflow-x:auto;overflow-y:hidden;scroll-behavior:smooth;scrollbar-width:none;touch-action:none}
[data-dockkit-strip-fill]{flex:1 1 0;min-width:0;height:28px;background:#eee}
[data-dockkit-tab]{position:relative;display:flex;flex:0 1 auto;align-items:center;min-width:120px;max-width:170px;height:28px;padding:0 10px;white-space:nowrap;touch-action:none;user-select:none;background:#ddd;border-right:1px solid #999}
[data-dockkit-caret]{flex:0 0 12px;height:28px;background:#bbb}
</style></head><body>
<div data-sidebar-right-panel><div id="panel">
<button aria-label="Collapse right sidebar" style="width:30px;height:30px">x</button>
<div data-dockkit-strip="pane1">
  <div data-dockkit-strip-tabs="pane1" id="strip">
    <div role="tab" data-dockkit-tab="a" aria-selected="true">A</div>
    <div data-dockkit-caret></div>
    <div role="tab" data-dockkit-tab="b">B</div>
    <div role="tab" data-dockkit-tab="c">C</div>
    <div role="tab" data-dockkit-tab="d">D</div>
    <div role="tab" data-dockkit-tab="e">E</div>
  </div>
  <div data-dockkit-strip-fill></div>
</div>
</div></div>
<script>
window.__RDSH_DEVICE_MODE__=${JSON.stringify(mode)};
window.__RDSH_PWA_COPY__={};window.__RDSH_PWA_PROBES__={};
window.__errors=[];window.addEventListener('error',e=>window.__errors.push(String(e.error||e.message)));
window.__loaded=null;window.__ModuleLoader__={load(def){window.__loaded=def;}};
</script></body></html>`;

const styleProbe = `(() => {
  const read = (selector, pseudo) => {
    const node = document.querySelector(selector);
    if (node === null) return null;
    const style = getComputedStyle(node, pseudo ?? undefined);
    return { touchAction: style.touchAction, overflowX: style.overflowX, scrollBehavior: style.scrollBehavior,
      width: Math.round(node.getBoundingClientRect().width) };
  };
  return { tab: read("[data-dockkit-tab]"), strip: read("[data-dockkit-strip]"),
    tabs: read("[data-dockkit-strip-tabs]"), fill: read("[data-dockkit-strip-fill]") };
})()`;

async function boot(page, mode) {
	await page.send("Page.navigate", { url: `data:text/html;base64,${Buffer.from(fixture(mode)).toString("base64")}` });
	await sleep(250);
	const before = await page.eval(styleProbe);
	await page.eval(CLIENT);
	const booted = await page.eval(`(() => {
		const def=window.__loaded; if(!def)return {error:"no module"};
		const disposers=[];
		const ctx={effect(fn){const d=fn();disposers.push(d)},inject(deps,cb){return cb(ctx)},
			slots:{inject(deps,cb){return cb()},register(){return()=>{}}},get(){return undefined},on(){return()=>{}}};
		const stub=()=>new Proxy(function(){return stub()},{get(t,k){if(k===Symbol.toPrimitive)return()=>0;if(k==="then")return undefined;if(k==="toString"||k==="valueOf")return()=>"";return stub()},apply(){return stub()},construct(){return stub()}});
		const React={createElement:()=>null,useState:()=>[null,()=>{}],useEffect:()=>{},useRef:()=>({current:null}),useMemo:(f)=>f(),useCallback:(f)=>f,memo:(v)=>v,Fragment:"f"};
		const require=(name)=>name==="react"?React:name==="react-dom/client"?{createRoot:()=>({render(){}})}:stub();
		def.factory(require).apply(ctx);
		// The fixture has no full app chrome; apply the hooks decoration would add.
		if (window.__RDSH_DEVICE_MODE__ === "mobile") {
			document.getElementById("panel").setAttribute("data-rdsh-rightpanel", "");
			for (const tab of document.querySelectorAll('[role="tab"][data-dockkit-tab]')) tab.setAttribute("data-rdsh-rtab", "");
		}
		return {tabs:document.querySelectorAll("[data-rdsh-rtab]").length, errors:window.__errors, api:!!window.__RDSH_MOBILE_UX__};
	})()`);
	await sleep(150);
	const after = await page.eval(styleProbe);
	return { booted, before, after };
}

async function drag(page, start, points) {
	await page.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: start[0], y: start[1], id: 1 }] });
	for (const [x, y] of points) {
		await page.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y, id: 1 }] });
		await sleep(16);
	}
	await page.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	await sleep(180);
}

const horizontal = (startX) => [[startX - 7, 51], [startX - 14, 52], [startX - 21, 53], [startX - 28, 54], [startX - 35, 55], [startX - 42, 56], [startX - 49, 57]];
const reset = (page) => page.eval(`document.getElementById("strip").scrollLeft=0`);
const scrollLeft = (page) => page.eval(`document.getElementById("strip").scrollLeft`);

try {
	const page = await Page.open();
	try {
		const { booted, before, after } = await boot(page, "mobile");
		check("the actual client boots with tab hooks", booted?.tabs === 5, booted);
		check("upstream fixture fill starts as auto", before?.fill?.touchAction === "auto", before?.fill);
		check("upstream fixture starts with touch-action:none on the strip chain",
			before?.tab?.touchAction === "none" && before?.strip?.touchAction === "none" && before?.tabs?.touchAction === "none",
			before);
		check("the fixture scrolls horizontally with smooth behavior",
			before?.tabs?.overflowX === "auto" && before?.tabs?.scrollBehavior === "smooth", before?.tabs);
		check("CSS_PHONE reopens tab/strip/tabs/fill to pan-x pan-y",
			after?.tab?.touchAction === "pan-x pan-y" && after?.strip?.touchAction === "pan-x pan-y"
			&& after?.tabs?.touchAction === "pan-x pan-y" && after?.fill?.touchAction === "pan-x pan-y",
			after);
		await drag(page, [100, 50], horizontal(100));
		check("a tab-body swipe pans the strip", (await scrollLeft(page)) > 20, await scrollLeft(page));
		check("the installed flex layout leaves no strip-fill hit area", before?.fill?.width === 0, before?.fill);
		await reset(page);
		await drag(page, [155, 50], horizontal(155));
		check("an inter-tab caret swipe pans the strip", (await scrollLeft(page)) > 20, await scrollLeft(page));
		await reset(page);
		await drag(page, [155, 50], [[155, 52], [156, 80], [157, 100], [158, 120]]);
		check("a vertical caret drag does not pan", (await scrollLeft(page)) === 0, await scrollLeft(page));
	} finally {
		await page.close();
	}

	const desktop = await Page.open();
	try {
		const { booted, after } = await boot(desktop, "desktop");
		await drag(desktop, [300, 50], horizontal(300));
		check("desktop mode never pans", (await scrollLeft(desktop)) === 0, await scrollLeft(desktop));
		check("desktop mode has no tab hooks", booted?.tabs === 0, booted);
		check("desktop mode gets no mobile strip override", after?.fill?.touchAction !== "pan-y", after);
	} finally {
		await desktop.close();
	}
} catch (error) {
	console.error(error);
	process.exit(2);
}
if (failures.length > 0) {
	console.error(`failed: ${failures.join(", ")}`);
	process.exit(1);
}
console.log("tab pan e2e: ok");
