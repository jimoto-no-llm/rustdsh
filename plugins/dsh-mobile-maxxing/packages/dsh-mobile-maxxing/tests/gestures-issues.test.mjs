/**
 * Behavioural checks for the interaction issues #31, #32, #38 and #76.
 *
 * These do not need a browser: the client bundle is evaluated in a stub DOM
 * with real event dispatch, timer and animation-frame queues. The assertions
 * are about the contract with upstream:
 *
 * - #31: dockkit arms a tab drag on `pointerdown` and starts it after 4px.
 *   Until the 450ms hold, our capture listener stops every `pointermove` for
 *   that touch, so a tap and a sideways pan never reorder. The hold releases
 *   the gate and lets dockkit's own drag (and therefore its own tab order)
 *   finish the reorder.
 * - #32: a swipe that starts on the tab strip or its chrome is not a
 *   panel-close gesture; the body swipe and the ✕ keep working.
 * - #38: the terminal's mount node is shrunk to the visual viewport band so
 *   the app's ResizeObserver runs the real xterm fit. No scroll event is
 *   synthesised: xterm 6's SmoothScrollableElement is an internal model, its
 *   DOM wrapper has no overflow, and a wheel would be application input.
 * - #76: iPadOS standalone can hide the keyboard with the composer still
 *   focused and without a visualViewport resize. The mobile half re-runs its
 *   existing measurement/decorate/fit pass from the document-blur, focusout
 *   and visibility lifecycle signals; it never blurs the composer, writes a
 *   fake height or forces a reflow. The native blank strip is WebKit's.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { COPY, PROBES } from "../lib/copy.js";

const CLIENT = readFileSync(new URL("../client.js", import.meta.url), "utf8");

/* ---------------------------------------------------------------------- */
/* A small, real-enough DOM                                               */
/* ---------------------------------------------------------------------- */

class FakeEvent {
	constructor(type, init = {}) {
		this.type = type;
		this.bubbles = init.bubbles === true;
		this.cancelable = init.cancelable === true;
		this.pointerId = init.pointerId;
		this.defaultPrevented = false;
		this.propagationStopped = false;
	}
	preventDefault() {
		this.defaultPrevented = true;
	}
	stopPropagation() {
		this.propagationStopped = true;
	}
	stopImmediatePropagation() {
		this.propagationStopped = true;
		this.immediateStopped = true;
	}
}

/** Fire the listeners on one node for one phase of a fake event. */
function fireFakeListeners(node, event, capture) {
	const listeners = node.listeners?.get(event.type);
	if (listeners === undefined) return;
	event.currentTarget = node;
	event.immediateStopped = false;
	for (const entry of [...listeners]) {
		if (entry.capture !== capture) continue;
		if (event.immediateStopped === true) break;
		entry.handler(event);
	}
}

class FakeMouseEvent extends FakeEvent {
	constructor(type, init = {}) {
		super(type, init);
		this.view = init.view ?? null;
	}
}

function makeStyle() {
	return {
		setProperty(name, value) {
			this[name] = String(value);
		},
		removeProperty(name) {
			delete this[name];
		},
		getPropertyValue(name) {
			return typeof this[name] === "string" ? this[name] : "";
		},
	};
}

class FakeElement {
	constructor(tag = "div") {
		this.tagName = String(tag).toUpperCase();
		this.nodeType = 1;
		this.attributes = new Map();
		this.children = [];
		this.childNodes = [];
		this.parentElement = null;
		this.isConnected = true;
		this.style = makeStyle();
		this.classList = {
			add() {},
			remove() {},
			toggle() {},
			contains: () => false,
		};
		this.dataset = {};
		this.dispatched = [];
		this.listeners = new Map();
		this.clicks = 0;
		this.scrollLeft = 0;
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
		const next = force === undefined ? !this.attributes.has(name) : Boolean(force);
		if (next) this.attributes.set(name, "");
		else this.attributes.delete(name);
		return next;
	}
	closest(selector) {
		if (typeof this._closest === "function") {
			const found = this._closest.call(this, selector);
			if (found !== null && found !== undefined) return found;
		}
		const attribute = /^\[(data-rdsh-[a-z0-9-]+)\]$/.exec(selector);
		if (attribute !== null && this.hasAttribute(attribute[1])) return this;
		return null;
	}
	matches(selector) {
		return this.closest(selector) === this;
	}
	querySelector(selector) {
		if (typeof this._querySelector === "function") return this._querySelector.call(this, selector) ?? null;
		return null;
	}
	querySelectorAll(selector) {
		if (typeof this._querySelectorAll === "function") return this._querySelectorAll.call(this, selector) ?? [];
		return [];
	}
	getBoundingClientRect() {
		if (typeof this._rect === "function") return this._rect.call(this);
		return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
	}
	dispatchEvent(event) {
		this.dispatched.push(event);
		// A small capture/bubble path so the behaviour tests can drive the
		// plugin's real delegated listeners (a key row is a row of buttons).
		if (event.target === undefined || event.target === null) event.target = this;
		const path = [];
		for (let node = this; node !== null && node !== undefined; node = node.parentElement) path.push(node);
		for (let index = path.length - 1; index >= 0; index -= 1) {
			fireFakeListeners(path[index], event, true);
			if (event.propagationStopped === true) return !event.defaultPrevented;
		}
		for (let index = 0; index < path.length; index += 1) {
			fireFakeListeners(path[index], event, false);
			if (event.propagationStopped === true) return !event.defaultPrevented;
		}
		return !event.defaultPrevented;
	}
	addEventListener(type, handler, options) {
		const capture = options === true || (options !== null && options !== undefined && options.capture === true);
		const list = this.listeners.get(type) ?? [];
		list.push({ handler, capture });
		this.listeners.set(type, list);
	}
	removeEventListener(type, handler, options) {
		const capture = options === true || (options !== null && options !== undefined && options.capture === true);
		const list = this.listeners.get(type) ?? [];
		this.listeners.set(type, list.filter((entry) => entry.handler !== handler || entry.capture !== capture));
	}
	click() {
		this.clicks += 1;
	}
	append(...nodes) {
		for (const node of nodes) {
			this.children.push(node);
			node.parentElement = this;
		}
	}
	appendChild(node) {
		this.children.push(node);
		node.parentElement = this;
		return node;
	}
	removeChild(node) {
		this.children = this.children.filter((child) => child !== node);
		return node;
	}
	insertBefore(node, reference = null) {
		const index = reference === null || reference === undefined ? -1 : this.children.indexOf(reference);
		if (index === -1) this.children.push(node);
		else this.children.splice(index, 0, node);
		node.parentElement = this;
		return node;
	}
	remove() {
		this.isConnected = false;
		if (this.parentElement !== null) {
			this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
		}
	}
	replaceChildren() {
		this.children = [];
	}
	after() {}
	before() {}
	prepend() {}
	focus() {}
	blur() {}
	contains(node) {
		return node === this;
	}
	get innerHTML() {
		return "";
	}
	set innerHTML(_value) {}
	get textContent() {
		return this._textContent ?? "";
	}
	set textContent(value) {
		this._textContent = String(value);
	}
}

/** A value that answers every operation without doing anything. */
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

/* ---------------------------------------------------------------------- */
/* Boot                                                                   */
/* ---------------------------------------------------------------------- */

function bootGestures({ narrow = true, mode = narrow ? "mobile" : "desktop", width = narrow ? 390 : 1024, configureDocument = () => {} } = {}) {
	let definition;
	const disposers = [];
	const timers = new Map();
	let nextTimer = 1;
	const frames = new Map();
	let nextFrame = 1;
	const documentHandlers = [];
	const windowHandlers = [];
	const vvHandlers = [];
	const observers = [];
	const schedule = (callback, delay) => {
		const id = nextTimer++;
		timers.set(id, { callback, delay });
		return id;
	};
	const cancel = (id) => {
		timers.delete(id);
	};
	const requestFrame = (callback) => {
		const id = nextFrame++;
		frames.set(id, callback);
		return id;
	};
	const cancelFrame = (id) => {
		frames.delete(id);
	};
	const visualViewport = {
		height: 844,
		offsetTop: 0,
		addEventListener(type, handler) {
			vvHandlers.push([type, handler]);
		},
		removeEventListener() {},
	};

	const doc = new FakeElement("#document");
	doc.baseURI = "http://localhost/";
	doc.documentElement = new FakeElement("html");
	doc.head = new FakeElement("head");
	doc.body = new FakeElement("body");
	doc.activeElement = null;
	doc.visibilityState = "visible";
	doc.styleSheets = [];
	doc.createElement = (tag) => new FakeElement(tag);
	doc.getElementById = () => null;
	doc.querySelector = () => null;
	doc.querySelectorAll = () => [];
	doc.addEventListener = (type, handler) => {
		documentHandlers.push([type, handler]);
	};
	doc.removeEventListener = () => {};
	configureDocument(doc);

	const sandbox = {
		__RDSH_PWA_PROBES__: PROBES,
		__RDSH_PWA_COPY__: COPY,
		__RDSH_DEVICE_MODE__: mode,
		window: {
			__ModuleLoader__: {
				load(value) {
					definition = value;
				},
			},
			document: doc,
			matchMedia: makeMatchMedia(narrow),
			setTimeout: schedule,
			clearTimeout: cancel,
			requestAnimationFrame: requestFrame,
			cancelAnimationFrame: cancelFrame,
			addEventListener: (type, handler) => {
				windowHandlers.push([type, handler]);
			},
			removeEventListener: () => {},
			location: { href: "http://localhost/" },
			navigator: stub(),
			localStorage: stub(),
			screen: { height: 844 },
			performance: { now: () => 0 },
			innerWidth: width,
			innerHeight: 844,
			visualViewport,
		},
		document: doc,
		navigator: stub(),
		location: { href: "http://localhost/" },
		localStorage: stub(),
		sessionStorage: stub(),
		matchMedia: makeMatchMedia(narrow),
		addEventListener: () => {},
		removeEventListener: () => {},
		setTimeout: schedule,
		clearTimeout: cancel,
		setInterval: () => 0,
		clearInterval: () => {},
		requestAnimationFrame: requestFrame,
		cancelAnimationFrame: cancelFrame,
		MutationObserver: class {
			constructor(callback) {
				this.callback = callback;
				this.target = null;
				observers.push(this);
			}
			observe(target) {
				this.target = target;
			}
			disconnect() {
				this.target = null;
			}
			takeRecords() {
				return [];
			}
		},
		IntersectionObserver: class {
			observe() {}
			disconnect() {}
		},
		ResizeObserver: class {
			observe() {}
			disconnect() {}
		},
		getComputedStyle: () => stub(),
		console,
		URL,
		URLSearchParams,
		Intl,
		TextEncoder,
		TextDecoder,
		AbortController,
		structuredClone,
		fetch: () => Promise.resolve(stub()),
		Element: FakeElement,
		HTMLElement: FakeElement,
		Node: FakeElement,
		Event: FakeEvent,
		MouseEvent: FakeMouseEvent,
		PointerEvent: FakeEvent,
		KeyboardEvent: FakeEvent,
		TouchEvent: FakeEvent,
		Touch: class Touch {},
		MessageChannel: class MessageChannel {},
		Notification: stub(),
		AudioContext: class AudioContext {},
		screen: { height: 844 },
		innerWidth: width,
		innerHeight: 844,
		devicePixelRatio: 3,
		performance: { now: () => 0 },
	};
	sandbox.globalThis = sandbox;
	sandbox.window.document = doc;
	sandbox.window.matchMedia = sandbox.matchMedia;
	sandbox.window.setTimeout = schedule;
	sandbox.window.clearTimeout = cancel;
	sandbox.window.setInterval = sandbox.setInterval;
	sandbox.window.clearInterval = sandbox.clearInterval;
	sandbox.window.requestAnimationFrame = requestFrame;
	sandbox.window.cancelAnimationFrame = cancelFrame;
	sandbox.window.addEventListener = sandbox.window.addEventListener;
	sandbox.window.removeEventListener = sandbox.window.removeEventListener;
	sandbox.window.location = sandbox.location;
	sandbox.window.navigator = sandbox.navigator;
	sandbox.window.localStorage = sandbox.localStorage;
	sandbox.window.screen = sandbox.screen;
	sandbox.window.performance = sandbox.performance;

	vm.createContext(sandbox);
	vm.runInContext(CLIENT, sandbox, { filename: "client.js" });
	assert.ok(definition !== undefined, "the module registered itself");
	const plugin = definition.factory(() => stub());
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
				return typeof callback === "function" ? callback() : undefined;
			},
			register() {
				return () => {};
			},
		},
		get: () => undefined,
		on: () => () => {},
	};
	plugin.apply(ctx);

	const drainFrames = (limit = 40) => {
		for (let index = 0; index < limit; index += 1) {
			if (frames.size === 0) return;
			const batch = [...frames.values()];
			frames.clear();
			for (const callback of batch) callback();
		}
	};
	const runTimers = (delay) => {
		const batch = [...timers.entries()].filter(([, timer]) => delay === undefined || timer.delay === delay);
		for (const [id, timer] of batch) {
			timers.delete(id);
			timer.callback();
		}
	};
	const handler = (type, name) => [...documentHandlers].reverse()
		.find(([registered, fn]) => registered === type && fn.name === name)?.[1];

	return {
		sandbox,
		ctx,
		doc,
		visualViewport,
		timers,
		frames,
		vvHandlers,
		windowHandlers,
		observers,
		drainFrames,
		runTimers,
		handler,
		disposeAll() {
			for (const dispose of disposers.splice(0).reverse()) dispose();
		},
	};
}

