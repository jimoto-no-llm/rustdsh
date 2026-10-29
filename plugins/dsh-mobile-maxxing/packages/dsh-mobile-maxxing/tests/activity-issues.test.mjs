/**
 * Behavioural regressions for the phone activity chips and the stats dock.
 *
 * #36 — the dock's used/max figures must come from the public Session list
 * snapshot (`sessions.list.getSnapshot()`), because `ClientSessions` has no
 * `projectionValues()` method. The values are the real `contextPressure`
 * projection: `projectedTokens ?? pressureTokens` over `contextWindow`.
 *
 * #40 — the header shell/subagent rings are the plugin's own elements and are
 * driven by the real `jobs` roster and `sessionStatus` projections, scoped to
 * the current root Session. A completed projection stops the ring without
 * relying on an upstream spinner node.
 *
 * #41 — tapping the chip of an open panel closes it; a different chip and the
 * panel's own controls keep their upstream behaviour.
 *
 * The stub DOM is deliberately small: only the nodes these decorators touch
 * are real. Services are the installed upstream shapes
 * (`ctx.sessions.list`, `ctx.jobs.state`, `ctx.uiSession.sessionStatus`), so
 * these tests fail when a public API changes shape.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { COPY, PROBES } from "../lib/copy.js";

const CLIENT = readFileSync(new URL("../client.js", import.meta.url), "utf8");

// ---------------------------------------------------------------------------
// A tiny DOM: real attributes, children, listeners and bubbling.
// ---------------------------------------------------------------------------

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

/** One attribute/class/tag matcher; enough for the selectors this code uses. */
function matchesOne(element, selector) {
	const attribute = /^([a-zA-Z][\w-]*)?((?:\[[^\]]+\])*)$/.exec(selector);
	if (attribute === null) return false;
	const tag = attribute[1];
	if (tag !== undefined && element.tagName !== tag.toUpperCase()) return false;
	const clauses = attribute[2] === "" ? [] : attribute[2].slice(1, -1).split("][");
	for (const clause of clauses) {
		const equals = /^([^=*^$]+)([*^$]?=)"([^"]*)"$/.exec(clause);
		if (equals === null) {
			if (!element.hasAttribute(clause)) return false;
			continue;
		}
		const [, name, operator, wanted] = equals;
		const actual = name === "class" ? element.className : element.getAttribute(name);
		if (actual === null || actual === undefined) return false;
		if (operator === "*" && !String(actual).includes(wanted)) return false;
		if (operator === "^" && !String(actual).startsWith(wanted)) return false;
		if (operator === "$" && !String(actual).endsWith(wanted)) return false;
		if (operator === "=" && String(actual) !== wanted) return false;
	}
	return true;
}

function matches(element, selector) {
	return selector.split(",").some((part) => matchesOne(element, part.trim()));
}

/** A node the decorators can actually mutate. */
function node(tagName) {
	const attributes = new Map();
	const children = [];
	const listeners = new Map();
	const classes = new Set();
	const element = {
		tagName: String(tagName).toUpperCase(),
		parentElement: null,
		style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => "" },
		dataset: {},
		textContent: "",
		scrollLeft: 0,
		scrollWidth: 0,
		clientWidth: 0,
		scrollHeight: 0,
		clientHeight: 0,
		hidden: false,
		disabled: false,
		get className() {
			return [...classes].join(" ");
		},
		set className(value) {
			classes.clear();
			for (const token of String(value).split(/\s+/)) if (token !== "") classes.add(token);
		},
		get classList() {
			return {
				add: (token) => classes.add(token),
				remove: (token) => classes.delete(token),
				toggle: (token, force) => {
					const next = force === undefined ? !classes.has(token) : Boolean(force);
					if (next) classes.add(token);
					else classes.delete(token);
					return next;
				},
				contains: (token) => classes.has(token),
				[Symbol.iterator]: () => classes[Symbol.iterator](),
			};
		},
		get children() {
			return children;
		},
		get firstChild() {
			return children[0] ?? null;
		},
		get firstElementChild() {
			return children.find((child) => child.tagName !== undefined) ?? null;
		},
		get innerHTML() {
			return "";
		},
		set innerHTML(value) {
			if (value === "") children.length = 0;
		},
		append(...nodes) {
			for (const child of nodes) {
				child.parentElement = element;
				children.push(child);
			}
		},
		prepend(...nodes) {
			for (const child of nodes.slice().reverse()) {
				child.parentElement = element;
				children.unshift(child);
			}
		},
		appendChild(child) {
			element.append(child);
			return child;
		},
		insertBefore(child, before) {
			const at = children.indexOf(child);
			if (at !== -1) children.splice(at, 1);
			const target = before === null || before === undefined ? children.length : children.indexOf(before);
			children.splice(target === -1 ? children.length : target, 0, child);
			child.parentElement = element;
			return child;
		},
		removeChild(child) {
			const index = children.indexOf(child);
			if (index !== -1) children.splice(index, 1);
			child.parentElement = null;
			return child;
		},
		replaceChildren(...nodes) {
			children.splice(0, children.length);
			element.append(...nodes);
		},
		remove() {
			element.parentElement?.removeChild(element);
		},
		setAttribute(name, value) {
			attributes.set(name, String(value));
		},
		getAttribute(name) {
			return attributes.has(name) ? attributes.get(name) : null;
		},
		hasAttribute(name) {
			return attributes.has(name);
		},
		removeAttribute(name) {
			attributes.delete(name);
		},
		toggleAttribute(name, force) {
			const next = force === undefined ? !attributes.has(name) : Boolean(force);
			if (next) attributes.set(name, "");
			else attributes.delete(name);
			return next;
		},
		matches: (selector) => matches(element, selector),
		closest(selector) {
			let current = element;
			while (current !== null && current !== undefined) {
				if (current.matches(selector)) return current;
				current = current.parentElement;
			}
			return null;
		},
		contains(other) {
			let current = other;
			while (current !== null && current !== undefined) {
				if (current === element) return true;
				current = current.parentElement;
			}
			return false;
		},
		querySelectorAll(selector) {
			const found = [];
			const visit = (parent) => {
				for (const child of parent.children ?? []) {
					if (child.matches?.(selector)) found.push(child);
					visit(child);
				}
			};
			visit(element);
			return found;
		},
		querySelector(selector) {
			return element.querySelectorAll(selector)[0] ?? null;
		},
		addEventListener(type, handler, options) {
			if (!listeners.has(type)) listeners.set(type, []);
			listeners.get(type).push({ handler, capture: options === true || options?.capture === true });
		},
		removeEventListener(type, handler) {
			const entries = listeners.get(type) ?? [];
			listeners.set(type, entries.filter((entry) => entry.handler !== handler));
		},
		dispatchEvent(event) {
			event.target = event.target ?? element;
			let current = element;
			while (current !== null && current !== undefined) {
				for (const entry of current.listeners?.get(event.type) ?? []) entry.handler(event);
				if (event.propagationStopped === true) break;
				current = current.parentElement;
			}
			return true;
		},
		click() {
			element.dispatchEvent({ type: "click", target: element, preventDefault() {}, stopPropagation() {} });
		},
		focus() {},
		blur() {},
		scrollBy() {},
		getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
		get listenerCount() {
			return [...listeners.values()].reduce((total, entries) => total + entries.length, 0);
		},
		listeners,
		_attributes: attributes,
	};
	return element;
}

/** The document: everything defaults to absent except what a test wires. */
function makeDocument() {
	const doc = node("#document");
	doc.baseURI = "http://localhost/";
	doc.visibilityState = "visible";
	doc.activeElement = null;
	doc.head = node("head");
	doc.body = node("body");
	doc.documentElement = node("html");
	doc.documentElement.append(doc.head, doc.body);
	doc.documentElement.parentElement = doc;
	doc.styleSheets = [];
	doc.createElement = (tag) => node(tag);
	doc.getElementById = () => null;
	doc.querySelector = (selector) => {
		if (selector === "[data-rdsh-composer-dock]") return doc.dock ?? null;
		if (selector === "[data-conversation-session]") return doc.shownSession ?? null;
		const chip = doc.querySelectorAll(selector)[0];
		return chip ?? null;
	};
	doc.querySelectorAll = (selector) => {
		if (selector === "header button[aria-label]") {
			return [...(doc.headerButtons ?? [])].filter((button) => button.getAttribute("aria-label") !== null);
		}
		if (selector === "header [class*='_spinner_']") return [];
		if (selector === "header svg[class*='_spinner_']:not([data-rdsh-activity-generated])") return [];
		const found = [];
		const visit = (parent) => {
			for (const child of parent.children ?? []) {
				if (matches(child, selector)) found.push(child);
				visit(child);
			}
		};
		visit(doc);
		return found;
	};
	doc.append(doc.documentElement);
	return doc;
}

// ---------------------------------------------------------------------------
// The installed public client services, as the decorators read them.
// ---------------------------------------------------------------------------

function snapshotStore(initial) {
	let value = initial;
	const listeners = new Set();
	return {
		getSnapshot: () => value,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		set(next) {
			value = next;
			for (const listener of [...listeners]) listener();
		},
		get listenerCount() {
			return listeners.size;
		},
	};
}

/**
 * `sessions`, `jobs`, and `uiSession` with the same snapshot/subscribe faces
 * the real client services expose.
 */
