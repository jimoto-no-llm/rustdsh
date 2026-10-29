/**
 * #84: the open model picker must not pan sideways.
 *
 * Upstream renders each model row as a `<button>` whose width is
 * shrink-to-fit. A local model's absolute path (`/home/…/Nanbeige4.3-33B…`)
 * gives that row a 422px min-content width inside the 345px list, so the list
 * grew to 456px and kept a horizontal scrollbar: any slightly diagonal vertical
 * swipe slid every row sideways while the sheet itself stayed put.
 *
 * This is a real-browser CSS fixture, not the React picker. The markup mirrors
 * the upstream `_surface_ri079_*` / `_7KE1Ra_*` structure observed in the live
 * app, and the stylesheet is read from `client.js` itself, so the assertions
 * measure the shipped rules. The scaffold only supplies what the plugin does
 * not own: the fixed sheet, the list's scroll box and the button's own
 * shrink-to-fit width.
 *
 * It uses the existing DevTools endpoint, opens its own blank target and closes
 * it again; no user tab, profile or session is touched, and Browser.close is
 * never sent. When no endpoint is reachable the browser tests skip instead of
 * failing a contributor without Chrome.
 *
 * Not verified here: iOS Safari's own touch heuristics or a real device.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const CDP = process.env.CDP_URL || "http://127.0.0.1:9222";
const CLIENT = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const LONG_PATH = "/home/ryu/llama-models/nanbeige43/Nanbeige4.3-33B-AWQ";

/** Extract the shipped stylesheets; the phone half keeps its width query. */
function shippedStylesheet(source) {
	const narrowMatch = source.match(/const NARROW_QUERY = "([^"]+)"/);
	const narrow = narrowMatch === null ? "(max-width: 767px)" : narrowMatch[1];
	const resolve = (css) => css
		.replace(/\$\{NARROW_QUERY\}/g, narrow)
		.replace(/\$\{RIGHT_PANEL_EXIT\}/g, '[data-rdsh-rightpanel] [aria-label="Exit fullscreen"]')
		.replace(/\$\{RIGHT_PANEL_SPLIT\}/g, '[data-rdsh-rightpanel] [aria-label="Split"]');
	const blocks = [];
	for (const match of source.matchAll(/const CSS = `([\s\S]*?)`;(?:\r?\n|$)/g)) {
		const css = match[1];
		if (!css.includes("{") || /^\s*\$\{/.test(css)) continue;
		blocks.push(resolve(css));
	}
	const device = source.match(/const CSS_DEVICE = `([\s\S]*?)`;(?:\r?\n|$)/);
	const phone = source.match(/const CSS_PHONE = `([\s\S]*?)`;(?:\r?\n|$)/);
	if (device !== null && phone !== null) {
		blocks.push(resolve(device[1]));
		blocks.push(`@media ${narrow} {\n${resolve(phone[1])}\n}`);
	}
	assert.ok(blocks.length >= 2, "the shipped stylesheets are missing");
	const css = blocks.join("\n");
	assert.equal(css.includes("${"), false, "an uninterpolated template token reached the fixture");
	return css;
}

const SHIPPED_STYLESHEET = shippedStylesheet(CLIENT);

test("#84 the shipped phone stylesheet caps a model row and locks the list to pan-y", () => {
	assert.match(
		SHIPPED_STYLESHEET,
		/\[data-rdsh-model-menu\] \[class\*="_option"\] \{[^}]*max-width: 100%/,
		"a model row can still grow past the list",
	);
	assert.match(
		SHIPPED_STYLESHEET,
		/\[data-rdsh-model-menu\] \[class\*="_groups"\] \{[^}]*overflow-x: hidden/,
		"the picker list can still scroll sideways",
	);
	assert.match(
		SHIPPED_STYLESHEET,
		/\[data-rdsh-model-menu\] \[class\*="_groups"\] \{[^}]*touch-action: pan-y/,
		"the picker list still accepts horizontal touch panning",
	);
});

