/**
 * #97: the hooks that used English aria-labels must survive a ja shell.
 *
 * The failure was never visual CSS: the plugin tagged nothing, so the
 * stylesheet had nothing to key off. These tests drive the real locators and
 * decorators against a small DOM double in the same style as
 * `mobile-controls-localization.test.mjs`, with the labels the ja shell
 * actually renders (`packages/dsh-locale-ja/locale/namespaces/ja`).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { PROBES as PACKAGE_PROBES } from "../lib/copy.js";

const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");

/** The declaration from `function name(` through its own closing brace. */
function functionSource(name) {
	const at = source.indexOf(`    function ${name}(`);
	assert.ok(at >= 0, `${name} exists`);
	const end = source.indexOf("\n    }\n", at);
	assert.ok(end >= 0, `${name} is complete`);
	return source.slice(at, end + "\n    }".length);
}

const NAMES = [
	"classToken",
	"composerCard",
	"modelTrigger",
	"addButton",
	"decorateComposer",
	"sessionHierarchy",
	"decorateRowActions",
	"modelMenu",
];

// --------------------------------------------------------------------------
// A DOM double. It understands exactly the selectors these functions use.
// --------------------------------------------------------------------------

/** Split a selector into comma alternatives of space-separated parts. */
function splitSelector(selector) {
	const groups = [[]];
	let current = "";
	let quote = "";
	let depth = 0;
	const flush = (nextGroup) => {
		if (current !== "") groups[groups.length - 1].push(current);
		current = "";
		if (nextGroup) groups.push([]);
	};
	for (const character of selector) {
		if (quote !== "") {
			current += character;
			if (character === quote) quote = "";
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			current += character;
			continue;
		}
		if (character === "[") depth += 1;
		if (character === "]") depth -= 1;
		if (depth === 0 && character === ",") {
			flush(true);
			continue;
		}
		if (depth === 0 && character === " ") {
			flush(false);
			continue;
		}
		current += character;
	}
	flush(false);
	return groups;
}

function matchesSimple(node, selector) {
	const parsed = selector.match(/^([a-zA-Z][\w-]*)?((?:\[[^\]]*\])*)$/);
	if (parsed === null) return false;
	if (parsed[1] !== undefined && node.tagName !== parsed[1].toUpperCase()) return false;
	for (const attribute of parsed[2].matchAll(/\[([A-Za-z][\w-]*)(?:([*^]?)=?"([^"]*)")?\]/g)) {
		const [, name, operator, value] = attribute;
		if (!node.hasAttribute(name)) return false;
		if (operator === undefined) continue;
		const actual = node.getAttribute(name) || "";
		if (operator === "=" && actual !== value) return false;
		if (operator === "*" && !actual.includes(value)) return false;
		if (operator === "^" && !actual.startsWith(value)) return false;
	}
	return true;
}

function element(tagName, attributes = {}) {
	const node = {
		tagName: tagName.toUpperCase(),
		children: [],
		parentElement: null,
		attributes: new Map(Object.entries(attributes)),
		get className() {
			return this.getAttribute("class") || "";
		},
		set className(value) {
			this.setAttribute("class", value);
		},
		get classList() {
			return (this.getAttribute("class") || "").split(/\s+/).filter((token) => token !== "");
		},
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
		toggleAttribute(name, force) {
			if (force === undefined) {
				if (this.attributes.has(name)) this.attributes.delete(name);
				else this.attributes.set(name, "");
				return this.attributes.has(name);
			}
			if (force) this.attributes.set(name, "");
			else this.attributes.delete(name);
			return force;
		},
		append(...children) {
			for (const child of children) {
				child.parentElement = this;
				this.children.push(child);
			}
			return children[0] ?? null;
		},
		querySelectorAll(selector) {
			return select(this, selector);
		},
		querySelector(selector) {
			return select(this, selector)[0] ?? null;
		},
		closest(selector) {
			let node = this;
			while (node !== null && node !== undefined) {
				if (matchesSimple(node, selector)) return node;
				node = node.parentElement;
			}
			return null;
		},
	};
	return node;
}

function descendants(node) {
	const found = [];
	for (const child of node.children) found.push(child, ...descendants(child));
	return found;
}

