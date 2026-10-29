/**
 * Behavioural checks for #92: the landscape drawer keeps one More launcher.
 *
 * rc.3 adds its own More row and portal menu (sidebar.panellist.actions). The
 * plugin must stop creating the #59 row there and append Plugins / Automation
 * tasks / Settings to the stock menu instead, borrowing each row's own label
 * and icon. This file boots the real bundle against an in-memory DOM, then
 * models React's portal by hand and runs the same decoration pass the app
 * runs.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { COPY } from "../lib/copy.js";

const CLIENT = readFileSync(new URL("../client.js", import.meta.url), "utf8");

/** A recursive stub, used only for incidental reads (navigator, fetch, ...). */
function stub(depth = 0) {
	const value = function stubbed() {
		return depth > 4 ? undefined : stub(depth + 1);
	};
	return new Proxy(value, {
		get(target, key) {
			if (key === Symbol.toPrimitive) return () => 0;
			if (key === Symbol.iterator) return function* empty() {};
			if (key === "then") return undefined;
			if (key === "toString" || key === "valueOf") return () => "";
			if (depth > 4) return undefined;
			return stub(depth + 1);
		},
		apply() {
			return depth > 4 ? undefined : stub(depth + 1);
		},
		construct() {
			return depth > 4 ? undefined : stub(depth + 1);
		},
		set() {
			return true;
		},
		has() {
			return true;
		},
	});
}