/** The slice of upstream layout the picker needs, copied from the live rules. */
const UPSTREAM_SCAFFOLD = `
html, body { margin: 0; height: 100%; background: #111; color: #eee; font-family: sans-serif; }
*, *::before, *::after { box-sizing: border-box; }
._surface_ri079_1 { position: fixed; top: 100px; left: 12px; width: 358px; min-width: 240px; max-width: 358px;
  height: 360px; max-height: 360px; padding: 4px; display: flex; flex-direction: column; overflow: hidden;
  border-radius: 16px; background: #242428; }
._material_ri079_21 { position: absolute; inset: 0; pointer-events: none; }
._7KE1Ra_searchRow { position: relative; flex: 0 0 auto; height: 28px; margin: 2px 0 3px; }
._7KE1Ra_searchRow input { width: 100%; height: 28px; border: 0; border-radius: 8px; padding: 0 7px;
  background: #303035; color: inherit; font: inherit; font-size: 16px; }
._7KE1Ra_groups { display: block; width: 100%; height: 314px; overflow: auto; }
._7KE1Ra_group { display: block; }
._7KE1Ra_option { display: flex; align-items: center; gap: 6px; width: auto; min-width: 100%;
  padding: 5px 7px; border: 0; background: none; color: inherit; font: inherit; text-align: left; }
._7KE1Ra_optionCopy { display: flex; flex-direction: column; flex: 1 1 0%; min-width: 0; }
._7KE1Ra_modelName { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  font-size: 13px; line-height: 18px; }
._7KE1Ra_check { flex: 0 0 14px; width: 14px; height: 14px; }
`;

/** One long local-model path plus enough short rows to scroll vertically. */
const ROWS = [LONG_PATH, "DeepSeek V4.1 Flash", "Kimi K3", "GPT-6.1 Terra", "Daybreak Blue",
	"orchestrator", "DeepSeek V4.1 Flash (latest)", "nanbige", "GPT-5.6 Sol", "K2.8 Preview",
	"K3.1 Pro", "GPT-6 Sol", "GPT-6 Luna", "GPT-6 Astra", "GPT-5.6 Luna", "GPT-5.5",
	"K2.7 Code Highspeed", "Kimi K3-256K"];