function createServices() {
	const list = snapshotStore({ ids: [], byId: {}, phase: "ready", projectionsBySession: {} });
	const sessions = {
		list,
		refreshCalls: [],
		scope: () => undefined,
		refreshProjections(sessionId) {
			sessions.refreshCalls.push(sessionId);
			return Promise.resolve();
		},
	};
	const jobState = snapshotStore({ rows: {}, observed: {} });
	const jobs = {
		state: jobState,
		watchRows: () => () => {},
		observe: () => () => {},
		kill: async () => ({ ok: true }),
	};
	const status = snapshotStore(new Map());
	const uiSession = { sessionStatus: status };
	const sessionsValue = (patch) => {
		const current = list.getSnapshot();
		list.set({ ...current, ...patch });
	};
	const projection = (sessionId, values) => {
		const current = list.getSnapshot();
		sessionsValue({
			ids: current.ids.includes(sessionId) ? current.ids : [...current.ids, sessionId],
			byId: { ...current.byId, [sessionId]: { id: sessionId, ...(current.byId[sessionId] ?? {}) } },
			projectionsBySession: { ...current.projectionsBySession, [sessionId]: { state: "ready", error: null, values } },
		});
	};
	const projectionOnly = (sessionId, values) => {
		const current = list.getSnapshot();
		sessionsValue({
			ids: current.ids.includes(sessionId) ? current.ids : [...current.ids, sessionId],
			byId: { ...current.byId, [sessionId]: { id: sessionId, ...(current.byId[sessionId] ?? {}), projectionValues: undefined } },
			projectionsBySession: { ...current.projectionsBySession, [sessionId]: { state: "ready", error: null, values } },
		});
	};
	const pressure = (sessionId, contextPressure) => {
		const current = list.getSnapshot();
		sessionsValue({
			ids: current.ids.includes(sessionId) ? current.ids : [...current.ids, sessionId],
			byId: {
				...current.byId,
				[sessionId]: { id: sessionId, ...(current.byId[sessionId] ?? {}), projectionValues: { contextPressure } },
			},
		});
	};
	const jobsIn = (sessionId, rows) => {
		const current = jobState.getSnapshot();
		jobState.set({ ...current, rows: { ...current.rows, [sessionId]: rows } });
	};
	const statusOf = (sessionId, running) => {
		const next = new Map(status.getSnapshot());
		next.set(sessionId, { running, pendingInteraction: undefined, completionUnread: false });
		status.set(next);
	};
	return {
		services: { sessions, jobs, uiSession },
		list,
		jobState,
		status,
		sessionsValue,
		projection,
		projectionOnly,
		pressure,
		jobsIn,
		statusOf,
	};
}

// ---------------------------------------------------------------------------
// Boot the real client module against the stub browser.
// ---------------------------------------------------------------------------

function boot({
	narrow = true,
	mode = narrow ? "mobile" : "desktop",
	services = createServices().services,
	getOverride = null,
	configureDocument = () => {},
	storage = null,
	console: consoleImpl = console,
} = {}) {
	let definition;
	const disposers = [];
	const frames = [];
	const media = { matches: narrow, listeners: new Set() };
	const timeouts = [];
	const intervals = new Map();
	let intervalId = 0;
	const sandbox = {
		__RDSH_PWA_PROBES__: PROBES,
		__RDSH_PWA_COPY__: COPY,
		window: {
			__ModuleLoader__: {
				load(value) {
					definition = value;
				},
			},
		},
		document: (() => {
			const doc = makeDocument();
			configureDocument(doc);
			return doc;
		})(),
		navigator: stub(),
		location: stub(),
		localStorage: storage === null ? stub() : memoryStorage(storage),
		sessionStorage: stub(),
		matchMedia: (query) => ({
			get matches() {
				return Boolean(media.matches && query.includes("max-width: 767px"));
			},
			addEventListener(type, listener) {
				if (type === "change" && query.includes("max-width: 767px")) media.listeners.add(listener);
			},
			removeEventListener(type, listener) {
				if (type === "change") media.listeners.delete(listener);
			},
		}),
		addEventListener: () => {},
		removeEventListener: () => {},
		setTimeout: (callback, ms) => {
			timeouts.push({ callback, ms });
			return timeouts.length;
		},
		clearTimeout: () => {},
		setInterval: (callback, ms) => {
			intervalId += 1;
			intervals.set(intervalId, { callback, ms });
			return intervalId;
		},
		clearInterval: (id) => {
			intervals.delete(id);
		},
		requestAnimationFrame: (callback) => {
			frames.push(callback);
			return frames.length;
		},
		cancelAnimationFrame: () => {},
		MutationObserver: class {
			observe() {}
			disconnect() {}
		},
		IntersectionObserver: class {
			observe() {}
			disconnect() {}
		},
		getComputedStyle: () => stub(),
		console: consoleImpl,
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
		PointerEvent: class PointerEvent {},
		KeyboardEvent: class KeyboardEvent {
			constructor(type, init = {}) {
				this.type = type;
				Object.assign(this, init);
			}
		},
		TouchEvent: class TouchEvent {},
		Touch: class Touch {},
		MessageChannel: class MessageChannel {},
		Notification: stub(),
		AudioContext: class AudioContext {},
		screen: stub(),
		innerWidth: 390,
		innerHeight: 844,
		devicePixelRatio: 3,
		performance: { now: () => 0 },
		globalThis: undefined,
	};
	sandbox.globalThis = sandbox;
	sandbox.__RDSH_DEVICE_MODE__ = mode;
	sandbox.window.document = sandbox.document;
	sandbox.window.matchMedia = sandbox.matchMedia;
	sandbox.window.setTimeout = sandbox.setTimeout;
	sandbox.window.clearTimeout = sandbox.clearTimeout;
	sandbox.window.setInterval = sandbox.setInterval;
	sandbox.window.clearInterval = sandbox.clearInterval;
	sandbox.window.requestAnimationFrame = sandbox.requestAnimationFrame;
	sandbox.window.addEventListener = sandbox.addEventListener;
	sandbox.window.removeEventListener = sandbox.removeEventListener;
	sandbox.window.location = sandbox.location;
	sandbox.window.navigator = sandbox.navigator;
	sandbox.window.localStorage = sandbox.localStorage;
	sandbox.window.screen = sandbox.screen;
	sandbox.window.performance = sandbox.performance;
	sandbox.window.innerWidth = 390;
	sandbox.window.innerHeight = 844;
	vm.createContext(sandbox);
	vm.runInContext(CLIENT, sandbox, { filename: "client.js" });
	assert.ok(definition !== undefined, "the module registered itself");

	const plugin = definition.factory((name) => stub());
	assert.equal(typeof plugin.apply, "function");

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
		get(name) {
			if (getOverride !== null) {
				const answer = getOverride(name);
				if (answer !== undefined) return answer;
			}
			return services[name];
		},
		on: () => () => {},
	};
	plugin.apply(ctx);
	const api = sandbox.__RDSH_MOBILE_UX__;
	// Desktop builds no plugin, so there is no diagnostics surface at all.
	if (mode !== "mobile") assert.equal(api, undefined, "a desktop boot published mobile diagnostics");
	else assert.ok(api !== undefined, "the diagnostics surface exists");
	return {
		sandbox,
		ctx,
		services,
		api,
		document: sandbox.document,
		frames,
		timeouts,
		intervals,
		runFrames() {
			for (const callback of frames.splice(0)) callback();
		},
		/** Emulate the width query flipping (rotation, window resize). */
		setNarrow(next) {
			media.matches = next;
			for (const listener of [...media.listeners]) listener({ matches: next });
		},
		dispose() {
			const errors = [];
			for (const dispose of disposers.splice(0).reverse()) {
				try {
					dispose();
				} catch (error) {
					errors.push(error);
				}
			}
			return errors;
		},
	};
}

/** A header chip with the attributes upstream renders. */
function chip(label, { expanded = null, children = [] } = {}) {
	const button = node("button");
	button.setAttribute("aria-label", label);
	if (expanded !== null) button.setAttribute("aria-expanded", String(expanded));
	for (const child of children) button.append(child);
	return button;
}

/** One count label from a committed namespace, rendered like the shell does. */
const NAMESPACES = new Map();
function countLabel(lang, name, key, count = 3) {
	const id = `${lang}/${name}`;
	if (!NAMESPACES.has(id)) {
		const file = new URL(`../../dsh-locale-ja/locale/namespaces/${id}.json`, import.meta.url);
		NAMESPACES.set(id, JSON.parse(readFileSync(file, "utf8")));
	}
	return NAMESPACES.get(id)[key].replace("{count}", String(count));
}

function ringOf(button) {
	return button.querySelector("[data-rdsh-activity-spinner]");
}

/** Publish one shown Session through upstream's real DOM attribute. */
function showSession(booted, sessionId) {
	if (sessionId === null) {
		booted.document.shownSession = null;
		return;
	}
	const holder = node("div");
	holder.setAttribute("data-conversation-session", sessionId);
	booted.document.shownSession = holder;
}

/** Decorate the given header chips through the plugin's own decorate pass. */
function decorateChips(booted, chips) {
	for (const chip of chips) {
		if (chip.parentElement === null) booted.document.body.append(chip);
	}
	booted.document.headerButtons = chips;
	// A desktop boot has no decorator: that IS the assertion in the #40 test.
	booted.api?.decorate?.();
	booted.runFrames();
}

/** The plugin's own 500ms poll, distinguishable from the PWA update poll. */
function activityPolls(booted) {
	return [...booted.intervals.values()].filter((entry) => entry.ms === 500);
}

// ---------------------------------------------------------------------------
// #36 — context figures from the public list snapshot
// ---------------------------------------------------------------------------

/** Boot with a narrow dock carrying the upstream three stats buttons. */
function bootWithDock({ services = {}, getOverride = null, labels = {} } = {}) {
	const dock = node("div");
	dock.setAttribute("data-rdsh-composer-dock", "");
	const turns = node("button");
	turns.setAttribute("aria-label", labels.turns ?? "3 turns · 42 tok/s");
	const usage = node("button");
	usage.setAttribute("aria-label", labels.usage ?? "Cache hit 40%");
	const context = node("button");
	context.setAttribute("aria-label", labels.context ?? "49% of context used");
	dock.append(turns, usage, context);
	const booted = boot({
		services,
		getOverride,
		configureDocument(doc) {
			doc.dock = dock;
			doc.body.append(dock);
		},
	});
	return { booted, dock, context };
}

/** Run one decorate pass and read the context pill's rendered text. */
function statText(booted, context) {
	booted.api.decorate();
	booted.runFrames();
	return context.getAttribute("data-rdsh-stat-text");
}

