/**
 * Real-browser regression fixture for the agent question / plan-review card.
 *
 * Issue #26 could not be verified against the live app without a DSH server,
 * so this test renders the card in an actual Chrome and measures the layout
 * the plugin CSS produces. It is a *CSS fixture*, not the React card: the
 * markup mirrors the upstream `Mbwy4a_*` structure (observed in the live app
 * during the 2026-10-24 parity work) and the stylesheet is read from
 * `client.js` itself, so a change to the shipped rules is what the assertions
 * see. The reduced upstream styles at the top of the fixture only provide the
 * layout primitives the plugin does not own (flex frame, card max-width,
 * `optionCopy { min-width: 0 }`, the grid answer field).
 *
 * It uses the existing DevTools endpoint, opens its own blank target and
 * closes it again; no user tab, profile or session is touched. When no
 * endpoint is reachable the tests skip instead of failing a contributor
 * without Chrome.
 *
 * Verified here: 390px and 320px gutters, long unbroken tokens wrapping,
 * 16px answer fields, footer containment, and the plan-review variant. Not
 * verified: iOS Safari's actual focus zoom, the React card, or a device.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const CDP = process.env.CDP_URL || "http://127.0.0.1:9222";
const CLIENT = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const LONG_TOKEN = `https://example.invalid/${"a".repeat(96)}`;

/**
 * Extract the shipped stylesheets from either client layout.
 *
 * Before the #44 foundation split, `client.js` had two `const CSS = \`…\``
 * literals. The foundation build instead declares `CSS_DEVICE` and
 * `CSS_PHONE` and composes them with `phoneStyles()` into a `CSS` alias that
 * contains no rules itself. Read the real declarations in both shapes rather
 * than tying this fixture to one spelling: the question-card rules must stay
 * covered across that refactor.
 *
 * @param {string} source - `client.js` contents.
 * @returns {string} CSS with the phone query resolved to a real media rule.
 */
function shippedStylesheet(source) {
	const narrowMatch = source.match(/const NARROW_QUERY = "([^"]+)"/);
	const narrow = narrowMatch === null ? "(max-width: 767px)" : narrowMatch[1];
	const resolve = (css) => css
		.replace(/\$\{NARROW_QUERY\}/g, narrow)
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
		// The foundation's `CSS` alias is only `${CSS_DEVICE}\n${phoneStyles(...)}`.
		// Skip that composition; the two constants below carry the rules.
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