function makeMatchMedia(narrow) {
	return (query) => ({
		matches: Boolean(narrow && query.includes("max-width: 767px")),
		addEventListener() {},
		removeEventListener() {},
	});
}

/** A pointer event with the fields the gesture code reads. */
function pointerEvent(target, x, y, { type = "touch", id = 7, primary = true } = {}) {
	return {
		target,
		pointerType: type,
		pointerId: id,
		isPrimary: primary,
		button: 0,
		clientX: x,
		clientY: y,
		cancelable: true,
		prevented: 0,
		stopped: 0,
		preventDefault() {
			this.prevented += 1;
		},
		stopImmediatePropagation() {
			this.stopped += 1;
		},
		stopPropagation() {
			this.stopped += 1;
		},
	};
}

/** A tab whose strip is @param strip. */
function tabFixture() {
	const strip = new FakeElement("div");
	strip.setAttribute("data-dockkit-strip-tabs", "");
	strip.scrollLeft = 100;
	const tab = new FakeElement("div");
	tab.setAttribute("data-rdsh-rtab", "");
	tab._closest = (selector) => {
		if (selector.includes("data-dockkit-strip-tabs")) return strip;
		if (selector.includes("[data-rdsh-rtab]") || selector.includes("[data-dockkit-tab]")) return tab;
		return null;
	};
	const target = new FakeElement("div");
	target._closest = (selector) => {
		if (selector === "[data-rdsh-rtab]") return tab;
		if (selector.includes("data-dockkit-tab-close")) return null;
		return null;
	};
	return { tab, strip, target };
}

function hasTimer(booted, delay) {
	return [...booted.timers.values()].some((timer) => timer.delay === delay);
}

/* ---------------------------------------------------------------------- */
/* #31: hold before the upstream tab drag                                 */
/* ---------------------------------------------------------------------- */

test("a touch tab stays blocked until the 450ms hold opens dockkit's drag", () => {
	const booted = bootGestures({ narrow: true });
	booted.drainFrames();
	const down = booted.handler("pointerdown", "onPointerDown");
	const move = booted.handler("pointermove", "onPointerMove");
	const up = booted.handler("pointerup", "onPointerUp");
	assert.equal(typeof down, "function", "pointerdown handler registered");
	assert.equal(typeof move, "function", "pointermove handler registered");
	assert.equal(typeof up, "function", "pointerup handler registered");
	const { tab, target } = tabFixture();

	down(pointerEvent(target, 100, 50));
	assert.equal(hasTimer(booted, 450), true, "the hold is scheduled at 450ms");
	assert.equal(tab.hasAttribute("data-rdsh-tab-hold"), false, "nothing is lifted yet");

	const early = pointerEvent(target, 104, 52);
	move(early);
	assert.equal(early.stopped, 1, "a pre-hold move is stopped before dockkit's 4px drag");
	assert.equal(tab.hasAttribute("data-rdsh-tab-hold"), false);

	booted.runTimers(450);
	assert.equal(tab.hasAttribute("data-rdsh-tab-hold"), true, "the hold lifts the tab");

	const afterHold = pointerEvent(target, 130, 52);
	move(afterHold);
	assert.equal(afterHold.stopped, 0, "the hold releases pointermove to the upstream drag");

	up(pointerEvent(target, 130, 52));
	assert.equal(tab.hasAttribute("data-rdsh-tab-hold"), false, "the lift is cleared on release");

	// The release can still synthesise a click on the tab that was dragged;
	// that click is a reorder artefact, not a tab switch.
	const click = {
		target,
		prevented: 0,
		stopped: 0,
		preventDefault() {
			this.prevented += 1;
		},
		stopImmediatePropagation() {
			this.stopped += 1;
		},
	};
	booted.handler("click", "onClickCapture")(click);
	assert.equal(click.prevented, 1, "a post-drag click is cancelled");
	assert.equal(click.stopped, 1, "the tab's own onClick never runs for that click");
	booted.disposeAll();
});

test("mouse and pen tabs: mouse is unchanged, pen waits for the same hold", () => {
	const booted = bootGestures({ narrow: true });
	booted.drainFrames();
	const down = booted.handler("pointerdown", "onPointerDown");
	const move = booted.handler("pointermove", "onPointerMove");
	const { tab, target } = tabFixture();

	booted.runTimers();
	down(pointerEvent(target, 40, 40, { type: "mouse", id: 1 }));
	assert.equal(hasTimer(booted, 450), false, "a mouse press does not arm the hold");
	assert.equal(tab.hasAttribute("data-rdsh-tab-hold"), false);

	down(pointerEvent(target, 40, 40, { type: "pen", id: 2 }));
	assert.equal(hasTimer(booted, 450), true, "a pen press arms the hold");
	const early = pointerEvent(target, 45, 41, { type: "pen", id: 2 });
	move(early);
	assert.equal(early.stopped, 1, "a pen move before the hold is blocked");
	booted.disposeAll();
});

test("a second finger cannot replace the primary tab gesture", () => {
	const booted = bootGestures({ narrow: true });
	booted.drainFrames();
	const down = booted.handler("pointerdown", "onPointerDown");
	const up = booted.handler("pointerup", "onPointerUp");
	const { tab, target } = tabFixture();
	const otherTab = new FakeElement("div");
	otherTab.setAttribute("data-rdsh-rtab", "");
	otherTab._closest = (selector) => (selector.includes("[data-rdsh-rtab]") ? otherTab : null);
	const otherTarget = new FakeElement("div");
	otherTarget._closest = (selector) => (selector === "[data-rdsh-rtab]" ? otherTab : null);

	down(pointerEvent(target, 100, 50, { id: 7 }));
	down(pointerEvent(otherTarget, 200, 50, { id: 8, primary: false }));
	booted.runTimers(450);
	assert.equal(tab.hasAttribute("data-rdsh-tab-hold"), true, "the primary tab owns the hold");
	assert.equal(otherTab.hasAttribute("data-rdsh-tab-hold"), false, "the secondary pointer did not start a gesture");

	// A secondary pointer's release must not clear the primary's hold.
	up(pointerEvent(otherTarget, 200, 50, { id: 8, primary: false }));
	assert.equal(tab.hasAttribute("data-rdsh-tab-hold"), true, "the secondary release did not cancel the hold");
	up(pointerEvent(target, 100, 50, { id: 7 }));
	assert.equal(tab.hasAttribute("data-rdsh-tab-hold"), false, "the primary release clears it");
	booted.disposeAll();
});

test("sideways movement pans the strip and cancels the hold; vertical does not pan", () => {
	const booted = bootGestures({ narrow: true });
	booted.drainFrames();
	const down = booted.handler("pointerdown", "onPointerDown");
	const move = booted.handler("pointermove", "onPointerMove");
	const up = booted.handler("pointerup", "onPointerUp");
	const { tab, strip, target } = tabFixture();

	down(pointerEvent(target, 100, 50));
	const sideways = pointerEvent(target, 80, 52);
	move(sideways);
	assert.equal(sideways.stopped, 1, "a cancelling move is still blocked from upstream");
	// The browser owns the strip's scrolling: the plugin must not write
	// scrollLeft, or a native pan would be applied a second time.
	assert.equal(strip.scrollLeft, 100, "the plugin wrote scrollLeft over a native pan");
	booted.runTimers(450);
	assert.equal(tab.hasAttribute("data-rdsh-tab-hold"), false, "movement cancels the hold");
	up(pointerEvent(target, 80, 52));
	assert.equal(hasTimer(booted, 250), false, "a pan is not replayed as a tab tap");

	strip.scrollLeft = 100;
	down(pointerEvent(target, 100, 50));
	const vertical = pointerEvent(target, 102, 90);
	move(vertical);
	assert.equal(strip.scrollLeft, 100, "a vertical drag does not pan the strip");
	booted.runTimers(450);
	assert.equal(tab.hasAttribute("data-rdsh-tab-hold"), false, "vertical movement also cancels the hold");
	booted.disposeAll();
});