test("#36 the dock reads contextPressure from the public Session list snapshot", () => {
	const harness = createServices();
	const { booted, dock, context } = bootWithDock({ services: harness.services });
	showSession(booted, "s1");
	assert.equal(statText(booted, context), "49%", "no projection yet: the percentage alone");

	// A carried projection repaints through the list subscription.
	harness.pressure("s1", { projectedTokens: 12345, pressureTokens: 12000, contextWindow: 1000000 });
	assert.equal(booted.frames.length, 1, "the projection frame schedules one decorate pass");
	booted.runFrames();
	assert.equal(context.getAttribute("data-rdsh-stat-text"), "49% · 12.3K/1M", "projectedTokens is the anchored numerator upstream uses");

	harness.pressure("s1", { pressureTokens: 12300, contextWindow: 1000000 });
	booted.runFrames();
	assert.equal(context.getAttribute("data-rdsh-stat-text"), "49% · 12.3K/1M", "pressureTokens is the fallback numerator");

	// A row whose summary hint has not landed still has the finished value.
	harness.projectionOnly("s1", { contextPressure: { pressureTokens: 900, contextWindow: 1000 } });
	booted.runFrames();
	assert.equal(context.getAttribute("data-rdsh-stat-text"), "49% · 900/1K", "projectionsBySession is the public fallback face");
	assert.deepEqual(harness.services.sessions.refreshCalls, ["s1"], "a carried value does not re-request the host");

	const buttons = dock.querySelectorAll("button");
	assert.equal(buttons[0].getAttribute("data-rdsh-stat-text"), "3 turns · 42 tok/s");
	assert.equal(buttons[1].getAttribute("data-rdsh-stat-text"), "Cache hit 40%");
});

test("#36 the reviewed ja stats labels are recognised", () => {
	// chat:stats.counts, chat:stats.cacheHit and conversation:context.aria as the
	// reviewed ja catalogue renders them. The rendered text itself still follows
	// this package's own copy pack, so the probe match is what is pinned here.
	const harness = createServices();
	const { booted, dock, context } = bootWithDock({
		services: harness.services,
		labels: {
			turns: "3 ターン 42 ステップ · 42 tok/s",
			usage: "キャッシュヒット 40%",
			context: "コンテキストの使用率 49%",
		},
	});
	showSession(booted, "s1");
	assert.equal(statText(booted, context), "49%", "the ja context chip lost its percentage");
	const buttons = dock.querySelectorAll("button");
	assert.equal(buttons[0].getAttribute("data-rdsh-stat-text"), "3 turns · 42 tok/s", "the ja turns chip was not found");
	assert.equal(buttons[1].getAttribute("data-rdsh-stat-text"), "Cache hit 40%", "the ja cache chip was not found");
});

test("#36 missing or malformed projections keep the percentage and ask once", () => {
	const harness = createServices();
	const { booted, context } = bootWithDock({ services: harness.services });
	showSession(booted, "s1");
	assert.equal(statText(booted, context), "49%");
	assert.equal(statText(booted, context), "49%");
	assert.deepEqual(harness.services.sessions.refreshCalls, ["s1"], "one request per selected Session");

	harness.pressure("s1", { pressureTokens: 12300 });
	assert.equal(statText(booted, context), "49%", "no route capacity means no used/max text");

	harness.pressure("s1", { pressureTokens: "12300", contextWindow: 1000000 });
	assert.equal(statText(booted, context), "49%", "wire numbers are numbers");

	harness.pressure("s1", { projectedTokens: 12345, pressureTokens: 12000, contextWindow: 0 });
	assert.equal(statText(booted, context), "49%", "a zero window is not a capacity");

	harness.pressure("s2", { projectedTokens: 5000, contextWindow: 200000 });
	showSession(booted, "s2");
	assert.equal(statText(booted, context), "49% · 5K/200K", "a session switch reads that session's row");

	showSession(booted, null);
	assert.equal(statText(booted, context), "49%", "no selected Session means no figures");
});

test("#36 an absent or throwing sessions service costs only the used/max text", () => {
	const plain = bootWithDock({});
	showSession(plain.booted, "s1");
	assert.doesNotThrow(() => statText(plain.booted, plain.context));
	assert.equal(plain.context.getAttribute("data-rdsh-stat-text"), "49%");

	// An old client that throws on the absent service must not break the dock.
	const throwing = bootWithDock({
		getOverride: (name) => {
			if (name === "sessions") throw new Error("service not injected");
			return undefined;
		},
	});
	showSession(throwing.booted, "s1");
	assert.equal(statText(throwing.booted, throwing.context), "49%");
});

// ---------------------------------------------------------------------------
// #40 — the rings are ours and follow the real projections
// ---------------------------------------------------------------------------

test("#40 a completed shell job stops the ring without any upstream spinner", () => {
	const harness = createServices();
	const booted = boot({ services: harness.services });
	const { api } = booted;
	showSession(booted, "s1");
	const nativeSpinner = node("svg");
	nativeSpinner.setAttribute("class", "abc_spinner");
	const shell = chip("2 background jobs running", { children: [nativeSpinner] });

	harness.jobsIn("s1", [
		{ id: "job-1", status: "running" },
		{ id: "job-2", status: "stopping" },
	]);
	decorateChips(booted, [shell]);
	assert.equal(shell.getAttribute("data-rdsh-activity-state"), "running");
	assert.equal(shell.hasAttribute("data-rdsh-activity-running"), true);
	const ring = ringOf(shell);
	assert.ok(ring !== null, "the plugin draws its own ring");
	assert.equal(ring.className, "rdsh-activity-ring");
	assert.equal(ring.querySelector("svg"), null, "the upstream spinner is neither adopted nor cloned");
	assert.equal(nativeSpinner.parentElement, shell, "the native node is left alone");

	// Completion of both jobs arrives as one roster frame.
	harness.jobsIn("s1", [
		{ id: "job-1", status: "completed" },
		{ id: "job-2", status: "failed" },
	]);
	decorateChips(booted, [shell]);
	assert.equal(shell.getAttribute("data-rdsh-activity-state"), "idle");
	assert.equal(shell.hasAttribute("data-rdsh-activity-running"), false);
	assert.equal(ringOf(shell), ring, "the ring is reused, not re-created");
	assert.equal(activityPolls(booted).length, 0, "an idle chip owns no timer");
});

test("#40 subagent running is scoped to the current root Session's catalog", () => {
	const harness = createServices();
	const booted = boot({ services: harness.services });
	const { api } = booted;
	showSession(booted, "root");
	harness.projection("root", { subagentCatalog: [{ id: "child-a", mode: "one-shot" }, { id: "child-b", mode: "one-shot" }] });
	harness.projection("other-root", { subagentCatalog: [{ id: "foreign-child", mode: "one-shot" }] });
	harness.statusOf("child-a", true);
	harness.statusOf("foreign-child", true);
	const subagent = chip("2 subagents");

	decorateChips(booted, [subagent]);
	assert.equal(subagent.getAttribute("data-rdsh-activity-state"), "running", "a running direct child spins the chip");
	assert.equal(activityPolls(booted).length, 1, "a running ring polls as a safety net");

	// The other Session's child finishing must not be required to stop this one.
	harness.statusOf("child-a", false);
	decorateChips(booted, [subagent]);
	assert.equal(subagent.getAttribute("data-rdsh-activity-state"), "idle", "the direct child's completion stops it");
	assert.equal(activityPolls(booted).length, 0);

	// A running child of another root never spins this root's chip.
	harness.statusOf("foreign-child", true);
	decorateChips(booted, [subagent]);
	assert.equal(subagent.getAttribute("data-rdsh-activity-state"), "idle");
});

test("#40 missing services fall back to upstream's real running label, not spinner nodes", () => {
	const booted = boot({ services: {} });
	const running = chip("3 background jobs running");
	const idle = chip("3 background jobs");
	const subagents = chip("1 subagent running");
	showSession(booted, "s1");
	decorateChips(booted, [running, idle, subagents]);
	assert.equal(running.getAttribute("data-rdsh-activity-state"), "running");
	assert.equal(idle.getAttribute("data-rdsh-activity-state"), "idle");
	assert.equal(subagents.getAttribute("data-rdsh-activity-state"), "running");
});

test("#40 a replaced service drops its old subscription (reconnect, no stale sessions)", () => {
	const harness = createServices();
	harness.jobsIn("s1", [{ id: "job-1", status: "running" }]);
	const booted = boot({ services: harness.services });
	const { api } = booted;
	showSession(booted, "s1");
	const shell = chip("1 background job running");

	decorateChips(booted, [shell]);
	assert.equal(harness.jobState.listenerCount, 1);
	assert.equal(shell.getAttribute("data-rdsh-activity-state"), "running");

	// The client jobs service is replaced (reconnect) by an idle roster.
	const replacementState = snapshotStore({ rows: { s1: [{ id: "job-1", status: "completed" }] }, observed: {} });
	booted.services.jobs = { state: replacementState, watchRows: () => () => {}, observe: () => () => {}, kill: async () => ({}) };
	decorateChips(booted, [shell]);
	assert.equal(harness.jobState.listenerCount, 0, "the old generation is unsubscribed");
	assert.equal(replacementState.listenerCount, 1, "the new generation is followed");
	assert.equal(shell.getAttribute("data-rdsh-activity-state"), "idle");
});

