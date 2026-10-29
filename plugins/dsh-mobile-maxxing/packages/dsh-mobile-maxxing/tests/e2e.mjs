/**
 * End-to-end check of the served app: manifest, worker, install prompt, offline
 * launch. Runs its own headless Chrome; needs a DSH Web instance with this
 * plugin enabled.
 *
 *   BASE_URL=http://127.0.0.1:3099 node tests/e2e.mjs
 *
 * Exits non-zero on the first failed assertion.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3099").replace(/\/$/, "");
const CHROME = process.env.CHROME || "google-chrome";
const PORT = Number(process.env.CDP_PORT || 9333);

const failures = [];
function check(name, condition, detail) {
	if (condition) {
		console.log(`ok   ${name}`);
		return;
	}
	failures.push(name);
	console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function http(path) {
	const response = await fetch(BASE + path, { redirect: "manual" });
	return { status: response.status, headers: response.headers, text: await response.text() };
}

// ---------------------------------------------------------------- CDP client
class Cdp {
	constructor(socket) {
		this.socket = socket;
		this.id = 0;
		this.pending = new Map();
		this.listeners = new Map();
		socket.onmessage = (event) => this.receive(event.data);
	}
	static async connect(url) {
		const socket = new WebSocket(url);
		await new Promise((resolve, reject) => {
			socket.onopen = resolve;
			socket.onerror = reject;
		});
		return new Cdp(socket);
	}
	receive(raw) {
		const message = JSON.parse(raw);
		if (message.id !== undefined) {
			const pending = this.pending.get(message.id);
			this.pending.delete(message.id);
			if (message.error) pending.reject(new Error(message.error.message));
			else pending.resolve(message.result);
			return;
		}
		for (const fn of this.listeners.get(message.method) || []) fn(message.params);
	}
	send(method, params = {}) {
		const id = ++this.id;
		this.socket.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
	}
	on(method, fn) {
		if (!this.listeners.has(method)) this.listeners.set(method, []);
		this.listeners.get(method).push(fn);
	}
	async eval(expression) {
		const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "evaluation failed");
		return result.result.value;
	}
}

async function startChrome() {
	const profile = await mkdtemp(join(tmpdir(), "dsh-mobile-maxxing-e2e-"));
	const child = spawn(CHROME, [
		"--headless=new",
		`--remote-debugging-port=${PORT}`,
		`--user-data-dir=${profile}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-gpu",
		"about:blank",
	], { stdio: "ignore" });
	const cleanup = async () => {
		child.kill("SIGTERM");
		await sleep(300);
		await rm(profile, { recursive: true, force: true });
	};
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
			if (response.ok) return { cleanup };
		} catch {
			/* not up yet */
		}
		await sleep(100);
	}
	await cleanup();
	throw new Error("headless Chrome did not start");
}

async function openTarget(url) {
	const response = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
	const target = await response.json();
	return target;
}

// ---------------------------------------------------------------- scenarios
async function checkStatic() {
	const manifest = await http("/dsh-mobile-maxxing.webmanifest");
	check("manifest is served", manifest.status === 200, manifest.status);
	check("manifest has the manifest content type", /application\/manifest\+json/.test(manifest.headers.get("content-type") || ""));
	const parsed = JSON.parse(manifest.text);
	check("manifest display is standalone", parsed.display === "standalone", parsed.display);
	check("manifest carries 192px and 512px icons",
		parsed.icons.some((icon) => icon.sizes === "192x192") && parsed.icons.some((icon) => icon.sizes === "512x512"));
	check("manifest has a maskable icon", parsed.icons.some((icon) => icon.purpose === "maskable"));
	check("manifest pins prefer_related_applications=false", parsed.prefer_related_applications === false);

	const worker = await http("/sw.js");
	check("worker is served", worker.status === 200);
	check("worker is JavaScript with root scope", /javascript/.test(worker.headers.get("content-type") || "") && worker.headers.get("service-worker-allowed") === "/");

	const index = await http("/");
	check("index carries the app metadata", index.text.includes("<!--dsh-mobile-maxxing-->"));
	check("index links the Apple touch icon", index.text.includes("apple-touch-icon"));
	check("index allows edge-to-edge drawing", index.text.includes("viewport-fit=cover"));

	for (const path of ["/pwa/icon-192.png", "/pwa/icon-512.png", "/pwa/icon-maskable-512.png", "/pwa/apple-touch-icon.png", "/pwa/screenshot-mobile.png"]) {
		const asset = await fetch(BASE + path);
		check(`${path} is served`, asset.ok, asset.status);
	}
}

