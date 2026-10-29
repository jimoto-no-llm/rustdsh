/**
 * Issue #71: a phone loads older messages when a real reader scroll reaches
 * the top. Upstream already renders the control, disables it while a page is
 * in flight and keeps the paging anchor; this plugin only presses it.
 *
 * The loader is one self-contained factory in the browser half, so these
 * tests extract that exact function and drive it with a small DOM, browser
 * timers and a MutationObserver. No browser, no DSH process, no network.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const CLIENT = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const FACTORY = CLIENT.match(/    function createOlderMessageLoader\(\{ doc, win, isPhone \}\) \{[\s\S]*?\n    \}\n/)?.[0];

assert.ok(FACTORY, "createOlderMessageLoader exists");
const createOlderMessageLoader = vm.runInNewContext("(" + FACTORY.trim() + ")", {});

// ---------------------------------------------------------------------------
// Small DOM: only the direct-children structure the loader reads.
// ---------------------------------------------------------------------------

class FakeNode {
	constructor(document, tagName) {
		this.ownerDocument = document;
		this.nodeType = 1;
		this.tagName = tagName.toUpperCase();
		this.parentElement = null;
		this.children = [];
		this.attributes = new Map();
		this.disabled = false;
		this.scrollTop = 0;
		this.clicks = 0;
		this.onClick = null;
	}

	append(...nodes) {
		for (const node of nodes) {
			node.parentElement = this;
			this.children.push(node);
		}
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

	click() {
		this.clicks += 1;
		if (typeof this.onClick === "function") this.onClick();
	}
}

class FakeDocument {
	constructor() {
		this.listeners = [];
		this.nodeType = 9;
		this.body = new FakeNode(this, "body");
	}

	addEventListener(type, handler, options) {
		this.listeners.push({ type, handler, capture: options === true || options?.capture === true });
	}

	removeEventListener(type, handler, options) {
		const capture = options === true || options?.capture === true;
		this.listeners = this.listeners.filter((listener) => !(listener.type === type && listener.handler === handler && listener.capture === capture));
	}

	count(type) {
		return this.listeners.filter((listener) => listener.type === type).length;
	}

	dispatch(type, target) {
		const event = { type, target, currentTarget: null };
		for (const listener of [...this.listeners]) {
			if (listener.type !== type || !listener.capture) continue;
			listener.handler.call(this, event);
		}
	}
}

function makeWindow() {
	const timers = new Map();
	const observers = new Set();
	let nextTimer = 0;

	class FakeMutationObserver {
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
	}

	const win = {
		MutationObserver: FakeMutationObserver,
		setTimeout(callback, ms) {
			nextTimer += 1;
			timers.set(nextTimer, { callback, ms });
			return nextTimer;
		},
		clearTimeout(id) {
			timers.delete(id);
		},
	};

	return {
		win,
		timers,
		observers,
		runTimers() {
			let guard = 20;
			while (timers.size > 0 && guard > 0) {
				guard -= 1;
				const [id, timer] = timers.entries().next().value;
				timers.delete(id);
				timer.callback();
			}
			assert.ok(guard > 0, "the loader rescheduled timers forever");
		},
		flushObservers() {
			for (const observer of [...observers]) if (observer.active) observer.callback([]);
		},
	};
}

function makeConversation(document, { disabled = false } = {}) {
	const scroller = new FakeNode(document, "div");
	const column = new FakeNode(document, "div");
	column.setAttribute("data-chat-flow", "");
	const older = new FakeNode(document, "div");
	const button = new FakeNode(document, "button");
	button.disabled = disabled;
	button.onClick = () => {
		button.disabled = true;
	};
	const row = new FakeNode(document, "div");
	row.setAttribute("data-chat-flow-kind", "assistant");
	older.append(button);
	column.append(older, row);
	scroller.append(column);
	document.body.append(scroller);
	return { document, scroller, column, older, button, row };
}

/**
 * Upstream's current layout: the transcript scrolls in a container several
 * elements above the flow column (the real GUI scrolls
 * [data-conversation-scroll], while the chat's own wrapper is overflow:visible).
 */
function makeNestedConversation(document) {
	const scroller = new FakeNode(document, "div");
	scroller.setAttribute("data-conversation-scroll", "");
	const viewArea = new FakeNode(document, "div");
	const frame = new FakeNode(document, "div");
	const root = new FakeNode(document, "div");
	const scroll = new FakeNode(document, "div");
	const column = new FakeNode(document, "div");
	column.setAttribute("data-chat-flow", "");
	const older = new FakeNode(document, "div");
	const button = new FakeNode(document, "button");
	button.onClick = () => {
		button.disabled = true;
	};
	const row = new FakeNode(document, "div");
	row.setAttribute("data-chat-flow-kind", "user");
	older.append(button);
	column.append(older, row);
	scroll.append(column);
	root.append(scroll);
	frame.append(root);
	viewArea.append(frame);
	scroller.append(viewArea);
	document.body.append(scroller);
	return { scroller, column, older, button, row };
}