test("#40 a projection frame refreshes the chip and teardown releases every subscription", () => {
	const harness = createServices();
	harness.jobsIn("s1", [{ id: "job-1", status: "running" }]);
	const shell = chip("1 background job running");
	const booted = boot({
		services: harness.services,
		configureDocument(doc) {
			doc.headerButtons = [shell];
		},
	});
	const { api } = booted;
	showSession(booted, "s1");
	booted.runFrames();
	assert.equal(booted.frames.length, 0);
	assert.equal(harness.list.listenerCount, 1);
	assert.equal(harness.jobState.listenerCount, 1);
	assert.equal(harness.status.listenerCount, 1);

	// Roster completion notifies through the subscription, not a DOM read.
	harness.jobsIn("s1", [{ id: "job-1", status: "completed" }]);
	assert.equal(booted.frames.length, 1, "a real frame schedules one decorate pass");
	booted.runFrames();
	assert.equal(shell.getAttribute("data-rdsh-activity-state"), "idle");
	assert.equal(activityPolls(booted).length, 0, "completion stops the poll");

	assert.deepEqual(booted.dispose(), []);
	assert.equal(harness.list.listenerCount, 0);
	assert.equal(harness.jobState.listenerCount, 0);
	assert.equal(harness.status.listenerCount, 0);
});

test("#40 count chips are detected in every upstream locale (en, zh)", () => {
	// Installed DSH 0.2.1-rc.2 ships en and zh only (locale/ dirs). The ja
	// vocabulary lives in PROBES too (#80); the committed labels are pinned
	// below against the full translation package.
	const en = chip("2 subagents");
	const zh = chip("2 个子智能体");
	const zhJobs = chip("1 个后台任务运行中");
	const booted = boot({
		services: {},
		configureDocument(doc) {
			doc.headerButtons = [en, zh, zhJobs];
		},
	});
	booted.api.decorate();
	booted.runFrames();
	assert.equal(en.getAttribute("data-rdsh-activity-chip"), "subagent");
	assert.equal(zh.getAttribute("data-rdsh-activity-chip"), "subagent");
	assert.equal(zhJobs.getAttribute("data-rdsh-activity-chip"), "shell");
	assert.equal(zhJobs.getAttribute("data-rdsh-activity-state"), "running", "the zh running word is probed");
	assert.equal(zh.getAttribute("data-rdsh-activity-state"), "idle");
});

test("#80 the committed ja count chips are all decorated, idle included", () => {
	// The full ja catalogue renders the subagent total noun-first
	// ("サブエージェント 3 件"); the old leading-number regex left that chip
	// bare, so no ring, icon or second-tap close was installed.
	const idleSubagents = chip(countLabel("ja", "subagent", "count.total.other"), { expanded: true });
	const runningSubagents = chip(countLabel("ja", "subagent", "count.running.other"));
	const idleJobs = chip(countLabel("ja", "job", "count.idle.other"));
	const runningJobs = chip(countLabel("ja", "job", "count.live.other"));
	const escapes = [];
	idleSubagents.dispatchEvent = (event) => {
		escapes.push(event);
		return true;
	};
	const booted = boot({
		services: {},
		configureDocument(doc) {
			doc.headerButtons = [idleSubagents, runningSubagents, idleJobs, runningJobs];
		},
	});
	booted.api.decorate();
	booted.runFrames();

	assert.equal(idleSubagents.getAttribute("data-rdsh-activity-chip"), "subagent");
	assert.equal(idleSubagents.getAttribute("data-rdsh-activity-state"), "idle");
	assert.ok(ringOf(idleSubagents) !== null, "the idle ja subagent chip has no ring");
	assert.ok(idleSubagents.querySelector("[data-rdsh-activity-icon]") !== null, "the idle ja subagent chip has no icon");
	assert.equal(runningSubagents.getAttribute("data-rdsh-activity-chip"), "subagent");
	assert.equal(runningSubagents.getAttribute("data-rdsh-activity-state"), "running");
	assert.equal(idleJobs.getAttribute("data-rdsh-activity-chip"), "shell");
	assert.equal(idleJobs.getAttribute("data-rdsh-activity-state"), "idle");
	assert.ok(ringOf(idleJobs) !== null, "the idle ja jobs chip has no ring");
	assert.equal(runningJobs.getAttribute("data-rdsh-activity-chip"), "shell");
	assert.equal(runningJobs.getAttribute("data-rdsh-activity-state"), "running");

	// The second tap closes the open panel through the root's Escape path.
	const event = documentClick(booted, ringOf(idleSubagents));
	assert.equal(event.prevented, true, "the ja idle chip never reaches the upstream opener");
	assert.equal(event.stopped, true);
	assert.equal(escapes.length, 1, "the ja idle chip has no second-tap close");
	assert.equal(escapes[0].key, "Escape");
});

test("#80 the noun-first ja match is anchored to a real count label", () => {
	// Negative controls built from the committed label: a bare noun, a verb
	// phrase, a number without its counter, and the label with a suffix must
	// all stay ordinary buttons.
	const idle = countLabel("ja", "subagent", "count.total.other");
	const noun = PROBES.activityChipCountLast.find((value) => idle.startsWith(`${value} `));
	assert.ok(noun !== undefined, "the committed noun-first label has no noun probe");
	const controls = [chip(noun), chip(`${noun}を開く`), chip(`${noun} 3`), chip(`${idle}の履歴`)];
	const booted = boot({ services: {} });
	decorateChips(booted, controls);
	for (const control of controls) {
		assert.equal(control.hasAttribute("data-rdsh-activity-chip"), false, `${control.getAttribute("aria-label")} was mistaken for a count chip`);
		assert.equal(ringOf(control), null, `${control.getAttribute("aria-label")} got a ring`);
		assert.equal(control.querySelector("[data-rdsh-activity-icon]"), null, `${control.getAttribute("aria-label")} got an icon`);
	}
});

test("#80 the committed en count labels keep their classification", () => {
	const idleSubagents = chip(countLabel("en", "subagent", "count.total.other"));
	const runningSubagents = chip(countLabel("en", "subagent", "count.running.other"));
	const idleJobs = chip(countLabel("en", "job", "count.idle.other"));
	const runningJobs = chip(countLabel("en", "job", "count.live.other"));
	const booted = boot({ services: {} });
	decorateChips(booted, [idleSubagents, runningSubagents, idleJobs, runningJobs]);
	assert.equal(idleSubagents.getAttribute("data-rdsh-activity-chip"), "subagent");
	assert.equal(idleSubagents.getAttribute("data-rdsh-activity-state"), "idle");
	assert.equal(runningSubagents.getAttribute("data-rdsh-activity-state"), "running");
	assert.equal(idleJobs.getAttribute("data-rdsh-activity-chip"), "shell");
	assert.equal(runningJobs.getAttribute("data-rdsh-activity-state"), "running");
	for (const control of [idleSubagents, runningSubagents, idleJobs, runningJobs]) {
		assert.ok(ringOf(control) !== null, "an en count chip lost its ring");
	}
});

test("#40 a width change keeps the mobile sources and nodes; desktop mode never subscribes", () => {
	const harness = createServices();
	harness.jobsIn("s1", [{ id: "job-1", status: "running" }]);
	const shell = chip("1 background job running");
	const booted = boot({
		mode: "mobile",
		services: harness.services,
		configureDocument(doc) {
			doc.headerButtons = [shell];
		},
	});
	showSession(booted, "s1");
	decorateChips(booted, [shell]);
	assert.equal(harness.list.listenerCount, 1);
	assert.equal(harness.jobState.listenerCount, 1);
	assert.equal(harness.status.listenerCount, 1);
	assert.equal(activityPolls(booted).length, 1);
	assert.ok(ringOf(shell) !== null);

	// Width is geometry only: a tablet-wide mobile window keeps the same mode,
	// sources and nodes rather than tearing the phone surface down.
	booted.setNarrow(false);
	booted.runFrames();
	assert.equal(harness.list.listenerCount, 1, "the width change released the list source");
	assert.equal(harness.jobState.listenerCount, 1, "the width change released the jobs source");
	assert.equal(harness.status.listenerCount, 1, "the width change released the status source");
	assert.equal(activityPolls(booted).length, 1);
	assert.equal(shell.hasAttribute("data-rdsh-activity-chip"), true);
	assert.ok(ringOf(shell) !== null, "the injected ring left with a width change");
	assert.equal(harness.jobState.listenerCount, 1, "a wide pass resubscribed");

	// The same narrow window in desktop mode never gets a phone subscription,
	// chip or ring.
	const desktopHarness = createServices();
	const desktopShell = chip("1 background job running");
	const desktop = boot({
		mode: "desktop",
		narrow: true,
		services: desktopHarness.services,
		configureDocument(doc) {
			doc.headerButtons = [desktopShell];
		},
	});
	showSession(desktop, "s1");
	decorateChips(desktop, [desktopShell]);
	desktop.runFrames();
	assert.equal(desktopHarness.list.listenerCount, 0);
	assert.equal(desktopHarness.jobState.listenerCount, 0);
	assert.equal(desktopHarness.status.listenerCount, 0);
	assert.equal(activityPolls(desktop).length, 0);
	assert.equal(desktopShell.hasAttribute("data-rdsh-activity-chip"), false);
	assert.equal(ringOf(desktopShell), null);
});

test("#40 a disappeared jobs service releases its old subscription too", () => {
	const harness = createServices();
	harness.jobsIn("s1", [{ id: "job-1", status: "running" }]);
	const shell = chip("1 background job running");
	const booted = boot({
		services: harness.services,
		configureDocument(doc) {
			doc.headerButtons = [shell];
		},
	});
	showSession(booted, "s1");
	decorateChips(booted, [shell]);
	assert.equal(harness.jobState.listenerCount, 1);
	delete booted.services.jobs;
	decorateChips(booted, [shell]);
	assert.equal(harness.jobState.listenerCount, 0, "a null source releases the previous one");
	assert.equal(shell.getAttribute("data-rdsh-activity-state"), "running", "the label remains the fallback");
});