async function checkRuntime() {
	const target = await openTarget("about:blank");
	const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
	const pluginErrors = [];
	cdp.on("Runtime.consoleAPICalled", ({ type, args }) => {
		if (type !== "error") return;
		const text = args.map((arg) => arg.value ?? arg.description ?? "").join(" ");
		if (text.includes("[dsh-mobile-maxxing]")) pluginErrors.push(text.split("\n")[0]);
	});
	await cdp.send("Page.enable");
	await cdp.send("Runtime.enable");
	await cdp.send("Network.enable");
	await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
	await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
		source: "window.__e2eInstallPrompt = 0; addEventListener('beforeinstallprompt', (event) => { window.__e2eInstallPrompt += 1; event.preventDefault(); });",
	});
	await cdp.send("Page.navigate", { url: BASE + "/" });

	let state = null;
	for (let attempt = 0; attempt < 150; attempt += 1) {
		await sleep(200);
		state = await cdp.eval("globalThis.__RDSH_PWA__ ? globalThis.__RDSH_PWA__.state : null").catch(() => null);
		// The install prompt rides Chrome's engagement heuristic: wait for it
		// instead of assuming it fires on the first frame.
		if (state !== null && state.sw === "active" && state.installable) break;
	}
	check("client plugin boots", state !== null);
	if (state === null) return cdp;
	check("no boot error", state.bootError === "", state.bootError);
	check("service worker is active", state.sw === "active", state.sw);
	check("no phantom update prompt on a first visit", state.updateReady === false, state.updateReady);
	check("install prompt is captured", state.installable === true);
	check("offline mode is not reported while online", state.offline === false);

	const runtime = await cdp.eval(`(async () => {
		const reg = await navigator.serviceWorker.getRegistration();
		return {
			controller: navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null,
			waiting: reg && reg.waiting ? reg.waiting.scriptURL : null,
			keys: await caches.keys(),
			installButton: !!document.querySelector('.dsh-mobile-maxxing-foot'),
			optimized: performance.getEntriesByType('navigation').length > 0,
		};
	})()`);
	check("our worker controls the page", /\/sw\.js$/.test(runtime.controller || ""), runtime.controller);
	check("no competing worker waits behind ours", runtime.waiting === null, runtime.waiting);
	check("a versioned shell cache exists", runtime.keys.some((key) => key.startsWith("dsh-mobile-maxxing-")), runtime.keys);
	check("the install affordance renders", runtime.installButton === true);

	await cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
	await cdp.send("Page.reload");
	// The offline pill is rendered by a later effect; polling keeps this
	// assertion strict while avoiding a fixed-delay race on a slow machine.
	let offline = null;
	for (let attempt = 0; attempt < 40; attempt += 1) {
		offline = await cdp.eval(`(() => ({
			title: document.title,
			offline: globalThis.__RDSH_PWA__ ? globalThis.__RDSH_PWA__.state.offline : null,
			pill: document.querySelector('.dsh-mobile-maxxing-pill') ? document.querySelector('.dsh-mobile-maxxing-pill').textContent : null,
			root: !!document.getElementById('root'),
		}))()`);
		if (offline.pill !== null) break;
		await sleep(250);
	}
	check("an offline reload still serves the app shell", offline.title === "DeepSeek Harness" && offline.root === true, offline);
	// Text is localised, so assert the element rendered rather than its wording.
	check("offline state is visible", typeof offline.pill === "string" && offline.pill.length > 0, offline);
	await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

	// Device mode, not width: a desktop window stays PC at 683px and 1440px.
	// The mode comes from the host bootstrap; width only drives geometry.
	for (const width of [683, 1440]) {
		await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
		await cdp.send("Page.reload");
		await sleep(2500);
		const view = await cdp.eval(`(() => ({
			width: window.innerWidth,
			narrow: matchMedia('(max-width: 767px)').matches,
			mode: document.documentElement.getAttribute('data-rdsh-device-mode'),
			phone: globalThis.__RDSH_MOBILE_UX__ ? globalThis.__RDSH_MOBILE_UX__.phone() : null,
			hideSettings: document.documentElement.hasAttribute('data-rdsh-hide-settings'),
			hidden: document.querySelectorAll('[data-rdsh-hidden], [data-rdsh-setting-hidden]').length,
		}))()`);
		// A desktop is a hard no-op: no diagnostics object at all, and no mobile
		// hook may be written into the page.
		const expected = view.mode === "desktop" && view.phone === null && view.hideSettings === false && view.hidden === 0;
		check(
			`a ${width}x900 desktop window stays PC`,
			expected,
			view,
		);
	}

	check("the plugin logs no errors", pluginErrors.length === 0, pluginErrors);
	return cdp;
}

const chrome = await startChrome().catch((error) => {
	console.error(error.message);
	process.exit(1);
});
try {
	await checkStatic();
	const cdp = await checkRuntime();
	if (cdp !== undefined) cdp.socket.close();
} finally {
	await chrome.cleanup();
}

if (failures.length > 0) {
	console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
	process.exit(1);
}
console.log("\nall checks passed");