test("a touch pan that starts on the strip gutter or fill scrolls without arming a hold", () => {
	const booted = bootGestures({ narrow: true });
	booted.drainFrames();
	const down = booted.handler("pointerdown", "onPointerDown");
	const move = booted.handler("pointermove", "onPointerMove");
	const up = booted.handler("pointerup", "onPointerUp");

	const strip = new FakeElement("div");
	strip.setAttribute("data-dockkit-strip-tabs", "");
	strip.scrollLeft = 100;
	strip.clientWidth = 200;
	strip.scrollWidth = 400;
	const outer = new FakeElement("div");
	outer.setAttribute("data-dockkit-strip", "");
	outer._querySelector = (selector) => (selector === "[data-dockkit-strip-tabs]" ? strip : null);
	const rightPanel = new FakeElement("div");
	rightPanel.setAttribute("data-sidebar-right-panel", "");
	const gutter = new FakeElement("div");
	gutter._closest = (selector) => {
		if (selector.includes("data-sidebar-right-panel")) return rightPanel;
		if (selector.includes("data-dockkit-strip-tabs")) return strip;
		return null;
	};
	const fill = new FakeElement("div");
	fill._closest = (selector) => {
		if (selector.includes("data-sidebar-right-panel")) return rightPanel;
		if (selector.includes("data-dockkit-strip-fill")) return fill;
		if (selector.includes("data-dockkit-strip-tabs")) return null;
		if (selector === "[data-dockkit-strip]") return outer;
		return null;
	};
	const outside = new FakeElement("div");
	outside._closest = (selector) => (selector.includes("data-dockkit-strip-tabs") ? strip : null);

	down(pointerEvent(gutter, 300, 50));
	assert.equal(hasTimer(booted, 450), false, "the gutter does not arm a tab hold");
	const sideways = pointerEvent(gutter, 280, 52);
	move(sideways);
	assert.equal(strip.scrollLeft, 100, "the gutter pan was applied a second time");
	up(pointerEvent(gutter, 280, 52));
	assert.equal(hasTimer(booted, 250), false, "the gutter pan was replayed as a tap");

	strip.scrollLeft = 100;
	down(pointerEvent(fill, 300, 50));
	move(pointerEvent(fill, 270, 51));
	assert.equal(strip.scrollLeft, 100, "the strip-fill pan was applied a second time");
	up(pointerEvent(fill, 270, 51));

	strip.scrollLeft = 100;
	down(pointerEvent(gutter, 300, 50));
	move(pointerEvent(gutter, 302, 90));
	assert.equal(strip.scrollLeft, 100, "a vertical gutter drag panned the strip");
	up(pointerEvent(gutter, 302, 90));

	// A left/other dockkit strip is not the right panel: no manual pan.
	strip.scrollLeft = 100;
	down(pointerEvent(outside, 300, 50));
	move(pointerEvent(outside, 270, 50));
	assert.equal(strip.scrollLeft, 100, "a non-right-panel strip was panned");
	up(pointerEvent(outside, 270, 50));

	// pointercancel and dispose both restore the strip's scroll-behavior.
	const cancel = booted.handler("pointercancel", "onPointerCancel");
	strip.style.scrollBehavior = "smooth";
	down(pointerEvent(gutter, 300, 50));
	assert.equal(strip.style.scrollBehavior, "auto", "the pan did not force auto scroll");
	cancel();
	assert.equal(strip.style.scrollBehavior, "smooth", "pointercancel did not restore scroll-behavior");

	strip.style.scrollBehavior = "smooth";
	down(pointerEvent(gutter, 300, 50));
	assert.equal(strip.style.scrollBehavior, "auto");
	booted.disposeAll();
	assert.equal(strip.style.scrollBehavior, "smooth", "dispose did not restore scroll-behavior");

	const desktop = bootGestures({ mode: "desktop", width: 390, narrow: true });
	desktop.drainFrames();
	const desktopDown = desktop.handler("pointerdown", "onPointerDown");
	const desktopMove = desktop.handler("pointermove", "onPointerMove");
	assert.equal(desktopDown, undefined, "desktop must not install a gutter pointerdown handler");
	assert.equal(desktopMove, undefined, "desktop must not install a gutter pointermove handler");
	desktop.disposeAll();
});

test("a new primary strip pan drops a stale tab replay, stale pan and secondary cancel", () => {
	const booted = bootGestures({ narrow: true });
	booted.drainFrames();
	const down = booted.handler("pointerdown", "onPointerDown");
	const up = booted.handler("pointerup", "onPointerUp");
	const move = booted.handler("pointermove", "onPointerMove");
	const cancel = booted.handler("pointercancel", "onPointerCancel");

	const { tab, target } = tabFixture();
	down(pointerEvent(target, 100, 50));
	up(pointerEvent(target, 100, 51));
	assert.equal(hasTimer(booted, 250), true, "the tab tap did not schedule a replay");

	const rightPanel = new FakeElement("div");
	rightPanel.setAttribute("data-sidebar-right-panel", "");
	const strip = new FakeElement("div");
	strip.setAttribute("data-dockkit-strip-tabs", "");
	strip.scrollLeft = 100;
	strip.clientWidth = 200;
	strip.scrollWidth = 400;
	strip.style.scrollBehavior = "smooth";
	const gutter = new FakeElement("div");
	gutter._closest = (selector) => {
		if (selector.includes("data-sidebar-right-panel")) return rightPanel;
		if (selector.includes("data-dockkit-strip-tabs")) return strip;
		return null;
	};

	down(pointerEvent(gutter, 300, 50));
	assert.equal(hasTimer(booted, 250), false, "the gutter down kept the old tab replay");
	booted.runTimers(250);
	assert.equal(tab.dispatched.length, 0, "the old tab click fired during the pan");
	assert.equal(strip.style.scrollBehavior, "auto", "the pan did not force auto scroll");

	// A duplicate primary down without an up releases the old candidate before
	// storing its scroll-behavior, so the strip can return to smooth.
	down(pointerEvent(gutter, 300, 50));
	assert.equal(strip.style.scrollBehavior, "auto");
	up(pointerEvent(gutter, 300, 51));
	assert.equal(strip.style.scrollBehavior, "smooth", "the stale candidate restored auto");

	// A secondary pointercancel must not stop the primary pan.
	strip.scrollLeft = 100;
	strip.style.scrollBehavior = "smooth";
	down(pointerEvent(gutter, 300, 50));
	move(pointerEvent(gutter, 290, 50));
	assert.equal(strip.style.scrollBehavior, "auto", "the primary pan did not start");
	assert.equal(strip.scrollLeft, 100, "the plugin panned the strip itself");
	cancel(pointerEvent(gutter, 290, 50, { id: 9, primary: false }));
	move(pointerEvent(gutter, 280, 50));
	assert.equal(strip.style.scrollBehavior, "auto", "a secondary cancel stopped the primary pan");
	up(pointerEvent(gutter, 280, 50));
	assert.equal(strip.style.scrollBehavior, "smooth");
	booted.disposeAll();
});

test("a plain tap still switches through the one-shot click replay", () => {
	const booted = bootGestures({ narrow: true });
	booted.drainFrames();
	const down = booted.handler("pointerdown", "onPointerDown");
	const up = booted.handler("pointerup", "onPointerUp");
	const { tab, target } = tabFixture();

	down(pointerEvent(target, 100, 50));
	up(pointerEvent(target, 100, 51));
	assert.equal(hasTimer(booted, 250), true, "a tap schedules the replay");
	booted.runTimers(250);
	assert.equal(tab.dispatched.length, 1, "the replay dispatched one click");
	assert.equal(tab.dispatched[0].type, "click");
	booted.disposeAll();
});

/* ---------------------------------------------------------------------- */
/* #32: the panel close swipe ignores its tab strip and header            */
/* ---------------------------------------------------------------------- */

function panelFixture(doc, width = 390) {
	const root = new FakeElement("div");
	root.setAttribute("data-sidebar-right-open", "");
	const panel = new FakeElement("div");
	const collapse = new FakeElement("button");
	panel._closest = (selector) => (selector === "[data-sidebar-right-panel]" ? root : null);
	panel._rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: width, bottom: 800, width, height: 800 });
	// #97: upstream marks the toggle with a stable data attribute; the label is
	// localised and only a fallback.
	collapse.setAttribute("data-sidebar-right-toggle", "");
	collapse.setAttribute("aria-label", "Collapse right sidebar");
	collapse._closest = (selector) => (selector === "[data-sidebar-right-panel]" ? root : null);
	collapse._rect = () => ({ x: width - 90, y: 10, top: 10, left: width - 90, right: width - 66, bottom: 34, width: 24, height: 24 });
	collapse.parentElement = panel;
	doc.querySelectorAll = (selector) => (selector.includes("data-sidebar-right-toggle") ? [collapse] : []);
	return { root, panel, collapse };
}

test("a swipe that starts on the tab strip or header does not close the panel", () => {
	const booted = bootGestures({ narrow: true });
	const { collapse } = panelFixture(booted.doc);
	booted.drainFrames();
	assert.equal(booted.doc.documentElement.hasAttribute("data-rdsh-rightpanel-open"), true, "the panel is open");

	const start = booted.handler("touchstart", "onEdgeSwipeStart");
	const move = booted.handler("touchmove", "onEdgeSwipeMove");
	const touch = (x, y = 200) => ({ cancelable: true, prevented: 0, preventDefault() { this.prevented += 1; }, touches: [{ clientX: x, clientY: y }] });

	const tablist = new FakeElement("div");
	const chrome = new FakeElement("div");
	chrome._closest = (selector) => (selector.includes('[role="tablist"]') ? tablist : null);
	start({ touches: [{ clientX: 300, clientY: 30 }], target: chrome });
	move(touch(390, 30));
	assert.equal(collapse.clicks, 0, "the tab strip is not a close gesture");

	const header = new FakeElement("div");
	header._closest = (selector) => (selector.includes("header") ? header : null);
	start({ touches: [{ clientX: 300, clientY: 30 }], target: header });
	move(touch(390, 30));
	assert.equal(collapse.clicks, 0, "the panel header is not a close gesture");

	// The body keeps the existing rightward close (dx >= 64), and a leftward
	// swipe still does nothing; the issue text had the sign backwards.
	const body = new FakeElement("div");
	body._closest = () => null;
	start({ touches: [{ clientX: 200, clientY: 400 }], target: body });
	move(touch(300, 400));
	assert.equal(collapse.clicks, 1, "the body swipe still closes the panel");

	start({ touches: [{ clientX: 300, clientY: 400 }], target: body });
	move(touch(200, 400));
	assert.equal(collapse.clicks, 1, "the close stays rightward-only");

	// The ✕ itself is a plain button click, not a swipe.
	collapse.click();
	assert.equal(collapse.clicks, 2, "the collapse button still closes");
	booted.disposeAll();
});

/* ---------------------------------------------------------------------- */
/* #59: docked panel swipes and the rotation reset                        */
/* ---------------------------------------------------------------------- */

/** A landscape dock: the panel owns the right column, the chat the rest. */
function dockFixture(doc, { viewport = 844, dock = 380 } = {}) {
	const root = new FakeElement("div");
	const panel = new FakeElement("div");
	const collapse = new FakeElement("button");
	root.setAttribute("data-sidebar-right-open", "");
	for (const node of [root, panel]) {
		node._closest = (selector) => (selector === "[data-sidebar-right-panel]" ? root : null);
	}
	root._rect = () => ({ x: viewport - dock, y: 0, top: 0, left: viewport - dock, right: viewport, bottom: 390, width: dock, height: 390 });
	panel._rect = root._rect;
	collapse.setAttribute("data-sidebar-right-toggle", "");
	collapse._closest = (selector) => (selector === "[data-sidebar-right-panel]" ? root : null);
	collapse._rect = () => ({ x: viewport - 34, y: 10, top: 10, left: viewport - 34, right: viewport - 6, bottom: 38, width: 28, height: 28 });
	collapse.parentElement = panel;
	doc.querySelectorAll = (selector) => (selector.includes("data-sidebar-right-toggle") ? [collapse] : []);
	return { root, panel, collapse };
}

test("#59 a panel closed during a swipe cannot be reopened by the stale toggle", () => {
	const booted = bootGestures({ narrow: true });
	const { root, collapse } = panelFixture(booted.doc);
	booted.drainFrames();
	const start = booted.handler("touchstart", "onEdgeSwipeStart");
	const move = booted.handler("touchmove", "onEdgeSwipeMove");
	const body = new FakeElement("div");
	start({ touches: [{ clientX: 20, clientY: 200 }], target: body });
	root.removeAttribute("data-sidebar-right-open");
	move({ touches: [{ clientX: 120, clientY: 200 }], cancelable: true, preventDefault() {} });
	assert.equal(collapse.clicks, 0, "the stale close gesture reopened the panel");
	booted.disposeAll();
});

test("#59 a docked panel closes only under a swipe that starts on it", () => {
	const booted = bootGestures({ narrow: false, mode: "mobile", width: 844 });
	const { collapse } = dockFixture(booted.doc);
	booted.drainFrames();
	assert.equal(booted.doc.documentElement.hasAttribute("data-rdsh-rightpanel-open"), true, "the dock is not open");

	const start = booted.handler("touchstart", "onEdgeSwipeStart");
	const move = booted.handler("touchmove", "onEdgeSwipeMove");
	const touch = (x, y = 200) => ({ cancelable: true, prevented: 0, preventDefault() { this.prevented += 1; }, touches: [{ clientX: x, clientY: y }] });
	const body = new FakeElement("div");
	body._closest = () => null;

	// The conversation column keeps its own gesture: it does not reach across
	// the split and collapse the dock under the finger.
	start({ touches: [{ clientX: 200, clientY: 200 }], target: body });
	move(touch(320, 200));
	assert.equal(collapse.clicks, 0, "a swipe on the chat closed the docked panel");

	// A swipe that starts on the panel still closes it.
	start({ touches: [{ clientX: 600, clientY: 200 }], target: body });
	move(touch(720, 200));
	assert.equal(collapse.clicks, 1, "the panel's own swipe no longer closes it");
	booted.disposeAll();
});