test("#40 a decorate pass completes when two services disappear mid-pass", () => {
	const harness = createServices();
	harness.jobsIn("s1", [{ id: "job-1", status: "running" }]);
	harness.projection("s1", { subagentCatalog: [{ id: "child-a", mode: "one-shot" }] });
	harness.statusOf("child-a", true);
	const shell = chip("1 background job running");
	const subagent = chip("1 subagent running");
	const errors = [];
	const booted = boot({
		services: harness.services,
		console: { ...console, error: (...args) => errors.push(args) },
		configureDocument(doc) {
			doc.headerButtons = [shell, subagent];
		},
	});
	showSession(booted, "s1");
	decorateChips(booted, [shell, subagent]);
	assert.equal(shell.getAttribute("data-rdsh-activity-state"), "running");
	assert.equal(subagent.getAttribute("data-rdsh-activity-state"), "running");

	// Both optional services vanish at once and the labels go idle. The pass
	// must reach the second chip instead of aborting on a null source.
	shell.setAttribute("aria-label", "1 background job");
	subagent.setAttribute("aria-label", "1 subagent");
	delete booted.services.jobs;
	delete booted.services.uiSession;
	decorateChips(booted, [shell, subagent]);
	assert.deepEqual(errors, [], "releasing a null source must not throw");
	assert.equal(shell.getAttribute("data-rdsh-activity-state"), "idle");
	assert.equal(subagent.getAttribute("data-rdsh-activity-state"), "idle", "the later chip was still processed");
});

test("#40 a replaced sessions service releases the old list subscription", () => {
	const harness = createServices();
	harness.jobsIn("s1", [{ id: "job-1", status: "running" }]);
	const shell = chip("1 background job running");
	const booted = boot({
		services: harness.services,
		configureDocument(doc) {
			doc.headerButtons = [shell];
		},
	});
	showSession(booted, "s1");
	decorateChips(booted, [shell]);
	assert.equal(harness.list.listenerCount, 1);

	// A reconnect replaces the whole sessions facade (the old one used to be
	// cached forever, so its list subscription leaked).
	const replacement = createServices();
	replacement.jobsIn("s1", [{ id: "job-1", status: "running" }]);
	booted.services.sessions = replacement.services.sessions;
	booted.services.jobs = replacement.services.jobs;
	decorateChips(booted, [shell]);
	assert.equal(harness.list.listenerCount, 0, "the old sessions generation is released");
	assert.equal(replacement.list.listenerCount, 1, "the new sessions generation is followed");
	assert.equal(harness.jobState.listenerCount, 0, "the old jobs generation is released as well");
	assert.equal(replacement.jobState.listenerCount, 1);
	assert.equal(shell.getAttribute("data-rdsh-activity-state"), "running");

	delete booted.services.sessions;
	decorateChips(booted, [shell]);
	assert.equal(replacement.list.listenerCount, 0, "a removed sessions service releases its subscription");
});

test("#40 the actual zh subagent running label is recognised", () => {
	const booted = boot({ services: {} });
	const running = chip("3 个子智能体，正在运行");
	const idle = chip("3 个子智能体");
	decorateChips(booted, [running, idle]);
	assert.equal(running.getAttribute("data-rdsh-activity-state"), "running", "正在运行 is a running word too");
	assert.equal(idle.getAttribute("data-rdsh-activity-state"), "idle");
});

test("#40 the reviewed ja count labels are recognised", () => {
	// subagent:count.running.other / job:count.live.other and their idle forms.
	const booted = boot({ services: {} });
	const subagentRunning = chip("3 件のサブエージェントが実行中");
	const subagentIdle = chip("3 件のサブエージェント");
	const jobRunning = chip("1件のバックグラウンドジョブが実行中");
	const jobIdle = chip("1件のバックグラウンドジョブ");
	decorateChips(booted, [subagentRunning, subagentIdle, jobRunning, jobIdle]);
	assert.equal(subagentRunning.getAttribute("data-rdsh-activity-chip"), "subagent", "the ja subagent noun did not pick the subagent glyph");
	assert.equal(subagentIdle.getAttribute("data-rdsh-activity-chip"), "subagent");
	assert.equal(jobRunning.getAttribute("data-rdsh-activity-chip"), "shell", "the ja job noun did not pick the shell glyph");
	assert.equal(jobIdle.getAttribute("data-rdsh-activity-chip"), "shell");
	assert.equal(subagentRunning.getAttribute("data-rdsh-activity-state"), "running", "the ja running word is not probed");
	assert.equal(jobRunning.getAttribute("data-rdsh-activity-state"), "running");
	assert.equal(subagentIdle.getAttribute("data-rdsh-activity-state"), "idle");
	assert.equal(jobIdle.getAttribute("data-rdsh-activity-state"), "idle");
});

test("#40 only count chips are decorated; the child breadcrumb switcher keeps stock paint", () => {
	const switcher = chip("Switch subagent: builder", { expanded: true });
	const count = chip("1 subagent");
	const booted = boot({
		configureDocument(doc) {
			doc.headerButtons = [switcher, count];
		},
	});
	showSession(booted, "root");
	decorateChips(booted, [switcher, count]);
	assert.equal(switcher.hasAttribute("data-rdsh-activity-chip"), false, "a switcher is not a count chip");
	assert.equal(switcher.querySelector("[data-rdsh-activity-icon]"), null);
	assert.equal(count.getAttribute("data-rdsh-activity-chip"), "subagent");
});

test("#40 an old generated ring is replaced; an adopted native spinner is preserved", () => {
	const booted = boot({ services: {} });

	// The previous build cloned an upstream spinner into a generated node.
	const cloneChip = chip("1 background job");
	const cloned = node("svg");
	cloned.setAttribute("data-rdsh-activity-spinner", "");
	cloned.setAttribute("data-rdsh-activity-generated", "");
	cloneChip.prepend(cloned);

	// ...and also tagged an upstream spinner in place, without the marker.
	const nativeChip = chip("1 subagent");
	const native = node("svg");
	native.setAttribute("data-rdsh-activity-spinner", "");
	nativeChip.prepend(native);

	decorateChips(booted, [cloneChip, nativeChip]);
	assert.equal(cloned.parentElement, null, "a ring this plugin cloned is removed");
	assert.equal(cloneChip.children.includes(cloned), false);
	const cloneRing = ringOf(cloneChip);
	assert.notEqual(cloneRing, cloned);
	assert.equal(cloneRing.tagName, "SPAN");
	assert.equal(cloneRing.className, "rdsh-activity-ring");

	assert.equal(native.parentElement, nativeChip, "the upstream node keeps its identity");
	assert.equal(nativeChip.children.includes(native), true);
	assert.equal(native.hasAttribute("data-rdsh-activity-spinner"), false, "only our marker is removed");
	const nativeRing = ringOf(nativeChip);
	assert.notEqual(nativeRing, native, "the ring is a separate node");
	assert.equal(nativeRing.tagName, "SPAN");
	assert.equal(nativeRing.className, "rdsh-activity-ring");
});

test("#40 an adopted native spinner survives reboot/HMR and width changes", () => {
	const native = node("svg");
	native.setAttribute("data-rdsh-activity-spinner", "");
	native.setAttribute("class", "abc_spinner");
	const shell = chip("2 background jobs running", { children: [native] });
	const harness = createServices();
	harness.jobsIn("s1", [{ id: "job-1", status: "running" }]);

	// The DOM starts as the previous build left it: a native spinner tagged in
	// place. Booting here is the reboot/HMR case.
	const booted = boot({
		services: harness.services,
		configureDocument(doc) {
			doc.headerButtons = [shell];
			doc.body.append(shell);
		},
	});
	showSession(booted, "s1");
	decorateChips(booted, [shell]);
	assert.equal(shell.getAttribute("data-rdsh-activity-state"), "running");
	assert.equal(native.parentElement, shell);
	assert.equal(native.hasAttribute("data-rdsh-activity-spinner"), false);
	const firstRing = ringOf(shell);
	assert.ok(firstRing !== null && firstRing !== native, "767px: a new ring is drawn beside the native node");

	// Width is geometry only. A mobile surface stays mobile at 1024px, so the
	// ring and chip must survive instead of being torn down and rebuilt.
	booted.setNarrow(false);
	booted.runFrames();
	const ringAtWide = ringOf(shell);
	assert.ok(ringAtWide !== null && ringAtWide === firstRing, "a width change replaced or removed our ring");
	assert.equal(native.parentElement, shell, "the native node survives the width change");
	assert.equal(native.hasAttribute("data-rdsh-activity-spinner"), false);
	assert.equal(shell.hasAttribute("data-rdsh-activity-chip"), true);

	// A later geometry pass still reuses the same owned ring.
	booted.setNarrow(true);
	decorateChips(booted, [shell]);
	assert.equal(native.parentElement, shell);
	assert.equal(native.hasAttribute("data-rdsh-activity-spinner"), false);
	assert.equal(ringOf(shell), firstRing, "the ring identity changed across width changes");
	assert.equal(shell.children.includes(native), true);
});

test("#40 only a running chip animates, and the safety poll is under a second", () => {
	// The ring is static when idle; the spin lives behind the running hook.
	assert.match(CLIENT, /const ACTIVITY_POLL_MS = 500;/, "completion is noticed well inside one second");
	assert.match(CLIENT, /\.rdsh-activity-ring \{[^}]*animation: none;/);
	assert.match(CLIENT, /\[data-rdsh-activity-chip\]\[data-rdsh-activity-running\] \.rdsh-activity-ring \{[^}]*animation: rdsh-activity-spin/);
	assert.match(CLIENT, /\[data-rdsh-activity-chip\]\[data-rdsh-activity-running\] \.rdsh-activity-ring \{[^}]*border-top-color/);
	// #92 appends the drawer rows to the shell's More menu by cloning their own
	// svg glyphs, so scope this guard to the ring code rather than the whole file.
	const ringSource = CLIENT.slice(
		CLIENT.indexOf("function ensureActivityRing"),
		CLIENT.indexOf("function decorateHeaderActivityChips"),
	);
	assert.equal(ringSource.length > 0, true, "the ring source could not be located");
	assert.equal(/cloneNode/.test(ringSource), false, "the ring is never cloned from an upstream spinner");
});

// ---------------------------------------------------------------------------
// #57 — the rings wear DSH's link colour, not the plugin's own green
// ---------------------------------------------------------------------------

