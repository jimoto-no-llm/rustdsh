/**
 * The drawer toggle has to survive upstream labels being translated.
 *
 * Issue #77: the decorator already tagged the drag-header toggle structurally
 * under a localised label, but the hamburger action still looked for the
 * English stock label only, so opening the drawer silently did nothing. These
 * tests drive the real locator, decorator and drawer actions against a small
 * DOM double and pin the boundaries a shared locator needs: the decorator stays
 * inside the sidebar slot, re-derivation wins over a stale tag, the action
 * keeps its global stock fallback, and closing never clicks a control that
 * says "Open".
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");

/** The declaration from `function name(` through its own closing brace. */
function functionSource(name) {
	const at = source.indexOf(`    function ${name}(`);
	assert.ok(at >= 0, `${name} exists`);
	const end = source.indexOf("\n    }\n", at);
	assert.ok(end >= 0, `${name} is complete`);
	return source.slice(at, end + "\n    }".length);
}

const sidebarSource = functionSource("sidebarToggle");
const decorateSource = functionSource("decorateSidebarToggle");
const toggleSource = functionSource("toggleDrawer");
const closeSource = functionSource("closeDrawer");

// --------------------------------------------------------------------------
// A DOM double. Only the selectors these four functions use are understood.
// --------------------------------------------------------------------------

function element(tagName, attributes = {}) {
	const node = {
		tagName: tagName.toUpperCase(),
		children: [],
		clicks: 0,
		attributes: new Map(Object.entries(attributes)),
		getAttribute(name) {
			return this.attributes.has(name) ? this.attributes.get(name) : null;
		},
		setAttribute(name, value) {
			this.attributes.set(name, String(value));
		},
		removeAttribute(name) {
			this.attributes.delete(name);
		},
		hasAttribute(name) {
			return this.attributes.has(name);
		},
		append(...children) {
			for (const child of children) {
				child.parentNode = this;
				this.children.push(child);
			}
			return children[0] ?? null;
		},
		click() {
			this.clicks += 1;
		},
		querySelector(selector) {
			return query(this, selector, true);
		},
		querySelectorAll(selector) {
			return query(this, selector, false);
		},
	};
	return node;
}

function descendants(node) {
	const found = [];
	for (const child of node.children) found.push(child, ...descendants(child));
	return found;
}

function matches(node, selector) {
	const labelled = selector.match(/^button\[aria-label="([^"]*)"\]$/);
	if (labelled !== null) {
		return node.tagName === "BUTTON" && node.getAttribute("aria-label") === labelled[1];
	}
	if (selector === "button[aria-label]") {
		return node.tagName === "BUTTON" && node.hasAttribute("aria-label");
	}
	const attribute = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
	return attribute !== null
		&& node.hasAttribute(attribute[1])
		&& (attribute[2] === undefined || node.getAttribute(attribute[1]) === attribute[2]);
}

function query(root, selector, first) {
	const found = [];
	for (const part of selector.split(",")) {
		const alternative = part.trim();
		if (alternative === ":scope > svg") {
			found.push(...root.children.filter((child) => child.tagName === "SVG"));
			continue;
		}
		found.push(...descendants(root).filter((node) => matches(node, alternative)));
	}
	const unique = [...new Set(found)];
	return first ? unique[0] ?? null : unique;
}

/**
 * Run the four extracted functions against a body that may hold a sidebar and
 * same-labelled controls outside it.
 */
function load({ sidebar = null, globals = [], phone = true, frameElement = null } = {}) {
	const body = element("body");
	if (sidebar !== null) body.append(sidebar);
	for (const control of globals) body.append(control);
	const document = {
		documentElement: element("html"),
		querySelector(selector) {
			return body.querySelector(selector);
		},
		querySelectorAll(selector) {
			return body.querySelectorAll(selector);
		},
	};
	// #97: the locator reads its label vocabulary from PROBES (the host-injected
	// table) instead of hardcoding en/zh strings.
	const probes = {
		sidebarOpen: ["Open sidebar", "打开侧边栏", "サイドバーを開く"],
		sidebarCollapse: ["Collapse sidebar", "收起侧边栏", "サイドバーを折りたたむ"],
	};
	const context = {
		document,
		phone: () => phone,
		frame: () => frameElement,
		state: { drawerOpen: true },
		emit() {},
		scheduleDecorate() {},
		probeValues: (key, fallback) => (Array.isArray(probes[key]) ? probes[key] : fallback === undefined ? [] : [fallback]),
		ariaLabelSelector: (tag, key, fallback) => context.probeValues(key, fallback)
			.map((value) => `${tag}[aria-label="${String(value).replaceAll('"', '\\"')}"]`)
			.join(", "),
	};
	const api = vm.runInNewContext(
		`(() => {\n${sidebarSource}\n${decorateSource}\n${toggleSource}\n${closeSource}\nreturn { sidebarToggle, decorateSidebarToggle, toggleDrawer, closeDrawer };\n})()`,
		context,
	);
	return { ...api, document, body };
}

function button(label, { icon = false } = {}) {
	const node = element("button", { "aria-label": label });
	if (icon) node.append(element("svg"));
	return node;
}

function sidebar() {
	const root = element("div", { "data-slot": "sidebar" });
	const header = element("div", { "data-window-drag": "" });
	root.append(header);
	return { root, header };
}