function select(root, selector) {
	const found = [];
	for (const parts of splitSelector(selector.trim())) {
		if (parts.length === 0) continue;
		const last = parts[parts.length - 1];
		for (const node of descendants(root)) {
			if (!matchesSimple(node, last)) continue;
			let parent = node.parentElement;
			let matched = true;
			for (let index = parts.length - 2; index >= 0; index -= 1) {
				while (parent !== null && !matchesSimple(parent, parts[index])) parent = parent.parentElement;
				if (parent === null) {
					matched = false;
					break;
				}
				parent = parent.parentElement;
			}
			if (matched) found.push(node);
		}
	}
	return [...new Set(found)];
}

// --------------------------------------------------------------------------
// The composer, as upstream renders it.
// --------------------------------------------------------------------------

function trigger({ label, effort = true, slot = true, root = true }) {
	const wrapper = root ? element("div", { class: "Xy_root" }) : element("div");
	const button = element("button", {
		class: "Xy_trigger",
		"aria-label": label,
		"aria-haspopup": "menu",
		"aria-expanded": "false",
	});
	button.append(element("span", { class: "Xy_triggerLabel" }));
	if (effort) button.append(element("span", { class: "Xy_triggerEffort" }));
	wrapper.append(button);
	if (!slot) return { wrapper, button, scope: wrapper };
	const seat = element("div", { "data-slot": "conversation.input.model" });
	seat.append(wrapper);
	return { wrapper, button, scope: seat };
}

function composer({ slot = true, effort = true, permission = true, englishOnly = false } = {}) {
	const body = element("body");
	const root = element("div");
	body.append(root);
	const card = element("div", { class: "Xy_card" });
	root.append(card);
	card.append(element("div", { "data-composer-input": "" }));
	const model = trigger({
		label: englishOnly
			? "Select model · Sonnet"
			: "モデルを選択（現在 Sonnet、推論の強度 Max）",
		effort: englishOnly ? false : effort,
		slot: englishOnly ? false : slot,
		root: !englishOnly,
	});
	if (englishOnly) {
		card.append(model.button);
	} else {
		card.append(model.scope);
	}
	let permissionButton = null;
	if (permission) {
		const wrapper = element("div", { class: "Xy_modes" });
		permissionButton = element("button", { class: "Xy_trigger", "aria-label": "権限: ワークスペース内の変更" });
		permissionButton.append(element("span", { class: "Xy_triggerLabel" }));
		wrapper.append(permissionButton);
		card.append(wrapper);
	}
	const add = element("button", {
		class: "Xy_add",
		"aria-label": "ファイルを追加またはコマンドを実行",
		"aria-haspopup": "listbox",
	});
	card.append(add);
	return { body, root, card, add, model: model.button, permission: permissionButton };
}

function load(fixture, { phone = true } = {}) {
	const ids = new Map();
	const document = {
		documentElement: element("html"),
		querySelector(selector) {
			return fixture.body.querySelector(selector);
		},
		querySelectorAll(selector) {
			return fixture.body.querySelectorAll(selector);
		},
		getElementById(id) {
			return ids.get(id) ?? null;
		},
	};
	const context = {
		document,
		phone: () => phone,
		t: (key) => key,
		ADD_LABEL: "add.label",
		ADD_STOCK_LABEL: "add.stock",
		ADD_SELECTOR: '[data-rdsh-add], [aria-label="add.label"], [aria-label="add.stock"]',
		ariaContainsSelector: () => "[data-stats]",
		clearComposerHooks() {},
		probeValues: (key, fallback) => (Array.isArray(PROBES[key]) ? PROBES[key] : Array.isArray(fallback) ? fallback : fallback === undefined ? [] : [fallback]),
		ariaLabelSelector: (tag, key, fallback) => context.probeValues(key, fallback)
			.map((value) => `${tag}[aria-label="${String(value).replaceAll('"', '\\"')}"]`)
			.join(", "),
		PROBES,
		ids,
	};
	const api = vm.runInNewContext(
		`(() => {\n${NAMES.map((name) => functionSource(name)).join("\n")}\nreturn { ${NAMES.join(", ")} };\n})()`,
		context,
	);
	return { ...api, document, fixture, ids };
}

/** The probe table the host injects; the ja entries are the reviewed ones. */
const PROBES = {
	sessionHierarchy: ["Session hierarchy", "会话层级", "セッション階層"],
	sessionActions: ["Session actions", "的操作", "のセッション操作"],
};

