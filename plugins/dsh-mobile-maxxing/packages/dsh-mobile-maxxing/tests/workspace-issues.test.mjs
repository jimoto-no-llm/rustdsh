/**
 * Behavioural tests for issues #39, #42 and #43.
 *
 * The browser half is one verbatim module, so these tests load it in a VM with
 * a very small DOM and drive the same closures production uses (exposed only
 * when `__RDSH_WORKSPACE_TEST__` is set before load). No browser, no DSH
 * process, no network.
 *
 *   #39  the workspace picker gets its search row before the first paint and
 *        never receives an inline transform or height
 *   #42  a 500ms press on a file/folder row opens a copy menu; >10px,
 *        pointercancel and scroll cancel it
 *   #43  the root path gets the same copy menu, and search runs only on an
 *        explicit click/Enter over the mounted tree
 *   #83  the file search gets an explicit clear button, and a native search
 *        clear resets filtering/highlight/no-hit state without typing-search
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { COPY, copyFor } from "../lib/copy.js";

const CLIENT = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const NARROW = "(max-width: 767px)";

// ---------------------------------------------------------------------------
// A small DOM: elements, text, attributes, bubbling and the handful of
// selectors these behaviours use. It is deliberately not a general engine.
// ---------------------------------------------------------------------------

function parseToken(token) {
	const tag = (token.match(/^([A-Za-z][\w-]*)/) ?? [])[1] ?? "";
	const attrs = [...token.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)].map((match) => ({
		name: match[1],
		value: match[2],
	}));
	return { tag: tag.toUpperCase(), attrs };
}

function tokenMatches(element, token) {
	if (element === null || element.nodeType !== 1) return false;
	if (token.tag !== "" && element.tagName !== token.tag) return false;
	for (const attr of token.attrs) {
		if (!element.attributes.has(attr.name)) return false;
		if (attr.value !== undefined && element.attributes.get(attr.name) !== attr.value) return false;
	}
	return true;
}

function selectorMatches(element, selector) {
	for (const group of selector.split(",")) {
		const tokens = group.trim().split(/\s+/).filter(Boolean).map(parseToken);
		if (tokens.length === 0) continue;
		let node = element;
		let ok = true;
		for (let index = tokens.length - 1; index >= 0; index -= 1) {
			if (index === tokens.length - 1) {
				if (!tokenMatches(node, tokens[index])) {
					ok = false;
					break;
				}
				continue;
			}
			node = node.parentElement;
			while (node !== null && node.nodeType === 1 && !tokenMatches(node, tokens[index])) node = node.parentElement;
			if (node === null || node.nodeType !== 1) {
				ok = false;
				break;
			}
		}
		if (ok) return true;
	}
	return false;
}

class FakeNode {
	constructor(document, nodeType, tagName) {
		this.ownerDocument = document;
		this.nodeType = nodeType;
		this.tagName = (tagName ?? "").toUpperCase();
		this.parentElement = null;
		this.childNodes = [];
		this.attributes = new Map();
		this.style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => "" };
		this.className = "";
		this.hidden = false;
		this.listeners = [];
		this.id = "";
		this.value = "";
		this.placeholder = "";
		this.autocomplete = "";
		this.spellcheck = true;
		this.title = "";
		this.tabIndex = 0;
	}

	get children() {
		return this.childNodes.filter((child) => child.nodeType === 1);
	}

	get isConnected() {
		let node = this;
		while (node !== null) {
			if (node === this.ownerDocument) return true;
			node = node.parentElement;
		}
		return false;
	}

	get textContent() {
		if (this.nodeType === 3) return this._text ?? "";
		return this.childNodes.map((child) => child.textContent).join("");
	}

	set textContent(value) {
		if (this.nodeType === 3) {
			this._text = String(value);
			return;
		}
		this.childNodes = [];
		if (value !== "") this.appendChild(this.ownerDocument.createTextNode(String(value)));
	}

	append(...nodes) {
		for (const node of nodes) this.appendChild(typeof node === "string" ? this.ownerDocument.createTextNode(node) : node);
	}

	appendChild(node) {
		if (node.parentElement !== null) node.remove();
		node.parentElement = this;
		this.childNodes.push(node);
		return node;
	}

	insertBefore(node, reference) {
		if (node.parentElement !== null) node.remove();
		const at = this.childNodes.indexOf(reference);
		if (at === -1) return this.appendChild(node);
		node.parentElement = this;
		this.childNodes.splice(at, 0, node);
		return node;
	}

	removeChild(node) {
		const at = this.childNodes.indexOf(node);
		if (at !== -1) this.childNodes.splice(at, 1);
		node.parentElement = null;
		return node;
	}

	remove() {
		if (this.parentElement !== null) this.parentElement.removeChild(this);
	}

	contains(node) {
		let current = node;
		while (current !== null) {
			if (current === this) return true;
			current = current.parentElement;
		}
		return false;
	}

	setAttribute(name, value) {
		this.attributes.set(name, String(value));
	}

	getAttribute(name) {
		return this.attributes.has(name) ? this.attributes.get(name) : null;
	}

	hasAttribute(name) {
		return this.attributes.has(name);
	}

	removeAttribute(name) {
		this.attributes.delete(name);
	}

	toggleAttribute(name, force) {
		if (force === true) this.setAttribute(name, "");
		else if (force === false) this.removeAttribute(name);
		else if (this.hasAttribute(name)) this.removeAttribute(name);
		else this.setAttribute(name, "");
	}

	matches(selector) {
		return selectorMatches(this, selector);
	}

	closest(selector) {
		let node = this;
		while (node !== null && node.nodeType === 1) {
			if (node.matches(selector)) return node;
			node = node.parentElement;
		}
		return null;
	}

	querySelectorAll(selector) {
		const found = [];
		const walk = (node) => {
			for (const child of node.childNodes) {
				if (child.nodeType !== 1) continue;
				if (selectorMatches(child, selector)) found.push(child);
				walk(child);
			}
		};
		walk(this);
		return found;
	}

	querySelector(selector) {
		return this.querySelectorAll(selector)[0] ?? null;
	}

	addEventListener(type, handler, options) {
		const capture = options === true || (options !== undefined && options !== null && options.capture === true);
		const once = options !== undefined && options !== null && options.once === true;
		this.listeners.push({ type, handler, capture, once });
	}

	removeEventListener(type, handler, options) {
		const capture = options === true || (options !== undefined && options !== null && options.capture === true);
		this.listeners = this.listeners.filter((listener) => !(listener.type === type && listener.handler === handler && listener.capture === capture));
	}

	dispatchEvent(event) {
		if (event.target === undefined || event.target === null) event.target = this;
		const path = [];
		let node = event.target;
		while (node !== null) {
			path.push(node);
			node = node.parentElement;
		}
		const call = (current, capture) => {
			for (const listener of [...current.listeners]) {
				if (listener.type !== event.type || listener.capture !== capture) continue;
				event.currentTarget = current;
				if (listener.once) current.removeEventListener(event.type, listener.handler, listener.capture);
				listener.handler.call(current, event);
				if (event.immediateStopped === true) return false;
			}
			return true;
		};
		for (const current of [...path].reverse()) {
			if (!call(current, true)) return !event.defaultPrevented;
			if (event.propagationStopped === true) return !event.defaultPrevented;
		}
		for (const current of path) {
			if (!call(current, false)) break;
			if (event.propagationStopped === true) break;
		}
		return !event.defaultPrevented;
	}

	focus() {
		this.ownerDocument.activeElement = this;
	}

	blur() {
		if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body;
	}

	getBoundingClientRect() {
		return { left: 20, top: 100, right: 220, bottom: 130, width: 200, height: 30 };
	}
}

class FakeText extends FakeNode {
	constructor(document, text) {
		super(document, 3, "");
		this._text = String(text);
	}
}

class FakeDocument extends FakeNode {
	constructor() {
		super(null, 9, "");
		this.ownerDocument = this;
		this.baseURI = "http://localhost/";
		this.documentElement = new FakeNode(this, 1, "html");
		this.documentElement.lang = "en";
		this.head = new FakeNode(this, 1, "head");
		this.body = new FakeNode(this, 1, "body");
		this.documentElement.append(this.head, this.body);
		this.appendChild(this.documentElement);
		this.activeElement = this.body;
	}

	createElement(tagName) {
		return new FakeNode(this, 1, tagName);
	}

	createTextNode(text) {
		return new FakeText(this, text);
	}

	createRange() {
		return {
			startNode: null,
			startOffset: 0,
			endNode: null,
			endOffset: 0,
			setStart(node, offset) {
				this.startNode = node;
				this.startOffset = offset;
			},
			setEnd(node, offset) {
				this.endNode = node;
				this.endOffset = offset;
			},
		};
	}

	getElementById(id) {
		return this.querySelectorAll("[id]").find((element) => element.id === id) ?? null;
	}
}

// ---------------------------------------------------------------------------
// Harness: sandbox, fake timers, observers and the test seam.
// ---------------------------------------------------------------------------

function event(type, target, props = {}) {
	return {
		type,
		target,
		currentTarget: null,
		defaultPrevented: false,
		propagationStopped: false,
		immediateStopped: false,
		preventDefault() {
			this.defaultPrevented = true;
		},
		stopPropagation() {
			this.propagationStopped = true;
		},
		stopImmediatePropagation() {
			this.immediateStopped = true;
			this.propagationStopped = true;
		},
		...props,
	};
}

function boot({ mode = "mobile", width = 390 } = {}) {
	const document = new FakeDocument();
	const timers = new Map();
	let timerId = 0;
	const frames = [];
	const observers = new Set();
	const copied = [];
	const clipboard = {
		writeText: async (text) => {
			copied.push(text);
		},
	};
	let narrowMatches = width <= 767;
	const media = () => ({
		matches: narrowMatches && media.lastQuery === NARROW,
		addEventListener() {},
		removeEventListener() {},
	});
	media.lastQuery = "";
	const matchMedia = (query) => {
		media.lastQuery = query;
		return media();
	};
	const storage = new Map();
	const sandbox = {
		document,
		window: null,
		globalThis: null,
		console,
		URL,
		URLSearchParams,
		Intl,
		TextEncoder,
		TextDecoder,
		AbortController,
		structuredClone,
		navigator: { userAgent: "test", platform: "test", maxTouchPoints: 1, clipboard },
		localStorage: {
			getItem: (key) => (storage.has(key) ? storage.get(key) : null),
			setItem: (key, value) => storage.set(key, String(value)),
			removeItem: (key) => storage.delete(key),
		},
		matchMedia,
		setTimeout: (callback, ms) => {
			timerId += 1;
			timers.set(timerId, { callback, ms });
			return timerId;
		},
		clearTimeout: (id) => timers.delete(id),
		setInterval: () => 0,
		clearInterval: () => {},
		requestAnimationFrame: (callback) => {
			frames.push(callback);
			return frames.length;
		},
		cancelAnimationFrame: () => {},
		queueMicrotask,
		getComputedStyle: () => ({ paddingLeft: "0px", paddingRight: "0px", overflowY: "visible" }),
		MutationObserver: class {
			constructor(callback) {
				this.callback = callback;
				this.active = false;
			}
			observe() {
				this.active = true;
				observers.add(this);
			}
			disconnect() {
				this.active = false;
				observers.delete(this);
			}
		},
		Highlight: class {
			constructor(...ranges) {
				this.ranges = ranges;
			}
		},
		CSS: { highlights: new Map() },
		Element: class {},
		HTMLElement: class {},
		Node: class {},
		Event: class {},
		PointerEvent: class {},
		KeyboardEvent: class {},
		innerWidth: width,
		innerHeight: 844,
		performance: { now: () => 0 },
		__RDSH_DEVICE_MODE__: mode,
		__RDSH_PWA_COPY__: COPY,
		__RDSH_PWA_LANG__: "en",
		__RDSH_WORKSPACE_TEST__: {},
	};
	sandbox.window = sandbox;
	sandbox.globalThis = sandbox;
	sandbox.window.addEventListener = (type, handler) => document.addEventListener(type, handler);
	sandbox.window.removeEventListener = (type, handler) => document.removeEventListener(type, handler);

	vm.createContext(sandbox);
	let definition;
	sandbox.window.__ModuleLoader__ = { load: (value) => { definition = value; } };
	vm.runInContext(CLIENT, sandbox, { filename: "client.js" });
	const plugin = definition.factory((name) => {
		if (name === "react") {
			return {
				createElement: () => ({}),
				useState: () => [null, () => {}],
				useEffect: () => {},
				useRef: () => ({ current: null }),
				useMemo: (factory) => factory(),
				useCallback: (factory) => factory,
				memo: (value) => value,
			};
		}
		if (name === "react-dom/client") return { createRoot: () => ({ render() {} }) };
		return {};
	});
	const ctx = {
		effect: () => () => {},
		inject: () => undefined,
		slots: { inject: () => undefined, register: () => () => {} },
		get: () => undefined,
		on: () => () => {},
	};
	plugin.apply(ctx);
	const tools = sandbox.__RDSH_WORKSPACE_TEST__?.workspace;
	// Desktop builds no plugin, so the seam is never installed.
	if (mode !== "mobile") assert.equal(tools, undefined, "a desktop boot installed the workspace tools");
	else assert.ok(tools, "the workspace test seam was not installed");

	const reset = () => {
		// A desktop boot has no tools; reset only clears this harness's state.
		tools?.disposeWorkspaceTools();
		document.body.childNodes = [];
		document.activeElement = document.body;
		sandbox.CSS.highlights.clear();
		timers.clear();
		observers.clear();
		frames.length = 0;
		copied.length = 0;
		storage.clear();
		narrowMatches = width <= 767;
	};

	const runTimers = (ms) => {
		for (const [id, timer] of [...timers]) {
			if (ms !== undefined && timer.ms !== ms) continue;
			timers.delete(id);
			timer.callback();
		}
	};
	const flushObservers = () => {
		for (const observer of [...observers]) {
			if (observer.active) observer.callback([]);
		}
	};
	const runFrames = () => {
		while (frames.length > 0) frames.shift()();
	};
	const setNarrow = (value) => {
		narrowMatches = value;
	};

	return { sandbox, document, definition, tools, timers, copied, reset, runTimers, flushObservers, runFrames, setNarrow };
}

function element(document, tagName, attributes = {}, children = []) {
	const node = document.createElement(tagName);
	for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
	for (const child of children) node.append(child);
	return node;
}

function buttonWithName(document, name, attributes = {}) {
	const button = element(document, "button", attributes);
	const label = element(document, "span");
	label.append(document.createTextNode(name));
	button.append(element(document, "svg"), label);
	return button;
}

/**
 * The upstream picker portal: [role=menu] (the shared Menu surface, marked by
 * data-menu-material) > material + viewport + footer. The footer label is a
 * parameter so a test can use the translated one: the picker is recognized
 * without reading it (#39).
 */
