/**
 * Real-browser regression fixture for the Settings > Models "Add provider"
 * tabs (#100).
 *
 * On a phone the settings modal is narrow, the second-level tab strip inside
 * "Add model provider" is a SegmentedControl whose tabs are `white-space:
 * nowrap`, and the panel has no scroller of its own. A long Japanese label
 * therefore widened the strip past the card, and the phone stylesheet's
 * `overflow-x: hidden` left the second tab unreachable.
 *
 * This is a CSS fixture, not the React screen: the markup mirrors the upstream
 * `VOzbGW_*` / `zGbnIq_*` / `_control_d62eq_*` structure and the stylesheet is
 * read from `client.js` itself, so the assertions see the shipped rules. The
 * scaffold at the top only provides what the plugin does not own (the panel's
 * scroll container, the card, and the primitive's nowrap tab).
 *
 * It uses the existing DevTools endpoint, opens its own blank target and closes
 * it again. When no endpoint is reachable the tests skip instead of failing a
 * contributor without Chrome.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const CDP = process.env.CDP_URL || "http://127.0.0.1:9222";
const CLIENT = readFileSync(new URL("../client.js", import.meta.url), "utf8");

/**
 * Extract the shipped stylesheets from either client layout.
 *
 * Mirrors `question-card.browser.test.mjs`: the pre-#44 file has one `CSS`
 * literal, the foundation build has `CSS_DEVICE` / `CSS_PHONE` and a `CSS`
 * alias with no rules of its own. The phone half has no width wrapper in this
 * client (it is only applied for a mobile device), so it is used as-is.
 */
function shippedStylesheet(source) {
	const resolve = (css) => css
		.replace(
			/\$\{RIGHT_PANEL_EXIT\}/g,
			'[data-rdsh-rightpanel] [aria-label="Exit fullscreen"], [data-rdsh-rightpanel] [aria-label="全画面表示を終了"]',
		)
		.replace(
			/\$\{RIGHT_PANEL_SPLIT\}/g,
			'[data-rdsh-rightpanel] [aria-label="Split"], [data-rdsh-rightpanel] [aria-label="分割"]',
		);
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
		blocks.push(resolve(phone[1]));
	}
	assert.ok(blocks.length >= 2, "the shipped stylesheets are missing");
	const css = blocks.join("\n");
	assert.equal(css.includes("${"), false, "an uninterpolated template token reached the fixture");
	return css;
}

const SHIPPED_STYLESHEET = shippedStylesheet(CLIENT);

test("the shipped stylesheet carries the #100 tab rules", () => {
	assert.match(
		SHIPPED_STYLESHEET,
		/\[class\*="zGbnIq_addModes"\] > \[role="tablist"\] \{[^}]*grid-auto-columns: minmax\(0, 1fr\)/,
		"the tab strip is no longer allowed to shrink below its labels",
	);
	assert.match(
		SHIPPED_STYLESHEET,
		/\[class\*="zGbnIq_addModes"\] > \[role="tablist"\] > \[role="tab"\] \{[^}]*white-space: normal/,
		"the tabs still refuse to wrap",
	);
});

/**
 * The slice of upstream CSS the layout needs, copied from the live rules
 * (`_control_d62eq_11`, `_tab_d62eq_37`, `VOzbGW_options`, `zGbnIq_addCard`).
 */
const UPSTREAM_SCAFFOLD = `
html, body { margin: 0; height: 100%; background: #111; color: #eee; font-family: sans-serif; font-size: 14px; }
*, *::before, *::after { box-sizing: border-box; }
[data-shortcut-modal="settings"] { display: flex; flex-direction: column; width: 100%; height: 100%; }
[data-shortcut-modal="settings"] > nav { flex: none; display: flex; gap: 8px; padding: 16px 12px 10px; }
[data-shortcut-modal="settings"] > nav + div { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
.VOzbGW_options { flex: 1; min-height: 0; padding: 0 24px 24px; overflow-y: auto; }
.zGbnIq_section { max-width: 720px; flex-direction: column; gap: 12px; display: flex; }
.zGbnIq_addCard { border-radius: 12px; background: #1c1c1e; flex-direction: column; gap: 14px; padding: 14px 16px; list-style: none; display: flex; }
.zGbnIq_addModes { flex-direction: column; align-items: flex-start; gap: 8px; display: flex; }
._control_d62eq_11 { position: relative; display: inline-grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 2px; padding: 4px; border-radius: 8px; background: #2c2c2e; }
._indicator_d62eq_22 { position: absolute; top: 4px; left: 4px; width: calc((100% - 8px - 2px * (var(--dsh-segment-count) - 1)) / var(--dsh-segment-count)); height: calc(100% - 8px); border: 0; border-radius: 6px; background: #3a3a3c; box-shadow: 0 1px 2px rgba(0,0,0,.4); transform: translate(calc(var(--dsh-segment-index) * (100% + 2px))); pointer-events: none; }
._tab_d62eq_37 { box-sizing: border-box; position: relative; z-index: 1; height: 28px; padding: 0 16px; border: 0; border-radius: 6px; background: transparent; color: #aaa; font: inherit; font-size: 13px; line-height: 20px; font-weight: 500; white-space: nowrap; cursor: pointer; }
._tab_d62eq_37[aria-selected="true"] { color: #fff; }
`;

/** The labels the live ja/en locales render in the second-level tabs. */
const LABELS = {
	ja: ["サードパーティのモデルプロバイダー", "カスタムモデル API"],
	en: ["Third-party model provider", "Custom model API"],
};