const ATTRIBUTE = /^\[\s*([\w-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]/;

/** Parse one compound selector: tag, .class and [attr=value] (no pseudo). */
function parseSimple(part) {
	let rest = part.trim();
	if (rest === "") return null;
	let tag = null;
	const tagMatch = rest.match(/^[a-zA-Z][\w-]*/);
	if (tagMatch !== null) {
		tag = tagMatch[0].toLowerCase();
		rest = rest.slice(tagMatch[0].length);
	}
	let className = null;
	const classMatch = rest.match(/^\.([A-Za-z0-9_-]+)/);
	if (classMatch !== null) {
		className = classMatch[1];
		rest = rest.slice(classMatch[0].length);
	}
	const attributes = [];
	let match;
	while ((match = rest.match(ATTRIBUTE)) !== null) {
		attributes.push({ name: match[1].toLowerCase(), value: match[2] ?? match[3] ?? match[4] ?? null });
		rest = rest.slice(match[0].length);
	}
	if (rest !== "") return null;
	if (tag === null && className === null && attributes.length === 0) return null;
	return { tag, className, attributes };
}

function matchesSimple(element, part) {
	const parsed = parseSimple(part);
	if (parsed === null) return false;
	if (parsed.tag !== null && element.tagName.toLowerCase() !== parsed.tag) return false;
	if (parsed.className !== null && !element.className.split(/\s+/).includes(parsed.className)) return false;
	for (const attribute of parsed.attributes) {
		if (!element.hasAttribute(attribute.name)) return false;
		if (attribute.value !== null && element.getAttribute(attribute.name) !== attribute.value) return false;
	}
	return true;
}

function selectorParts(group) {
	const parts = [];
	let buffer = "";
	let quote = null;
	for (const character of group.trim()) {
		if (quote !== null) {
			buffer += character;
			if (character === quote) quote = null;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			buffer += character;
			continue;
		}
		if (/\s/.test(character)) {
			if (buffer !== "") parts.push(buffer);
			buffer = "";
			continue;
		}
		buffer += character;
	}
	if (buffer !== "") parts.push(buffer);
	return parts;
}

function matches(element, selector) {
	for (const group of selector.split(",")) {
		const parts = selectorParts(group);
		if (parts.length === 0) continue;
		if (!matchesSimple(element, parts[parts.length - 1])) continue;
		let at = parts.length - 2;
		let node = element.parentElement;
		while (at >= 0) {
			if (node === null) break;
			if (matchesSimple(node, parts[at])) at -= 1;
			node = node.parentElement;
		}
		if (at < 0) return true;
	}
	return false;
}

/** The minimal element the decoration code touches, with real event dispatch. */
class FakeElement {
	constructor(document, tagName) {
		this.ownerDocument = document;
		this.tagName = tagName.toUpperCase();
		this.attributes = new Map();
		this.children = [];
		this.parentElement = null;
		this.listeners = new Map();
		this.style = {
			cssText: "",
			setProperty() {},
			removeProperty() {},
			getPropertyValue: () => "",
		};
		this.dataset = {};
		this.textContentValue = "";
		this.innerHTMLValue = "";
		this.disabled = false;
		this.type = "";
	}
	get className() {
		return this.getAttribute("class") ?? "";
	}
	set className(value) {
		this.setAttribute("class", String(value ?? ""));
	}
	get id() {
		return this.getAttribute("id") ?? "";
	}
	set id(value) {
		this.setAttribute("id", String(value ?? ""));
	}
	get classList() {
		const element = this;
		return {
			add(...names) {
				const current = new Set(element.className.split(/\s+/).filter(Boolean));
				for (const name of names) current.add(name);
				element.className = [...current].join(" ");
			},
			remove(...names) {
				const current = new Set(element.className.split(/\s+/).filter(Boolean));
				for (const name of names) current.delete(name);
				element.className = [...current].join(" ");
			},
			contains: (name) => element.className.split(/\s+/).includes(name),
			toggle: (name, force) => {
				const has = element.className.split(/\s+/).includes(name);
				const next = force === undefined ? !has : force;
				if (next) element.classList.add(name);
				else element.classList.remove(name);
				return next;
			},
		};
	}
	get isConnected() {
		let node = this;
		while (node.parentElement !== null) node = node.parentElement;
		return node === this.ownerDocument || node === this.ownerDocument.body
			|| node === this.ownerDocument.head || node === this.ownerDocument.documentElement;
	}
	get textContent() {
		return this.textContentValue + this.children.map((child) => child.textContent).join("");
	}
	set textContent(value) {
		this.children = [];
		this.textContentValue = String(value ?? "");
	}
	get innerText() {
		return this.textContent;
	}
	set innerText(value) {
		this.textContent = value;
	}
	get innerHTML() {
		return this.innerHTMLValue;
	}
	set innerHTML(value) {
		this.children = [];
		this.textContentValue = "";
		this.innerHTMLValue = String(value ?? "");
	}
	get elements() {
		return this.children;
	}
	get firstElementChild() {
		return this.children[0] ?? null;
	}
	get lastElementChild() {
		return this.children[this.children.length - 1] ?? null;
	}
	get nextElementSibling() {
		if (this.parentElement === null) return null;
		const siblings = this.parentElement.children;
		return siblings[siblings.indexOf(this) + 1] ?? null;
	}
	get scrollHeight() {
		return 0;
	}
	get clientHeight() {
		return 0;
	}
	get offsetHeight() {
		return 0;
	}
	get offsetWidth() {
		return 0;
	}
	getBoundingClientRect() {
		return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
	}
	getAttribute(name) {
		return this.attributes.has(name) ? this.attributes.get(name) : null;
	}
	setAttribute(name, value) {
		this.attributes.set(name, String(value));
	}
	hasAttribute(name) {
		return this.attributes.has(name);
	}
	removeAttribute(name) {
		this.attributes.delete(name);
	}
	toggleAttribute(name, force) {
		const next = force === undefined ? !this.hasAttribute(name) : force === true;
		if (next) this.setAttribute(name, "");
		else this.removeAttribute(name);
		return next;
	}
	append(...nodes) {
		for (const node of nodes) {
			if (typeof node === "string") {
				const text = this.ownerDocument.createElement("#text");
				text.textContent = node;
				this.children.push(text);
				text.parentElement = this;
				continue;
			}
			node.parentElement?.removeChild?.(node);
			this.children.push(node);
			node.parentElement = this;
		}
	}
	appendChild(node) {
		this.append(node);
		return node;
	}
	insertBefore(node, before) {
		this.append(node);
		const at = this.children.indexOf(node);
		const target = this.children.indexOf(before);
		if (at !== -1 && target !== -1) {
			this.children.splice(at, 1);
			this.children.splice(target, 0, node);
		}
		return node;
	}
	after(node) {
		if (this.parentElement === null) return;
		const at = this.parentElement.children.indexOf(this);
		node.parentElement?.removeChild?.(node);
		this.parentElement.children.splice(at + 1, 0, node);
		node.parentElement = this.parentElement;
	}
	removeChild(node) {
		const at = this.children.indexOf(node);
		if (at !== -1) this.children.splice(at, 1);
		if (node.parentElement === this) node.parentElement = null;
	}
	remove() {
		this.parentElement?.removeChild(this);
	}
	replaceChildren(...nodes) {
		this.children = [];
		this.textContentValue = "";
		this.append(...nodes);
	}
	contains(node) {
		if (node === this) return true;
		return this.children.some((child) => child.contains(node));
	}
	cloneNode(deep = false) {
		const copy = new FakeElement(this.ownerDocument, this.tagName);
		copy.attributes = new Map(this.attributes);
		copy.textContentValue = this.textContentValue;
		copy.innerHTMLValue = this.innerHTMLValue;
		copy.disabled = this.disabled;
		copy.type = this.type;
		if (deep) {
			for (const child of this.children) copy.append(child.cloneNode(true));
		}
		return copy;
	}
	querySelectorAll(selector) {
		const results = [];
		const visit = (node) => {
			for (const child of node.children) {
				if (matches(child, selector)) results.push(child);
				visit(child);
			}
		};
		visit(this);
		return results;
	}
	querySelector(selector) {
		return this.querySelectorAll(selector)[0] ?? null;
	}
	closest(selector) {
		let node = this;
		while (node !== null) {
			if (node instanceof FakeElement && matches(node, selector)) return node;
			node = node.parentElement;
		}
		return null;
	}
	matches(selector) {
		return matches(this, selector);
	}
	addEventListener(type, fn) {
		if (!this.listeners.has(type)) this.listeners.set(type, []);
		this.listeners.get(type).push(fn);
	}
	removeEventListener(type, fn) {
		const list = this.listeners.get(type);
		if (list === undefined) return;
		const at = list.indexOf(fn);
		if (at !== -1) list.splice(at, 1);
	}
	dispatchEvent(event) {
		event.target ??= this;
		let node = this;
		while (node !== null && event.stopped !== true) {
			for (const fn of [...(node.listeners?.get(event.type) ?? [])]) {
				event.currentTarget = node;
				try {
					fn(event);
				} catch {
					/* a boot-time listener with a richer event shape must not stop the feature under test */
				}
			}
			node = node.parentElement ?? null;
		}
		return !event.defaultPrevented;
	}
	focus() {
		this.ownerDocument.activeElement = this;
	}
	blur() {
		if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
	}
	click() {
		if (this.disabled === true) return;
		this.dispatchEvent(new FakeEvent("click", this));
	}
}

class FakeEvent {
	constructor(type, target) {
		this.type = type;
		this.target = target;
		this.defaultPrevented = false;
		this.stopped = false;
	}
	preventDefault() {
		this.defaultPrevented = true;
	}
	stopPropagation() {
		this.stopped = true;
	}
	stopImmediatePropagation() {
		this.stopped = true;
	}
}

class FakeKeyboardEvent extends FakeEvent {
	constructor(type, init = {}) {
		super(type, null);
		Object.assign(this, init);
		this.isTrusted = false;
	}
}

class FakeDocument extends FakeElement {
	constructor() {
		super(null, "#document");
		this.ownerDocument = this;
		this.activeElement = null;
		this.visibilityState = "visible";
		this.styleSheets = [];
		this.documentElement = new FakeElement(this, "html");
		this.head = new FakeElement(this, "head");
		this.body = new FakeElement(this, "body");
		this.documentElement.parentElement = this;
		this.body.parentElement = this.documentElement;
		this.head.parentElement = this.documentElement;
		this.children = [this.documentElement];
		this.documentElement.children = [this.head, this.body];
		this.documentElement.lang = "en";
		this.baseURI = "http://localhost/";
	}
	get isConnected() {
		return true;
	}
	getElementById() {
		return null;
	}
	createElement(tag) {
		return new FakeElement(this, tag);
	}
	listenerCount(type) {
		return (this.listeners.get(type) ?? []).length;
	}
}

function memoryStorage(initial = {}) {
	const map = new Map(Object.entries(initial));
	return {
		getItem: (key) => (map.has(key) ? map.get(key) : null),
		setItem: (key, value) => map.set(key, String(value)),
		removeItem: (key) => map.delete(key),
		clear: () => map.clear(),
		key: (index) => [...map.keys()][index] ?? null,
		get length() {
			return map.size;
		},
	};
}

/** Boot the client half against the fake DOM and return its test surface. */
function boot({ mode = "mobile", width = 390 } = {}) {
	let definition;
	const document = new FakeDocument();
	const narrow = width <= 767;
	const window = {
		addEventListener() {},
		removeEventListener() {},
		innerWidth: width,
		innerHeight: 844,
		matchMedia: (query) => ({
			matches: query.includes("max-width: 767px") ? narrow : false,
			addEventListener() {},
			removeEventListener() {},
		}),
	};
	const sandbox = {
		window,
		document,
		navigator: stub(),
		location: stub(),
		localStorage: memoryStorage(),
		sessionStorage: memoryStorage(),
		matchMedia: window.matchMedia,
		addEventListener: window.addEventListener,
		removeEventListener: window.removeEventListener,
		setTimeout: () => 0,
		clearTimeout() {},
		setInterval: () => 0,
		clearInterval() {},
		requestAnimationFrame: () => 0,
		cancelAnimationFrame() {},
		MutationObserver: class {
			observe() {}
			disconnect() {}
		},
		IntersectionObserver: class {
			observe() {}
			disconnect() {}
		},
		ResizeObserver: class {
			observe() {}
			disconnect() {}
		},
		getComputedStyle: () => ({
			overflowX: "visible",
			overflowY: "visible",
			visibility: "visible",
			display: "block",
			paddingLeft: "0px",
			paddingRight: "0px",
			getPropertyValue: () => "",
		}),
		console,
		URL,
		URLSearchParams,
		Intl,
		TextEncoder,
		TextDecoder,
		AbortController,
		structuredClone,
		fetch: () => Promise.resolve(stub()),
		Element: class Element {},
		HTMLElement: class HTMLElement {},
		Node: class Node {},
		Event: class Event {},
		CustomEvent: class CustomEvent {},
		KeyboardEvent: FakeKeyboardEvent,
		PointerEvent: class PointerEvent {},
		TouchEvent: class TouchEvent {},
		Touch: class Touch {},
		MessageChannel: class MessageChannel {},
		Notification: stub(),
		AudioContext: class AudioContext {},
		screen: stub(),
		innerWidth: width,
		innerHeight: 844,
		devicePixelRatio: 3,
		performance: { now: () => 0 },
		queueMicrotask,
		__RDSH_PWA_LANG__: "en",
		__RDSH_PWA_COPY__: COPY,
		__RDSH_PWA_PROBES__: {},
		__RDSH_DEVICE_MODE__: mode,
	};
	sandbox.globalThis = sandbox;
	window.__ModuleLoader__ = {
		load(value) {
			definition = value;
		},
	};
	window.document = document;
	window.setTimeout = sandbox.setTimeout;
	window.clearTimeout = sandbox.clearTimeout;
	window.setInterval = sandbox.setInterval;
	window.clearInterval = sandbox.clearInterval;
	window.requestAnimationFrame = sandbox.requestAnimationFrame;
	window.cancelAnimationFrame = sandbox.cancelAnimationFrame;
	window.navigator = sandbox.navigator;
	window.localStorage = sandbox.localStorage;
	window.screen = sandbox.screen;
	window.performance = sandbox.performance;
	vm.createContext(sandbox);
	vm.runInContext(CLIENT, sandbox, { filename: "client.js" });
	assert.ok(definition !== undefined, "the module registered itself");
	const plugin = definition.factory(() => stub());
	const disposers = [];
	const ctx = {
		effect(fn) {
			const dispose = fn();
			if (typeof dispose === "function") disposers.push(dispose);
			return typeof dispose === "function" ? dispose : () => {};
		},
		inject(deps, callback) {
			return callback(ctx);
		},
		slots: {
			inject(deps, callback) {
				if (typeof callback === "function") return callback();
				return undefined;
			},
			register() {
				return () => {};
			},
		},
		get: () => undefined,
		on: () => () => {},
		emit() {},
	};
	plugin.apply(ctx);
	const api = sandbox.__RDSH_MOBILE_UX__;
	if (mode !== "mobile") assert.equal(api, undefined, "a desktop boot published mobile diagnostics");
	else assert.ok(api !== undefined, "the diagnostics surface is present");
	return {
		sandbox,
		document,
		window,
		api,
		dispose() {
			for (const dispose of disposers.splice(0).reverse()) dispose();
		},
	};
}

/** A stock panel row with the glyph the menu borrows, plus a click counter. */
function makeRow(document, label, icon, hits, key) {
	const row = document.createElement("button");
	row.type = "button";
	row.setAttribute("aria-label", label);
	const glyph = document.createElement("span");
	glyph.className = "hHd-Xa_panelGlyph";
	const svg = document.createElement("svg");
	svg.setAttribute("data-stock-icon", icon);
	glyph.append(svg);
	row.append(glyph);
	const title = document.createElement("span");
	title.className = "hHd-Xa_panelTitle hHd-Xa_wide";
	title.textContent = label;
	row.append(title);
	row.addEventListener("click", () => {
		hits[key] += 1;
	});
	return row;
}

/**
 * The drawer fixture: the three rows, plus rc.3's More launcher when asked.
 * The Settings row exists before boot so decorateSidebarSettingsRow adopts it,
 * exactly as it adopts its own injected row on the next pass.
 */
function makeNav(env, { launcher = true } = {}) {
	const { document } = env;
	const hits = { plugins: 0, automation: 0, settings: 0 };
	const nav = document.createElement("nav");
	nav.className = "hHd-Xa_panelList";
	nav.setAttribute("aria-label", "Panels");
	const plugins = makeRow(document, "Plugins", "plugins", hits, "plugins");
	const automation = makeRow(document, "Automation tasks", "automation", hits, "automation");
	const settings = makeRow(document, "Settings", "settings", hits, "settings");
	settings.className = "hHd-Xa_panelRow rdsh-mux-settings-row";
	settings.setAttribute("data-rdsh-settings-row", "");
	nav.append(plugins, automation, settings);
	let more = null;
	if (launcher) {
		const anchor = document.createElement("span");
		anchor.className = "hHd-Xa_moreAnchor";
		more = document.createElement("button");
		more.type = "button";
		more.setAttribute("aria-label", "More");
		more.setAttribute("aria-haspopup", "menu");
		more.setAttribute("aria-expanded", "false");
		anchor.append(more);
		nav.append(anchor);
	}
	document.body.append(nav);
	return { nav, plugins, automation, settings, more, hits };
}

function makeMenuItem(document, label) {
	const item = document.createElement("button");
	item.type = "button";
	item.setAttribute("role", "menuitem");
	item.textContent = label;
	return item;
}

/**
 * Model rc.3's open portal: body > [role=menu] > viewport > slot + rows.
 * The slot outlet is display:contents in the shell, so its parent is the real
 * list the plugin appends to.
 */
function openShellMenu(env, fixture) {
	const { document } = env;
	const menu = document.createElement("div");
	menu.className = "hHd-Xa_moreMenu";
	menu.setAttribute("role", "menu");
	const material = document.createElement("div");
	material.setAttribute("aria-hidden", "true");
	const viewport = document.createElement("div");
	viewport.setAttribute("role", "presentation");
	const slot = document.createElement("div");
	slot.setAttribute("data-slot", "sidebar.panellist.actions");
	const browse = makeMenuItem(document, "Browse other plugins");
	const create = makeMenuItem(document, "Create your plugin");
	slot.append(browse, create);
	viewport.append(slot);
	menu.append(material, viewport);
	document.body.append(menu);
	fixture.more.setAttribute("aria-expanded", "true");
	return {
		menu,
		viewport,
		slot,
		browse,
		create,
		close() {
			menu.remove();
			fixture.more.setAttribute("aria-expanded", "false");
		},
	};
}

function moreItems(document) {
	return document.querySelectorAll("[data-rdsh-more-item][role='menuitem']");
}

const FOLDED = "[data-rdsh-nav-more-hidden]";

test("#92 landscape with the stock launcher shows one More and folds the rows", () => {
	const env = boot({ mode: "mobile", width: 1024 });
	const fixture = makeNav(env);
	env.api.decorateNow();
	assert.equal(fixture.nav.querySelectorAll("[data-rdsh-nav-more]").length, 0, "#59's row must not be created next to the shell's");
	assert.equal(fixture.nav.querySelectorAll('button[aria-haspopup="menu"]').length, 1, "the landscape nav has more than one More launcher");
	assert.equal(fixture.nav.querySelector('button[aria-haspopup="menu"]'), fixture.more, "the stock launcher is not the remaining launcher");
	for (const row of [fixture.plugins, fixture.automation, fixture.settings]) {
		assert.equal(row.hasAttribute("data-rdsh-nav-more-hidden"), true, "a folded row is still visible");
	}
	// Repainting must not resurrect the #59 row.
	env.api.decorateNow();
	assert.equal(fixture.nav.querySelectorAll("[data-rdsh-nav-more]").length, 0);
	assert.equal(fixture.nav.querySelectorAll(FOLDED).length, 3);
	env.dispose();
});

test("#92 the stock menu gains the three rows with their own icons and labels", () => {
	const env = boot({ mode: "mobile", width: 1024 });
	const fixture = makeNav(env);
	env.api.decorateNow();
	const opened = openShellMenu(env, fixture);
	env.api.decorateNow();

	const items = moreItems(env.document);
	assert.equal(items.length, 3, "the stock menu does not carry exactly the three folded rows");
	const separators = env.document.querySelectorAll('[data-rdsh-more-item][role="separator"]');
	assert.equal(separators.length, 1, "the appended rows have no separator");
	assert.deepEqual(items.map((item) => item.textContent), ["Plugins", "Automation tasks", "Settings"]);
	// Source order: our three rows, our separator, then the shell's own rows.
	// The slot outlet is display:contents, so all of them share one list.
	assert.deepEqual(opened.viewport.children.slice(0, 4), [...items, separators[0]], "the rows were not inserted at the top of the list");
	assert.equal(opened.viewport.children[4], opened.slot, "the shell's own rows were displaced");
	for (const item of items) {
		// The shell's keyboard walk and Escape both key off the list subtree, so
		// the appended rows must be real buttons inside it (no extra handlers).
		assert.equal(item.tagName, "BUTTON");
		assert.equal(opened.menu.contains(item), true, "an appended row is outside the shell menu's keyboard/Escape scope");
		assert.equal(item.disabled, false);
	}
	const stock = [fixture.plugins, fixture.automation, fixture.settings];
	for (const [index, item] of items.entries()) {
		assert.equal(item.getAttribute("aria-label"), stock[index].getAttribute("aria-label"), "the label was not borrowed from the stock row");
		const icon = item.querySelector("svg");
		assert.ok(icon, "the appended item lost its icon");
		assert.equal(icon.getAttribute("data-stock-icon"), stock[index].querySelector("svg").getAttribute("data-stock-icon"), "the icon was not cloned from the stock row");
	}
	env.dispose();
});

test("#92 the appended rows are rebuilt, never duplicated, when the menu is reused", () => {
	const env = boot({ mode: "mobile", width: 1024 });
	const fixture = makeNav(env);
	env.api.decorateNow();
	const opened = openShellMenu(env, fixture);
	env.api.decorateNow();
	const first = moreItems(env.document);
	assert.equal(first.length, 3);
	// Every decorate pass (the observer's own repaint) must be a no-op.
	env.api.decorateNow();
	env.api.decorateNow();
	assert.deepEqual(moreItems(env.document), first, "a repaint replaced the appended nodes");

	// Closing the portal removes them with React's subtree; a new open builds
	// exactly one copy again.
	opened.close();
	env.api.decorateNow();
	assert.equal(env.document.querySelectorAll("[data-rdsh-more-item]").length, 0, "closing the menu left nodes behind");
	openShellMenu(env, fixture);
	env.api.decorateNow();
	assert.equal(moreItems(env.document).length, 3, "reopening the menu duplicated the appended rows");
	assert.equal(env.document.querySelectorAll('[data-rdsh-more-item][role="separator"]').length, 1);
	env.dispose();
});

test("#92 a menu item runs its hidden stock row and closes the shell menu", () => {
	const env = boot({ mode: "mobile", width: 1024 });
	const fixture = makeNav(env);
	env.api.decorateNow();
	const escapes = [];
	env.document.addEventListener("keydown", (event) => {
		if (event.key === "Escape") escapes.push(event);
	});

	openShellMenu(env, fixture);
	env.api.decorateNow();
	moreItems(env.document)[0].click();
	assert.equal(fixture.hits.plugins, 1, "the Plugins item did not click the hidden stock row");
	assert.equal(escapes.length, 1, "the shell menu was not asked to close");
	assert.equal(env.document.querySelectorAll("[data-rdsh-more-item]").length, 0, "the appended rows survived activation");

	// Settings opens another menu, so the close must happen first: the stock
	// row's own click has to run, and only one Escape is sent.
	openShellMenu(env, fixture);
	env.api.decorateNow();
	moreItems(env.document)[2].click();
	assert.equal(fixture.hits.settings, 1, "the Settings item did not click the hidden stock row");
	assert.equal(escapes.length, 2);
	env.dispose();
});

test("#92 portrait keeps the three rows and appends nothing", () => {
	const env = boot({ mode: "mobile", width: 390 });
	const fixture = makeNav(env);
	env.api.decorateNow();
	assert.equal(fixture.nav.querySelectorAll("[data-rdsh-nav-more]").length, 0, "a portrait phone got the landscape More row");
	assert.equal(fixture.nav.querySelectorAll(FOLDED).length, 0, "a portrait phone folded a row");
	for (const row of [fixture.plugins, fixture.automation, fixture.settings]) {
		assert.equal(row.hasAttribute("data-rdsh-nav-more-hidden"), false);
	}
	// Even an already-open stock menu stays untouched outside landscape.
	openShellMenu(env, fixture);
	env.api.decorateNow();
	assert.equal(env.document.querySelectorAll("[data-rdsh-more-item]").length, 0, "portrait injected rows into the stock menu");
	env.dispose();
});

test("#92 a shell without the stock launcher keeps the #59 More row", () => {
	const env = boot({ mode: "mobile", width: 1024 });
	const fixture = makeNav(env, { launcher: false });
	env.api.decorateNow();
	const more = fixture.nav.querySelector("[data-rdsh-nav-more]");
	assert.ok(more, "the rc.2 fallback More row was not created");
	assert.equal(more.getAttribute("aria-label"), COPY.en["mux.navMore"]);
	assert.equal(more.getAttribute("aria-haspopup"), "menu");
	assert.equal(fixture.nav.querySelectorAll(FOLDED).length, 3, "the fallback did not fold the three rows");
	assert.equal(env.document.querySelectorAll("[data-rdsh-more-item]").length, 0, "the fallback has no shell menu to feed");
	// Its own menu still lists the three rows.
	more.click();
	const ownItems = env.document.querySelectorAll(".rdsh-mux-nav-more-menu [role='menuitem']");
	assert.deepEqual(ownItems.map((item) => item.textContent), ["Plugins", "Automation tasks", "Settings"]);
	env.dispose();
});

test("#92 a desktop boot injects nothing", () => {
	const env = boot({ mode: "desktop", width: 1024 });
	const fixture = makeNav(env);
	assert.equal(env.api, undefined, "the mobile half booted on a desktop");
	assert.equal(fixture.nav.querySelectorAll("[data-rdsh-nav-more]").length, 0);
	assert.equal(env.document.querySelectorAll("[data-rdsh-more-item]").length, 0);
	assert.equal(env.document.querySelectorAll(FOLDED).length, 0);
	env.dispose();
});