test("#113 a left-edge swipe while a fullscreen panel is open closes the panel", () => {
	const booted = bootGestures({ narrow: true, mode: "mobile", width: 390 });
	const { root, collapse } = panelFixture(booted.doc);
	booted.drainFrames();
	assert.equal(booted.doc.documentElement.hasAttribute("data-rdsh-rightpanel-open"), true, "the panel is not open");

	const start = booted.handler("touchstart", "onEdgeSwipeStart");
	const move = booted.handler("touchmove", "onEdgeSwipeMove");
	const touch = (x, y = 200) => ({ cancelable: true, prevented: 0, preventDefault() { this.prevented += 1; }, touches: [{ clientX: x, clientY: y }] });
	const body = new FakeElement("div");
	body._closest = () => null;

	// #113: a fullscreen panel owns the left edge; a rightward swipe from there
	// closes the panel instead of opening the drawer.
	start({ touches: [{ clientX: 10, clientY: 200 }], target: body });
	move(touch(150, 200));
	assert.equal(collapse.clicks, 1, "the left-edge swipe did not close the fullscreen panel");
	booted.disposeAll();
});

/** A phone panel with dockkit's fullscreen control and its once-marker. */
function promoteFixture(doc, { viewport = 390, fired = "1" } = {}) {
	const root = new FakeElement("div");
	const panel = new FakeElement("div");
	const collapse = new FakeElement("button");
	const fullscreen = new FakeElement("button");
	root.setAttribute("data-sidebar-right-open", "");
	for (const node of [root, panel, collapse, fullscreen]) {
		node._closest = (selector) => (selector === "[data-sidebar-right-panel]" ? root : null);
	}
	root._rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: viewport, bottom: 844, width: viewport, height: 844 });
	panel._rect = root._rect;
	collapse.setAttribute("data-sidebar-right-toggle", "");
	collapse._rect = () => ({ x: viewport - 34, y: 10, top: 10, left: viewport - 34, right: viewport - 6, bottom: 38, width: 28, height: 28 });
	collapse.parentElement = panel;
	fullscreen.setAttribute("aria-label", "Fullscreen");
	if (fired !== null) fullscreen.setAttribute("data-rdsh-auto-fired", fired);
	fullscreen._rect = () => ({ x: viewport - 70, y: 10, top: 10, left: viewport - 70, right: viewport - 42, bottom: 38, width: 28, height: 28 });
	fullscreen.parentElement = panel;
	doc.querySelectorAll = (selector) => {
		if (selector.includes("data-sidebar-right-toggle")) return [collapse];
		if (selector.includes("Fullscreen") || selector.includes("全画面表示")) return [fullscreen];
		if (selector === "[data-rdsh-auto-fired]") return [fullscreen];
		return [];
	};
	return { root, panel, collapse, fullscreen };
}

test("#59 a rotation re-arms the panel's fullscreen promotion", async () => {
	const booted = bootGestures({ narrow: true });
	const { fullscreen } = promoteFixture(booted.doc);
	booted.drainFrames();
	assert.equal(fullscreen.clicks, 0, "the once-marker did not suppress the second click");
	// The slow decorate pass is rate-limited by wall-clock time.
	await new Promise((resolve) => setTimeout(resolve, 950));

	// A width change is what a rotation reports: the panel that was docked in
	// landscape must be promoted again so the upright phone never shows it as a
	// narrow column.
	booted.sandbox.window.innerWidth = 844;
	const resize = booted.windowHandlers.filter(([type]) => type === "resize").at(-1)?.[1];
	assert.equal(typeof resize, "function", "the resize handler is missing");
	resize();
	assert.equal(fullscreen.hasAttribute("data-rdsh-auto-fired"), false, "the rotation kept the promotion disarmed");
	booted.drainFrames();
	booted.runTimers(350);
	booted.drainFrames();
	assert.equal(fullscreen.clicks, 1, "the upright phone did not promote the docked panel");
	booted.disposeAll();
});

test("a long press on a tab does not open the text callout menu", () => {
	const booted = bootGestures({ narrow: true });
	booted.drainFrames();
	const context = booted.handler("contextmenu", "onSessionContextMenu");
	assert.equal(typeof context, "function", "contextmenu handler registered");
	const { tab } = tabFixture();
	const target = new FakeElement("div");
	target._closest = (selector) => (selector.includes("[data-rdsh-rtab]") ? tab : null);
	const event = {
		target,
		prevented: 0,
		preventDefault() {
			this.prevented += 1;
		},
	};
	context(event);
	assert.equal(event.prevented, 1, "the hold's callout is suppressed on a tab");
	const other = new FakeElement("div");
	other._closest = () => null;
	const neutral = { target: other, prevented: 0, preventDefault() { this.prevented += 1; } };
	context(neutral);
	assert.equal(neutral.prevented, 0, "a context menu outside the tab is untouched");
	booted.disposeAll();
});

/* ---------------------------------------------------------------------- */
/* #38: terminal fit follows the visual viewport                          */
/* ---------------------------------------------------------------------- */
/** Height of the fixture's scrollbar track, in pixels. */
const TERMINAL_SCROLL_TRACK = 200;

function terminalFixture(doc, collapseFixture, emulator = null) {
	const section = new FakeElement("section");
	section.setAttribute("data-sidebar-terminal", "");
	const screen = new FakeElement("div");
	screen._rect = () => ({ x: 0, y: 44, top: 44, left: 0, right: 390, bottom: 744, width: 390, height: 700 });
	const xterm = new FakeElement("div");
	xterm.parentElement = screen;
	const textarea = new FakeElement("textarea");
	textarea.setAttribute("class", "xterm-helper-textarea");
	textarea.focusCount = 0;
	textarea.blurCount = 0;
	textarea.focus = () => {
		textarea.focusCount += 1;
		doc.activeElement = textarea;
	};
	textarea.blur = () => {
		textarea.blurCount += 1;
	};
	textarea.parentElement = xterm;
	xterm.children.push(textarea);
	if (emulator !== null) {
		screen["__reactFiber$test"] = {
			return: {
				memoizedState: {
					memoizedState: { current: emulator },
					next: null,
				},
			},
		};
	}
	const scroller = new FakeElement("div");
	scroller.setAttribute("class", "xterm-scrollable-element");
	// The vertical scrollbar is where xterm's JS-owned scroll position becomes
	// observable: the slider carries `style.top`/`style.height` inside the
	// track (client.terminal.js `AbstractScrollbar.render`).
	const bar = new FakeElement("div");
	bar.setAttribute("class", "invisible scrollbar vertical");
	bar._rect = () => ({ x: 384, y: 44, top: 44, left: 384, right: 390, bottom: 244, width: 6, height: TERMINAL_SCROLL_TRACK });
	const slider = new FakeElement("div");
	slider.setAttribute("class", "slider");
	slider.style.top = "0px";
	slider.style.height = `${TERMINAL_SCROLL_TRACK}px`;
	section._querySelector = (selector) => {
		if (selector === ".xterm") return xterm;
		if (selector === "textarea.xterm-helper-textarea, textarea") return textarea;
		return null;
	};
	screen.parentElement = section;
	section.children.push(screen);
	screen._querySelector = (selector) => {
		if (selector === ".xterm-scrollable-element") return scroller;
		if (selector === ".xterm-screen") return null;
		return null;
	};
	xterm._querySelector = (selector) => (selector === ".xterm-scrollable-element" ? scroller : null);
	scroller._querySelector = (selector) => (selector === ".scrollbar.vertical" ? bar : null);
	bar._querySelector = (selector) => (selector === ".slider" ? slider : null);
	doc.querySelectorAll = (selector) => {
		if (selector === "[data-sidebar-terminal]") return [section];
		if (selector === "[data-rdsh-terminal-fit]") return screen.hasAttribute("data-rdsh-terminal-fit") ? [screen] : [];
		if (selector.includes("data-sidebar-right-toggle")) return [collapseFixture.collapse];
		if (selector === "[data-rdsh-rightpanel]") return [];
		return [];
	};
	return { section, screen, xterm, textarea, scroller, bar, slider };
}

/** Move the fixture's terminal scrollbar, as xterm does when output arrives. */
function scrollTerminalTo(terminal, top, size = TERMINAL_SCROLL_TRACK - top) {
	terminal.slider.style.top = `${top}px`;
	terminal.slider.style.height = `${size}px`;
}

function visualViewportHandler(booted, type = "resize") {
	return [...booted.vvHandlers].reverse().find(([registered]) => registered === type)?.[1];
}

test("the terminal mount shrinks to the visual viewport without synthesising input", () => {
	const booted = bootGestures({ narrow: true });
	const collapseFixture = panelFixture(booted.doc);
	const terminal = terminalFixture(booted.doc, collapseFixture);
	booted.drainFrames();
	assert.equal(booted.doc.documentElement.hasAttribute("data-rdsh-rightpanel-open"), true, "the panel is open");

	const resize = visualViewportHandler(booted);
	assert.equal(typeof resize, "function", "the visual viewport resize is watched");
	assert.equal(typeof visualViewportHandler(booted, "scroll"), "function", "the visual viewport scroll is watched too");

	booted.visualViewport.height = 544;
	resize();
	// Five events before the frame coalesce into one fit.
	booted.drainFrames();
	assert.equal(terminal.screen.style.height, "500px", "the mount follows 544px minus its 44px top");
	assert.equal(terminal.screen.style.flex, "0 0 auto", "the mount is not grown back by flex");
	assert.equal(terminal.screen.hasAttribute("data-rdsh-terminal-fit"), true);
	assert.equal(terminal.screen.style.rows, undefined, "no fake rows attribute is written");
	assert.equal(terminal.screen.hasAttribute("rows"), false);
	// No wheel, key or mouse event may be sent to the terminal: a wheel is
	// input to a mouse-tracking/alternate-buffer program.
	assert.equal(terminal.scroller.dispatched.length, 0, "the fit does not synthesise a terminal event");

	// A decoration pass with the same geometry must not write again either.
	const before = terminal.screen.style.height;
	resize();
	booted.drainFrames();
	assert.equal(terminal.screen.style.height, before, "an unchanged fit keeps the same height");
	assert.equal(terminal.scroller.dispatched.length, 0, "an unchanged fit still sends no terminal event");

	booted.visualViewport.height = 844;
	resize();
	booted.drainFrames();
	assert.equal(terminal.screen.style.height, undefined, "closing the keyboard removes the fitted height");
	assert.equal(terminal.screen.hasAttribute("data-rdsh-terminal-fit"), false, "the fit hook is cleared");
	booted.disposeAll();
});

test("#59 a keyboard fit never stretches an upper terminal into the lower split", () => {
	const booted = bootGestures({ narrow: true });
	const fixture = panelFixture(booted.doc);
	const terminal = terminalFixture(booted.doc, fixture);
	const pane = new FakeElement("section");
	const split = new FakeElement("div");
	pane._rect = () => ({ top: 0, bottom: 422, left: 0, right: 390, width: 390, height: 422 });
	pane._closest = (selector) => selector === "[data-dockkit-split]" ? split : null;
	terminal.screen._closest = (selector) => selector === "[data-dockkit-pane]" ? pane : null;
	booted.drainFrames();
	booted.visualViewport.height = 544;
	visualViewportHandler(booted)();
	booted.drainFrames();
	assert.equal(terminal.screen.style.height, "378px", "the terminal grew through the bottom of its 422px pane");
	booted.disposeAll();
});

