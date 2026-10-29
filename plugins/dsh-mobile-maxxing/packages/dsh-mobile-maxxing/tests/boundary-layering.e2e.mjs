/**
 * #46 layering geometry in a real browser, checked against the device-MODE
 * stylesheet split (CSS-only fixture).
 *
 * This is deliberately a CSS-only check: it installs `CSS_DEVICE` always and
 * `CSS_PHONE` only in the explicit `mobile` fixture, exactly as the running
 * bundle does when the host bootstrap selected mobile mode. It does NOT test
 * the classifier/bootstrap itself (the QA matrix and unit tests own that); a
 * real bootstrap is never run here, and this file must not claim production
 * mode selection was exercised.
 *
 * Width is only geometry: the same mobile fixture must keep the phone inset and
 * session frame at 390 and 1024, and the desktop fixture must not get them at
 * either width. No artificial `@media (max-width: 767px)` wrapper is added
 * around `CSS_PHONE` — that would false-green the old width contract.
 *
 * Creates its OWN incognito browser context and page target through the
 * browser-level CDP endpoint, drives only that target, and disposes both in a
 * `finally`. Existing tabs/targets are only read from `/json/list` to find the
 * new target's WebSocket URL; they are never attached to or modified.
 *
 *   node tests/boundary-layering.e2e.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PORT = process.env.CDP_PORT || 9222;
const client = readFileSync(new URL("../client.js", import.meta.url), "utf8");

/** Raw stylesheet text; no interpolation and no width wrapper. */
function cssTemplate(name) {
	const tick = String.fromCharCode(96);
	const match = client.match(new RegExp(`const ${name} = ${tick}([\\s\\S]*?)${tick};\\n`));
	assert.ok(match, `${name} exists`);
	return match[1];
}

const deviceCss = cssTemplate("CSS_DEVICE");
const phoneCss = cssTemplate("CSS_PHONE");
assert.equal(/@media\s*\(max-width:\s*767px\)/.test(phoneCss), false, "CSS_PHONE must not carry a hand-written 767px wrapper");
assert.equal(phoneCss.trimStart().startsWith("@media"), false, "CSS_PHONE must stay raw, not wrapped in an @media block");

/**
 * Upstream-shaped fixture. `mode` only decides whether the raw phone sheet is
 * present; viewport width never changes that decision.
 */
function fixtureFor(mode) {
	const phoneSheet = mode === "mobile" ? `<style data-fixture="phone">${phoneCss}</style>` : "";
	return {
		head: `<meta name="viewport" content="width=device-width, initial-scale=1">`
			+ `<style data-fixture="device">${deviceCss}</style>${phoneSheet}`,
		body: `<div data-rdsh-frame data-rightbar-fullscreen style="display:grid;grid-template-columns:0 minmax(0,1fr) 0;height:100dvh">
  <div data-rdsh-center-col style="grid-column:2;display:flex;flex-direction:column;min-width:0">
    <header data-rdsh-header data-window-drag style="height:76px;flex:0 0 76px;background:#333"></header>
    <div style="flex:1 1 auto;background:#222">chat</div>
  </div>
  <div data-rdsh-rightbar-col style="grid-column:3;position:relative;overflow:visible;min-width:0">
    <div data-sidebar-right-panel="fullscreen" style="position:absolute;top:0;bottom:0;right:0;width:100vw;overflow:clip;pointer-events:none">
      <div data-rdsh-rightpanel style="height:100%;background:#555;pointer-events:auto"><span>panel</span></div>
    </div>
  </div>
</div>
<div data-row-key="session:s1" data-rdsh-session-frame style="--rdsh-session-frame:#ff6b6b;height:20px">row</div>`,
	};
}

/** One CDP socket with request/response correlation. */
async function connect(webSocketUrl) {
	const socket = new WebSocket(webSocketUrl);
	await new Promise((resolve, reject) => {
		socket.onopen = resolve;
		socket.onerror = reject;
	});
	let nextId = 0;
	const pending = new Map();
	socket.onmessage = (event) => {
		const message = JSON.parse(event.data);
		if (message.id === undefined) return;
		const call = pending.get(message.id);
		pending.delete(message.id);
		if (call === undefined) return;
		if (message.error) call.reject(new Error(message.error.message));
		else call.resolve(message.result);
	};
	return {
		send(method, params = {}) {
			const id = ++nextId;
			socket.send(JSON.stringify({ id, method, params }));
			return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
		},
		close() {
			try {
				socket.close();
			} catch {
				/* already closed */
			}
		},
	};
}

const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
assert.ok(version.webSocketDebuggerUrl, "the CDP browser endpoint is required (CDP_PORT)");