function fixtureHtml(lang) {
	const [first, second] = LABELS[lang];
	return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${UPSTREAM_SCAFFOLD}${SHIPPED_STYLESHEET}</style></head>
<body><div data-shortcut-modal="settings">
  <nav><div>Models</div></nav>
  <div>
    <div class="VOzbGW_header"><span>Models</span></div>
    <div class="VOzbGW_options">
      <div class="zGbnIq_section">
        <div class="zGbnIq_addCard">
          <div class="zGbnIq_addModes">
            <div role="tablist" class="_control_d62eq_11" aria-label="Add provider type">
              <span class="_indicator_d62eq_22" style="--dsh-segment-count: 2; --dsh-segment-index: 0"></span>
              <button type="button" role="tab" class="_tab_d62eq_37" aria-selected="true">${first}</button>
              <button type="button" role="tab" class="_tab_d62eq_37" aria-selected="false">${second}</button>
            </div>
          </div>
        </div>
      </div>
      <div style="height: 1200px"></div>
    </div>
  </div>
</div></body></html>`;
}

// ---------------------------------------------------------------------------
// Minimal CDP client (its own target, closed afterwards)
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
		const result = await this.send("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
		});
		if (result.exceptionDetails) {
			throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "evaluation failed");
		}
		return result.result.value;
	}

	async load(width, lang) {
		const height = width >= 768 ? 390 : 844;
		await this.send("Emulation.setDeviceMetricsOverride", {
			width,
			height,
			deviceScaleFactor: 3,
			mobile: true,
		});
		await this.send("Page.navigate", {
			url: `data:text/html;base64,${Buffer.from(fixtureHtml(lang)).toString("base64")}`,
		});
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

/** The measurements every assertion works from. */
const MEASURE = `(() => {
  const round = (value) => Math.round(value * 10) / 10;
  const modal = document.querySelector('[data-shortcut-modal="settings"]');
  const options = modal.querySelector('[class*="VOzbGW_options"]');
  const optionsRect = options.getBoundingClientRect();
  const optionsStyle = getComputedStyle(options);
  const contentRight = optionsRect.left + options.clientWidth - parseFloat(optionsStyle.paddingRight);
  const tablist = modal.querySelector('[class*="zGbnIq_addModes"] > [role="tablist"]');
  const tablistRect = tablist.getBoundingClientRect();
  const tabs = [...tablist.querySelectorAll('[role="tab"]')].map((tab) => {
    const rect = tab.getBoundingClientRect();
    return {
      innerText: tab.innerText,
      x: round(rect.x), width: round(rect.width), right: round(rect.right), height: round(rect.height),
      scrollWidth: tab.scrollWidth, clientWidth: tab.clientWidth,
      scrollHeight: tab.scrollHeight, clientHeight: tab.clientHeight,
      whiteSpace: getComputedStyle(tab).whiteSpace,
    };
  });
  return {
    viewport: innerWidth,
    options: { scrollWidth: options.scrollWidth, clientWidth: options.clientWidth, overflowX: optionsStyle.overflowX },
    contentRight: round(contentRight),
    tablist: { x: round(tablistRect.x), width: round(tablistRect.width), right: round(tablistRect.right) },
    tabs,
  };
})()`;

const reachable = await cdpReachable();
const skip = reachable ? false : `no Chrome DevTools endpoint at ${CDP}`;
const browserTest = (name, fn) => test(name, { skip }, fn);

async function measureAt(width, lang) {
	const page = await Page.open();
	try {
		await page.load(width, lang);
		return await page.eval(MEASURE);
	} finally {
		await page.close();
	}
}

function assertTabsInside(measured, { width, lang }) {
	assert.equal(measured.viewport, width, "the viewport override did not apply");
	assert.equal(measured.options.overflowX, "hidden", "the panel's overflow-x guard is gone");
	assert.equal(measured.options.scrollWidth, measured.options.clientWidth, "the settings panel scrolls sideways");
	assert.ok(
		measured.tablist.right <= measured.contentRight + 0.5,
		`the tab strip overflows the card content (${measured.tablist.right} > ${measured.contentRight})`,
	);
	assert.equal(measured.tabs.length, 2, "the second-level tab strip lost a tab");
	for (const [index, tab] of measured.tabs.entries()) {
		assert.equal(tab.innerText.replace(/\s+/g, " ").trim(), LABELS[lang][index], `tab ${index} lost its label`);
		assert.ok(tab.scrollWidth <= tab.clientWidth + 1, `tab ${index} is clipped horizontally`);
		assert.ok(tab.scrollHeight <= tab.clientHeight + 1, `tab ${index} is clipped vertically`);
	}
}

browserTest("real browser: the Add-provider tabs stay inside the card at 390px in Japanese (#100)", async () => {
	const measured = await measureAt(390, "ja");
	assertTabsInside(measured, { width: 390, lang: "ja" });
	assert.ok(measured.tabs.every((tab) => tab.height > 28), "the long ja labels did not wrap onto a second line");
});

browserTest("real browser: the Add-provider tabs stay inside the card at 320px in Japanese (#100)", async () => {
	const measured = await measureAt(320, "ja");
	assertTabsInside(measured, { width: 320, lang: "ja" });
	assert.ok(measured.tabs.every((tab) => tab.height > 28), "the long ja labels did not wrap onto a second line");
});

browserTest("real browser: English labels do not regress at 390px", async () => {
	assertTabsInside(await measureAt(390, "en"), { width: 390, lang: "en" });
});

browserTest("real browser: the landscape tablet layout keeps the tabs inside the card", async () => {
	assertTabsInside(await measureAt(844, "ja"), { width: 844, lang: "ja" });
});