test("keyboard open/close cycles leave no stale height, and rotation refits", () => {
	const booted = bootGestures({ narrow: true });
	const collapseFixture = panelFixture(booted.doc);
	const terminal = terminalFixture(booted.doc, collapseFixture);
	booted.drainFrames();
	const resize = visualViewportHandler(booted);

	for (let cycle = 0; cycle < 5; cycle += 1) {
		booted.visualViewport.height = 544;
		resize();
		booted.drainFrames();
		assert.equal(terminal.screen.style.height, "500px", `cycle ${cycle + 1} did not fit`);
		booted.visualViewport.height = 844;
		resize();
		booted.drainFrames();
		assert.equal(terminal.screen.style.height, undefined, `cycle ${cycle + 1} left a gap`);
	}

	// Five resize events in one frame schedule exactly one fit.
	booted.visualViewport.height = 544;
	for (let index = 0; index < 5; index += 1) resize();
	const fits = [...booted.frames.values()].filter((callback) => callback.name === "applyTerminalFit");
	assert.equal(fits.length, 1, "the fit is coalesced into one frame");
	booted.drainFrames();

	booted.visualViewport.height = 390;
	const orientation = [...booted.windowHandlers].reverse().find(([type]) => type === "orientationchange")?.[1];
	assert.equal(typeof orientation, "function", "rotation is watched");
	orientation();
	booted.drainFrames();
	assert.equal(terminal.screen.style.height, "346px", "a rotation runs the same fit path");
	booted.disposeAll();
});

test("a visual-viewport scroll (offsetTop change) refits without touching the terminal", () => {
	const booted = bootGestures({ narrow: true });
	const collapseFixture = panelFixture(booted.doc);
	const terminal = terminalFixture(booted.doc, collapseFixture);
	booted.drainFrames();

	booted.visualViewport.height = 544;
	booted.visualViewport.offsetTop = 120;
	visualViewportHandler(booted, "scroll")();
	booted.drainFrames();
	assert.equal(terminal.screen.style.height, "620px", "the band bottom, not the visible height, drives the mount");
	assert.equal(terminal.scroller.dispatched.length, 0, "a moved band still sends no terminal event");
	booted.disposeAll();
});

test("a closed panel or a desktop width clears the terminal fit", () => {
	const booted = bootGestures({ narrow: true });
	const collapseFixture = panelFixture(booted.doc);
	const terminal = terminalFixture(booted.doc, collapseFixture);
	booted.drainFrames();
	const resize = visualViewportHandler(booted);

	booted.visualViewport.height = 544;
	resize();
	booted.drainFrames();
	assert.equal(terminal.screen.style.height, "500px");

	// Make the panel measure as gone: the next decorate drops the open state.
	collapseFixture.panel._rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
	resize();
	booted.drainFrames();
	assert.equal(booted.doc.documentElement.hasAttribute("data-rdsh-rightpanel-open"), false, "the closed panel is noticed");
	assert.equal(terminal.screen.style.height, undefined, "a closed panel keeps no inline height");
	booted.disposeAll();

	// A 390px desktop window builds no plugin: no visual-viewport handler is
	// installed and no fit is ever attempted.
	const desktop = bootGestures({ mode: "desktop", width: 390 });
	assert.equal(visualViewportHandler(desktop), undefined, "a desktop installed a visual-viewport handler");
	const desktopCollapse = panelFixture(desktop.doc);
	const desktopTerminal = terminalFixture(desktop.doc, desktopCollapse);
	desktop.drainFrames();
	desktop.visualViewport.height = 544;
	desktop.drainFrames();
	assert.equal(desktopTerminal.screen.style.height, undefined, "a desktop window never fits");
	assert.equal(desktop.doc.documentElement.hasAttribute("data-rdsh-rightpanel-open"), false, "a desktop wrote mobile panel state");
	desktop.disposeAll();

	// A 1024px mobile tablet keeps the fit feature.
	const tablet = bootGestures({ mode: "mobile", width: 1024 });
	const tabletCollapse = panelFixture(tablet.doc, 1024);
	const tabletTerminal = terminalFixture(tablet.doc, tabletCollapse);
	tablet.drainFrames();
	tablet.visualViewport.height = 544;
	visualViewportHandler(tablet)();
	tablet.drainFrames();
	assert.equal(tabletTerminal.screen.style.height, "500px", "a wide mobile tablet lost the fit");
	tablet.disposeAll();
});

test("the terminal fit follows the bottom while the reader is at the end", () => {
	const booted = bootGestures({ narrow: true });
	const collapseFixture = panelFixture(booted.doc);
	const terminal = terminalFixture(booted.doc, collapseFixture);
	booted.drainFrames();
	const resize = visualViewportHandler(booted);

	booted.visualViewport.height = 544;
	resize();
	booted.drainFrames();
	assert.equal(terminal.screen.style.height, "500px", "the fit did not apply at the bottom");

	// Output lands: the slider shrinks but still ends at the track's bottom.
	scrollTerminalTo(terminal, 60);
	assert.equal(terminal.slider.style.height, "140px");
	// The keyboard inset changes while the reader is still at the bottom, so
	// the fit must follow it and keep the last row in the band.
	booted.visualViewport.height = 400;
	resize();
	booted.drainFrames();
	assert.equal(terminal.screen.style.height, "356px", "the fit did not follow the bottom");
	assert.equal(terminal.screen.hasAttribute("data-rdsh-terminal-fit"), true, "the fit hook was dropped");
	assert.equal(terminal.scroller.dispatched.length, 0, "the follow synthesised a terminal event");
	assert.equal(booted.observers.some((observer) => observer.target === terminal.bar), false, "an at-bottom terminal was put on hold");
	booted.disposeAll();
});

test("a scrolled-up reader is not pulled to the bottom by the terminal fit", () => {
	const booted = bootGestures({ narrow: true });
	const collapseFixture = panelFixture(booted.doc);
	const terminal = terminalFixture(booted.doc, collapseFixture);
	booted.drainFrames();
	const resize = visualViewportHandler(booted);

	booted.visualViewport.height = 544;
	resize();
	booted.drainFrames();
	assert.equal(terminal.screen.style.height, "500px");

	// The reader scrolls up: the slider no longer reaches the track's bottom.
	scrollTerminalTo(terminal, 20, 60);
	const framesBefore = [...booted.frames.values()].filter((callback) => callback.name === "applyTerminalFit").length;

	booted.visualViewport.height = 400;
	resize();
	booted.drainFrames();
	assert.equal(terminal.screen.style.height, "500px", "the fit moved a scrolled-up reader");
	assert.equal(terminal.screen.hasAttribute("data-rdsh-terminal-fit"), true, "the existing fit was dropped");
	assert.equal(framesBefore, 0, "a fit was already queued before the inset changed");

	const watcher = booted.observers.find((observer) => observer.target === terminal.bar);
	assert.ok(watcher, "the held fit is not waiting on the scrollbar");
	assert.equal([...booted.frames.values()].filter((callback) => callback.name === "applyTerminalFit").length, 0, "a fit was queued while the reader was up");
	assert.equal(terminal.scroller.dispatched.length, 0, "the hold synthesised a terminal event");

	// Back at the end: the observer releases the held fit, which follows the
	// inset that was measured while the reader was away.
	scrollTerminalTo(terminal, 100, 100);
	watcher.callback();
	booted.drainFrames();
	assert.equal(terminal.screen.style.height, "356px", "the held fit did not run at the end");
	assert.equal(terminal.scroller.dispatched.length, 0, "releasing the fit synthesised a terminal event");
	booted.disposeAll();
});

test("a desktop never observes or fits the terminal scrollbar", () => {
	const desktop = bootGestures({ mode: "desktop", width: 390 });
	const collapseFixture = panelFixture(desktop.doc);
	const terminal = terminalFixture(desktop.doc, collapseFixture);
	desktop.drainFrames();
	scrollTerminalTo(terminal, 20, 60);
	desktop.drainFrames();
	assert.equal(visualViewportHandler(desktop), undefined, "a desktop installed a visual-viewport handler");
	assert.equal(desktop.observers.some((observer) => observer.target === terminal.bar), false, "a desktop watched the terminal scrollbar");
	assert.equal(terminal.screen.hasAttribute("data-rdsh-terminal-fit"), false, "a desktop wrote the fit hook");
	assert.equal(terminal.screen.style.height, undefined, "a desktop wrote a fitted height");
	desktop.disposeAll();
});

/* ---------------------------------------------------------------------- */
/* #76: keyboard hide without a visual-viewport resize                    */
/* ---------------------------------------------------------------------- */

/**
 * A contenteditable composer and its focus state. The recovery must never
 * blur it: the reported iPad path keeps focus while the keyboard goes away.
 */
function composerFixture(doc) {
	const composer = new FakeElement("div");
	composer.setAttribute("contenteditable", "true");
	composer._closest = (selector) => (String(selector).includes("contenteditable") ? composer : null);
	let blurs = 0;
	composer.blur = () => {
		blurs += 1;
	};
	doc.activeElement = composer;
	return { composer, blurs: () => blurs };
}

function windowHandler(booted, type, name) {
	return [...booted.windowHandlers].reverse()
		.find(([registered, handler]) => registered === type && handler.name === name)?.[1];
}

function countRecoveryFrames(booted) {
	return [...booted.frames.values()].filter((callback) => callback.name === "applyKeyboardRecovery").length;
}

test("#76 a keyboard hide with focus retained recovers without a viewport resize", () => {
	const booted = bootGestures({ narrow: true });
	booted.drainFrames();
	const { composer, blurs } = composerFixture(booted.doc);
	// The keyboard was up and the browser has cleared its geometry, but the
	// affected iPad build never delivered a visualViewport resize for it.
	booted.visualViewport.height = 544;
	booted.visualViewport.height = 844;
	booted.doc.documentElement.style.removeProperty("--rdsh-safe-top");

	const blur = windowHandler(booted, "blur", "scheduleKeyboardRecovery");
	assert.equal(typeof blur, "function", "the document blur is not watched");
	blur();
	assert.equal(countRecoveryFrames(booted), 1, "no recovery pass was queued");
	booted.drainFrames();

	assert.equal(booted.doc.documentElement.style.getPropertyValue("--rdsh-safe-top"), "0px", "the layout was not re-measured");
	assert.equal(booted.doc.activeElement, composer, "the recovery stole focus from the composer");
	assert.equal(blurs(), 0, "the recovery blurred the composer");
	booted.disposeAll();
});

test("#76 a composer focusout refreshes the layout, an unrelated focusout does not", () => {
	const booted = bootGestures({ narrow: true });
	booted.drainFrames();
	const { composer } = composerFixture(booted.doc);
	const focusout = booted.handler("focusout", "onKeyboardFocusOut");
	assert.equal(typeof focusout, "function", "the composer focusout is not watched");

	booted.doc.documentElement.style.removeProperty("--rdsh-safe-top");
	focusout({ target: composer });
	booted.drainFrames();
	assert.equal(booted.doc.documentElement.style.getPropertyValue("--rdsh-safe-top"), "0px", "the dismissed keyboard was not recovered");
	assert.equal(booted.doc.activeElement, composer, "the focusout recovery stole focus");

	// A button cannot have raised the keyboard, so it must not trigger the
	// measurement pass (this listener also sees every other focus move).
	booted.doc.documentElement.style.removeProperty("--rdsh-safe-top");
	focusout({ target: new FakeElement("button") });
	booted.drainFrames();
	assert.equal(booted.doc.documentElement.style.getPropertyValue("--rdsh-safe-top"), "", "an unrelated focusout re-measured");
	booted.disposeAll();
});