let browser = null;
let page = null;
let browserContextId = null;
let targetId = null;
let result = null;
try {
	browser = await connect(version.webSocketDebuggerUrl);
	({ browserContextId } = await browser.send("Target.createBrowserContext", { disposeOnDetach: false }));
	({ targetId } = await browser.send("Target.createTarget", { url: "about:blank", browserContextId }));

	// Read-only: the list is used only to resolve the new target's page socket.
	const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
	const target = targets.find((entry) => entry.id === targetId && entry.type === "page");
	assert.ok(target, "the browser did not expose the target this test created");
	page = await connect(target.webSocketDebuggerUrl);

	const send = page.send;
	const evaluate = async (expression) => {
		const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (response.exceptionDetails) {
			throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
		}
		return response.result.value;
	};
	const setViewport = async (width, height) => {
		await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
		await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
	};
	const install = async (mode) => {
		const fixture = fixtureFor(mode);
		await evaluate(`(() => {
  document.documentElement.setAttribute("data-rdsh-device-mode", ${JSON.stringify(mode)});
  document.head.innerHTML = ${JSON.stringify(fixture.head)};
  document.body.innerHTML = ${JSON.stringify(fixture.body)};
  return true;
})()`);
	};
	const measure = () => evaluate(`(() => {
  const header = document.querySelector("header[data-rdsh-header]");
  const rect = header.getBoundingClientRect();
  const hit = document.elementFromPoint(Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2));
  const style = getComputedStyle(header);
  return {
    rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
    display: style.display,
    visibility: style.visibility,
    paddingLeft: style.paddingLeft,
    panelInFront: hit !== null && hit.closest("[data-sidebar-right-panel]") !== null,
    frameShadow: getComputedStyle(document.querySelector("[data-rdsh-session-frame]")).boxShadow,
    phoneSheet: document.querySelector('style[data-fixture="phone"]') !== null,
    mode: document.documentElement.getAttribute("data-rdsh-device-mode"),
  };
})()`);
	const toggleHeaderFrames = async (count) => {
		const rects = [];
		for (let index = 0; index < count; index += 1) {
			await evaluate(`document.documentElement.toggleAttribute("data-rdsh-rightpanel-open", ${index % 2 === 0})`);
			await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
			rects.push((await measure()).rect.join(","));
		}
		return [...new Set(rects)];
	};

	await send("Page.enable");
	await send("Runtime.enable");

	// Mobile mode at 390: #46 keeps the header in flow and the panel in front.
	await setViewport(390, 844);
	await install("mobile");
	const mobile390 = await measure();
	assert.equal(mobile390.mode, "mobile");
	assert.equal(mobile390.phoneSheet, true, "the mobile fixture is missing the raw phone sheet");
	assert.notEqual(mobile390.display, "none", "the open panel removed the header from layout");
	assert.notEqual(mobile390.visibility, "hidden", "the open panel hid the header");
	assert.equal(mobile390.panelInFront, true, "the panel is not painted above the header");
	assert.equal(mobile390.paddingLeft, "64px", "the mobile header inset is not applied");
	assert.match(mobile390.frameShadow, /255, 107, 107/, "the mobile session frame is not applied");
	const mobile390Rects = await toggleHeaderFrames(10);
	assert.equal(mobile390Rects.length, 1, "the header rect moved while the panel opened and closed at 390");

	// Same mobile fixture at 1024: this fixture is the fullscreen sheet (the
	// frame carries data-rightbar-fullscreen, as upstream does), so #46 layering
	// must hold there too. #72's dock at this width is a different presentation
	// and is covered by boundary-issues.test.mjs, not by this geometry fixture.
	await setViewport(1024, 900);
	const mobile1024 = await measure();
	assert.equal(mobile1024.mode, "mobile");
	assert.equal(mobile1024.phoneSheet, true, "a resize removed the phone sheet in mobile mode");
	assert.equal(mobile1024.paddingLeft, "64px", "the mobile header inset was dropped at 1024");
	assert.match(mobile1024.frameShadow, /255, 107, 107/, "the mobile session frame was dropped at 1024");
	assert.equal(mobile1024.panelInFront, true, "the panel is not in front at the tablet width");
	const mobile1024Rects = await toggleHeaderFrames(10);
	assert.equal(mobile1024Rects.length, 1, "the header rect moved at the tablet width");

	// Desktop fixture at 1024 and 390: no phone sheet, no phone inset/frame.
	await install("desktop");
	const desktop1024 = await measure();
	assert.equal(desktop1024.mode, "desktop");
	assert.equal(desktop1024.phoneSheet, false, "a desktop fixture got the phone sheet");
	assert.notEqual(desktop1024.paddingLeft, "64px", "the mobile header inset leaked into desktop mode at 1024");
	assert.equal(desktop1024.frameShadow, "none", "the mobile session frame leaked into desktop mode at 1024");

	await setViewport(390, 844);
	const desktop390 = await measure();
	assert.equal(desktop390.mode, "desktop");
	assert.equal(desktop390.phoneSheet, false, "a desktop fixture got the phone sheet at 390");
	assert.notEqual(desktop390.paddingLeft, "64px", "a narrow desktop window got the mobile header inset");
	assert.equal(desktop390.frameShadow, "none", "a narrow desktop window got the mobile session frame");

	result = {
		fixtureKind: "css-only static mode sheets (device always, phone only in mobile fixture); bootstrap/classifier not exercised",
		mobile390,
		mobile390Rects,
		mobile1024,
		mobile1024Rects,
		desktop1024,
		desktop390,
	};
} finally {
	page?.close();
	if (browser !== null) {
		if (targetId !== null) {
			await browser.send("Target.closeTarget", { targetId }).catch(() => {});
		}
		if (browserContextId !== null) {
			await browser.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
		}
		browser.close();
	}
}

console.log(JSON.stringify(result, null, 2));