test("#57 running and settled rings use the link token and the old green is gone", () => {
	// The static ring a completed chip keeps and the arc a running one turns
	// are both water blue, matching DSH's own links in either palette. The
	// fallback is the dark value; the token still resolves per theme.
	assert.match(
		CLIENT,
		/\.rdsh-activity-ring \{\s*display: block; border: 1\.6px solid var\(--dsw-alias-link, #[0-9a-f]{6}\);/,
		"the settled ring paints the link token with a fallback",
	);
	assert.match(
		CLIENT,
		/\[data-rdsh-activity-chip\]\[data-rdsh-activity-running\] \.rdsh-activity-ring \{[^}]*border-top-color: var\(--dsw-alias-link, #[0-9a-f]{6}\);/,
		"the running arc paints the link token with a fallback",
	);
	assert.equal(
		/#22c55e|--dsw-alias-state-success-primary/.test(CLIENT),
		false,
		"the fixed green ring colour is gone",
	);
});

test("#57 only the ring changes colour; the idle chip stays secondary", () => {
	// The icon and label keep the neutral idle colour; the ring alone carries
	// the activity state, so no new state hook is needed (#40's attributes).
	assert.match(
		CLIENT,
		/\[data-rdsh-activity-chip\] \{[^}]*color: var\(--dsw-alias-label-secondary, #[0-9a-f]{6}\);/,
		"an idle chip keeps the secondary label colour",
	);
	assert.match(
		CLIENT,
		/setAttribute\("data-rdsh-activity-state", running \? "running" : "idle"\)/,
		"#57 reuses the two #40 states instead of adding a third",
	);
	// The rules live in the phone stylesheet, so a desktop window never sees
	// them (#44).
	const phoneStart = CLIENT.indexOf("const CSS_PHONE = `");
	const desktopStart = CLIENT.indexOf("const CSS = CSS_DEVICE;");
	const ring = CLIENT.indexOf("\n  .rdsh-activity-ring {");
	assert.ok(phoneStart !== -1 && desktopStart > phoneStart && ring > phoneStart && ring < desktopStart, "the ring CSS stays inside CSS_PHONE");
});

// ---------------------------------------------------------------------------
// #41 — same chip closes, another chip switches, inner controls unaffected
// ---------------------------------------------------------------------------

/** Call the real document capture listener with a synthetic click. */
function documentClick(booted, target) {
	const entries = booted.document.listeners.get("click") ?? [];
	const capture = entries.find((entry) => entry.capture);
	assert.ok(capture !== undefined, "the plugin installed its capture click listener");
	const event = {
		type: "click",
		target,
		prevented: false,
		stopped: false,
		preventDefault() {
			this.prevented = true;
		},
		stopImmediatePropagation() {
			this.stopped = true;
		},
		stopPropagation() {
			this.stopped = true;
		},
	};
	capture.handler(event);
	return event;
}

test("#41 a second tap on the open chip closes it with the menu's Escape path", () => {
	const booted = boot();
	const subagent = chip("2 subagents", { expanded: true });
	const events = [];
	subagent.dispatchEvent = (event) => {
		events.push(event);
		return true;
	};
	subagent.setAttribute("data-rdsh-activity-chip", "subagent");
	decorateChips(booted, [subagent]);

	const event = documentClick(booted, ringOf(subagent));
	assert.equal(event.prevented, true, "the click does not reach the upstream opener");
	assert.equal(event.stopped, true);
	assert.equal(events.length, 1);
	const escape = events[0];
	assert.equal(escape.type, "keydown");
	assert.equal(escape.key, "Escape");
	assert.equal(escape.bubbles, true, "the dropdown root owns the dismissal handler");
	assert.equal(escape.cancelable, true);
});

test("#41 a closed chip and a different open chip keep upstream behaviour", () => {
	const booted = boot();
	const closed = chip("2 subagents", { expanded: false });
	closed.setAttribute("data-rdsh-activity-chip", "subagent");
	const switched = documentClick(booted, closed);
	assert.equal(switched.prevented, false, "opening is still upstream's job");
	assert.equal(switched.stopped, false);

	// A different chip is never intercepted: its own aria-expanded is false,
	// and the old panel's pointerdown-outside close handles the switch.
	const other = chip("1 background job", { expanded: false });
	other.setAttribute("data-rdsh-activity-chip", "shell");
	const click = documentClick(booted, other);
	assert.equal(click.prevented, false);
	assert.equal(click.stopped, false);
});

test("#41 panel controls are not chips and keep their own click", () => {
	const booted = boot();
	const panelButton = node("button");
	panelButton.setAttribute("aria-label", "Stop job");
	panelButton.setAttribute("data-rdsh-activity-chip", ""); // not what upstream emits
	panelButton.removeAttribute("data-rdsh-activity-chip");
	const event = documentClick(booted, panelButton);
	assert.equal(event.prevented, false, "an inner control is not intercepted");
	assert.equal(event.stopped, false);
});

test("#41 the desktop window is untouched", () => {
	// Desktop builds no plugin: it installs no click listener, so the app's own
	// chip handler is never intercepted or cancelled.
	const booted = boot({ narrow: false });
	assert.equal(booted.api, undefined, "a desktop booted the activity half");
	const entries = booted.document.listeners.get("click") ?? [];
	assert.deepEqual(entries, [], "a desktop installed a capture click listener");
	const open = chip("2 subagents", { expanded: true });
	open.setAttribute("data-rdsh-activity-chip", "subagent");
	assert.equal(open.hasAttribute("data-rdsh-activity-chip"), true, "a desktop stripped the app's chip attribute");
});

// ---------------------------------------------------------------------------
// #82 — the open activity popover names its kind and sorts on one tap
// ---------------------------------------------------------------------------

/** A localStorage that remembers, and records which keys were touched. */
function memoryStorage(initial = {}) {
	const map = new Map(Object.entries(initial));
	const reads = [];
	const writes = [];
	return {
		reads,
		writes,
		getItem(key) {
			reads.push(key);
			return map.has(key) ? map.get(key) : null;
		},
		setItem(key, value) {
			writes.push(key);
			map.set(key, String(value));
		},
		removeItem(key) {
			writes.push(key);
			map.delete(key);
		},
		clear: () => map.clear(),
		key: (index) => [...map.keys()][index] ?? null,
		get length() {
			return map.size;
		},
	};
}

/** One row of the subagent catalog, shaped like upstream renders it. */
function subagentRow(label, state) {
	const wrapper = node("div");
	wrapper.className = "ZKlsPq_node";
	const row = node("div");
	row.setAttribute("role", "treeitem");
	row.setAttribute("aria-level", "1");
	// The real list draws a dot for a finished row and a spinner for a live one;
	// both carry the state on the glyph, which is what the sort reads.
	const glyph = node(state === "ongoing" ? "svg" : "span");
	glyph.setAttribute("data-state", state);
	const title = node("span");
	title.textContent = label;
	row.append(glyph, title);
	wrapper.append(row);
	return { wrapper, row, glyph, title };
}

/** The popover upstream portals to <body> when the subagent chip opens. */
function subagentPopover(booted, rows = [["質問カード", "done"], ["右パネル", "ongoing"], ["見出し", "ongoing"]]) {
	const doc = booted.document;
	const menu = node("div");
	menu.className = "ZKlsPq_menu";
	const tree = node("div");
	tree.setAttribute("role", "tree");
	const wrappers = rows.map(([label, state]) => {
		const entry = subagentRow(label, state);
		tree.append(entry.wrapper);
		return entry;
	});
	menu.append(tree);
	doc.body.append(menu);
	return { menu, tree, wrappers };
}

/**
 * The job popover: a menu surface with the two section headers upstream draws
 * (one hidden from assistive tech, the settled one not) and button rows that
 * carry their own state.
 */
function shellPopover(booted) {
	const doc = booted.document;
	const surface = node("div");
	surface.setAttribute("data-menu-material", "");
	const material = node("div");
	material.setAttribute("aria-hidden", "true");
	const list = node("ul");
	list.setAttribute("aria-label", "background jobs");
	const runningHeader = node("li");
	runningHeader.setAttribute("aria-hidden", "true");
	runningHeader.textContent = "running";
	// The settled header is a toggle of its own, and carries no state.
	const settledHeader = node("li");
	settledHeader.className = "QsffPG_sectionHeader";
	const settledToggle = node("button");
	settledToggle.setAttribute("aria-expanded", "true");
	settledToggle.textContent = "settled 10";
	settledHeader.append(settledToggle);
	const jobRow = (state) => {
		const item = node("li");
		const button = node("button");
		button.setAttribute("aria-expanded", "false");
		const glyph = node("svg");
		glyph.setAttribute("data-state", state);
		button.append(glyph);
		item.append(button);
		return item;
	};
	list.append(runningHeader, jobRow("ongoing"), settledHeader, jobRow("done"));
	surface.append(material, list);
	doc.body.append(surface);
	return { surface, material, list, runningHeader, settledHeader };
}

/**
 * The app frame: the header chip, plus an unrelated tree inside the app (the
 * search results the review caught this code reordering).
 */
function appFrame(booted, { label = countLabel("en", "subagent", "count.running.other"), expanded = true } = {}) {
	const doc = booted.document;
	const frame = node("div");
	frame.setAttribute("id", "root");
	const header = node("header");
	header.setAttribute("data-window-drag", "");
	const button = chip(label, { expanded });
	header.append(button);
	const search = node("div");
	search.setAttribute("role", "tree");
	const result = node("div");
	result.setAttribute("role", "treeitem");
	const glyph = node("span");
	glyph.setAttribute("data-state", "done");
	result.append(glyph);
	search.append(result);
	frame.append(header, search);
	doc.body.append(frame);
	doc.headerButtons = [button];
	return { frame, header, button, search };
}

/** Run the plugin's own decoration pass with the given chips as header chips. */
function decorateFrame(booted, chips) {
	booted.document.headerButtons = chips;
	booted.api?.decorate?.();
	booted.runFrames();
}

function headingOf(booted) {
	return booted.document.querySelector("[data-rdsh-activity-heading]");
}

/** The heading's own text span (the row also holds the sort toggle). */
function headingTitleOf(booted) {
	return booted.document.querySelector("[data-rdsh-activity-title]");
}

function sortToggleOf(booted) {
	return booted.document.querySelector("[data-rdsh-activity-sort]");
}

/** The row order the list actually has, which is also the focus order. */
function rowLabels(tree) {
	return [...tree.children].map((wrapper) => wrapper.querySelector('[role="treeitem"]').children[1].textContent);
}

test("#82 the open subagent list gets its kind's name above it", () => {
	const booted = boot();
	const frame = appFrame(booted);
	const popover = subagentPopover(booted);
	decorateFrame(booted, [frame.button]);

	const heading = headingOf(booted);
	assert.notEqual(heading, null, "the open list got no heading");
	assert.equal(headingTitleOf(booted).textContent, "Subagent");
	assert.equal(heading.getAttribute("role"), "heading", "the heading has no semantic role");
	assert.equal(heading.getAttribute("aria-level"), "2");
	assert.equal(heading.parentElement, popover.menu, "the heading is not in the popover");
	assert.equal(popover.menu.children[0], heading, "the heading does not lead the list");
	assert.equal(popover.tree.contains(heading), false, "the heading sits inside the tree the rows fill");

	// A second pass reuses the node instead of adding one.
	decorateFrame(booted, [frame.button]);
	assert.equal(booted.document.querySelectorAll("[data-rdsh-activity-heading]").length, 1, "a second pass duplicated the heading");
	assert.equal(headingOf(booted), heading, "a second pass rebuilt the heading");
});

test("#82 the heading follows the display language", () => {
	const booted = boot({
		configureDocument(doc) {
			doc.documentElement.lang = "ja";
		},
	});
	const frame = appFrame(booted, { label: countLabel("ja", "subagent", "count.running.other") });
	const subagent = subagentPopover(booted);
	decorateFrame(booted, [frame.button]);
	assert.equal(headingTitleOf(booted).textContent, "サブエージェント", "an en heading appeared in a ja shell");
	assert.equal(sortToggleOf(booted).textContent, "実行中を上に");
	assert.equal(sortToggleOf(booted).getAttribute("aria-label"), "実行中を上に並べ替え");

	// A shell list is named by its own kind, and it has nothing to sort. Opening
	// its chip closes the subagent list, as upstream does.
	frame.button.setAttribute("aria-expanded", "false");
	subagent.menu.remove();
	const shell = shellPopover(booted);
	const jobsChip = chip(countLabel("ja", "job", "count.live.other"), { expanded: true });
	frame.header.append(jobsChip);
	decorateFrame(booted, [jobsChip]);
	assert.equal(headingTitleOf(booted).textContent, "ターミナル");
	assert.equal(headingOf(booted).parentElement, shell.surface, "the shell heading left its own surface");
	assert.equal(sortToggleOf(booted), null, "the shell list got a sort toggle");
});

test("#82 one tap puts the running rows first and a second restores upstream order", () => {
	const booted = boot({ storage: {} });
	const frame = appFrame(booted);
	const popover = subagentPopover(booted, [["done-1", "done"], ["run-1", "ongoing"], ["done-2", "done"], ["run-2", "ongoing"]]);
	decorateFrame(booted, [frame.button]);

	const toggle = sortToggleOf(booted);
	assert.notEqual(toggle, null, "the heading row has no sort toggle");
	assert.equal(toggle.getAttribute("aria-pressed"), "false", "the default is not upstream's order");
	assert.equal(toggle.textContent, "Running first");
	assert.equal(popover.tree.hasAttribute("data-rdsh-activity-sorted"), false);
	assert.deepEqual(rowLabels(popover.tree), ["done-1", "run-1", "done-2", "run-2"]);

	toggle.click();
	booted.runFrames();
	assert.equal(booted.sandbox.localStorage.getItem("dsh-mobile-maxxing:activity-sort"), "1", "the choice was not stored on this device");
	assert.equal(popover.tree.hasAttribute("data-rdsh-activity-sorted"), true);
	assert.equal(toggle.getAttribute("aria-pressed"), "true");
	// The rows themselves moved, as a stable partition: running first, each
	// group in upstream's order. The focus and reader order is therefore the
	// order the phone draws, unlike a CSS-only reorder.
	assert.deepEqual(rowLabels(popover.tree), ["run-1", "run-2", "done-1", "done-2"]);

	toggle.click();
	booted.runFrames();
	assert.equal(booted.sandbox.localStorage.getItem("dsh-mobile-maxxing:activity-sort"), null, "turning the sort off left the stored choice");
	assert.equal(popover.tree.hasAttribute("data-rdsh-activity-sorted"), false);
	assert.equal(toggle.getAttribute("aria-pressed"), "false");
	assert.deepEqual(rowLabels(popover.tree), ["done-1", "run-1", "done-2", "run-2"], "the upstream order was not restored");
});

test("#82 a row that finishes while sorted falls back into the finished group", () => {
	const booted = boot({ storage: { "dsh-mobile-maxxing:activity-sort": "1" } });
	const frame = appFrame(booted);
	const popover = subagentPopover(booted, [["done-1", "done"], ["run-1", "ongoing"], ["run-2", "ongoing"]]);
	decorateFrame(booted, [frame.button]);
	assert.deepEqual(rowLabels(popover.tree), ["run-1", "run-2", "done-1"]);

	// The projection updates the row's glyph; the next pass re-partitions
	// upstream's own order, so the finished row sits with the finished rows in
	// the order upstream has them (done-1 before run-1), not in the slot the
	// sorted view happened to give it.
	popover.wrappers[1].glyph.setAttribute("data-state", "done");
	decorateFrame(booted, [frame.button]);
	assert.deepEqual(rowLabels(popover.tree), ["run-2", "done-1", "run-1"]);
});

test("#82 a row added while sorted keeps its upstream place when the sort goes", () => {
	const booted = boot({ storage: { "dsh-mobile-maxxing:activity-sort": "1" } });
	const frame = appFrame(booted);
	const popover = subagentPopover(booted, [["done-1", "done"], ["run-1", "ongoing"]]);
	decorateFrame(booted, [frame.button]);
	assert.deepEqual(rowLabels(popover.tree), ["run-1", "done-1"]);

	// Upstream appends a new running session while the view is sorted.
	const added = subagentRow("run-2", "ongoing");
	popover.tree.append(added.wrapper);
	decorateFrame(booted, [frame.button]);
	assert.deepEqual(rowLabels(popover.tree), ["run-1", "run-2", "done-1"]);

	// A row upstream removes drops out of the saved order too.
	popover.wrappers[1].wrapper.remove();
	decorateFrame(booted, [frame.button]);
	assert.deepEqual(rowLabels(popover.tree), ["run-2", "done-1"]);

	// Turning the sort off now gives the order upstream has: the added row
	// where upstream put it, the removed one gone.
	sortToggleOf(booted).click();
	booted.runFrames();
	assert.deepEqual(rowLabels(popover.tree), ["done-1", "run-2"]);
});

test("#82 a row added while sorted goes last on restore, not before its neighbour", () => {
	// The reported case: upstream [done-1, run-1] sorts to [run-1, done-1]; a
	// running row appended meanwhile must come back last, not between them.
	const booted = boot({ storage: { "dsh-mobile-maxxing:activity-sort": "1" } });
	const frame = appFrame(booted);
	const popover = subagentPopover(booted, [["done-1", "done"], ["run-1", "ongoing"]]);
	decorateFrame(booted, [frame.button]);
	assert.deepEqual(rowLabels(popover.tree), ["run-1", "done-1"]);

	const added = subagentRow("run-2", "ongoing");
	popover.tree.append(added.wrapper);
	decorateFrame(booted, [frame.button]);
	assert.deepEqual(rowLabels(popover.tree), ["run-1", "run-2", "done-1"]);

	sortToggleOf(booted).click();
	booted.runFrames();
	assert.deepEqual(rowLabels(popover.tree), ["done-1", "run-1", "run-2"], "the added row was restored before its neighbour");
});

test("#82 turning the sort off restores the upstream order after adds and removals", () => {
	const booted = boot({ storage: { "dsh-mobile-maxxing:activity-sort": "1" } });
	const frame = appFrame(booted);
	const popover = subagentPopover(booted, [["done-1", "done"], ["run-1", "ongoing"], ["done-2", "done"]]);
	decorateFrame(booted, [frame.button]);
	assert.deepEqual(rowLabels(popover.tree), ["run-1", "done-1", "done-2"]);

	// Upstream appends a finished row, then removes the first one.
	const added = subagentRow("done-3", "done");
	popover.tree.append(added.wrapper);
	decorateFrame(booted, [frame.button]);
	popover.wrappers[0].wrapper.remove();
	decorateFrame(booted, [frame.button]);
	assert.deepEqual(rowLabels(popover.tree), ["run-1", "done-2", "done-3"]);

	sortToggleOf(booted).click();
	booted.runFrames();
	assert.deepEqual(rowLabels(popover.tree), ["run-1", "done-2", "done-3"], "the saved order was not restored");
});

test("#82 a row that keeps the focus keeps it when the sort moves it", () => {
	const booted = boot({ storage: {} });
	const frame = appFrame(booted);
	const popover = subagentPopover(booted, [["done-1", "done"], ["run-1", "ongoing"]]);
	decorateFrame(booted, [frame.button]);

	const doc = booted.document;
	// The row the sort will move: the running one.
	const focused = popover.wrappers[1].row;
	let focusCalls = 0;
	focused.focus = () => {
		focusCalls += 1;
		doc.activeElement = focused;
	};
	focused.focus();
	assert.equal(doc.activeElement, focused);

	// Model the browser that drops the focus when a focused node is moved.
	const insertBefore = popover.tree.insertBefore;
	popover.tree.insertBefore = (child, before) => {
		// Moving the wrapper takes its subtree with it, so a focused row inside
		// loses the focus to <body> in a real browser.
		if (doc.activeElement !== null && child.contains(doc.activeElement)) doc.activeElement = doc.body;
		return insertBefore.call(popover.tree, child, before);
	};
	// The stored choice turns the sort on for the next pass, without the click
	// path (which touches the focus of its own).
	booted.sandbox.localStorage.setItem("dsh-mobile-maxxing:activity-sort", "1");
	booted.api.decorateNow();
	popover.tree.insertBefore = insertBefore;

	assert.deepEqual(rowLabels(popover.tree), ["run-1", "done-1"]);
	assert.equal(doc.activeElement, focused, "moving the focused row dropped the focus to <body>");
	assert.ok(focusCalls >= 2, "the guard did not put the focus back");
});

test("#82 a stored choice comes back on the next open and orders the rows again", () => {
	const booted = boot({ storage: { "dsh-mobile-maxxing:activity-sort": "1" } });
	const frame = appFrame(booted);
	const popover = subagentPopover(booted);
	decorateFrame(booted, [frame.button]);
	assert.equal(sortToggleOf(booted).getAttribute("aria-pressed"), "true", "the saved choice was not read back");
	assert.equal(popover.tree.hasAttribute("data-rdsh-activity-sorted"), true);
	assert.deepEqual(rowLabels(popover.tree), ["右パネル", "見出し", "質問カード"]);
});

test("#82 closing the popover leaves no heading or marker, but keeps the choice", () => {
	const booted = boot({ storage: { "dsh-mobile-maxxing:activity-sort": "1" } });
	const frame = appFrame(booted);
	const popover = subagentPopover(booted);
	decorateFrame(booted, [frame.button]);
	assert.notEqual(headingOf(booted), null);

	popover.menu.remove();
	frame.button.setAttribute("aria-expanded", "false");
	decorateFrame(booted, [frame.button]);
	assert.equal(headingOf(booted), null, "a closed popover kept its heading");
	assert.equal(booted.document.querySelectorAll("[data-rdsh-activity-sorted]").length, 0, "a closed popover kept the sort marker");
	assert.equal(booted.sandbox.localStorage.getItem("dsh-mobile-maxxing:activity-sort"), "1", "closing the panel forgot this device's choice");
});

test("#82 a teardown takes the heading and the sorted order with it", () => {
	const booted = boot({ storage: { "dsh-mobile-maxxing:activity-sort": "1" } });
	const frame = appFrame(booted);
	const popover = subagentPopover(booted, [["done-1", "done"], ["run-1", "ongoing"]]);
	decorateFrame(booted, [frame.button]);
	assert.deepEqual(rowLabels(popover.tree), ["run-1", "done-1"]);

	booted.dispose();
	assert.equal(headingOf(booted), null, "a teardown left the heading over a closed list");
	assert.equal(booted.document.querySelectorAll("[data-rdsh-activity-sorted]").length, 0, "a teardown left the sort marker");
	assert.deepEqual(rowLabels(popover.tree), ["done-1", "run-1"], "a teardown left the rows in the sorted order");
});

test("#82 another tree inside the app, or another menu, is never touched", () => {
	const booted = boot();
	const frame = appFrame(booted);
	// The search tree lives inside the app frame, not in the chip's portal.
	const before = [...frame.search.children];
	// A settings menu is a body-level menu surface, but its items are not jobs.
	const settingsMenu = node("div");
	settingsMenu.setAttribute("data-menu-material", "");
	const settingsList = node("ul");
	const settingsItem = node("li");
	const settingsButton = node("button");
	settingsButton.textContent = "setting";
	settingsItem.append(settingsButton);
	settingsList.append(settingsItem);
	settingsMenu.append(settingsList);
	booted.document.body.append(settingsMenu);

	decorateFrame(booted, [frame.button]);
	assert.equal(headingOf(booted), null, "an app tree got a heading");
	assert.equal(sortToggleOf(booted), null, "an app tree got a sort toggle");
	assert.deepEqual([...frame.search.children], before, "the app's search tree was reordered");
	assert.equal(frame.search.hasAttribute("data-rdsh-activity-sorted"), false);

	// A body-level menu surface is not the subagent chip's panel either: the
	// kind the chip names decides, so the job list is only adopted by the job
	// chip (there is one open panel, and the chip says which one).
	decorateFrame(booted, [frame.button]);
	assert.equal(settingsMenu.querySelector("[data-rdsh-activity-heading]"), null, "a settings menu got a heading");
	assert.equal(settingsMenu.hasAttribute("data-rdsh-activity-sorted"), false);
});

test("#82 the terminal list is found under its section headers", () => {
	const booted = boot();
	const frame = appFrame(booted, { label: countLabel("en", "job", "count.live.other") });
	const shell = shellPopover(booted);
	decorateFrame(booted, [frame.button]);
	assert.notEqual(headingOf(booted), null, "the job list was not found under its section headers");
	assert.equal(headingTitleOf(booted).textContent, "Terminal");
	assert.equal(headingOf(booted).parentElement, shell.surface);
	assert.equal(sortToggleOf(booted), null, "the job list got a sort toggle");
	assert.deepEqual([...shell.list.children].slice(0, 2), [shell.runningHeader, shell.list.children[1]], "the job list was reordered");
});

test("#82 the terminal list is named when every job has settled and the section is collapsed", () => {
	const booted = boot();
	const frame = appFrame(booted, { label: countLabel("en", "job", "count.live.other") });
	const surface = node("div");
	surface.setAttribute("data-menu-material", "");
	const list = node("ul");
	// Only the settled header is rendered: the running group is empty and the
	// settled group is collapsed, so not one row carries a state glyph.
	const settledHeader = node("li");
	const settledToggle = node("button");
	settledToggle.setAttribute("aria-expanded", "false");
	settledToggle.textContent = "settled 10";
	settledHeader.append(settledToggle);
	list.append(settledHeader);
	surface.append(list);
	booted.document.body.append(surface);

	decorateFrame(booted, [frame.button]);
	assert.notEqual(headingOf(booted), null, "a collapsed, all-settled job list got no heading");
	assert.equal(headingTitleOf(booted).textContent, "Terminal");
	assert.equal(headingOf(booted).parentElement, surface);
});

test("#82 a browser that refuses storage still toggles for this page", () => {
	const booted = boot({ storage: null });
	// Private mode, a full quota, or a policy that denies localStorage: the read
	// and the write both throw, and the button still has to work.
	booted.sandbox.localStorage = {
		getItem() {
			throw new Error("denied");
		},
		setItem() {
			throw new Error("denied");
		},
		removeItem() {
			throw new Error("denied");
		},
	};
	const frame = appFrame(booted);
	const popover = subagentPopover(booted);
	decorateFrame(booted, [frame.button]);
	const toggle = sortToggleOf(booted);
	assert.equal(toggle.getAttribute("aria-pressed"), "false");

	toggle.click();
	booted.runFrames();
	assert.equal(toggle.getAttribute("aria-pressed"), "true", "a refused write left the toggle dead");
	assert.deepEqual(rowLabels(popover.tree), ["右パネル", "見出し", "質問カード"]);

	// A later pass reads the page's own choice, not the store it cannot reach.
	decorateFrame(booted, [frame.button]);
	assert.equal(sortToggleOf(booted).getAttribute("aria-pressed"), "true", "the page choice was forgotten between passes");
});

test("#82 a desktop builds no heading or toggle and never reads the choice", () => {
	const booted = boot({ mode: "desktop", narrow: true, storage: { "dsh-mobile-maxxing:activity-sort": "1" } });
	// The fixtures exist so the only reason for silence is the desktop gate.
	appFrame(booted);
	subagentPopover(booted);
	assert.equal(booted.api, undefined, "a desktop booted the activity half");
	assert.equal(headingOf(booted), null, "a desktop got a heading");
	assert.equal(sortToggleOf(booted), null, "a desktop got a sort toggle");
	assert.equal(booted.document.querySelectorAll("[data-rdsh-activity-sorted]").length, 0);
	assert.equal(booted.sandbox.localStorage.reads.includes("dsh-mobile-maxxing:activity-sort"), false, "a desktop read the device-local choice");
});

test("#82 the sort moves the rows themselves and lives in the phone sheet", () => {
	const tick = String.fromCharCode(96);
	const phoneStart = CLIENT.indexOf("const CSS_PHONE = " + tick);
	const phone = CLIENT.slice(phoneStart, CLIENT.indexOf(tick + ";", phoneStart));
	const deviceStart = CLIENT.indexOf("const CSS_DEVICE = " + tick);
	const device = CLIENT.slice(deviceStart, CLIENT.indexOf(tick + ";", deviceStart));
	assert.match(phone, /\.rdsh-activity-heading \{/, "the heading row has no phone style");
	assert.doesNotMatch(phone, /\[data-rdsh-activity-sorted\][^{]*\{[^}]*order:/, "the sort is a CSS order, so focus and reader order would not follow it");
	assert.doesNotMatch(device, /data-rdsh-activity-heading|rdsh-activity-sort/, "a desktop sheet carries the phone rules");

	// The rows are reordered in the document, and the running state comes from
	// the glyph, never from a localised label.
	const apply = CLIENT.slice(CLIENT.indexOf("function activityRowRunning("), CLIENT.indexOf("function clearActivitySort("));
	assert.match(apply, /tree\.insertBefore\(/, "the rows are not moved in the document");
	assert.match(apply, /\[data-state="ongoing"\]/, "the running rows are not detected by their state attribute");
	assert.doesNotMatch(apply, /aria-label/, "a row is classified by a localised label");
	const lookup = CLIENT.slice(CLIENT.indexOf("function subagentListOf("), CLIENT.indexOf("function activityPopover("));
	assert.match(lookup, /\[data-state\]/, "the list is not recognised by its state glyphs");
	assert.doesNotMatch(lookup, /aria-label/, "the popover is found by a localised label");
	// The portal never holds the chips, so the app frame is never the popover.
	assert.match(CLIENT, /if \(child\.querySelector\("\[data-rdsh-activity-chip\]"\) !== null\) continue;/, "the app frame can be taken for the popover");
});