test("#76 repeated lifecycle events share one recovery pass, and a burst can run again", () => {
	const booted = bootGestures({ narrow: true });
	booted.drainFrames();
	const { composer } = composerFixture(booted.doc);
	booted.visualViewport.height = 844;
	const blur = windowHandler(booted, "blur", "scheduleKeyboardRecovery");
	const focus = windowHandler(booted, "focus", "scheduleKeyboardRecovery");
	const visible = booted.handler("visibilitychange", "onKeyboardVisibility");
	assert.equal(typeof focus, "function", "the document focus is not watched");
	assert.equal(typeof visible, "function", "visibility is not watched");

	booted.doc.documentElement.style.removeProperty("--rdsh-safe-top");
	for (let index = 0; index < 5; index += 1) {
		blur();
		focus();
	}
	visible();
	assert.equal(countRecoveryFrames(booted), 1, "the events were not coalesced");
	booted.drainFrames();
	assert.equal(booted.doc.documentElement.style.getPropertyValue("--rdsh-safe-top"), "0px", "the coalesced pass did not run");
	assert.equal(booted.doc.activeElement, composer, "the burst stole focus");

	// The next real keyboard hide is a new pass, not a swallowed event.
	booted.doc.documentElement.style.removeProperty("--rdsh-safe-top");
	for (let index = 0; index < 5; index += 1) blur();
	assert.equal(countRecoveryFrames(booted), 1, "the second burst was not queued once");
	booted.drainFrames();
	assert.equal(booted.doc.documentElement.style.getPropertyValue("--rdsh-safe-top"), "0px", "the second burst was swallowed");
	booted.disposeAll();
});

test("#76 a keyboard-shrunk layout height is not published as a native gap", () => {
	const booted = bootGestures({ narrow: true });
	booted.drainFrames();
	// Standalone iPad: innerHeight is the web view height. Opening the keyboard
	// shrank it, and the dismiss left it there without an event. Only the
	// window's navigator is wrapped: the boot's service-worker stub stays live.
	const bootNavigator = booted.sandbox.window.navigator;
	booted.sandbox.window.navigator = new Proxy(bootNavigator, {
		get(target, key) {
			if (key === "standalone") return true;
			return Reflect.get(target, key);
		},
	});
	booted.sandbox.window.innerHeight = 544;
	booted.sandbox.innerHeight = 544;
	booted.visualViewport.height = 544;
	booted.doc.documentElement.style.removeProperty("--rdsh-safe-top");

	const blur = windowHandler(booted, "blur", "scheduleKeyboardRecovery");
	blur();
	booted.drainFrames();
	assert.equal(booted.doc.documentElement.style.getPropertyValue("--rdsh-safe-top"), "", "the stale layout was measured");
	assert.equal(booted.doc.documentElement.hasAttribute("data-rdsh-native-gap"), false, "a keyboard-sized gap was published");
	assert.equal(hasTimer(booted, 350), true, "there is no late retry for the dismiss animation");

	// The browser finally restores the layout height, still with no event.
	booted.sandbox.window.innerHeight = 844;
	booted.sandbox.innerHeight = 844;
	booted.visualViewport.height = 844;
	booted.runTimers(350);
	booted.drainFrames();
	assert.equal(booted.doc.documentElement.style.getPropertyValue("--rdsh-safe-top"), "0px", "the restored layout was not measured");
	assert.equal(booted.doc.documentElement.hasAttribute("data-rdsh-native-gap"), false, "a native gap appeared on a full-height layout");
	booted.disposeAll();
});

/**
 * Measure an installed iPhone whose web view is one 47px status bar shorter
 * than the 844px screen, under the given status-bar meta.
 */
function nativeGapUnder(statusBarStyle) {
	const meta = new FakeElement("meta");
	meta.setAttribute("name", "apple-mobile-web-app-status-bar-style");
	meta.setAttribute("content", statusBarStyle);
	const booted = bootGestures({
		narrow: true,
		configureDocument(doc) {
			doc.querySelector = (selector) => (selector === 'meta[name="apple-mobile-web-app-status-bar-style"]' ? meta : null);
		},
	});
	booted.drainFrames();
	const bootNavigator = booted.sandbox.window.navigator;
	booted.sandbox.window.navigator = new Proxy(bootNavigator, {
		get(target, key) {
			if (key === "standalone") return true;
			return Reflect.get(target, key);
		},
	});
	booted.sandbox.window.innerHeight = 797;
	booted.sandbox.innerHeight = 797;
	booted.visualViewport.height = 797;
	const resize = [...booted.windowHandlers].reverse().find(([type]) => type === "resize")?.[1];
	assert.equal(typeof resize, "function", "resize is not watched");
	resize();
	const html = booted.doc.documentElement;
	const measured = { gap: html.hasAttribute("data-rdsh-native-gap"), px: html.style.getPropertyValue("--rdsh-native-gap-px") };
	booted.disposeAll();
	return measured;
}

test("a status-bar-sized shortfall is an unpainted bottom strip only under a translucent status bar", () => {
	// black-translucent draws the page under the clock, so the missing 47px is
	// the strip below the web view (iOS 26).
	assert.deepEqual(nativeGapUnder("black-translucent"), { gap: true, px: "47px" });
	// Any other style starts the web view below the status bar: the 47px is the
	// status bar itself, and the home indicator is inside the page.
	assert.deepEqual(nativeGapUnder("default"), { gap: false, px: "0px" }, "default kept the bottom padding off");
	assert.deepEqual(nativeGapUnder("black"), { gap: false, px: "0px" }, "black kept the bottom padding off");
});

test("#76 a recovery pass does not disturb the rotation follow-up", () => {
	const booted = bootGestures({ narrow: true });
	booted.drainFrames();
	composerFixture(booted.doc);
	booted.visualViewport.height = 844;
	const blur = windowHandler(booted, "blur", "scheduleKeyboardRecovery");
	const orientation = [...booted.windowHandlers].reverse().find(([type]) => type === "orientationchange")?.[1];
	assert.equal(typeof orientation, "function", "rotation is not watched");

	booted.doc.documentElement.style.removeProperty("--rdsh-safe-top");
	blur();
	// A rotation lands before the queued recovery frame runs. It runs the full
	// geometry pass itself and must keep its own 350ms follow-up.
	booted.visualViewport.height = 390;
	orientation();
	booted.drainFrames();
	assert.equal(booted.doc.documentElement.style.getPropertyValue("--rdsh-safe-top"), "0px", "the recovery/rotation pass did not measure");
	assert.equal(hasTimer(booted, 350), true, "the rotation follow-up was lost");
	booted.disposeAll();
});

test("#76 a desktop installs no keyboard-hide recovery", () => {
	const desktop = bootGestures({ mode: "desktop", width: 1024 });
	desktop.drainFrames();
	assert.equal(windowHandler(desktop, "blur", "scheduleKeyboardRecovery"), undefined, "a desktop watches blur");
	assert.equal(windowHandler(desktop, "focus", "scheduleKeyboardRecovery"), undefined, "a desktop watches focus");
	assert.equal(desktop.handler("visibilitychange", "onKeyboardVisibility"), undefined, "a desktop watches visibility");
	assert.equal(desktop.handler("focusout", "onKeyboardFocusOut"), undefined, "a desktop watches focusout");
	desktop.disposeAll();
});

test("#76 a queued recovery frame and timer die with the boot effect", () => {
	const booted = bootGestures({ narrow: true });
	booted.drainFrames();
	booted.visualViewport.height = 544;
	booted.sandbox.window.innerHeight = 544;
	booted.sandbox.innerHeight = 544;
	const blur = windowHandler(booted, "blur", "scheduleKeyboardRecovery");
	blur();
	assert.equal(countRecoveryFrames(booted), 1, "no recovery frame was queued");
	booted.disposeAll();
	assert.equal(countRecoveryFrames(booted), 0, "a recovery frame survived teardown");
	assert.equal(hasTimer(booted, 350), false, "a recovery timer survived teardown");
});

test("every dockkit tab layer lets the browser pan natively", () => {
	// touch-action is the intersection of the hit tab, its strip and the
	// scroller up to the scroll container. The horizontal pan now belongs to
	// the browser, so all four layers must be opened: a leftover `none` (or
	// pan-y only) blocks the native swipe and the strip stops scrolling.
	assert.match(
		CLIENT,
		/\[data-sidebar-right-panel\] \[data-dockkit-strip\],\s*\n\s*\[data-sidebar-right-panel\] \[data-dockkit-strip-tabs\],\s*\n\s*\[data-sidebar-right-panel\] \[data-dockkit-strip-fill\],\s*\n\s*\[data-sidebar-right-panel\] \[data-dockkit-tab\] \{ touch-action: pan-x pan-y; \}/,
		"a dockkit tab layer still blocks native panning",
	);
});

test("the terminal fit never synthesises a wheel or other terminal event", () => {
	// xterm 6's SmoothScrollableElement is not a DOM scroller: its wrapper has
	// no overflow and its scrollTop is unrelated. A wheel is application input
	// for alternate-buffer / mouse-tracking programs, so fit only.
	const start = CLIENT.indexOf("Terminal: keep the screen inside the visual viewport");
	const end = CLIENT.indexOf("function scrollableAncestor", start);
	assert.ok(start !== -1 && end > start, "the terminal fit block is present");
	const block = CLIENT.slice(start, end);
	assert.doesNotMatch(block, /dispatchEvent/, "the fit dispatches an event");
	assert.doesNotMatch(block, /new Event\("wheel"\)/, "the fit creates a wheel");
	assert.doesNotMatch(block, /scrollTop\s*=/, "the follow writes a DOM scroll position");
	assert.doesNotMatch(block, /\.scrollTo(?:Top|Bottom|Line|Page)?\(/, "the follow scrolls a DOM node");
	assert.doesNotMatch(CLIENT, /deltaY = 1e7/, "the huge wheel fallback is back");
});

/* ---------------------------------------------------------------------- */
/* #61 / #62: a route detail owns the left-edge swipe                     */
/* ---------------------------------------------------------------------- */

/** One full-screen plugin detail with its upstream breadcrumb button. */
function routeDetailNode({ attribute = "data-plugin-detail", value = "demo", onBack = () => {} } = {}) {
	const detail = new FakeElement("div");
	detail.setAttribute(attribute, value);
	detail._rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 390, bottom: 800, width: 390, height: 800 });
	const crumb = new FakeElement("button");
	crumb.setAttribute("class", "X_2TxG_crumb");
	crumb.setAttribute("aria-label", "Back to plugins");
	crumb._rect = () => ({ x: 24, y: 28, top: 28, left: 24, right: 130, bottom: 48, width: 106, height: 20 });
	crumb.click = () => {
		crumb.clicks += 1;
		onBack();
	};
	detail._querySelectorAll = (selector) => (selector === 'button[class*="_crumb"]' ? [crumb] : []);
	return { detail, crumb };
}

/** The three document lookups routeDetailOf and the drawer use. */
function wireRouteDetail(doc, current, open = null, page = null) {
	doc.querySelectorAll = (selector) => {
		if (selector === "[data-plugin-detail], [data-plugin-item-detail], [data-plugin-row-detail]") {
			const detail = current();
			return detail === null ? [] : [detail];
		}
		return [];
	};
	doc.querySelector = (selector) => {
		if (selector === '[data-testid="task-manager-page"]') return page;
		if (open !== null && selector.includes("Open sidebar")) return open;
		return null;
	};
}

function edgeSwipeHandlers(booted) {
	const start = booted.handler("touchstart", "onEdgeSwipeStart");
	const move = booted.handler("touchmove", "onEdgeSwipeMove");
	assert.equal(typeof start, "function", "the edge swipe start is registered");
	assert.equal(typeof move, "function", "the edge swipe move is registered");
	return { start, move };
}

const swipeTouch = (x, y = 300) => ({
	cancelable: true,
	prevented: 0,
	preventDefault() {
		this.prevented += 1;
	},
	touches: [{ clientX: x, clientY: y }],
});

const swipeStart = (start, x, target) => start({ touches: [{ clientX: x, clientY: 300 }], target });