function fixtureHtml() {
	const rows = ROWS.map((name, index) => `<button type="button" class="_7KE1Ra_option _7KE1Ra_modelOption">
      <span class="_7KE1Ra_optionCopy"><span class="_7KE1Ra_modelName">${name}</span></span>
      <span class="_7KE1Ra_check">${index === 0 ? "✓" : ""}</span></button>`).join("\n");
	return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${UPSTREAM_SCAFFOLD}${SHIPPED_STYLESHEET}</style></head>
<body><div class="_surface_ri079_1 _7KE1Ra_menu" role="group" data-rdsh-model-menu style="left: 12px; top: 100px">
  <div class="_material_ri079_21"></div>
  <div class="_7KE1Ra_searchRow"><input type="search" disabled placeholder="モデルを検索…"></div>
  <div class="_7KE1Ra_groups scrollable" role="menu"><section class="_7KE1Ra_group">
${rows}
  </section></div>
</div></body></html>`;
}

// ---------------------------------------------------------------------------
// Minimal CDP client (its own target, closed afterwards; never Browser.close)
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function cdpReachable() {
	try {
		const response = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1000) });
		return response.ok;
	} catch {
		return false;
	}
}

class Page {
	constructor(socket, target) {
		this.socket = socket;
		this.target = target;
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

	static async open() {
		const response = await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" });
		assert.ok(response.ok, `could not create a DevTools target (${response.status})`);
		const target = await response.json();
		const socket = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise((resolve, reject) => {
			socket.onopen = resolve;
			socket.onerror = reject;
		});
		const page = new Page(socket, target);
		await page.send("Page.enable");
		await page.send("Runtime.enable");
		return page;
	}

	send(method, params = {}) {
		const id = ++this.id;
		this.socket.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
	}

	async eval(expression) {
		const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (result.exceptionDetails) {
			throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "evaluation failed");
		}
		return result.result.value;
	}

	async load(width) {
		await this.send("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 3, mobile: true });
		await this.send("Page.navigate", {
			url: `data:text/html;base64,${Buffer.from(fixtureHtml()).toString("base64")}`,
		});
		await sleep(400);
	}

	/** Drag a finger; touch scrolling needs real input, not synthetic events. */
	async swipe(x0, y0, x1, y1, steps = 8) {
		await this.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y: y0 }] });
		for (let step = 1; step <= steps; step++) {
			await this.send("Input.dispatchTouchEvent", {
				type: "touchMove",
				touchPoints: [{ x: x0 + ((x1 - x0) * step) / steps, y: y0 + ((y1 - y0) * step) / steps }],
			});
			await sleep(16);
		}
		await this.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		await sleep(400);
	}

	async close() {
		try {
			this.socket.close();
		} catch {
			/* already gone */
		}
		await fetch(`${CDP}/json/close/${this.target.id}`).catch(() => {});
	}
}

const MEASURE = `(() => {
  const round = (value) => Math.round(value * 10) / 10;
  const surface = document.querySelector("[data-rdsh-model-menu]");
  const groups = surface.querySelector('[class*="_groups"]');
  const surfaceRect = surface.getBoundingClientRect();
  const groupStyle = getComputedStyle(groups);
  return {
    viewport: innerWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    surface: { left: round(surfaceRect.left), right: round(surfaceRect.right), width: round(surfaceRect.width) },
    groups: { scrollWidth: groups.scrollWidth, clientWidth: groups.clientWidth,
      scrollLeft: groups.scrollLeft, scrollTop: groups.scrollTop,
      overflowX: groupStyle.overflowX, touchAction: groupStyle.touchAction,
      overscrollBehaviorX: groupStyle.overscrollBehaviorX },
    rows: [...surface.querySelectorAll('[class*="_option"]')].map((row) => round(row.getBoundingClientRect().width)),
  };
})()`;

const reachable = await cdpReachable();
const skip = reachable ? false : `no Chrome DevTools endpoint at ${CDP}`;
const browserTest = (name, fn) => test(name, { skip }, fn);

async function measureAt(width) {
	const page = await Page.open();
	try {
		await page.load(width);
		const measured = await page.eval(MEASURE);
		// A horizontal thumb swipe: the list used to follow it to 111px.
		await page.swipe(200, 300, 60, 300);
		const afterHorizontal = await page.eval(MEASURE);
		await page.eval(`(() => { const groups = document.querySelector('[data-rdsh-model-menu] [class*="_groups"]'); groups.scrollTo({ left: 0, top: 0 }); })()`);
		await sleep(100);
		// A diagonal vertical scroll, the gesture that dragged the rows sideways.
		await page.swipe(200, 400, 120, 260);
		const afterDiagonal = await page.eval(MEASURE);
		return { measured, afterHorizontal, afterDiagonal };
	} finally {
		await page.close();
	}
}

function assertPickerGeometry({ measured, afterHorizontal, afterDiagonal }, width) {
	assert.equal(measured.viewport, width, "the viewport override did not apply");
	assert.ok(measured.documentScrollWidth <= width, `the page scrolls sideways (${measured.documentScrollWidth} > ${width})`);
	assert.ok(measured.surface.left >= 0, `the sheet starts off-screen (${measured.surface.left})`);
	assert.ok(measured.surface.right <= width, `the sheet ends off-screen (${measured.surface.right} > ${width})`);
	assert.equal(measured.groups.scrollWidth, measured.groups.clientWidth, "the picker list is wider than its box");
	assert.equal(measured.groups.overflowX, "hidden", "the picker list still accepts horizontal overflow");
	assert.equal(measured.groups.touchAction, "pan-y", "the picker list still accepts horizontal touch panning");
	assert.equal(measured.groups.overscrollBehaviorX, "none", "the picker list still chains horizontal overscroll");
	for (const row of measured.rows) {
		assert.ok(row <= measured.groups.clientWidth, `a model row is ${row}px wide in a ${measured.groups.clientWidth}px list`);
	}
	assert.equal(afterHorizontal.groups.scrollLeft, 0, "a horizontal swipe still scrolls the picker list");
	assert.equal(afterHorizontal.groups.scrollTop, 0, "a horizontal swipe moved the list vertically");
	assert.equal(afterDiagonal.groups.scrollLeft, 0, "a diagonal vertical scroll still slides the rows sideways");
	assert.ok(afterDiagonal.groups.scrollTop > 0, "vertical scrolling stopped working");
}

for (const width of [390, 320]) {
	browserTest(`#84 the picker stays inside a ${width}px phone and scrolls only vertically`, async () => {
		assertPickerGeometry(await measureAt(width), width);
	});
}