function workspaceMenu(document, names, addLabel = "Add workspace…") {
	const menu = element(document, "div", { role: "menu", "data-menu-material": "translucent" });
	const material = element(document, "div", { "aria-hidden": "true" });
	const viewport = element(document, "div", { role: "presentation" });
	for (const name of names) {
		const wrap = element(document, "div");
		wrap.append(buttonWithName(document, name, { role: "menuitem" }));
		viewport.append(wrap);
	}
	const footer = element(document, "div", { role: "presentation" });
	const footerWrap = element(document, "div");
	footerWrap.append(buttonWithName(document, addLabel, { role: "menuitem" }));
	footer.append(footerWrap);
	menu.append(material, viewport, footer);
	return { menu, viewport, footer, material };
}

/**
 * The upstream right-panel files tree, using its real data hooks:
 * root + root PathLabel + body > nested li rows, with absolute paths.
 */
function filesTree(document) {
	const panel = element(document, "div", { "data-rdsh-rightpanel": "" });
	const root = element(document, "div", { "data-files-state": "tree", "data-files-root": "/work/repo" });
	const header = element(document, "div");
	const path = element(document, "span", { "data-path-label": "", "data-files-path": "" });
	path.title = "/work/repo";
	const pathText = element(document, "span");
	pathText.append(document.createTextNode("/work/repo"));
	path.append(pathText);
	header.append(path);
	const body = element(document, "div", { "data-files-body": "" });
	const list = element(document, "ul");

	const src = element(document, "li", { "data-files-entry": "directory", "data-files-path": "/work/repo/src" });
	const srcButton = buttonWithName(document, "src");
	const children = element(document, "ul");
	const app = element(document, "li", { "data-files-entry": "file", "data-files-path": "/work/repo/src/app.js" });
	app.append(buttonWithName(document, "app.js"));
	children.append(app);
	src.append(srcButton, children);

	const readme = element(document, "li", { "data-files-entry": "file", "data-files-path": "/work/repo/README.md" });
	readme.append(buttonWithName(document, "README.md"));
	list.append(src, readme);
	body.append(list);
	root.append(header, body);
	panel.append(root);
	document.body.append(panel);
	return { panel, root, header, path, body, src, app, readme };
}

// ---------------------------------------------------------------------------
// #39 — picker: sync decoration, no inline anchoring, cleanup
// ---------------------------------------------------------------------------

test("the browser module id follows the current package namespace", () => {
	const run = boot();
	assert.equal(run.definition.id, "dsh-mobile-maxxing");
});

test("#39 the picker search row is in the menu before its first paint", () => {
	const run = boot();
	run.reset();
	const { menu, viewport } = workspaceMenu(run.document, ["Alpha", "Beta"]);
	run.tools.beginWorkspacePicker();
	run.document.body.appendChild(menu);
	// The observer callback is the pre-paint microtask: no rAF was run yet.
	run.flushObservers();

	const search = menu.querySelector("[data-rdsh-workspace-search]");
	assert.ok(search, "the search row was not inserted");
	assert.equal(search.parentElement, menu, "the search row is not inside the menu");
	assert.equal(menu.children.indexOf(search) + 1, menu.children.indexOf(viewport), "the search row is not directly before the list");
	assert.equal(search.querySelector("input").placeholder, COPY.en["workspace.search.placeholder"]);
	assert.equal(menu.style.transform, undefined, "the picker was transformed instead of left to upstream");
	assert.equal(menu.style.maxHeight, undefined, "the picker height was written inline after mount");
	assert.equal(menu.getAttribute("data-rdsh-workspace-menu"), "", "the static height hook was not applied");
	assert.equal(viewport.getAttribute("data-rdsh-workspace-viewport"), "", "the list viewport hook was not applied");
	assert.equal(run.sandbox.CSS.highlights.size, 0, "the picker does not use the file-search highlight");
	// The row is out of flow: the menu's measured box comes from the band the
	// stylesheet reserves, not from this element.
	assert.equal(search.hasAttribute("data-rdsh-workspace-search"), true);
	assert.equal(menu.children[0].getAttribute("aria-hidden"), "true", "the fixture lost upstream's material layer");
});