test("a left-edge swipe on a plugin detail presses the breadcrumb instead of opening the drawer", () => {
	const booted = bootGestures({ narrow: true });
	const open = new FakeElement("button");
	let drawerPresses = 0;
	open.click = () => {
		drawerPresses += 1;
	};
	const { detail, crumb } = routeDetailNode();
	wireRouteDetail(booted.doc, () => detail, open);
	booted.doc.documentElement.setAttribute("data-rdsh-drawer", "closed");
	booted.doc.documentElement.removeAttribute("data-rdsh-rightpanel-open");
	const { start, move } = edgeSwipeHandlers(booted);

	swipeStart(start, 8, new FakeElement("div"));
	const event = swipeTouch(120);
	move(event);
	assert.equal(crumb.clicks, 1, "the plugin breadcrumb was not pressed");
	assert.equal(drawerPresses, 0, "the detail opened the session drawer instead of going back");
	assert.ok(event.prevented > 0, "the detail did not claim the horizontal swipe");
	assert.equal(booted.doc.documentElement.getAttribute("data-rdsh-drawer"), "closed", "the detail left the drawer open");
	booted.disposeAll();
});

/** Drive one automation-detail swipe with the given (upstream) close label. */
function assertAutomationDetailBack(label) {
	const booted = bootGestures({ narrow: true });
	const open = new FakeElement("button");
	let drawerPresses = 0;
	open.click = () => {
		drawerPresses += 1;
	};
	const page = new FakeElement("section");
	page.setAttribute("data-testid", "task-manager-page");
	page._rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 390, bottom: 800, width: 390, height: 800 });
	const listPane = new FakeElement("div");
	// Upstream hides the list below 760px: a 0x0 box is the signal.
	listPane._rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
	const detailPane = new FakeElement("div");
	detailPane._rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 390, bottom: 800, width: 390, height: 800 });
	detailPane.parentElement = page;
	const close = new FakeElement("button");
	close.setAttribute("aria-label", label);
	close._rect = () => ({ x: 354, y: 8, top: 8, left: 354, right: 382, bottom: 36, width: 28, height: 28 });
	close.parentElement = detailPane;
	close.click = () => {
		close.clicks += 1;
		// Closing the detail puts the list pane back on screen.
		listPane._rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 390, bottom: 800, width: 390, height: 800 });
	};
	page.children = [listPane, detailPane];
	page.querySelectorAll = (selector) => (selector === "button[aria-label]" ? [close] : []);
	wireRouteDetail(booted.doc, () => null, open, page);
	booted.doc.documentElement.setAttribute("data-rdsh-drawer", "closed");
	booted.doc.documentElement.removeAttribute("data-rdsh-rightpanel-open");
	const { start, move } = edgeSwipeHandlers(booted);

	swipeStart(start, 8, new FakeElement("div"));
	const event = swipeTouch(120);
	move(event);
	assert.equal(close.clicks, 1, "the automation detail's close control was not pressed");
	assert.equal(drawerPresses, 0, "the task detail opened the session drawer instead of going back");
	assert.ok(event.prevented > 0, "the automation detail did not claim the horizontal swipe");
	assert.equal(booted.doc.documentElement.getAttribute("data-rdsh-drawer"), "closed", "the task detail left the drawer open");

	// With the list back, the same screen is an ordinary route again.
	swipeStart(start, 8, new FakeElement("div"));
	move(swipeTouch(120));
	assert.equal(drawerPresses, 1, "the list did not recover the ordinary drawer swipe");
	booted.disposeAll();
}

test("a left-edge swipe on an en automation detail closes it instead of opening the drawer", () => {
	assertAutomationDetailBack("Close details");
});

test("a left-edge swipe on a ja automation detail closes it instead of opening the drawer", () => {
	assertAutomationDetailBack("詳細を閉じる");
});

test("nested plugin details go back one breadcrumb per swipe", () => {
	const booted = bootGestures({ narrow: true });
	const row = routeDetailNode({ attribute: "data-plugin-row-detail", value: "demo:row" });
	const pkg = routeDetailNode({ attribute: "data-plugin-detail", value: "demo" });
	const state = { detail: row.detail, pressed: [] };
	row.crumb.click = () => {
		row.crumb.clicks += 1;
		state.pressed.push("row");
		state.detail = pkg.detail;
	};
	pkg.crumb.click = () => {
		pkg.crumb.clicks += 1;
		state.pressed.push("package");
		state.detail = null;
	};
	wireRouteDetail(booted.doc, () => state.detail);
	booted.doc.documentElement.setAttribute("data-rdsh-drawer", "closed");
	booted.doc.documentElement.removeAttribute("data-rdsh-rightpanel-open");
	const { start, move } = edgeSwipeHandlers(booted);

	// The component page goes back to its package page first.
	swipeStart(start, 8, new FakeElement("div"));
	move(swipeTouch(120));
	assert.deepEqual(state.pressed, ["row"], "the swipe skipped the component level");
	assert.equal(booted.doc.documentElement.getAttribute("data-rdsh-drawer"), "closed", "a nested detail opened the drawer");

	// The package page then goes back to the list, never two levels at once.
	swipeStart(start, 8, new FakeElement("div"));
	move(swipeTouch(120));
	assert.deepEqual(state.pressed, ["row", "package"], "the package crumb was not pressed exactly once more");
	assert.equal(booted.doc.documentElement.getAttribute("data-rdsh-drawer"), "closed", "the second level opened the drawer");
	booted.disposeAll();
});

test("a left-edge swipe on an ordinary list still opens the drawer", () => {
	const booted = bootGestures({ narrow: true });
	const open = new FakeElement("button");
	let drawerPresses = 0;
	open.click = () => {
		drawerPresses += 1;
	};
	wireRouteDetail(booted.doc, () => null, open);
	booted.doc.documentElement.setAttribute("data-rdsh-drawer", "closed");
	booted.doc.documentElement.removeAttribute("data-rdsh-rightpanel-open");
	const { start, move } = edgeSwipeHandlers(booted);

	swipeStart(start, 8, new FakeElement("div"));
	move(swipeTouch(120));
	assert.equal(drawerPresses, 1, "the ordinary list lost its drawer swipe");
	booted.disposeAll();
});

test("a desktop boot installs neither the route swipe nor the mobile drawer", () => {
	const booted = bootGestures({ narrow: false, mode: "desktop", width: 1024 });
	const open = new FakeElement("button");
	let drawerPresses = 0;
	open.click = () => {
		drawerPresses += 1;
	};
	const { detail, crumb } = routeDetailNode();
	wireRouteDetail(booted.doc, () => detail, open);
	booted.doc.documentElement.setAttribute("data-rdsh-drawer", "closed");
	booted.doc.documentElement.removeAttribute("data-rdsh-rightpanel-open");

	// Desktop returns before building the mobile half, so there is no handler
	// to claim a swipe and no route back control to press.
	assert.equal(booted.handler("touchstart", "onEdgeSwipeStart"), undefined, "a desktop installed the route swipe");
	assert.equal(booted.sandbox.__RDSH_MOBILE_UX__, undefined, "a desktop built the mobile half");
	assert.equal(crumb.clicks, 0, "a desktop route detail was sent back");
	assert.equal(drawerPresses, 0, "a desktop route detail opened a drawer");
	booted.disposeAll();
});

/* ---------------------------------------------------------------------- */
/* #78: mobile terminal special-key row                                   */
/* ---------------------------------------------------------------------- */

/** A stand-in for the xterm object the React ref points at. */
function keyEmulator(applicationCursor = false) {
	return {
		modes: { applicationCursorKeysMode: applicationCursor },
		sent: [],
		input(data) {
			this.sent.push(data);
		},
	};
}

function terminalKeyRow(terminal) {
	return terminal.section.children.find((child) => child.hasAttribute("data-rdsh-special-keys")) ?? null;
}

function terminalKeyButton(row, id) {
	return row.children.find((child) => child.getAttribute("data-rdsh-terminal-key") === id) ?? null;
}

/** Press one row button the way a finger does. */
function pressTerminalKey(row, id) {
	const button = terminalKeyButton(row, id);
	assert.ok(button, "the " + id + " key exists");
	const event = new FakeEvent("pointerdown", { bubbles: true, cancelable: true });
	event.button = 0;
	button.dispatchEvent(event);
	return { button, event };
}

function terminalKeyEvent(type, fields = {}) {
	const event = new FakeEvent(type, { bubbles: true, cancelable: true });
	for (const [name, value] of Object.entries(fields)) event[name] = value;
	return event;
}

test("#78 the mobile terminal gets one labelled, ordered key row above xterm", () => {
	const booted = bootGestures({ narrow: true });
	const collapse = panelFixture(booted.doc);
	const emulator = keyEmulator();
	const terminal = terminalFixture(booted.doc, collapse, emulator);
	booted.drainFrames();

	const row = terminalKeyRow(terminal);
	assert.ok(row, "no row was mounted");
	assert.equal(terminal.section.children.filter((child) => child.hasAttribute("data-rdsh-special-keys")).length, 1, "the row was mounted twice");
	assert.equal(row.parentElement, terminal.section, "the row is not a direct child of the terminal section");
	assert.ok(terminal.section.children.indexOf(row) < terminal.section.children.indexOf(terminal.screen), "the row is not above the xterm mount");
	assert.equal(row.getAttribute("role"), "group");
	assert.equal(row.getAttribute("aria-label"), COPY.en["terminalKeys.label"]);
	assert.deepEqual(row.children.map((button) => button.getAttribute("data-rdsh-terminal-key")), ["escape", "tab", "up", "down", "left", "right", "ctrl"]);
	assert.equal(terminalKeyButton(row, "escape").textContent, "Esc");
	assert.equal(terminalKeyButton(row, "tab").textContent, "Tab");
	assert.equal(terminalKeyButton(row, "up").getAttribute("aria-label"), "Arrow up");
	assert.equal(terminalKeyButton(row, "ctrl").textContent, "Ctrl");
	assert.equal(terminalKeyButton(row, "ctrl").getAttribute("aria-pressed"), "false");

	// The test seam is the same pure table production uses.
	const api = booted.sandbox.__RDSH_MOBILE_UX__;
	assert.equal(api.specialKeys.sequence("up", false, false), "\x1b[A");
	assert.equal(api.specialKeys.sequence("up", true, false), "\x1bOA");
	assert.equal(api.specialKeys.controlByte("c"), "\x03");
	booted.disposeAll();
});

test("existing off-screen floats remain recoverable", () => {
	const booted = bootGestures({ narrow: true });
	const float = new FakeElement("div");
	float.setAttribute("data-dockkit-float", "pane-1");
	float._rect = () => { const left = Number.parseFloat(float.style.left ?? "-160"); return { left, right: left + 300, top: 30, bottom: 330, width: 300, height: 300 }; };
	const title = new FakeElement("span"); title.textContent = "Terminal";
	float._querySelector = (s) => s === "[data-dockkit-float-title]" ? title : null;
	const owner = new FakeElement("div"); owner.setAttribute("data-sidebar-right-session", "session-1");
	float._closest = (s) => s === "[data-sidebar-right-session]" ? owner : null;
	const oldQuery = booted.doc.querySelectorAll;
	booted.doc.querySelectorAll = (s) => s === "[data-dockkit-float]" ? [float] : oldQuery(s);
	const create = booted.doc.createElement;
	booted.doc.createElement = (tag) => { const node = create(tag); node._querySelector = (s) => s === ".rdsh-float-shelf-list" ? node.children.find((c) => c.className === "rdsh-float-shelf-list") : null; return node; };
	const moves = [];
	booted.ctx.get = (name) => name === "sidebarRight" ? { actionsFor: () => ({ moveFloat: (...args) => moves.push(args) }) } : undefined;
	booted.sandbox.__RDSH_MOBILE_UX__.updateFloatShelf();
	assert.equal(float.hasAttribute("data-rdsh-float-stored"), true);
	const shelf = booted.doc.body.children.find((node) => node.className === "rdsh-float-shelf");
	assert.ok(shelf);
	const list = shelf.children[1];
	assert.equal(list.children[0].textContent, "Terminal");
	booted.sandbox.__RDSH_MOBILE_UX__.updateFloatShelf();
	assert.equal(list.children.length, 1);
	list.children[0].dispatchEvent(new FakeEvent("click"));
	assert.equal(float.hasAttribute("data-rdsh-float-stored"), false);
	assert.deepEqual(moves[0], ["session-1", "pane-1", 0, 30]);
	booted.disposeAll();
});