test("the stylesheet extractor understands the old and foundation client layouts", () => {
	const oldStyle = [
		'const NARROW_QUERY = "(max-width: 767px)";',
		"const CSS = `",
		".shell { color: red; }",
		"`;",
		"const CSS = `",
		"@media ${NARROW_QUERY} {",
		".phone { color: green; }",
		"}",
		"`;",
	].join("\n");
	const old = shippedStylesheet(oldStyle);
	assert.match(old, /\.shell \{ color: red; \}/, "the shell stylesheet was dropped");
	assert.match(old, /@media \(max-width: 767px\) \{/, "the old phone query was not resolved");
	assert.match(old, /\.phone \{ color: green; \}/, "the old phone stylesheet was dropped");

	// #44 splits the layout sheet into CSS_DEVICE / CSS_PHONE and composes an
	// alias with phoneStyles(). The alias has no rules of its own, so reading
	// only `const CSS =` would silently feed the fixture no layout at all.
	const foundationStyle = [
		'const NARROW_QUERY = "(max-width: 767px)";',
		"const CSS = `",
		".shell { color: red; }",
		"`;",
		"const CSS_DEVICE = `",
		".device { color: blue; }",
		"`;",
		"const CSS_PHONE = `",
		".phone { color: green; }",
		"`;",
		"const phoneStyles = (css) => `@media ${NARROW_QUERY} {\\n${css}\\n}`;",
		"const CSS = `${CSS_DEVICE}\\n${phoneStyles(CSS_PHONE)}`;",
	].join("\n");
	const foundation = shippedStylesheet(foundationStyle);
	assert.match(foundation, /\.shell \{ color: red; \}/, "the foundation shell stylesheet was dropped");
	assert.match(foundation, /\.device \{ color: blue; \}/, "CSS_DEVICE was not read");
	assert.match(foundation, /@media \(max-width: 767px\) \{/, "CSS_PHONE was not wrapped in the phone query");
	assert.match(foundation, /\.phone \{ color: green; \}/, "CSS_PHONE was not read");
	assert.doesNotMatch(foundation, /\$\{CSS_DEVICE\}/, "the composition alias leaked into the fixture");
	assert.equal(foundation.includes("${"), false, "an uninterpolated token reached the fixture");

	// Whichever layout the file currently uses, the fixture must still contain
	// the question-card rules it measures.
	assert.match(SHIPPED_STYLESHEET, /\[data-rdsh-question-frame\] \{/, "the real question frame rule is missing");
	assert.match(
		SHIPPED_STYLESHEET,
		/\[data-rdsh-question-frame\] > \[data-rdsh-question-card\]/,
		"the real question card rule is missing",
	);
});
/**
 * The small slice of upstream card CSS the layout needs. Copied from the live
 * `Mbwy4a_*` rules; deliberately not the whole upstream stylesheet.
 */
const UPSTREAM_SCAFFOLD = `
:root { --dsh-chat-content-width: 349px; --dsh-composer-side-clearance: 0px; }
html, body { margin: 0; padding: 0; background: #111; }
.Mbwy4a_frame { padding: 6px calc(var(--dsh-composer-side-clearance) + 16px) 10px; justify-content: center; display: flex; }
.Mbwy4a_card { width: 100%; max-width: var(--dsh-chat-content-width); border-radius: 20px; background: #222; color: #eee;
  max-height: min(60vh, 520px); flex-direction: column; padding: 0 0 10px; display: flex; overflow: hidden; box-sizing: border-box; }
.Mbwy4a_card, .Mbwy4a_card * { box-sizing: border-box; }
.Mbwy4a_header { flex-shrink: 0; justify-content: space-between; align-items: flex-start; gap: 16px;
  padding: 20px 16px 0 24px; display: flex; }
.Mbwy4a_headingBlock { min-width: 0; }
.Mbwy4a_title { margin: 0; font-size: 16px; font-weight: 500; line-height: 22px; }
.Mbwy4a_body { overscroll-behavior: contain; flex-direction: column; flex: auto; min-height: 0; display: flex; overflow-y: auto; }
.Mbwy4a_options { flex-direction: column; gap: 1px; margin: 8px 0 0; padding: 4px 12px; display: flex; }
.Mbwy4a_option { border-radius: 8px; width: 100%; min-height: 40px; color: inherit; text-align: left; background: 0 0;
  border: 1px solid transparent; flex-shrink: 0; align-items: flex-start; gap: 8px; padding: 8px 12px 8px 8px; display: flex; font: inherit; }
.Mbwy4a_optionCopy { flex: 1; min-width: 0; }
.Mbwy4a_optionLine { flex-wrap: wrap; align-items: baseline; gap: 2px 6px; display: flex; }
.Mbwy4a_optionLabel { font-size: 14px; font-weight: 500; line-height: 24px; }
.Mbwy4a_description { color: #aaa; font-size: 14px; font-weight: 400; line-height: 24px; }
.Mbwy4a_customRow { border-radius: 8px; border: 1px solid transparent; flex-shrink: 0; align-items: flex-start; gap: 8px;
  width: 100%; min-height: 40px; padding: 8px 12px 8px 8px; display: flex; }
.Mbwy4a_customInline { flex: 1; }
.Mbwy4a_customBlock { border: .5px solid #444; border-radius: 12px; flex-shrink: 0; min-height: 64px; margin: 0 12px; --dsh-answer-field-padding: 8px 12px; }
.Mbwy4a_field { --dsh-answer-field-padding: 0; min-width: 0; display: grid; }
.Mbwy4a_field > * { min-width: 0; padding: var(--dsh-answer-field-padding); font: inherit; white-space: pre-wrap;
  word-break: break-word; overflow-wrap: anywhere; grid-area: 1 / 1; font-size: 14px; line-height: 24px; }
.Mbwy4a_fieldMirror { box-sizing: content-box; visibility: hidden; max-height: 144px; overflow: hidden; }
.Mbwy4a_fieldInput { resize: none; color: #eee; background: 0 0; border: none; outline: none; overflow-y: auto; }
.Mbwy4a_footer { flex-shrink: 0; justify-content: space-between; align-items: center; gap: 12px; margin-top: 12px; padding: 0 10px 0 18px; display: flex; }
.Mbwy4a_footerActions { flex-shrink: 0; align-items: center; gap: 12px; display: flex; }
.Mbwy4a_strip { padding: 10px 12px; }
.Mbwy4a_summary { padding: 12px 16px; }
.Mbwy4a_reviewNote { color: #aaa; margin: 0; padding: 8px 12px; font-size: 14px; line-height: 24px; }
`;

/** One card; `plan` adds the review strip/summary the plan-review card uses. */
function card({ plan = false, typing = false } = {}) {
	return `<div class="Mbwy4a_frame" data-rdsh-question-frame>
  <div class="Mbwy4a_card" data-rdsh-question-card${typing ? ' data-rdsh-question-typing=""' : ""}>
    <div class="Mbwy4a_header">
      <div class="Mbwy4a_headingBlock"><div class="Mbwy4a_title">${LONG_TOKEN}</div></div>
      <div class="Mbwy4a_headerActions"><button class="Mbwy4a_iconButton" aria-label="Collapse the question card">x</button></div>
    </div>
    <div class="Mbwy4a_body">
      ${plan ? `<div class="Mbwy4a_strip"><p class="Mbwy4a_reviewNote">Plan review</p></div>
      <div class="Mbwy4a_summary"><p class="Mbwy4a_description">${LONG_TOKEN}</p></div>` : ""}
      <div class="Mbwy4a_options">
        <button class="Mbwy4a_option"><span class="Mbwy4a_number">1</span><span class="Mbwy4a_optionCopy">
          <span class="Mbwy4a_optionLine"><span class="Mbwy4a_optionLabel">${LONG_TOKEN}</span></span>
          <span class="Mbwy4a_description">${LONG_TOKEN}</span>
        </span></button>
        <div class="Mbwy4a_customRow"><div class="Mbwy4a_customInline"><div class="Mbwy4a_customBlock">
          <div class="Mbwy4a_field"><div class="Mbwy4a_fieldMirror">${LONG_TOKEN}</div><textarea class="Mbwy4a_fieldInput" rows="2"></textarea></div>
        </div></div></div>
      </div>
    </div>
    <div class="Mbwy4a_footer"><span class="Mbwy4a_feedback"></span>
      <div class="Mbwy4a_footerActions"><button>Skip</button><button>Continue</button></div></div>
  </div>
</div>`;
}

function fixtureHtml({ typing = false } = {}) {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${UPSTREAM_SCAFFOLD}${SHIPPED_STYLESHEET}</style></head>
<body>${card({ typing })}${card({ plan: true })}</body></html>`;
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

	async load(width, height = 844, options = {}) {
		await this.send("Emulation.setDeviceMetricsOverride", {
			width,
			height,
			deviceScaleFactor: 3,
			mobile: width < 768,
		});
		await this.send("Page.navigate", {
			url: `data:text/html;base64,${Buffer.from(fixtureHtml(options)).toString("base64")}`,
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

/** The measurements every card assertion works from. */
const MEASURE = `(() => {
  const round = (value) => Math.round(value * 10) / 10;
  const cards = [...document.querySelectorAll("[data-rdsh-question-card]")];
  return {
    viewport: innerWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    cards: cards.map((card) => {
      const frame = card.closest("[data-rdsh-question-frame]");
      const rect = card.getBoundingClientRect();
      const frameRect = frame.getBoundingClientRect();
      const frameStyle = getComputedStyle(frame);
      const cardStyle = getComputedStyle(card);
      const field = card.querySelector('[class*="_field"]');
      const textarea = field === null ? null : field.querySelector("textarea");
      const mirror = field === null ? null : field.firstElementChild;
      const header = card.querySelector('[class*="_header"]');
      const footer = card.querySelector('[class*="_footer"]');
      const long = [...card.querySelectorAll('[class*="_optionLabel"], [class*="_title"], [class*="_description"]')];
      return {
        frame: { x: round(frameRect.x), width: round(frameRect.width),
          paddingLeft: round(parseFloat(frameStyle.paddingLeft)), paddingRight: round(parseFloat(frameStyle.paddingRight)) },
        card: { x: round(rect.x), width: round(rect.width), right: round(rect.right),
          marginLeft: round(parseFloat(cardStyle.marginLeft)), marginRight: round(parseFloat(cardStyle.marginRight)),
          scrollWidth: card.scrollWidth, clientWidth: card.clientWidth },
        headerPaddingLeft: header === null ? null : round(parseFloat(getComputedStyle(header).paddingLeft)),
        footerPaddingTop: footer === null ? null : round(parseFloat(getComputedStyle(footer).paddingTop)),
        footerRight: footer === null ? null : round(footer.getBoundingClientRect().right),
        fieldFontSize: textarea === null ? null : round(parseFloat(getComputedStyle(textarea).fontSize)),
        mirrorFontSize: mirror === null ? null : round(parseFloat(getComputedStyle(mirror).fontSize)),
        labels: long.map((element) => ({ width: round(element.getBoundingClientRect().width),
          height: round(element.getBoundingClientRect().height) })),
      };
    }),
  };
})()`;

const reachable = await cdpReachable();
const skip = reachable ? false : `no Chrome DevTools endpoint at ${CDP}`;
const browserTest = (name, fn) => test(name, { skip }, fn);

/** Open the fixture at one width, hand the measurements to the assertions. */
async function measureAt(width) {
	const page = await Page.open();
	try {
		await page.load(width);
		return await page.eval(MEASURE);
	} finally {
		await page.close();
	}
}

/** Assertions shared by the 390px and 320px runs. */
function assertPhoneGeometry(measured, width) {
	assert.equal(measured.viewport, width, "the viewport override did not apply");
	assert.ok(measured.documentScrollWidth <= width, `the page scrolls sideways (${measured.documentScrollWidth} > ${width})`);
	assert.equal(measured.cards.length, 2, "the question and plan-review cards did not both render");

	for (const [index, card] of measured.cards.entries()) {
		const label = index === 0 ? "question" : "plan-review";
		assert.equal(card.card.x, 16, `${label}: left gutter is not 16px (${card.card.x})`);
		assert.equal(card.card.right, width - 16, `${label}: right gutter is not 16px (${width - card.card.right})`);
		assert.equal(card.card.width, width - 32, `${label}: card is not viewport - 32px (${card.card.width})`);
		assert.equal(card.frame.paddingLeft, 16, `${label}: frame left padding is not 16px`);
		assert.equal(card.frame.paddingRight, 16, `${label}: frame right padding is not 16px`);
		assert.equal(card.card.marginLeft, 0, `${label}: the card is not flush with the frame gutter`);
		assert.equal(card.card.marginRight, 0, `${label}: the card is not flush with the frame gutter`);
		assert.equal(card.headerPaddingLeft, 16, `${label}: the header lost its 16px inset`);
		assert.equal(card.footerPaddingTop, 8, `${label}: the footer lost its 8px inset`);
		assert.ok(card.footerRight <= card.card.right + 0.5, `${label}: the footer overflows the card`);
		assert.ok(card.card.scrollWidth <= card.card.clientWidth, `${label}: the card scrolls sideways with a long token`);
		assert.ok(card.fieldFontSize >= 16, `${label}: the answer field is below 16px (${card.fieldFontSize}px)`);
		assert.ok(card.mirrorFontSize >= 16, `${label}: the answer mirror is below 16px and will resize under the field`);
		for (const [position, element] of card.labels.entries()) {
			assert.ok(element.width <= card.card.width, `${label}: long token ${position} is wider than the card`);
			assert.ok(element.height > 24, `${label}: long token ${position} did not wrap`);
		}
	}
}

browserTest("real browser: selected choices use the session glow and custom text shares it", async () => {
  const page = await Page.open();
  try {
    await page.load(390);
    const measured = await page.eval(`(() => {
      const options = [...document.querySelectorAll(".Mbwy4a_option")];
      options[0].setAttribute("data-rdsh-question-tile", "");
      options[0].setAttribute("role", "radio");
      options[0].setAttribute("aria-checked", "true");
      options[1].setAttribute("data-rdsh-question-tile", "");
      options[1].setAttribute("role", "checkbox");
      options[1].setAttribute("aria-checked", "true");
      const custom = document.querySelector(".Mbwy4a_customRow");
      custom.setAttribute("data-rdsh-question-tile", "");
      custom.classList.add("Mbwy4a_customRowActive");
      return [options[0], options[1], custom].map((node) => {
        const style = getComputedStyle(node);
        return { background: style.backgroundImage, animation: style.animationName, border: style.borderTopWidth };
      });
    })()`);
    for (const style of measured) {
      assert.match(style.background, /conic-gradient/, "the session glow was not reused");
      assert.equal(style.animation, "rdsh-question-glow");
      assert.equal(style.border, "2px");
    }
  } finally { await page.close(); }
});

browserTest("real browser: question and plan-review cards keep 16px gutters and wrap long tokens at 390px", async () => {
	assertPhoneGeometry(await measureAt(390), 390);
});

browserTest("real browser: the same card fits a 320px phone without horizontal overflow", async () => {
	assertPhoneGeometry(await measureAt(320), 320);
});

browserTest("real browser: the viewport-wide card is phone-only", async () => {
	const measured = await measureAt(1024);
	assert.equal(measured.viewport, 1024);
	for (const card of measured.cards) {
		assert.ok(card.card.width <= 349.5, `a desktop card grew to ${card.card.width}px`);
		assert.ok(card.fieldFontSize < 16, "the 16px answer field leaked out of the phone query");
	}
});

/**
 * The card's answer field is the only part the user needs while typing, so the
 * keyboard-height measurement records whether it is still inside the card's
 * scroll body and above the fold.
 */
const MEASURE_ANSWER = `(() => {
  const round = (value) => Math.round(value * 10) / 10;
  const card = document.querySelector("[data-rdsh-question-card][data-rdsh-question-typing]")
    ?? document.querySelector("[data-rdsh-question-card]");
  const body = card.querySelector('[class*="_body"]');
  const field = card.querySelector("textarea");
  const cardRect = card.getBoundingClientRect();
  const bodyRect = body.getBoundingClientRect();
  const fieldRect = field.getBoundingClientRect();
  return {
    vh: innerHeight,
    typing: card.hasAttribute("data-rdsh-question-typing"),
    cardH: round(cardRect.height),
    bodyH: round(bodyRect.height),
    fieldBottom: round(fieldRect.bottom),
    bodyBottom: round(bodyRect.bottom),
    maxHeight: getComputedStyle(card).maxHeight,
  };
})()`;

/** Load one card at a phone/keyboard geometry and measure the answer field. */
async function measureAnswer(width, height, typing) {
	const page = await Page.open();
	try {
		await page.load(width, height, { typing });
		return await page.eval(MEASURE_ANSWER);
	} finally {
		await page.close();
	}
}

browserTest("real browser: a focused answer field keeps the card open at the keyboard height", async () => {
	const typing = await measureAnswer(390, 400, true);
	assert.equal(typing.vh, 400, "the keyboard-height viewport did not apply");
	assert.equal(typing.typing, true, "the typing hook is missing");
	assert.equal(typing.maxHeight, "372px", "the 60vh cap still applies while typing");
	assert.ok(typing.cardH > 280, `the card collapsed while typing (${typing.cardH}px)`);
	assert.ok(typing.bodyH > 140, `the card body collapsed while typing (${typing.bodyH}px)`);
	// The body is the scrollport; the shipped JS scrolls this field into it.
	assert.ok(typing.cardH <= typing.vh, "the typing card is taller than the visible viewport");

	// Without the hook, upstream's 60vh cap is still what ships.
	const capped = await measureAnswer(390, 400, false);
	assert.equal(capped.maxHeight, "240px", "upstream's cap changed without the typing hook");
	assert.ok(capped.cardH <= 241, `the untyped card grew to ${capped.cardH}px`);
	assert.ok(capped.fieldBottom > capped.bodyBottom, "the fixture no longer reproduces the clipped field");
});

browserTest("real browser: a 200px keyboard height still leaves the card body usable", async () => {
	const typing = await measureAnswer(390, 200, true);
	assert.equal(typing.maxHeight, "172px", "the visible-height cap did not apply at 200px");
	assert.ok(typing.cardH >= 160, `the 200px card collapsed to ${typing.cardH}px`);

	const capped = await measureAnswer(390, 200, false);
	assert.equal(capped.maxHeight, "120px", "upstream's 60vh cap changed without the typing hook");
	assert.ok(capped.bodyH <= 40, `the untyped 200px body is not the collapsed original (${capped.bodyH}px)`);
	assert.ok(typing.bodyH > capped.bodyH, `the typing hook bought no body height (${typing.bodyH} vs ${capped.bodyH})`);
});