// --------------------------------------------------------------------------
// Localised labels: the issue's actual failure mode.
// --------------------------------------------------------------------------

test("the real zh open label is decorated and clicked by the drawer action", () => {
	const { root, header } = sidebar();
	const toggle = button("打开侧边栏", { icon: true });
	header.append(toggle);
	const app = load({ sidebar: root });
	app.decorateSidebarToggle();
	assert.equal(toggle.hasAttribute("data-rdsh-sidebar-toggle"), true);
	app.toggleDrawer();
	assert.equal(toggle.clicks, 1, "the action did not click the decorated control");
	assert.equal(root.querySelectorAll("[data-rdsh-sidebar-toggle]").length, 1);
});

test("the real zh collapse label still works as the one drawer toggle", () => {
	const { root, header } = sidebar();
	const toggle = button("收起侧边栏", { icon: true });
	header.append(toggle);
	const app = load({ sidebar: root });
	app.decorateSidebarToggle();
	app.toggleDrawer();
	assert.equal(toggle.clicks, 1);
});

// --------------------------------------------------------------------------
// Re-derive before trusting a tag.
// --------------------------------------------------------------------------

test("a stale tag loses to the drag-header structure", () => {
	const { root, header } = sidebar();
	const stale = button("閉じる");
	const real = button("打开侧边栏", { icon: true });
	header.append(stale, real);
	stale.setAttribute("data-rdsh-sidebar-toggle", "");
	const app = load({ sidebar: root });
	app.decorateSidebarToggle();
	assert.equal(stale.hasAttribute("data-rdsh-sidebar-toggle"), false);
	assert.equal(real.hasAttribute("data-rdsh-sidebar-toggle"), true);
	app.toggleDrawer();
	assert.equal(real.clicks, 1);
	assert.equal(stale.clicks, 0);
});

test("a stale tag loses to the stock action label", () => {
	const { root, header } = sidebar();
	const stale = button("閉じる", { icon: true });
	const real = button("Collapse sidebar");
	header.append(stale);
	root.append(real);
	stale.setAttribute("data-rdsh-sidebar-toggle", "");
	const app = load({ sidebar: root });
	app.decorateSidebarToggle();
	assert.equal(stale.hasAttribute("data-rdsh-sidebar-toggle"), false);
	assert.equal(real.hasAttribute("data-rdsh-sidebar-toggle"), true);
	app.toggleDrawer();
	assert.equal(real.clicks, 1);
});

// --------------------------------------------------------------------------
// The slot boundary: no sidebar means no tag, while the action keeps its
// stock fallback.
// --------------------------------------------------------------------------

test("a missing sidebar slot never tags a same-labelled global control", () => {
	const globalToggle = button("Open sidebar", { icon: true });
	const app = load({ globals: [globalToggle] });
	app.decorateSidebarToggle();
	assert.equal(globalToggle.hasAttribute("data-rdsh-sidebar-toggle"), false);
	assert.equal(app.sidebarToggle(), null);
	app.toggleDrawer();
	assert.equal(globalToggle.clicks, 1, "the action lost its global stock fallback");
});

// --------------------------------------------------------------------------
// Closing only ever clicks the collapse control.
// --------------------------------------------------------------------------

for (const label of ["Open sidebar", "打开侧边栏"]) {
	test(`closeDrawer never clicks a control known to open the sidebar (${label})`, () => {
		const { root, header } = sidebar();
		const open = button(label, { icon: true });
		header.append(open);
		const app = load({ sidebar: root, frameElement: element("div") });
		app.decorateSidebarToggle();
		assert.equal(open.hasAttribute("data-rdsh-sidebar-toggle"), true);
		assert.equal(app.sidebarToggle(true), null, "the collapse locator returned an Open control");
		app.closeDrawer();
		assert.equal(open.clicks, 0);
		assert.equal(app.document.documentElement.getAttribute("data-rdsh-drawer"), "closed");
	});
}

test("closeDrawer clicks the localised collapse control once", () => {
	const { root, header } = sidebar();
	const collapse = button("收起侧边栏", { icon: true });
	header.append(collapse);
	const app = load({ sidebar: root, frameElement: element("div") });
	app.decorateSidebarToggle();
	app.closeDrawer();
	assert.equal(collapse.clicks, 1);
});

test("closeDrawer leaves an already collapsed sidebar alone", () => {
	const { root, header } = sidebar();
	const collapse = button("收起侧边栏", { icon: true });
	header.append(collapse);
	const frame = element("div", { "data-sidebar-collapsed": "" });
	const app = load({ sidebar: root, frameElement: frame });
	app.decorateSidebarToggle();
	app.closeDrawer();
	assert.equal(collapse.clicks, 0);
});

// --------------------------------------------------------------------------
// Desktop stays a no-op.
// --------------------------------------------------------------------------

test("a desktop pass removes the tag and adds none", () => {
	const { root, header } = sidebar();
	const toggle = button("打开侧边栏", { icon: true });
	header.append(toggle);
	toggle.setAttribute("data-rdsh-sidebar-toggle", "");
	const app = load({ sidebar: root, phone: false });
	app.decorateSidebarToggle();
	assert.equal(toggle.hasAttribute("data-rdsh-sidebar-toggle"), false);
});