test("dropping a dock tab outside cancels floating, while in-panel drops remain", () => {
	const booted = bootGestures({ narrow: true });
	const cancel = [];
	booted.sandbox.window.dispatchEvent = (event) => cancel.push(event);
	const surface = new FakeElement("div");
	surface._rect = () => ({left: 0, top: 50, right: 390, bottom: 800});
	const tab = new FakeElement("div");
	tab._closest = (selector) => selector === "[data-dockkit-surface]" ? surface : null;
	const target = new FakeElement("div");
	target._closest = (selector) => selector === "[data-sidebar-right-panel] [data-dockkit-tab]" ? tab : null;
	const down = booted.handler("pointerdown", "onPointerDown");
	const up = booted.handler("pointerup", "onPointerUp");
	down(pointerEvent(target, 100, 100));
	up(pointerEvent(target, 100, 200));
	assert.equal(cancel.length, 0, "in-panel reordering and splitting remain available");
	down(pointerEvent(target, 100, 100));
	up(pointerEvent(target, 100, 30));
	assert.equal(cancel.length, 1, "outside drop must cancel the upstream drag");
	assert.equal(cancel[0].type, "pointercancel");
	booted.disposeAll();
});

test("#78 Esc, Tab and arrows send the exact PTY sequences in both cursor modes", () => {
	const booted = bootGestures({ narrow: true });
	const collapse = panelFixture(booted.doc);
	const emulator = keyEmulator();
	const terminal = terminalFixture(booted.doc, collapse, emulator);
	booted.drainFrames();
	const row = terminalKeyRow(terminal);
	assert.ok(row);

	const sent = (expected) => {
		assert.deepEqual(emulator.sent, expected);
		emulator.sent.length = 0;
	};
	let press = pressTerminalKey(row, "escape");
	sent(["\x1b"]);
	assert.equal(press.event.defaultPrevented, true, "a key press let the button steal focus");
	press = pressTerminalKey(row, "tab");
	sent(["\t"]);
	press = pressTerminalKey(row, "up");
	sent(["\x1b[A"]);
	press = pressTerminalKey(row, "down");
	sent(["\x1b[B"]);
	press = pressTerminalKey(row, "right");
	sent(["\x1b[C"]);
	press = pressTerminalKey(row, "left");
	sent(["\x1b[D"]);

	emulator.modes.applicationCursorKeysMode = true;
	pressTerminalKey(row, "up");
	sent(["\x1bOA"]);
	pressTerminalKey(row, "down");
	sent(["\x1bOB"]);
	pressTerminalKey(row, "right");
	sent(["\x1bOC"]);
	pressTerminalKey(row, "left");
	sent(["\x1bOD"]);

	// Focus stays in the hidden textarea: the keyboard and an IME composition
	// must survive a row tap.
	assert.equal(booted.doc.activeElement, terminal.textarea, "the row did not focus the terminal input");
	assert.ok(terminal.textarea.focusCount > 0, "the terminal input was never focused");
	assert.equal(terminal.textarea.blurCount, 0, "the row blurred the terminal input");
	booted.disposeAll();
});

test("#78 Ctrl is a one-shot modifier and Ctrl+C becomes ETX", () => {
	const booted = bootGestures({ narrow: true });
	const collapse = panelFixture(booted.doc);
	const emulator = keyEmulator();
	const terminal = terminalFixture(booted.doc, collapse, emulator);
	booted.drainFrames();
	const row = terminalKeyRow(terminal);
	const ctrl = terminalKeyButton(row, "ctrl");
	assert.ok(row);

	pressTerminalKey(row, "ctrl");
	assert.deepEqual(emulator.sent, [], "Ctrl alone sent input");
	assert.equal(ctrl.getAttribute("aria-pressed"), "true", "Ctrl was not visibly armed");

	pressTerminalKey(row, "up");
	assert.deepEqual(emulator.sent, ["\x1b[1;5A"], "Ctrl+Up is not the xterm CSI 1;5 form");
	assert.equal(ctrl.getAttribute("aria-pressed"), "false", "the one-shot modifier survived its key");
	emulator.sent.length = 0;
	pressTerminalKey(row, "up");
	assert.deepEqual(emulator.sent, ["\x1b[A"], "the next arrow kept Ctrl");
	emulator.sent.length = 0;

	// Pressing the armed modifier again cancels it instead of latching.
	pressTerminalKey(row, "ctrl");
	pressTerminalKey(row, "ctrl");
	assert.deepEqual(emulator.sent, [], "cancelling Ctrl sent input");
	assert.equal(ctrl.getAttribute("aria-pressed"), "false");

	// A soft-keyboard C is converted before xterm sees it.
	pressTerminalKey(row, "ctrl");
	const keydown = terminalKeyEvent("keydown", { key: "c", code: "KeyC", keyCode: 67 });
	terminal.textarea.dispatchEvent(keydown);
	assert.deepEqual(emulator.sent, ["\x03"], "Ctrl then C did not send ETX");
	assert.equal(keydown.defaultPrevented, true, "the original C reached xterm too");
	assert.equal(ctrl.getAttribute("aria-pressed"), "false", "Ctrl stayed armed after C");

	// iOS may only give beforeinput; it must be consumed the same way.
	pressTerminalKey(row, "ctrl");
	emulator.sent.length = 0;
	const before = terminalKeyEvent("beforeinput", { data: "c", inputType: "insertText" });
	terminal.textarea.dispatchEvent(before);
	assert.deepEqual(emulator.sent, ["\x03"], "beforeinput C did not send ETX");
	assert.equal(before.defaultPrevented, true, "the original beforeinput reached xterm too");

	// An IME composition is not ours to intercept.
	pressTerminalKey(row, "ctrl");
	emulator.sent.length = 0;
	terminal.textarea.dispatchEvent(terminalKeyEvent("keydown", { key: "c", keyCode: 67, isComposing: true }));
	terminal.textarea.dispatchEvent(terminalKeyEvent("keydown", { key: "Process", keyCode: 229 }));
	terminal.textarea.dispatchEvent(terminalKeyEvent("beforeinput", { data: "c", isComposing: true }));
	assert.deepEqual(emulator.sent, [], "an IME composition was turned into a control byte");
	assert.equal(ctrl.getAttribute("aria-pressed"), "true", "an IME composition consumed Ctrl");

	// Ctrl with a non-character terminal key still consumes the modifier.
	pressTerminalKey(row, "ctrl");
	assert.equal(ctrl.getAttribute("aria-pressed"), "false", "the IME test left Ctrl armed");
	pressTerminalKey(row, "ctrl");
	assert.equal(ctrl.getAttribute("aria-pressed"), "true");
	pressTerminalKey(row, "escape");
	assert.deepEqual(emulator.sent, ["\x1b"], "Ctrl+Esc is not a plain Esc");
	assert.equal(ctrl.getAttribute("aria-pressed"), "false");
	booted.disposeAll();
});

test("#78 the textarea fallback sends bytes when the emulator ref is unavailable", () => {
	const booted = bootGestures({ narrow: true });
	const collapse = panelFixture(booted.doc);
	const terminal = terminalFixture(booted.doc, collapse);
	booted.drainFrames();
	const row = terminalKeyRow(terminal);
	assert.ok(row);

	pressTerminalKey(row, "escape");
	let event = terminal.textarea.dispatched.at(-1);
	assert.equal(event.type, "input", "the fallback did not use xterm's input handler");
	assert.equal(event.data, "\x1b");
	assert.equal(event.inputType, "insertText");
	assert.equal(event.composed, false);

	pressTerminalKey(row, "up");
	event = terminal.textarea.dispatched.at(-1);
	assert.equal(event.data, "\x1b[A", "the fallback lost the normal arrow sequence");

	pressTerminalKey(row, "ctrl");
	terminal.textarea.dispatchEvent(terminalKeyEvent("keydown", { key: "c", keyCode: 67 }));
	event = terminal.textarea.dispatched.at(-1);
	assert.equal(event.type, "input");
	assert.equal(event.data, "\x03", "the fallback lost Ctrl+C");
	assert.equal(booted.doc.activeElement, terminal.textarea, "the fallback lost focus");
	booted.disposeAll();
});

test("#78 the key row is mobile-only, idempotent, hidden with its tab, and disposed", () => {
	const desktop = bootGestures({ narrow: false, mode: "desktop", width: 1024 });
	const desktopCollapse = panelFixture(desktop.doc, 1024);
	const desktopTerminal = terminalFixture(desktop.doc, desktopCollapse, keyEmulator());
	desktop.drainFrames();
	assert.equal(terminalKeyRow(desktopTerminal), null, "a desktop got the key row");
	assert.equal(desktop.sandbox.__RDSH_MOBILE_UX__, undefined, "a desktop built the mobile half");
	desktop.disposeAll();

	const booted = bootGestures({ narrow: true });
	const collapse = panelFixture(booted.doc);
	const emulator = keyEmulator();
	const terminal = terminalFixture(booted.doc, collapse, emulator);
	booted.drainFrames();
	const row = terminalKeyRow(terminal);
	assert.ok(row);
	const api = booted.sandbox.__RDSH_MOBILE_UX__;
	api.specialKeys.decorate();
	api.specialKeys.decorate();
	assert.equal(terminal.section.children.filter((child) => child.hasAttribute("data-rdsh-special-keys")).length, 1, "a decorate pass duplicated the row");

	// Keyboard open/close only changes the screen band; the row stays above it.
	booted.visualViewport.height = 544;
	visualViewportHandler(booted)();
	booted.drainFrames();
	assert.equal(terminal.screen.style.height, "500px", "the fit stopped following the keyboard");
	assert.equal(terminalKeyRow(terminal), row, "the row was lost while the keyboard was open");

	// A hidden terminal tab drops the row (and its listeners); becoming
	// visible again builds a fresh one.
	terminal.section._closest = (selector) => (selector === "[hidden]" ? {} : null);
	api.specialKeys.decorate();
	assert.equal(terminalKeyRow(terminal), null, "a hidden tab kept its key row");
	assert.equal((terminal.section.listeners.get("keydown") ?? []).length, 0, "a hidden tab kept its key listener");
	terminal.section._closest = () => null;
	api.specialKeys.decorate();
	const fresh = terminalKeyRow(terminal);
	assert.ok(fresh, "a visible tab did not get its row back");
	assert.notEqual(fresh, row, "the removed row object was reused");

	pressTerminalKey(fresh, "escape");
	assert.deepEqual(emulator.sent, ["\x1b"]);
	const sent = emulator.sent.length;
	booted.disposeAll();
	assert.equal(fresh.isConnected, false, "the row survived dispose");
	assert.equal(terminal.section.children.includes(fresh), false, "the row is still in the terminal");
	assert.equal((terminal.section.listeners.get("keydown") ?? []).length, 0, "the terminal key listener survived dispose");
	assert.equal((terminal.section.listeners.get("beforeinput") ?? []).length, 0, "the terminal beforeinput listener survived dispose");
	terminal.textarea.dispatchEvent(terminalKeyEvent("keydown", { key: "c", keyCode: 67 }));
	assert.equal(emulator.sent.length, sent, "a disposed row still sent input");
});