test("#39 the opening click reserves the search band before the menu mounts", () => {
	const run = boot();
	run.reset();
	const html = run.document.documentElement;
	const { menu } = workspaceMenu(run.document, ["Alpha", "Beta"]);
	// The click handler calls beginWorkspacePicker() in the capture phase,
	// before React can mount the portal. The attribute must therefore exist
	// while the portal is still absent, so the first offsetHeight/offsetWidth
	// read already sees the reserved band.
	run.tools.beginWorkspacePicker();
	assert.equal(html.getAttribute("data-rdsh-workspace-picking"), "", "the first placement was not armed");
	assert.equal(run.document.querySelector('[role="menu"]'), null, "the fixture mounted the portal too early");

	run.document.body.appendChild(menu);
	run.flushObservers();
	assert.ok(menu.querySelector("[data-rdsh-workspace-search]"), "the armed portal was not decorated");
	assert.equal(menu.getAttribute("data-rdsh-workspace-menu"), "", "the tagged geometry hook is missing");
	assert.equal(html.hasAttribute("data-rdsh-workspace-picking"), false, "the armed state outlived the tagged menu");
});

test("#39 a keyboard-opened session-less composer is armed before the menu mounts", () => {
	const run = boot();
	run.reset();
	// The hero draft editor opens the picker from Enter/Space without a click,
	// so the click capture never sees it. Both keys must arm the reservation.
	const card = element(run.document, "div", { "data-composer-card": "" });
	const editor = element(run.document, "div", {
		"data-composer-input": "",
		"aria-haspopup": "menu",
		"aria-expanded": "false",
	});
	card.append(editor);
	run.document.body.append(card);
	const key = (value) => event("keydown", editor, { key: value, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false });

	run.tools.armWorkspacePickerFromKey(key("Enter"));
	assert.equal(run.document.documentElement.getAttribute("data-rdsh-workspace-picking"), "", "Enter did not arm the reservation");
	run.tools.clearWorkspacePicker();

	run.tools.armWorkspacePickerFromKey(key(" "));
	assert.equal(run.document.documentElement.getAttribute("data-rdsh-workspace-picking"), "", "Space did not arm the reservation");
	run.tools.clearWorkspacePicker();

	// A normal session composer has no popup wiring: typing a space must not
	// reserve the picker band or arm its observer.
	const plain = element(run.document, "div", { "data-composer-input": "" });
	run.document.body.append(plain);
	run.tools.armWorkspacePickerFromKey(event("keydown", plain, { key: " " }));
	assert.equal(run.document.documentElement.hasAttribute("data-rdsh-workspace-picking"), false, "a plain space armed the picker");
	// The capture handler the browser installs must call this same path.
	assert.match(CLIENT, /function onKeyDownCapture\(event\) \{[\s\S]{0,400}armWorkspacePickerFromKey\(event\)/, "the keydown listener does not arm the picker");
});

test("#39 the reserved band is released when no portal arrives, or on teardown", () => {
	const timeout = boot();
	timeout.reset();
	timeout.tools.beginWorkspacePicker();
	assert.equal(timeout.document.documentElement.hasAttribute("data-rdsh-workspace-picking"), true);
	timeout.runTimers(1500);
	assert.equal(timeout.document.documentElement.hasAttribute("data-rdsh-workspace-picking"), false, "the timeout kept the menu armed");

	const cleared = boot();
	cleared.reset();
	cleared.tools.beginWorkspacePicker();
	cleared.tools.clearWorkspacePicker();
	assert.equal(cleared.document.documentElement.hasAttribute("data-rdsh-workspace-picking"), false, "clear kept the menu armed");

	const disposed = boot();
	disposed.reset();
	disposed.tools.beginWorkspacePicker();
	disposed.tools.disposeWorkspaceTools();
	assert.equal(disposed.document.documentElement.hasAttribute("data-rdsh-workspace-picking"), false, "teardown kept the menu armed");
});

test("#39 picker filter, no-match row, Escape and removal", () => {
	const run = boot();
	run.reset();
	const { menu, viewport } = workspaceMenu(run.document, ["Alpha workspace", "Beta workspace"]);
	run.tools.beginWorkspacePicker();
	run.document.body.appendChild(menu);
	run.flushObservers();
	const input = menu.querySelector("input");
	const empty = menu.querySelector("[data-rdsh-workspace-empty]");
	const rows = [...viewport.querySelectorAll("button[role=menuitem]")].map((button) => button.parentElement);

	input.value = "beta";
	input.dispatchEvent(event("input", input));
	assert.equal(rows[0].hasAttribute("data-rdsh-workspace-hidden"), true, "the non-matching row stayed visible");
	assert.equal(rows[1].hasAttribute("data-rdsh-workspace-hidden"), false, "the matching row was hidden");
	assert.equal(empty.hidden, true, "the no-match row is shown while a row matches");

	input.value = "zzz";
	input.dispatchEvent(event("input", input));
	assert.equal(empty.hidden, false, "the no-match row is not shown for zero hits");
	assert.equal(empty.textContent, COPY.en["workspace.search.noMatches"]);

	// First Escape clears the query; a second one is left to upstream.
	const escape = event("keydown", input, { key: "Escape" });
	input.dispatchEvent(escape);
	assert.equal(input.value, "", "Escape did not clear the query");
	assert.equal(escape.defaultPrevented, true, "the clear Escape was not consumed");
	assert.equal(rows[1].hasAttribute("data-rdsh-workspace-hidden"), false, "clearing did not restore every row");

	run.tools.clearWorkspacePicker();
	assert.equal(menu.querySelector("[data-rdsh-workspace-search]"), null, "the search row survived cleanup");
	assert.equal(menu.hasAttribute("data-rdsh-workspace-menu"), false, "the menu hook survived cleanup");
	assert.equal(viewport.hasAttribute("data-rdsh-workspace-viewport"), false, "the viewport hook survived cleanup");
	assert.deepEqual(run.tools.filesSearch(), null);
});

test("#39 the picker is recognized without an English footer label", () => {
	const run = boot();
	run.reset();
	// zh: hero.chooseWorkspace is "选择工作区" and menu.addWorkspace is
	// "添加工作区…". The old English readers left this whole panel undecorated.
	const row = element(run.document, "div");
	const chip = element(run.document, "button", {
		"aria-label": "选择工作区",
		"aria-haspopup": "menu",
		"aria-expanded": "true",
	});
	chip.append(element(run.document, "svg"), element(run.document, "span"), element(run.document, "svg"));
	row.append(chip, element(run.document, "div", { "data-slot": "conversation.hero.workspace" }));
	run.document.body.append(row);
	const { menu, viewport } = workspaceMenu(run.document, ["Alpha", "Beta"], "添加工作区…");
	run.document.body.append(menu);
	run.tools.decorateWorkspacePicker();
	const search = menu.querySelector("[data-rdsh-workspace-search]");
	assert.ok(search, "the localized picker menu was not recognized");
	assert.equal(search.parentElement, menu, "the search row is not inside the menu");
	assert.equal(menu.getAttribute("data-rdsh-workspace-menu"), "", "the menu hook was not applied");
	assert.equal(viewport.getAttribute("data-rdsh-workspace-viewport"), "", "the list viewport hook was not applied");
});

test("#39 the picker triggers are recognized without an English aria-label", () => {
	const run = boot();
	run.reset();
	// zh: hero.chooseWorkspace is "选择工作区". The old aria-label selector only
	// matched the English controls, so a zh UI never armed the picker.
	const row = element(run.document, "div");
	const chip = element(run.document, "button", {
		"aria-label": "选择工作区",
		"aria-haspopup": "menu",
		"aria-expanded": "false",
	});
	chip.append(element(run.document, "svg"), element(run.document, "span"), element(run.document, "svg"));
	// The picker's own slot outlet is the chip's sibling in the hero row.
	row.append(chip, element(run.document, "div", { "data-slot": "conversation.hero.workspace" }));
	run.document.body.append(row);
	assert.equal(run.tools.workspaceTriggerControl(chip), chip, "the localized hero chip was not recognized");

	// The session-less composer is the other entry: the draft editor inside the
	// composer card.
	const card = element(run.document, "div", { "data-composer-card": "" });
	const editor = element(run.document, "div", { "aria-label": "选择工作区", "aria-haspopup": "menu", "aria-expanded": "false", "data-composer-input": "" });
	card.append(editor);
	run.document.body.append(card);
	assert.equal(run.tools.workspaceTriggerControl(editor), editor, "the localized composer trigger was not recognized");

	// A submenu row or a popup without the picker's open state is not a trigger.
	const submenu = element(run.document, "button", { role: "menuitem", "aria-haspopup": "menu", "aria-expanded": "false" });
	const plain = element(run.document, "button", { "aria-haspopup": "menu" });
	run.document.body.append(submenu, plain);
	assert.equal(run.tools.workspaceTriggerControl(submenu), null, "a submenu row was treated as the picker trigger");
	assert.equal(run.tools.workspaceTriggerControl(plain), null, "a popup without aria-expanded was treated as the picker trigger");

	// The recognized trigger still arms the pre-paint decoration in a zh UI.
	run.tools.beginWorkspacePicker();
	const { menu } = workspaceMenu(run.document, ["Alpha"], "添加工作区…");
	run.document.body.append(menu);
	run.flushObservers();
	assert.ok(menu.querySelector("[data-rdsh-workspace-search]"), "a zh-UI picker was not decorated");
});

test("#39 a label-only footer menu is not mistaken for the picker", () => {
	const run = boot();
	run.reset();
	// The plugin market's menus also use a footer; their rows carry no icon.
	const menu = element(run.document, "div", { role: "menu" });
	const viewport = element(run.document, "div", { role: "presentation" });
	for (const name of ["Index A", "Index B"]) {
		const wrap = element(run.document, "div");
		const button = element(run.document, "button", { role: "menuitem" });
		const label = element(run.document, "span");
		label.append(run.document.createTextNode(name));
		button.append(label);
		wrap.append(button);
		viewport.append(wrap);
	}
	const footer = element(run.document, "div", { role: "presentation" });
	const footerWrap = element(run.document, "div");
	footerWrap.append(buttonWithName(run.document, "Manage sources", { role: "menuitem" }));
	footer.append(footerWrap);
	menu.append(viewport, footer);
	run.document.body.append(menu);

	run.tools.beginWorkspacePicker();
	run.flushObservers();
	assert.equal(menu.querySelector("[data-rdsh-workspace-search]"), null, "an unrelated footer menu received the workspace search row");
	assert.equal(menu.hasAttribute("data-rdsh-workspace-menu"), false, "an unrelated footer menu was tagged as the picker");
});

test("#39 a footer-less picker is recognized from its open trigger", () => {
	const run = boot();
	run.reset();
	// Without the directory-flow entry point upstream renders no footer, only
	// the workspace rows.
	const row = element(run.document, "div");
	const chip = element(run.document, "button", {
		"aria-label": "选择工作区",
		"aria-haspopup": "menu",
		"aria-expanded": "false",
	});
	row.append(chip, element(run.document, "div", { "data-slot": "conversation.hero.workspace" }));
	run.document.body.append(row);
	const menu = element(run.document, "div", { role: "menu" });
	const viewport = element(run.document, "div", { role: "presentation" });
	const wrap = element(run.document, "div");
	wrap.append(buttonWithName(run.document, "Alpha", { role: "menuitem" }));
	viewport.append(wrap);
	menu.append(viewport);
	run.document.body.append(menu);

	run.tools.decorateWorkspacePicker();
	assert.equal(menu.querySelector("[data-rdsh-workspace-search]"), null, "the picker was decorated while its trigger reported it closed");

	chip.setAttribute("aria-expanded", "true");
	run.tools.decorateWorkspacePicker();
	assert.ok(menu.querySelector("[data-rdsh-workspace-search]"), "the open picker without a footer was not decorated");
});

test("#39 another icon menu is not decorated while the picker is closed", () => {
	const run = boot();
	run.reset();
	// open-in-app renders icon rows plus an icon footer row too; with no
	// picker trigger reporting it open, that menu must stay untouched.
	const row = element(run.document, "div");
	const chip = element(run.document, "button", {
		"aria-label": "选择工作区",
		"aria-haspopup": "menu",
		"aria-expanded": "false",
	});
	row.append(chip, element(run.document, "div", { "data-slot": "conversation.hero.workspace" }));
	run.document.body.append(row);
	const { menu } = workspaceMenu(run.document, ["App A", "App B"], "Reveal in folder");
	run.document.body.append(menu);

	run.tools.decorateWorkspacePicker();
	assert.equal(menu.querySelector("[data-rdsh-workspace-search]"), null, "an unrelated icon menu received the workspace search row");
	assert.equal(menu.hasAttribute("data-rdsh-workspace-menu"), false, "an unrelated icon menu was tagged as the picker");
});

// ---------------------------------------------------------------------------
// #42 — long press copy menu
// ---------------------------------------------------------------------------

test("#42 a 500ms press on a file copies its absolute path and name", async () => {
	const run = boot();
	run.reset();
	const tree = filesTree(run.document);
	run.tools.decorateWorkspaceFiles();
	run.tools.installWorkspaceTools();

	const fileButton = tree.readme.querySelector("button");
	run.document.dispatchEvent(event("pointerdown", fileButton, { pointerType: "touch", clientX: 10, clientY: 10 }));
	run.runTimers(500);
	const menu = run.document.querySelector("[data-rdsh-file-menu]");
	assert.ok(menu, "the long press did not open a menu");
	assert.equal(menu.getAttribute("role"), "menu");
	const items = [...menu.querySelectorAll("button")];
	assert.deepEqual(items.map((item) => item.textContent), [COPY.en["files.menu.copyPath"], COPY.en["files.menu.copyName"]]);
	assert.equal(run.document.activeElement, items[0], "the first menu item was not focused");

	items[0].dispatchEvent(event("click", items[0]));
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(run.copied, ["/work/repo/README.md"], "the absolute path was not copied");
	assert.equal(run.document.querySelector("[data-rdsh-file-menu]"), null, "the menu stayed open after choosing");
});

test("#42 the root path menu copies the real tree root", async () => {
	const run = boot();
	run.reset();
	const tree = filesTree(run.document);
	run.tools.decorateWorkspaceFiles();
	run.tools.installWorkspaceTools();

	const inner = tree.path.querySelector("span");
	run.document.dispatchEvent(event("pointerdown", inner, { pointerType: "touch", clientX: 10, clientY: 10 }));
	run.runTimers(500);
	const menu = run.document.querySelector("[data-rdsh-file-menu]");
	assert.ok(menu, "the root path long press did not open a menu");
	const items = [...menu.querySelectorAll("button")];
	assert.equal(items.length, 1, "the root path menu should only offer copy path");
	items[0].dispatchEvent(event("click", items[0]));
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(run.copied, ["/work/repo"], "the menu invented or relativised the root path");
});

test("#42 movement, pointercancel and scroll cancel the press", () => {
	const run = boot();
	run.reset();
	const tree = filesTree(run.document);
	run.tools.decorateWorkspaceFiles();
	run.tools.installWorkspaceTools();
	const fileButton = tree.readme.querySelector("button");

	run.document.dispatchEvent(event("pointerdown", fileButton, { pointerType: "touch", clientX: 10, clientY: 10 }));
	run.document.dispatchEvent(event("pointermove", fileButton, { pointerType: "touch", clientX: 40, clientY: 10 }));
	run.runTimers(500);
	assert.equal(run.document.querySelector("[data-rdsh-file-menu]"), null, "a 30px move still opened the menu");

	run.document.dispatchEvent(event("pointerdown", fileButton, { pointerType: "touch", clientX: 10, clientY: 10 }));
	run.document.dispatchEvent(event("pointercancel", fileButton, { pointerType: "touch" }));
	run.runTimers(500);
	assert.equal(run.document.querySelector("[data-rdsh-file-menu]"), null, "pointercancel still opened the menu");

	run.document.dispatchEvent(event("pointerdown", fileButton, { pointerType: "touch", clientX: 10, clientY: 10 }));
	run.document.dispatchEvent(event("scroll", run.document.body));
	run.runTimers(500);
	assert.equal(run.document.querySelector("[data-rdsh-file-menu]"), null, "scrolling still opened the menu");

	const late = event("pointerdown", fileButton, { pointerType: "touch", clientX: 10, clientY: 10 });
	run.document.dispatchEvent(late);
	run.document.dispatchEvent(event("pointermove", fileButton, { pointerType: "touch", clientX: 10, clientY: 10 }));
	run.runTimers(500);
	assert.ok(run.document.querySelector("[data-rdsh-file-menu]"), "a press that did not move should still open");
});

test("#42 Escape closes the menu and returns focus; outside press closes it", () => {
	const run = boot();
	run.reset();
	const tree = filesTree(run.document);
	run.tools.decorateWorkspaceFiles();
	run.tools.installWorkspaceTools();
	const fileButton = tree.readme.querySelector("button");

	run.document.dispatchEvent(event("pointerdown", fileButton, { pointerType: "touch", clientX: 10, clientY: 10 }));
	run.runTimers(500);
	const menu = run.document.querySelector("[data-rdsh-file-menu]");
	assert.ok(menu, "no menu for the Escape test");
	const escape = event("keydown", run.document.activeElement, { key: "Escape" });
	run.document.dispatchEvent(escape);
	assert.equal(run.document.querySelector("[data-rdsh-file-menu]"), null, "Escape did not close the menu");
	assert.equal(run.document.activeElement, fileButton, "focus did not return to the long-pressed row");

	run.document.dispatchEvent(event("pointerdown", fileButton, { pointerType: "touch", clientX: 10, clientY: 10 }));
	run.runTimers(500);
	assert.ok(run.document.querySelector("[data-rdsh-file-menu]"), "the second menu did not open");
	run.document.dispatchEvent(event("pointerdown", tree.body, { pointerType: "touch" }));
	assert.equal(run.document.querySelector("[data-rdsh-file-menu]"), null, "an outside press did not close the menu");
});

test("#42 a press on a menu item is not dismissed before its click", () => {
	const run = boot();
	run.reset();
	const tree = filesTree(run.document);
	run.tools.decorateWorkspaceFiles();
	run.tools.installWorkspaceTools();
	const fileButton = tree.readme.querySelector("button");

	run.document.dispatchEvent(event("pointerdown", fileButton, { pointerType: "touch", clientX: 10, clientY: 10 }));
	run.runTimers(500);
	const menu = run.document.querySelector("[data-rdsh-file-menu]");
	assert.ok(menu, "the long press did not open the menu");

	// The item's own pointerdown is capture-routed through the document first.
	const item = menu.querySelector("button");
	run.document.dispatchEvent(event("pointerdown", item, { pointerType: "touch", clientX: 20, clientY: 20 }));
	assert.ok(run.document.querySelector("[data-rdsh-file-menu]"), "the item press dismissed its own menu");

	item.dispatchEvent(event("click", item));
	assert.equal(run.document.querySelector("[data-rdsh-file-menu]"), null, "the item action did not close the menu");
});

test("#42 long press does not let the closing tap activate the row", () => {
	const run = boot();
	run.reset();
	const tree = filesTree(run.document);
	run.tools.decorateWorkspaceFiles();
	run.tools.installWorkspaceTools();
	let clicks = 0;
	tree.readme.querySelector("button").addEventListener("click", () => {
		clicks += 1;
	});

	run.document.dispatchEvent(event("pointerdown", tree.readme.querySelector("button"), { pointerType: "touch", clientX: 10, clientY: 10 }));
	run.runTimers(500);
	const click = event("click", tree.readme.querySelector("button"));
	tree.readme.querySelector("button").dispatchEvent(click);
	assert.equal(clicks, 0, "the tap that ended the long press reached the row");
	assert.equal(click.defaultPrevented, true, "the long-press click was not cancelled");
});

test("#42 rows in another tree or outside the decorated tree are not copy targets", () => {
	const run = boot();
	run.reset();
	const first = filesTree(run.document);
	const second = filesTree(run.document);
	run.tools.decorateWorkspaceFiles();
	run.tools.installWorkspaceTools();

	run.document.dispatchEvent(event("pointerdown", second.readme.querySelector("button"), { pointerType: "touch", clientX: 10, clientY: 10 }));
	run.runTimers(500);
	assert.equal(run.document.querySelector("[data-rdsh-file-menu]"), null, "a row in a second tree opened a menu");

	const strayRow = element(run.document, "li", { "data-files-entry": "file", "data-files-path": "/work/repo/stray.js" });
	strayRow.append(buttonWithName(run.document, "stray.js"));
	run.document.body.append(strayRow);
	run.document.dispatchEvent(event("pointerdown", strayRow.querySelector("button"), { pointerType: "touch", clientX: 10, clientY: 10 }));
	run.runTimers(500);
	assert.equal(run.document.querySelector("[data-rdsh-file-menu]"), null, "a row outside the tree opened a menu");

	run.document.dispatchEvent(event("pointerdown", first.readme.querySelector("button"), { pointerType: "touch", clientX: 10, clientY: 10 }));
	run.runTimers(500);
	assert.ok(run.document.querySelector("[data-rdsh-file-menu]"), "the decorated tree stopped opening menus");
});

test("#42 another finger cannot cancel or replace the running long press", () => {
	const run = boot();
	run.reset();
	const tree = filesTree(run.document);
	run.tools.decorateWorkspaceFiles();
	run.tools.installWorkspaceTools();
	const button = tree.readme.querySelector("button");

	run.document.dispatchEvent(event("pointerdown", button, { pointerType: "touch", pointerId: 1, isPrimary: true, clientX: 10, clientY: 10 }));
	run.document.dispatchEvent(event("pointermove", button, { pointerType: "touch", pointerId: 2, isPrimary: false, clientX: 60, clientY: 60 }));
	run.document.dispatchEvent(event("pointerup", button, { pointerType: "touch", pointerId: 2, isPrimary: false }));
	run.runTimers(500);
	assert.ok(run.document.querySelector("[data-rdsh-file-menu]"), "a second finger cancelled the press");

	run.tools.disposeWorkspaceTools();
	run.reset();
	const again = filesTree(run.document);
	run.tools.decorateWorkspaceFiles();
	run.tools.installWorkspaceTools();
	const againButton = again.readme.querySelector("button");
	run.document.dispatchEvent(event("pointerdown", againButton, { pointerType: "touch", pointerId: 3, isPrimary: true, clientX: 10, clientY: 10 }));
	run.document.dispatchEvent(event("pointerdown", againButton, { pointerType: "touch", pointerId: 4, isPrimary: false, clientX: 12, clientY: 12 }));
	run.runTimers(500);
	const menu = run.document.querySelector("[data-rdsh-file-menu]");
	assert.ok(menu, "the primary press was lost");
});

test("#42 Tab leaves the menu instead of trapping focus", () => {
	const run = boot();
	run.reset();
	const tree = filesTree(run.document);
	run.tools.decorateWorkspaceFiles();
	run.tools.installWorkspaceTools();
	const button = tree.readme.querySelector("button");
	run.document.dispatchEvent(event("pointerdown", button, { pointerType: "touch", clientX: 10, clientY: 10 }));
	run.runTimers(500);
	const menu = run.document.querySelector("[data-rdsh-file-menu]");
	const items = [...menu.querySelectorAll("button")];
	menu.dispatchEvent(event("keydown", menu, { key: "ArrowDown" }));
	assert.equal(run.document.activeElement, items[1], "ArrowDown did not move within the menu");

	const tab = event("keydown", items[1], { key: "Tab" });
	items[1].dispatchEvent(tab);
	assert.equal(run.document.querySelector("[data-rdsh-file-menu]"), null, "Tab did not close the menu");
	assert.equal(tab.defaultPrevented, false, "Tab was consumed instead of moving to the next element");
	assert.equal(run.document.activeElement, button, "Tab did not put focus back on the trigger");
});


test("#43 button and Enter run the same explicit search, and empty clears", () => {
	const run = boot();
	run.reset();
	const tree = filesTree(run.document);
	run.tools.decorateWorkspaceFiles();
	const search = tree.root.querySelector("[data-rdsh-files-search]");
	assert.ok(search, "the search row was not inserted");
	const input = search.querySelector("input");
	const submit = search.querySelector("button");
	assert.equal(input.getAttribute("data-rdsh-files-search-input"), "", "the input has no stable hook");
	assert.equal(submit.getAttribute("data-rdsh-files-search-button"), "", "the submit button has no stable hook");
	assert.match(submit.innerHTML, /^<svg\b[^>]*aria-hidden="true"/, "the search icon must use the hand-drawn SVG");
	assert.doesNotMatch(submit.textContent + submit.innerHTML, /\p{Extended_Pictographic}/u, "the search button must not use system emoji");
	assert.equal(submit.getAttribute("aria-label"), COPY.en["files.search.submit"], "the icon button lost its accessible name");
	assert.equal(tree.root.children.indexOf(search) + 1, tree.root.children.indexOf(tree.body), "the search row is not between header and body");

	input.value = "app";
	submit.dispatchEvent(event("click", submit));
	assert.equal(tree.app.hasAttribute("data-rdsh-files-hidden"), false, "the file hit was hidden");
	assert.equal(tree.readme.hasAttribute("data-rdsh-files-hidden"), true, "the non-hit file stayed visible");
	assert.equal(tree.src.hasAttribute("data-rdsh-files-hidden"), false, "the ancestor of a hit was hidden");
	assert.equal(run.sandbox.CSS.highlights.has("rdsh-files-search"), true, "the hit was not highlighted");

	// Enter takes the same path.
	input.value = "README";
	input.dispatchEvent(event("keydown", input, { key: "Enter" }));
	assert.equal(tree.readme.hasAttribute("data-rdsh-files-hidden"), false, "Enter did not search");
	assert.equal(tree.app.hasAttribute("data-rdsh-files-hidden"), true, "Enter left the old hit visible");

	// Typing alone is not incremental.
	input.value = "src";
	input.dispatchEvent(event("input", input));
	assert.equal(tree.readme.hasAttribute("data-rdsh-files-hidden"), false, "typing filtered without a submit");

	input.value = "";
	submit.dispatchEvent(event("click", submit));
	assert.equal(tree.app.hasAttribute("data-rdsh-files-hidden"), false, "empty submit did not clear the app row");
	assert.equal(tree.readme.hasAttribute("data-rdsh-files-hidden"), false, "empty submit did not clear the readme row");
	assert.equal(run.sandbox.CSS.highlights.size, 0, "empty submit left a highlight");
	assert.equal(search.querySelector("[data-rdsh-files-empty]").hidden, true, "empty submit left the no-hit row");
});

test("#43 zero hits shows one localized row and search never rewrites the tree text", () => {
	const run = boot();
	run.reset();
	const tree = filesTree(run.document);
	run.tools.decorateWorkspaceFiles();
	const search = tree.root.querySelector("[data-rdsh-files-search]");
	const input = search.querySelector("input");
	const before = tree.readme.textContent;

	input.value = "no-such-entry";
	search.querySelector("button").dispatchEvent(event("click", search.querySelector("button")));
	assert.equal(tree.app.hasAttribute("data-rdsh-files-hidden"), true, "a non-hit row stayed visible");
	assert.equal(tree.readme.hasAttribute("data-rdsh-files-hidden"), true, "a non-hit row stayed visible");
	assert.equal(search.querySelector("[data-rdsh-files-empty]").hidden, false, "the no-hit row is not shown");
	assert.equal(search.querySelector("[data-rdsh-files-empty]").textContent, COPY.en["files.search.noMatches"]);
	assert.equal(tree.readme.textContent, before, "searching rewrote the upstream text");
	assert.equal(tree.readme.querySelectorAll("mark").length, 0, "searching injected markup into the tree");
});

test("#43 the zero-hit line is a block below the field row, not a flex item in it", () => {
	const run = boot();
	run.reset();
	const tree = filesTree(run.document);
	run.tools.decorateWorkspaceFiles();
	const search = tree.root.querySelector("[data-rdsh-files-search]");
	const row = search.querySelector(".rdsh-mux-files-search-row");
	const input = search.querySelector("input");
	const submit = search.querySelector("button");
	const empty = search.querySelector("[data-rdsh-files-empty]");
	assert.ok(row, "the field row was not created");
	assert.equal(input.parentElement, row, "the input is not inside the field row");
	assert.equal(submit.parentElement, row, "the submit button is not inside the field row");
	assert.equal(empty.parentElement, search, "the no-hit line left the search block");
	assert.notEqual(empty.parentElement, row, "the no-hit line is still a flex item beside the input");
	assert.equal(search.children.length, 2, "the search block gained extra children");
	assert.equal(search.children[0], row, "the field row is not first");
	assert.equal(search.children[1], empty, "the no-hit line is not the block after the field row");
	assert.match(CLIENT, /\.rdsh-mux-files-search \{[^}]*flex-direction: column;/, "the search block does not stack its row and the no-hit line");
	assert.match(CLIENT, /\.rdsh-mux-files-search-row \{[^}]*display: flex;/, "the field row is not a row");
	assert.equal(tree.root.children.indexOf(search) + 1, tree.root.children.indexOf(tree.body), "the search block is not between header and body");
});

test("#43 the highlight uses ranges, not DOM edits", () => {
	const run = boot();
	run.reset();
	const tree = filesTree(run.document);
	run.tools.decorateWorkspaceFiles();
	const search = tree.root.querySelector("[data-rdsh-files-search]");
	search.querySelector("input").value = "app";
	search.querySelector("button").dispatchEvent(event("click", search.querySelector("button")));
	const highlight = run.sandbox.CSS.highlights.get("rdsh-files-search");
	assert.ok(highlight, "no custom highlight was registered");
	assert.equal(highlight.ranges.length, 1, "the hit was not split into one range");
	const range = highlight.ranges[0];
	assert.equal(range.startNode.textContent, "app.js");
	assert.equal(range.startOffset, 0);
	assert.equal(range.endOffset, 3);
	assert.equal(tree.app.querySelector("button span").childNodes.length, 1, "the name span gained nodes");
});

test("#43 highlight offsets stay in the original text when lowercasing expands", () => {
	const run = boot();
	run.reset();
	const tree = filesTree(run.document);
	const list = tree.body.querySelector("ul");
	// U+0130 lowercases to "i" + combining dot (two code units). An index from
	// the lowercased string would point past this two-unit text node.
	const dotted = element(run.document, "li", { "data-files-entry": "file", "data-files-path": "/work/repo/İx" });
	dotted.append(buttonWithName(run.document, "İx"));
	const literal = element(run.document, "li", { "data-files-entry": "file", "data-files-path": "/work/repo/a.b.js" });
	literal.append(buttonWithName(run.document, "a.b.js"));
	list.append(dotted, literal);
	run.tools.decorateWorkspaceFiles();
	const search = tree.root.querySelector("[data-rdsh-files-search]");
	const input = search.querySelector("input");

	input.value = "x";
	search.querySelector("button").dispatchEvent(event("click", search.querySelector("button")));
	const highlight = run.sandbox.CSS.highlights.get("rdsh-files-search");
	assert.ok(highlight, "no highlight for the dotted name");
	const range = highlight.ranges[0];
	assert.equal(range.startNode.textContent, "İx");
	assert.equal(range.startOffset, 1, "the range does not start at the original x");
	assert.equal(range.endOffset, 2, "the range end left the original text node");
	assert.ok(range.endOffset <= range.startNode.textContent.length, "the range end is outside the text node");

	// The query is a literal: `.` must not behave as a regex wildcard.
	input.value = ".b";
	search.querySelector("button").dispatchEvent(event("click", search.querySelector("button")));
	assert.equal(literal.hasAttribute("data-rdsh-files-hidden"), false, "a literal dot did not match");
	assert.equal(dotted.hasAttribute("data-rdsh-files-hidden"), true, "a literal dot matched every character");
	const second = run.sandbox.CSS.highlights.get("rdsh-files-search").ranges[0];
	assert.equal(second.startOffset, 1);
	assert.equal(second.endOffset, 3);
});

test("#43 filtering still works where CSS Custom Highlight is unavailable", () => {
	const run = boot();
	run.reset();
	const tree = filesTree(run.document);
	run.tools.decorateWorkspaceFiles();
	// Chrome 105+/Safari 17.2+ have the API. Older engines get no substring
	// paint, but the explicit filter must still run and must not rewrite DOM.
	run.sandbox.CSS.highlights = undefined;
	const search = tree.root.querySelector("[data-rdsh-files-search]");
	search.querySelector("input").value = "app";
	assert.doesNotThrow(() => search.querySelector("button").dispatchEvent(event("click", search.querySelector("button"))));
	assert.equal(tree.app.hasAttribute("data-rdsh-files-hidden"), false, "the hit was hidden without the highlight API");
	assert.equal(tree.readme.hasAttribute("data-rdsh-files-hidden"), true, "the non-hit stayed visible without the highlight API");
	assert.equal(tree.app.querySelectorAll("mark").length, 0, "a fallback rewrote the tree");
});

test("#83 the clear button sits beside search, starts hidden and shows while typing", () => {
	const run = boot();
	run.reset();
	const tree = filesTree(run.document);
	run.tools.decorateWorkspaceFiles();
	const search = tree.root.querySelector("[data-rdsh-files-search]");
	const input = search.querySelector("input");
	const submit = search.querySelector("[data-rdsh-files-search-button]");
	const clear = search.querySelector("[data-rdsh-files-search-clear]");
	assert.ok(clear, "the clear button was not created");
	assert.equal(clear.parentElement, submit.parentElement, "the clear button left the search row");
	assert.equal(clear.hidden, true, "the clear button is shown for an empty field");
	assert.equal(clear.getAttribute("aria-label"), COPY.en["files.search.clear"], "the clear button has no accessible name");
	assert.equal(clear.title, COPY.en["files.search.clear"], "the clear button has no tooltip");
	assert.match(clear.innerHTML, /^<svg\b[^>]*aria-hidden="true"/, "the clear icon must use the hand-drawn SVG");
	assert.doesNotMatch(clear.textContent + clear.innerHTML, /\p{Extended_Pictographic}/u, "the clear button must not use system emoji");
	assert.equal(search.querySelectorAll("button").length, 2, "the search row lost or gained a button");

	input.value = "app";
	input.dispatchEvent(event("input", input));
	assert.equal(clear.hidden, false, "typing did not reveal the clear button");
	assert.equal(tree.readme.hasAttribute("data-rdsh-files-hidden"), false, "typing filtered without a submit");
});

test("#83 the clear button is visible while the field is focused, before the first keystroke", () => {
	const run = boot();
	run.reset();
	const tree = filesTree(run.document);
	run.tools.decorateWorkspaceFiles();
	const search = tree.root.querySelector("[data-rdsh-files-search]");
	const input = search.querySelector("input");
	const clear = search.querySelector("[data-rdsh-files-search-clear]");
	assert.equal(clear.hidden, true, "the clear button started visible on an empty field");

	// Tapping the field is the state the user is in while typing on a phone;
	// the reveal used to wait for the soft keyboard's `input` event.
	run.document.activeElement = input;
	input.dispatchEvent(event("focus", input));
	assert.equal(clear.hidden, false, "focusing the field did not reveal the clear button");

	run.document.activeElement = run.document.body;
	input.dispatchEvent(event("blur", input));
	assert.equal(clear.hidden, true, "an empty field kept the clear button after blur");

	// WebKit's native cancel can emit only `search`; the state follows it too.
	input.value = "app";
	input.dispatchEvent(event("search", input));
	assert.equal(clear.hidden, false, "the native search event did not reveal the clear button");
	assert.equal(input.value, "app", "the search event filtered without a submit");
});

test("#83 clear drops hiding, highlight and the no-hit row, then focuses the field", () => {
	const run = boot();
	run.reset();
	const tree = filesTree(run.document);
	run.tools.decorateWorkspaceFiles();
	const search = tree.root.querySelector("[data-rdsh-files-search]");
	const input = search.querySelector("input");
	const submit = search.querySelector("[data-rdsh-files-search-button]");
	const clear = search.querySelector("[data-rdsh-files-search-clear]");
	const empty = search.querySelector("[data-rdsh-files-empty]");

	input.value = "no-such-entry";
	submit.dispatchEvent(event("click", submit));
	assert.equal(empty.hidden, false, "setup did not show the no-hit row");

	input.value = "app";
	input.dispatchEvent(event("input", input));
	submit.dispatchEvent(event("click", submit));
	assert.equal(tree.readme.hasAttribute("data-rdsh-files-hidden"), true, "setup did not hide the non-hit");
	assert.equal(run.sandbox.CSS.highlights.has("rdsh-files-search"), true, "setup did not highlight the hit");

	const focusCalls = [];
	input.focus = (options) => {
		focusCalls.push(options);
		run.document.activeElement = input;
	};
	clear.dispatchEvent(event("click", clear));
	assert.equal(input.value, "", "clear did not empty the field");
	assert.equal(tree.app.hasAttribute("data-rdsh-files-hidden"), false, "clear left a filtered hit hidden");
	assert.equal(tree.readme.hasAttribute("data-rdsh-files-hidden"), false, "clear left a non-hit hidden");
	assert.equal(tree.src.hasAttribute("data-rdsh-files-hidden"), false, "clear left an ancestor hidden");
	assert.equal(run.sandbox.CSS.highlights.size, 0, "clear left the highlight behind");
	assert.equal(empty.hidden, true, "clear left the no-hit row");
	assert.equal(clear.hidden, true, "clear left its own button visible");
	assert.equal(run.document.activeElement, input, "clear did not return focus to the field");
	assert.equal(focusCalls.length, 1, "clear focused the field more than once");
	assert.equal(focusCalls[0].preventScroll, true, "clear focused without preventScroll");
});

test("#83 a native search clear resets filtering without making typing incremental", () => {
	const run = boot();
	run.reset();
	const tree = filesTree(run.document);
	run.tools.decorateWorkspaceFiles();
	const search = tree.root.querySelector("[data-rdsh-files-search]");
	const input = search.querySelector("input");
	const clear = search.querySelector("[data-rdsh-files-search-clear]");
	const empty = search.querySelector("[data-rdsh-files-empty]");

	input.value = "app";
	input.dispatchEvent(event("input", input));
	search.querySelector("[data-rdsh-files-search-button]").dispatchEvent(event("click", search.querySelector("[data-rdsh-files-search-button]")));
	assert.equal(tree.readme.hasAttribute("data-rdsh-files-hidden"), true, "setup did not filter");
	assert.equal(run.sandbox.CSS.highlights.has("rdsh-files-search"), true, "setup did not highlight");

	// WebKit's native cancel control writes an empty value and emits input.
	input.value = "";
	input.dispatchEvent(event("input", input));
	assert.equal(tree.app.hasAttribute("data-rdsh-files-hidden"), false, "native clear left a row hidden");
	assert.equal(tree.readme.hasAttribute("data-rdsh-files-hidden"), false, "native clear left a row hidden");
	assert.equal(run.sandbox.CSS.highlights.size, 0, "native clear left a highlight");
	assert.equal(empty.hidden, true, "native clear left the no-hit row");
	assert.equal(clear.hidden, true, "native clear left the clear button visible");

	input.value = "src";
	input.dispatchEvent(event("input", input));
	assert.equal(tree.readme.hasAttribute("data-rdsh-files-hidden"), false, "typing filtered without a submit");
	assert.equal(clear.hidden, false, "typing did not reveal the clear button");
});

test("#83 Escape clears the query and hides the clear button", () => {
	const run = boot();
	run.reset();
	const tree = filesTree(run.document);
	run.tools.decorateWorkspaceFiles();
	const search = tree.root.querySelector("[data-rdsh-files-search]");
	const input = search.querySelector("input");
	const clear = search.querySelector("[data-rdsh-files-search-clear]");
	const empty = search.querySelector("[data-rdsh-files-empty]");

	input.value = "app";
	input.dispatchEvent(event("input", input));
	search.querySelector("[data-rdsh-files-search-button]").dispatchEvent(event("click", search.querySelector("[data-rdsh-files-search-button]")));
	const escape = event("keydown", input, { key: "Escape" });
	input.dispatchEvent(escape);
	assert.equal(input.value, "", "Escape did not clear the query");
	assert.equal(escape.defaultPrevented, true, "the clearing Escape was not consumed");
	assert.equal(tree.app.hasAttribute("data-rdsh-files-hidden"), false, "Escape left a hit hidden");
	assert.equal(tree.readme.hasAttribute("data-rdsh-files-hidden"), false, "Escape left a non-hit hidden");
	assert.equal(run.sandbox.CSS.highlights.size, 0, "Escape left a highlight");
	assert.equal(empty.hidden, true, "Escape left the no-hit row");
	assert.equal(clear.hidden, true, "Escape left the clear button visible");
});

test("#83 clear is mobile-only and is removed with the search row on disposal", () => {
	const desktop = boot({ mode: "desktop", width: 390 });
	desktop.reset();
	const desktopTree = filesTree(desktop.document);
	assert.equal(desktop.tools, undefined, "a desktop boot installed the workspace tools");
	assert.equal(desktopTree.root.querySelector("[data-rdsh-files-search-clear]"), null, "desktop got the clear button");

	const run = boot();
	run.reset();
	const tree = filesTree(run.document);
	run.tools.decorateWorkspaceFiles();
	const search = tree.root.querySelector("[data-rdsh-files-search]");
	const input = search.querySelector("input");
	input.value = "app";
	input.dispatchEvent(event("input", input));
	search.querySelector("[data-rdsh-files-search-button]").dispatchEvent(event("click", search.querySelector("[data-rdsh-files-search-button]")));
	const clear = search.querySelector("[data-rdsh-files-search-clear]");
	assert.ok(clear, "setup did not create the clear button");

	run.tools.disposeWorkspaceTools();
	assert.equal(tree.root.querySelector("[data-rdsh-files-search]"), null, "dispose kept the search row");
	assert.equal(tree.root.querySelector("[data-rdsh-files-search-clear]"), null, "dispose kept the clear button");
	assert.equal(run.tools.filesSearch(), null, "dispose kept the search state");
	assert.equal(run.sandbox.CSS.highlights.size, 0, "dispose kept a highlight");
	assert.equal(tree.readme.hasAttribute("data-rdsh-files-hidden"), false, "dispose kept a row hidden");
});


test("#42 an unrelated container's scroll neither cancels the press nor closes the menu", () => {
	const run = boot();
	run.reset();
	const tree = filesTree(run.document);
	run.tools.decorateWorkspaceFiles();
	run.tools.installWorkspaceTools();
	const unrelated = element(run.document, "div");
	run.document.body.append(unrelated);
	const button = tree.readme.querySelector("button");

	run.document.dispatchEvent(event("pointerdown", button, { pointerType: "touch", clientX: 10, clientY: 10 }));
	run.document.dispatchEvent(event("scroll", unrelated));
	run.runTimers(500);
	assert.ok(run.document.querySelector("[data-rdsh-file-menu]"), "an unrelated scroll cancelled the press");

	run.document.dispatchEvent(event("scroll", unrelated));
	assert.ok(run.document.querySelector("[data-rdsh-file-menu]"), "an unrelated scroll closed the menu");

	run.document.dispatchEvent(event("scroll", tree.body));
	assert.equal(run.document.querySelector("[data-rdsh-file-menu]"), null, "a tree scroll kept the menu");
});

test("#42 contextmenu opens the copy menu and prevents the native one", () => {
	const run = boot();
	run.reset();
	const tree = filesTree(run.document);
	run.tools.decorateWorkspaceFiles();
	run.tools.installWorkspaceTools();

	const rowEvent = event("contextmenu", tree.readme.querySelector("button"));
	tree.readme.querySelector("button").dispatchEvent(rowEvent);
	assert.equal(rowEvent.defaultPrevented, true, "the native context menu was not prevented");
	const menu = run.document.querySelector("[data-rdsh-file-menu]");
	assert.ok(menu, "contextmenu did not open the copy menu");
	assert.equal(menu.querySelectorAll("button").length, 2, "the file menu lost an item");

	// The root path follows the same route (keyboard Shift+F10 also dispatches
	// a contextmenu event in real browsers).
	run.document.dispatchEvent(event("keydown", run.document.activeElement, { key: "Escape" }));
	const rootTarget = tree.path.querySelector("span");
	const rootEvent = event("contextmenu", rootTarget);
	rootTarget.dispatchEvent(rootEvent);
	assert.equal(rootEvent.defaultPrevented, true, "the root path left the native context menu");
	const rootMenu = run.document.querySelector("[data-rdsh-file-menu]");
	assert.ok(rootMenu, "contextmenu did not open the root path menu");
	assert.equal(rootMenu.querySelectorAll("button").length, 1, "the root path menu gained an item");

	run.document.dispatchEvent(event("keydown", run.document.activeElement, { key: "Escape" }));
	const unrelated = element(run.document, "div");
	run.document.body.append(unrelated);
	const unrelatedEvent = event("contextmenu", unrelated);
	unrelated.dispatchEvent(unrelatedEvent);
	assert.equal(unrelatedEvent.defaultPrevented, false, "an unrelated contextmenu was consumed");
	assert.equal(run.document.querySelector("[data-rdsh-file-menu]"), null, "an unrelated contextmenu opened a menu");
});

test("#43 the root path is a keyboard menu trigger only in mobile mode and restores its attributes", () => {
	const run = boot();
	run.reset();
	const tree = filesTree(run.document);
	tree.path.setAttribute("tabindex", "-1");
	tree.path.setAttribute("role", "note");
	tree.path.setAttribute("aria-label", "custom root");
	run.tools.decorateWorkspaceFiles();

	assert.equal(tree.path.getAttribute("tabindex"), "0", "the root path is not keyboard reachable");
	assert.equal(tree.path.getAttribute("role"), "note", "an upstream role was overwritten");
	assert.equal(tree.path.getAttribute("aria-label"), "custom root", "an upstream label was overwritten");
	assert.equal(tree.path.getAttribute("aria-haspopup"), "menu");
	assert.equal(tree.path.getAttribute("aria-expanded"), "false");
	assert.equal(tree.path.hasAttribute("data-rdsh-files-root-path"), true);

	const openAndClose = (init) => {
		const openEvent = event("keydown", tree.path, init);
		tree.path.dispatchEvent(openEvent);
		assert.equal(openEvent.defaultPrevented, true, `the ${init.key} key was not consumed`);
		const menu = run.document.querySelector("[data-rdsh-file-menu]");
		assert.ok(menu, `the ${init.key} key did not open the root menu`);
		assert.equal(tree.path.getAttribute("aria-expanded"), "true");
		assert.equal(run.document.activeElement, menu.querySelector("button"), `the ${init.key} key did not focus the menu`);
		run.document.dispatchEvent(event("keydown", run.document.activeElement, { key: "Escape" }));
		assert.equal(run.document.querySelector("[data-rdsh-file-menu]"), null, `Escape after ${init.key} did not close`);
		assert.equal(run.document.activeElement, tree.path, `Escape after ${init.key} did not restore focus`);
		assert.equal(tree.path.getAttribute("aria-expanded"), "false");
	};

	openAndClose({ key: "Enter" });
	openAndClose({ key: " " });
	openAndClose({ key: "ContextMenu" });
	openAndClose({ key: "F10", shiftKey: true });

	// Width is geometry only: a 1024px tablet keeps the mobile trigger.
	run.setNarrow(false);
	run.tools.decorateWorkspaceFiles();
	assert.equal(tree.path.hasAttribute("data-rdsh-files-root-path"), true, "a wide mobile window lost the root trigger");
	assert.equal(tree.path.getAttribute("tabindex"), "0", "a wide mobile window lost keyboard reach");
	assert.equal(tree.path.hasAttribute("aria-haspopup"), true);

	run.tools.disposeWorkspaceTools();
	assert.equal(tree.path.getAttribute("tabindex"), "-1", "dispose did not restore tabindex");
	assert.equal(tree.path.getAttribute("role"), "note", "dispose did not restore role");
	assert.equal(tree.path.hasAttribute("data-rdsh-files-root-path"), false, "dispose kept the root trigger hook");

	// A 390px desktop window is still desktop: no trigger, no phone attributes.
	const desktop = boot({ mode: "desktop", width: 390 });
	desktop.reset();
	const desktopTree = filesTree(desktop.document);
	desktopTree.path.setAttribute("tabindex", "-1");
	desktopTree.path.setAttribute("role", "note");
	desktopTree.path.setAttribute("aria-label", "custom root");
	// Nothing decorates on a desktop: the seam does not exist.
	assert.equal(desktop.tools, undefined, "a desktop boot installed the workspace tools");
	assert.equal(desktopTree.path.hasAttribute("data-rdsh-files-root-path"), false, "desktop kept the root trigger hook");
	assert.equal(desktopTree.path.getAttribute("tabindex"), "-1", "desktop did not restore tabindex");
	assert.equal(desktopTree.path.getAttribute("role"), "note", "desktop did not restore role");
	assert.equal(desktopTree.path.getAttribute("aria-label"), "custom root", "desktop did not restore aria-label");
	assert.equal(desktopTree.path.hasAttribute("aria-haspopup"), false, "desktop kept aria-haspopup");
	assert.equal(desktopTree.path.hasAttribute("aria-expanded"), false, "desktop kept aria-expanded");
});

test("the new tree/search work survives width but is absent on desktop and removed on teardown/pagehide", () => {
	const run = boot({ mode: "mobile", width: 390 });
	run.reset();
	const tree = filesTree(run.document);
	run.tools.decorateWorkspaceFiles();
	run.tools.installWorkspaceTools();
	assert.ok(tree.root.querySelector("[data-rdsh-files-search]"), "setup did not inject the search row");

	// A 1024px mobile window keeps the mobile surface: width is geometry only.
	run.setNarrow(false);
	run.tools.decorateWorkspaceFiles();
	assert.ok(tree.root.querySelector("[data-rdsh-files-search]"), "a wide mobile window lost the search row");
	assert.equal(tree.root.hasAttribute("data-rdsh-files-tree"), true, "a wide mobile window lost the tree hook");
	assert.equal(tree.path.hasAttribute("data-rdsh-files-root-path"), true, "a wide mobile window lost the path hook");

	run.document.dispatchEvent(event("pagehide", run.document.body, { persisted: true }));
	assert.ok(tree.root.querySelector("[data-rdsh-files-search]"), "a bfcache pagehide tore the resources down");
	run.document.dispatchEvent(event("pagehide", run.document.body));
	assert.equal(tree.root.querySelector("[data-rdsh-files-search]"), null, "pagehide kept the search row");
	assert.equal(tree.root.hasAttribute("data-rdsh-files-tree"), false, "pagehide kept the tree hook");

	// The same 390px window in desktop mode never gets any of it.
	const desktop = boot({ mode: "desktop", width: 390 });
	desktop.reset();
	const desktopTree = filesTree(desktop.document);
	assert.equal(desktop.tools, undefined, "a desktop boot installed the workspace tools");
	assert.equal(desktopTree.root.querySelector("[data-rdsh-files-search]"), null, "desktop got the search row");
	assert.equal(desktopTree.root.hasAttribute("data-rdsh-files-tree"), false, "desktop got the tree hook");
	assert.equal(desktopTree.path.hasAttribute("data-rdsh-files-root-path"), false, "desktop got the path hook");
});

test("closing the panel or clipping it removes the injected tree UI", () => {
	const run = boot();
	run.reset();
	const tree = filesTree(run.document);
	run.tools.decorateWorkspaceFiles();
	run.tools.installWorkspaceTools();
	assert.ok(tree.root.querySelector("[data-rdsh-files-search]"), "setup did not inject the search row");

	// A closed right sidebar keeps the tree mounted but loses the panel hook
	// and is clipped to zero width.
	tree.panel.removeAttribute("data-rdsh-rightpanel");
	tree.root.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
	run.tools.decorateWorkspaceFiles();
	assert.equal(tree.root.querySelector("[data-rdsh-files-search]"), null, "a closed panel kept the search row");
	assert.equal(tree.root.hasAttribute("data-rdsh-files-tree"), false, "a closed panel kept the tree hook");
	assert.equal(tree.path.hasAttribute("data-rdsh-files-root-path"), false, "a closed panel kept the path hook");
});

test("the new listeners and CSS stay mobile-mode only", () => {
	// Behavioural half: a 390px desktop never gets the press menu.
	const desktop = boot({ mode: "desktop", width: 390 });
	desktop.reset();
	const desktopTree = filesTree(desktop.document);
	assert.equal(desktop.tools, undefined, "a desktop boot installed the workspace tools");
	desktop.document.dispatchEvent(event("pointerdown", desktopTree.readme.querySelector("button"), { pointerType: "touch" }));
	desktop.runTimers(500);
	assert.equal(desktop.document.querySelector("[data-rdsh-file-menu]"), null, "a desktop press opened the phone menu");

	// ...while a 1024px mobile tablet still does.
	const tablet = boot({ mode: "mobile", width: 1024 });
	tablet.reset();
	const tabletTree = filesTree(tablet.document);
	tablet.tools.decorateWorkspaceFiles();
	tablet.tools.installWorkspaceTools();
	tablet.document.dispatchEvent(event("pointerdown", tabletTree.readme.querySelector("button"), { pointerType: "touch" }));
	tablet.runTimers(500);
	assert.notEqual(tablet.document.querySelector("[data-rdsh-file-menu]"), null, "a wide mobile tablet lost the press menu");

	// Static half: the injected rows are 16px, the tree text is unselectable
	// and the feature rules live in the mobile-only stylesheet, not the
	// always-on device sheet.
	assert.match(CLIENT, /\.rdsh-mux-files-search input \{[^}]*font-size: 16px;/, "the file search can trigger iOS zoom");
	assert.match(CLIENT, /\.rdsh-mux-workspace-search input \{[^}]*font-size: 16px;/, "the picker search can trigger iOS zoom");
	assert.match(CLIENT, /-webkit-user-select: none;[\s\S]{0,80}user-select: none;[\s\S]{0,80}-webkit-touch-callout: none;/, "tree text is still selectable on a phone");
	assert.match(CLIENT, /::highlight\(rdsh-files-search\)/, "the search highlight has no paint");
	assert.match(CLIENT, /\[data-rdsh-files-hidden\] \{ display: none !important; \}/, "filtered rows are still visible");
	const device = CLIENT.slice(CLIENT.indexOf("const CSS_DEVICE"), CLIENT.indexOf("const CSS_PHONE"));
	const phone = CLIENT.slice(CLIENT.indexOf("const CSS_PHONE"), CLIENT.indexOf("const CSS = CSS_DEVICE"));
	assert.match(phone, /\.rdsh-mux-files-search input/, "file-search CSS is not in the mobile sheet");
	assert.match(phone, /\.rdsh-mux-workspace-search input/, "picker-search CSS is not in the mobile sheet");
	assert.doesNotMatch(device, /\.rdsh-mux-files-search input/, "file-search CSS leaked into the device sheet");
	const picker = CLIENT.slice(CLIENT.indexOf("function decorateWorkspacePicker("), CLIENT.indexOf("// Right-panel workspace files"));
	assert.equal(/\.style\.(?:maxHeight|height|transform|top|left)\s*=/.test(picker), false, "the picker writes layout inline");
});

test("every new string exists in both copy packs", () => {
	const keys = [
		"workspace.search.placeholder",
		"workspace.search.noMatches",
		"files.search.placeholder",
		"files.search.submit",
		"files.search.clear",
		"files.search.noMatches",
		"files.menu.root",
		"files.menu.entry",
		"files.menu.copyPath",
		"files.menu.copyName",
		"files.copied",
	];
	for (const key of keys) {
		assert.equal(typeof COPY.en[key], "string", `${key} is missing from en`);
		assert.equal(typeof COPY.ja[key], "string", `${key} is missing from ja`);
		assert.notEqual(COPY.ja[key], "", `${key} is empty in ja`);
	}
	assert.equal(copyFor("ja")["files.menu.copyPath"], "パスをコピー");
	assert.equal(copyFor("ja")["files.search.noMatches"], "該当なし");
});