/** A real touch/wheel/key gesture inside the transcript, then a scroll event. */
function userScroll(run, conversation, scrollTop = 0) {
	conversation.scroller.scrollTop = scrollTop;
	run.document.dispatch("pointerdown", conversation.row);
	run.document.dispatch("scroll", conversation.scroller);
}

function setup({ phone = true } = {}) {
	const document = new FakeDocument();
	const run = makeWindow();
	const loader = createOlderMessageLoader({ doc: document, win: run.win, isPhone: () => phone });
	return { document, run, loader };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

test("initial mount, programmatic scrolls and DOM mutations never press Load earlier", () => {
	const { document, run, loader } = setup();
	const conversation = makeConversation(document);
	assert.equal(loader.install(), true);

	// A scroll with no reader input is upstream's own anchor/follow pass.
	document.dispatch("scroll", conversation.scroller);
	run.runTimers();
	assert.equal(conversation.button.clicks, 0, "a programmatic scroll loaded history");

	// A gesture outside the transcript does not arm it either.
	document.dispatch("pointerdown", document.body);
	conversation.scroller.scrollTop = 0;
	document.dispatch("scroll", conversation.scroller);
	run.runTimers();
	assert.equal(conversation.button.clicks, 0, "a gesture outside the transcript loaded history");

	// Mutations alone (a streamed reply, a re-render) are never a user scroll.
	conversation.column.append(new FakeNode(document, "div"));
	run.flushObservers();
	run.runTimers();
	assert.equal(conversation.button.clicks, 0, "a DOM mutation loaded history");
});

test("one settled user scroll at the top presses the existing control exactly once", () => {
	const { document, run, loader } = setup();
	const conversation = makeConversation(document);
	loader.install();

	conversation.scroller.scrollTop = 0;
	document.dispatch("pointerdown", conversation.row);
	document.dispatch("scroll", conversation.scroller);
	assert.equal(conversation.button.clicks, 0, "the control fired before the scroll settled");
	run.runTimers();
	assert.equal(conversation.button.clicks, 1, "the enabled older control was not pressed");
	assert.deepEqual({ ...loader.state() }, { installed: true, armed: false, loading: true });
});

test("a disabled control is ignored, and an in-flight control is not pressed twice", () => {
	const { document, run, loader } = setup();
	const conversation = makeConversation(document, { disabled: true });
	loader.install();

	userScroll({ document }, conversation);
	run.runTimers();
	assert.equal(conversation.button.clicks, 0, "a disabled older control was pressed");

	conversation.button.disabled = false;
	userScroll({ document }, conversation);
	run.runTimers();
	assert.equal(conversation.button.clicks, 1);

	// Still in flight: another real scroll during the same load must not queue a
	// duplicate request even though the button exists.
	userScroll({ document }, conversation);
	run.runTimers();
	assert.equal(conversation.button.clicks, 1, "a second request started while one was in flight");
});

test("re-arms only after upstream's commit enables the control again", () => {
	const { document, run, loader } = setup();
	const conversation = makeConversation(document);
	loader.install();

	userScroll({ document }, conversation);
	run.runTimers();
	assert.equal(conversation.button.clicks, 1);

	// Loading rendering: the button is disabled. Mutations may stream in, but
	// none of them may click.
	conversation.column.append(new FakeNode(document, "div"));
	run.flushObservers();
	run.runTimers();
	assert.equal(conversation.button.clicks, 1, "a loading mutation pressed the control again");
	assert.equal(loader.state().loading, true);

	// Upstream commits the older page and re-enables the same control.
	conversation.button.disabled = false;
	run.flushObservers();
	assert.equal(loader.state().loading, false);
	assert.equal(loader.state().armed, true);
	assert.equal(conversation.button.clicks, 1, "re-arming itself pressed the control");

	// Only a new real reader scroll may load the next page.
	userScroll({ document }, conversation);
	run.runTimers();
	assert.equal(conversation.button.clicks, 2, "the re-armed control did not load the next page");
});

test("never writes the viewport; upstream owns the paging anchor", () => {
	const { document, run, loader } = setup();
	const conversation = makeConversation(document);
	let top = 0;
	let writes = 0;
	let scrollToCalls = 0;
	let scrollByCalls = 0;
	Object.defineProperty(conversation.scroller, "scrollTop", {
		configurable: true,
		get: () => top,
		set: (value) => {
			writes += 1;
			top = value;
		},
	});
	conversation.scroller.scrollTo = () => {
		scrollToCalls += 1;
	};
	conversation.scroller.scrollBy = () => {
		scrollByCalls += 1;
	};
	loader.install();

	userScroll({ document }, conversation);
	writes = 0; // the test's own scroll above is not a loader write
	run.runTimers();
	assert.equal(conversation.button.clicks, 1);
	assert.equal(writes, 0, "the loader wrote scrollTop");
	assert.equal(scrollToCalls, 0, "the loader called scrollTo");
	assert.equal(scrollByCalls, 0, "the loader called scrollBy");

	// Upstream's loadEarlier keeps its own anchor across the commit; the loader
	// leaves that scrollTop untouched and does not compensate a second time.
	top = 200;
	writes = 0;
	conversation.button.disabled = false;
	run.flushObservers();
	run.runTimers();
	assert.equal(top, 200, "the loader moved a viewport upstream had anchored");
	assert.equal(writes, 0, "the loader wrote scrollTop after the commit");
	assert.equal(scrollToCalls, 0);
	assert.equal(scrollByCalls, 0);
});

test("never fights a reader who moves during the fetch", () => {
	const { document, run, loader } = setup();
	const conversation = makeConversation(document);
	let top = 0;
	let writes = 0;
	Object.defineProperty(conversation.scroller, "scrollTop", {
		configurable: true,
		get: () => top,
		set: (value) => {
			writes += 1;
			top = value;
		},
	});
	loader.install();

	userScroll({ document }, conversation);
	run.runTimers();
	assert.equal(conversation.button.clicks, 1);

	// The reader keeps scrolling while the older page is still in flight.
	top = 500;
	writes = 0;
	document.dispatch("pointerdown", conversation.row);
	document.dispatch("scroll", conversation.scroller);

	// The commit may change the layout, but the reader owns the viewport now.
	conversation.button.disabled = false;
	run.flushObservers();
	run.runTimers();

	assert.equal(top, 500, "the loader yanked a reader who had moved");
	assert.equal(writes, 0, "the loader wrote scrollTop while the reader moved");
	assert.equal(conversation.button.clicks, 1);
});

test("the flow column may sit below the scrolling container (real upstream layout)", () => {
	const { document, run, loader } = setup();
	const conversation = makeNestedConversation(document);
	loader.install();

	// No gesture: upstream's own follow/anchor pass never loads history.
	conversation.scroller.scrollTop = 0;
	document.dispatch("scroll", conversation.scroller);
	run.runTimers();
	assert.equal(conversation.button.clicks, 0, "a programmatic scroll loaded history");

	// The reader's gesture is inside the column; the scroll fires on the outer
	// container. That is how the real GUI reaches the top of a transcript.
	document.dispatch("pointerdown", conversation.row);
	document.dispatch("scroll", conversation.scroller);
	run.runTimers();
	assert.equal(conversation.button.clicks, 1, "the nested transcript did not load its older page");
});

test("a scroll from an element that does not hold the gesture's column is ignored", () => {
	const { document, run, loader } = setup();
	const conversation = makeNestedConversation(document);
	const other = new FakeNode(document, "div");
	document.body.append(other);
	loader.install();

	document.dispatch("pointerdown", conversation.row);
	other.scrollTop = 0;
	document.dispatch("scroll", other);
	run.runTimers();
	assert.equal(conversation.button.clicks, 0, "a foreign scroller pressed the control");
});

test("the loader source has no direct viewport writes", () => {
	assert.doesNotMatch(FACTORY, /.scrollTop\s*=/, "the loader writes scrollTop");
	assert.doesNotMatch(FACTORY, /\.scroll(?:To|By)\s*\(/, "the loader calls scrollTo/scrollBy");
});

test("desktop installs nothing and never clicks", () => {
	const { document, run, loader } = setup({ phone: false });
	const conversation = makeConversation(document);

	assert.equal(loader.install(), false);
	assert.equal(document.listeners.length, 0, "a desktop installed a listener");
	userScroll({ document }, conversation);
	run.runTimers();
	assert.equal(conversation.button.clicks, 0);
});

test("dispose clears listeners, the settle timer and the observer", () => {
	const { document, run, loader } = setup();
	const conversation = makeConversation(document);
	loader.install();
	assert.equal(document.count("scroll"), 1);
	assert.equal(document.count("pointerdown"), 1);

	// A queued settle must not fire after teardown.
	document.dispatch("pointerdown", conversation.row);
	document.dispatch("scroll", conversation.scroller);
	assert.equal(run.timers.size, 1);
	loader.dispose();
	assert.equal(document.listeners.length, 0, "dispose left a listener behind");
	assert.equal(run.timers.size, 0, "dispose left a timer behind");
	run.runTimers();
	assert.equal(conversation.button.clicks, 0, "a disposed loader still clicked");

	// Reinstall, start a load, then dispose while the observer is live.
	assert.equal(loader.install(), true);
	userScroll({ document }, conversation);
	run.runTimers();
	assert.equal(conversation.button.clicks, 1);
	assert.equal(run.observers.size, 1);
	loader.dispose();
	assert.equal(run.observers.size, 0, "dispose left the MutationObserver connected");

	conversation.button.disabled = false;
	run.flushObservers();
	run.runTimers();
	assert.equal(conversation.button.clicks, 1, "a disposed observer re-armed and clicked");
});

test("the phone boot installs the loader and the shared cleanup disposes it", () => {
	assert.match(CLIENT, /if \(phone\(\)\) \{\s*\n\s*installWorkspaceTools\(\);\s*\n\s*installOlderLoader\(\);/, "the boot does not install #71 with the other phone hooks");
	assert.match(CLIENT, /disposeWorkspaceTools\(\);\s*\n\s*\/\/ #71 owns its own document listeners, timer and observer\.\s*\n\s*disposeOlderLoader\(\);/, "clearPhoneHooks does not dispose #71");
});