test("#97 編集カードの見出しは en/zh/ja のどれでも一致する", () => {
	const declaration = source.match(/    const EDITED_FILES = probeValues[\s\S]*?;\n/);
	assert.ok(declaration !== null, "EDITED_FILES が見つかりません");
	const patterns = vm.runInNewContext(
		`(() => {\n${declaration[0]}\nreturn EDITED_FILES;\n})()`,
		{ probeValues: (key, fallback) => (Array.isArray(PACKAGE_PROBES[key]) ? PACKAGE_PROBES[key] : fallback) },
	);
	const matches = (text) => patterns.some((pattern) => pattern.test(text));
	assert.equal(matches("Edited 3 files"), true, "en");
	assert.equal(matches("已编辑 3 个文件"), true, "zh");
	assert.equal(matches("3 ファイルを編集しました"), true, "ja");
	assert.equal(matches("Edited 3 files and more"), false, "the whole label must match");
});

test("#97 追加した PROBES は en/zh/ja の語彙を持つ", () => {
	const expected = {
		modelTrigger: ["Select model", "选择模型", "モデルを選択"],
		sessionHierarchy: ["Session hierarchy", "会话层级", "セッション階層"],
		sessionActions: ["Session actions", "的操作", "のセッション操作"],
		editedFiles: ["Edited {count} files", "已编辑 {count} 个文件", "{count} ファイルを編集しました"],
		sidebarOpen: ["Open sidebar", "打开侧边栏", "サイドバーを開く"],
		sidebarCollapse: ["Collapse sidebar", "收起侧边栏", "サイドバーを折りたたむ"],
		rightPanelOpen: ["Open right sidebar", "打开右侧边栏", "右サイドバーを開く"],
		rightPanelCollapse: ["Collapse right sidebar", "收起右侧边栏", "右サイドバーを折りたたむ"],
	};
	for (const [key, values] of Object.entries(expected)) {
		assert.deepEqual(PACKAGE_PROBES[key], values, `PROBES.${key} が en/zh/ja の3語彙になっていません`);
	}
});

// --------------------------------------------------------------------------
// 1. The model trigger: structure, not the label.
// --------------------------------------------------------------------------

test("ja のモデルラベルでも slot 内の triggerEffort からボタンを取ってフックする", () => {
	const fixture = composer({ slot: true });
	const app = load(fixture);
	app.decorateComposer();
	assert.equal(fixture.model.hasAttribute("data-rdsh-model-button"), true);
	assert.equal(fixture.permission.hasAttribute("data-rdsh-model-button"), false);
});

test("slot が無いシェルでも triggerEffort の親 button でフックする", () => {
	const fixture = composer({ slot: false });
	const app = load(fixture);
	app.decorateComposer();
	assert.equal(fixture.model.hasAttribute("data-rdsh-model-button"), true);
	assert.equal(fixture.permission.hasAttribute("data-rdsh-model-button"), false);
});

test("effort の無いモデルは root 構造で選び、権限セレクトを誤爆しない", () => {
	const fixture = composer({ slot: false, effort: false });
	const app = load(fixture);
	app.decorateComposer();
	assert.equal(fixture.model.hasAttribute("data-rdsh-model-button"), true);
	assert.equal(fixture.permission.hasAttribute("data-rdsh-model-button"), false);
});

test("旧シェルの英語ラベルは最終フォールバックとして残る", () => {
	const fixture = composer({ englishOnly: true });
	const app = load(fixture);
	app.decorateComposer();
	assert.equal(fixture.model.hasAttribute("data-rdsh-model-button"), true);
});

// --------------------------------------------------------------------------
// 2. Breadcrumbs: structure, then PROBES.
// --------------------------------------------------------------------------

function header({ label, slot = false, klass = "Xy_crumbs" }) {
	const document = element("body");
	const host = element("header", { "data-window-drag": "" });
	document.append(host);
	const nav = element("nav", { class: klass, "aria-label": label });
	if (slot) {
		const seat = element("div", { "data-slot": "conversation.session.header" });
		seat.append(nav);
		host.append(seat);
	} else {
		host.append(nav);
	}
	return { document, host, nav };
}

function loadHeader(fixture) {
	const document = {
		documentElement: element("html"),
		querySelector: (selector) => fixture.document.querySelector(selector),
		querySelectorAll: (selector) => fixture.document.querySelectorAll(selector),
	};
	const context = {
		document,
		PROBES,
		probeValues: (key, fallback) => (Array.isArray(PROBES[key]) ? PROBES[key] : Array.isArray(fallback) ? fallback : fallback === undefined ? [] : [fallback]),
	};
	context.ariaLabelSelector = (tag, key, fallback) => context.probeValues(key, fallback)
		.map((value) => `${tag}[aria-label="${String(value).replaceAll('"', '\\"')}"]`)
		.join(", ");
	const api = vm.runInNewContext(
		`(() => {\n${functionSource("sessionHierarchy")}\nreturn { sessionHierarchy };\n})()`,
		context,
	);
	return { ...api, document };
}

test("ja のパンくず nav でも data-rdsh-crumbs が付く", () => {
	const fixture = header({ label: "セッション階層" });
	const app = loadHeader(fixture);
	const nav = app.sessionHierarchy();
	assert.equal(nav, fixture.nav);
	nav.setAttribute("data-rdsh-crumbs", "");
	assert.equal(fixture.document.querySelectorAll("[data-rdsh-crumbs]").length, 1);
});

test("クラス接尾辞が変わっても header 構造からパンくずを取る", () => {
	const fixture = header({ label: "セッション階層", klass: "Builder9_crumbs" });
	const app = loadHeader(fixture);
	assert.equal(app.sessionHierarchy(), fixture.nav);
});

test("en のパンくず nav でも同じ（退行なし）", () => {
	const fixture = header({ label: "Session hierarchy" });
	const app = loadHeader(fixture);
	assert.equal(app.sessionHierarchy(), fixture.nav);
});

test("slot の中の nav を最優先する", () => {
	const fixture = header({ label: "何か別のラベル", slot: true });
	const app = loadHeader(fixture);
	assert.equal(app.sessionHierarchy(), fixture.nav);
});

// --------------------------------------------------------------------------
// 3. Session-row actions: the "..." stays, the shortcuts go.
// --------------------------------------------------------------------------

test("ja の行アクションでも「…」メニューは minor にならない", () => {
	const actions = element("div", { class: "Xy_rowActions" });
	const menu = element("button", { "aria-label": "作業中のセッション のセッション操作" });
	const archive = element("button", { "aria-label": "セッションをアーカイブ" });
	const pin = element("button", { "aria-label": "セッションをピン留め" });
	actions.append(menu, archive, pin);
	const app = load(composer());
	app.decorateRowActions(actions);
	assert.equal(menu.hasAttribute("data-rdsh-row-minor"), false);
	assert.equal(archive.hasAttribute("data-rdsh-row-minor"), true);
	assert.equal(pin.hasAttribute("data-rdsh-row-minor"), true);
});

test("popup 属性を持つボタンをメニューとして優先する", () => {
	const actions = element("div", { class: "Xy_rowActions" });
	const archive = element("button", { "aria-label": "アーカイブ" });
	const menu = element("button", { "aria-label": "その他", "aria-haspopup": "menu" });
	actions.append(archive, menu);
	const app = load(composer());
	app.decorateRowActions(actions);
	assert.equal(menu.hasAttribute("data-rdsh-row-minor"), false);
	assert.equal(archive.hasAttribute("data-rdsh-row-minor"), true);
});

test("手掛かりが無い旧シェルでは先頭ボタンをメニューとして残す", () => {
	const actions = element("div", { class: "Xy_rowActions" });
	const menu = element("button", { "aria-label": "何か" });
	const archive = element("button", { "aria-label": "別の何か" });
	actions.append(menu, archive);
	const app = load(composer());
	app.decorateRowActions(actions);
	assert.equal(menu.hasAttribute("data-rdsh-row-minor"), false);
	assert.equal(archive.hasAttribute("data-rdsh-row-minor"), true);
});

// --------------------------------------------------------------------------
// 4. Model picker: aria-controls, not the class hash.
// --------------------------------------------------------------------------

test("開いているモデルメニューは trigger の aria-controls から取る", () => {
	const fixture = composer({ slot: true });
	fixture.model.setAttribute("aria-controls", "picked-menu");
	const menu = element("div", { id: "picked-menu", class: "OtherHash_menu", role: "group" });
	menu.setAttribute("id", "picked-menu");
	fixture.body.append(menu);
	const app = load(fixture);
	app.ids.set("picked-menu", menu);
	assert.equal(app.modelMenu(), menu);
});

test("aria-controls の無いシェルは class 接尾辞と role にフォールバックする", () => {
	const fixture = composer({ slot: true });
	const menu = element("div", { class: "OtherHash_menu", role: "group" });
	fixture.body.append(menu);
	const app = load(fixture);
	assert.equal(app.modelMenu(), menu);
});
