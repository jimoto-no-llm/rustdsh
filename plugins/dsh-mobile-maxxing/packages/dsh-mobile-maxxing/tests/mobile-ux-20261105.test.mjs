/**
 * The 2026-11-05 device findings (#141-#145) on a phone.
 *
 * Like the other bundle tests, the browser half has no exports: a slice of the
 * real source runs against the smallest DOM double that can answer it, so the
 * rule under test is the one the bundle ships rather than a copy of it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const CLIENT = readFileSync(new URL("../client.js", import.meta.url), "utf8");

/** The real source from "start" through the first "end" after it. */
function slice(start, end) {
	const at = CLIENT.indexOf(start);
	assert.ok(at >= 0, start.trim() + " exists");
	const stop = CLIENT.indexOf(end, at);
	assert.ok(stop > at, end.trim() + " closes the slice");
	return CLIENT.slice(at, stop);
}

// ---------------------------------------------------------------------------
// #142: the drawer's session search keeps the focus the app gives it
// ---------------------------------------------------------------------------

const GUARD_START = "    let allowFocusElement = null;";
const GUARD_END = "    // Keyboard: a sent message";

function guardHarness({ drawer = "open", inDrawer = true } = {}) {
	class Element {
		constructor() {
			this.tagName = "INPUT";
			this.disabled = false;
			this.readOnly = false;
			this.inDrawer = inDrawer;
		}
		closest(selector) {
			if (selector === 'input, textarea, [contenteditable="true"]') return this;
			if (selector === "[data-rdsh-sidebar]") return this.inDrawer ? this : null;
			return null;
		}
		getAttribute(name) { return name === "type" ? "text" : null; }
		blur() { this.blurred = (this.blurred ?? 0) + 1; }
	}
	const root = { getAttribute: (name) => (name === "data-rdsh-drawer" ? drawer : null) };
	const field = new Element();
	const queued = [];
	const sandbox = {
		Element,
		phone: () => true,
		document: { documentElement: root, activeElement: field },
		setTimeout: (fn) => queued.push(fn),
	};
	vm.runInNewContext(slice(GUARD_START, GUARD_END) + "\nthis.guard = onFocusInGuard; this.pointer = onFocusPointer;", sandbox);
	return {
		field, sandbox, root,
		focus(target = field) {
			sandbox.guard({ target });
			queued.splice(0).forEach((fn) => fn());
			return target.blurred ?? 0;
		},
	};
}

test("the open drawer's own search field keeps the focus the app gives it", () => {
	const h = guardHarness();
	// The search button's click focuses the input programmatically, so no
	// pointerdown ever authorised this field.
	assert.equal(h.focus(), 0, "the drawer's field is not blurred");
	assert.equal(h.field.blurred, undefined);
});

test("a field outside the drawer still needs a deliberate tap", () => {
	const h = guardHarness({ inDrawer: false });
	assert.equal(h.focus(), 1, "the app's automatic focus is still rejected");
});

test("a closed drawer does not authorise its fields", () => {
	const h = guardHarness({ drawer: "closed" });
	assert.equal(h.focus(), 1);
});

test("a deliberate tap on the field itself is unchanged", () => {
	const h = guardHarness({ inDrawer: false });
	h.sandbox.pointer({ target: h.field });
	assert.equal(h.focus(), 0, "onFocusPointer already authorised this field");
});

// ---------------------------------------------------------------------------
// #143: the session list renders one page (20 rows) at a time
// ---------------------------------------------------------------------------

const LIMIT_START = "    const SESSION_PAGE_SIZE = 20;";
const LIMIT_END = "    function toggleDrawer()";

function pagingHarness({ rows: rowCount = 21, drawer = "open", search = "", phone = true } = {}) {
	class Node {
		constructor(tag = "div") {
			this.tagName = tag;
			this.attributes = new Map();
			this.children = [];
			this.listeners = new Map();
			this.textContent = "";
		}
		setAttribute(name, value) { this.attributes.set(name, String(value)); }
		removeAttribute(name) { this.attributes.delete(name); }
		hasAttribute(name) { return this.attributes.has(name); }
		addEventListener(type, fn) { this.listeners.set(type, fn); }
		append(node) { this.children.push(node); }
		remove() { this.removed = true; }
		click() { this.listeners.get("click")?.({ type: "click" }); }
	}
	const rows = Array.from({ length: rowCount }, () => new Node("div"));
	const more = [];
	const scroller = new Node("div");
	scroller.append = (node) => { more.push(node); };
	const searchField = search === null ? null : { value: search };
	const sidebar = {
		querySelectorAll: (selector) => (selector === '[data-row-key^="session:"]' ? rows : []),
		querySelector: (selector) => {
			if (selector === "input") return searchField;
			if (selector === "[data-rdsh-session-more]") return more.find((node) => node.isConnected !== false) ?? null;
			return null;
		},
	};
	const document = {
		documentElement: { getAttribute: (name) => (name === "data-rdsh-drawer" ? drawer : null) },
		querySelector: (selector) => (selector === "[data-rdsh-sidebar]" ? sidebar : null),
		querySelectorAll: (selector) => (selector === "[data-rdsh-session-overflow]" ? rows.filter((row) => row.hasAttribute("data-rdsh-session-overflow")) : []),
		createElement: (tag) => new Node(tag),
	};
	let decorates = 0;
	const sandbox = {
		document, Node,
		phone: () => phone,
		t: (key) => (key === "mux.sessions.more" ? "Show more sessions" : key),
		sessionListScroller: () => scroller,
		scheduleDecorate: () => { decorates += 1; },
	};
	vm.runInNewContext(slice(LIMIT_START, LIMIT_END) + "\nthis.decorateLimit = decorateSessionLimit; this.limit = () => sessionLimit;", sandbox);
	return { rows, more, sidebar, sandbox, decorate: () => sandbox.decorateLimit(), decorates: () => decorates };
}

const hidden = (h) => h.rows.filter((row) => row.hasAttribute("data-rdsh-session-overflow")).length;

test("21 sessions show the first 20 and a Show more button", () => {
	const h = pagingHarness();
	h.decorate();
	assert.equal(hidden(h), 1, "the 21st row is the only hidden one");
	assert.equal(h.more.length, 1, "one button is appended");
	assert.equal(h.more[0].textContent, "Show more sessions");
	assert.equal(h.sandbox.limit(), 20);
});

test("Show more reveals the next page and then retires the button", () => {
	const h = pagingHarness();
	h.decorate();
	h.more[0].click();
	assert.equal(h.decorates(), 1, "the click asks for a decorate pass");
	assert.equal(h.sandbox.limit(), 40);
	h.decorate();
	assert.equal(hidden(h), 0, "all 21 rows are visible");
	assert.equal(h.more[0].removed, true, "no button when nothing is left");
});

test("a search result set is never paged", () => {
	const h = pagingHarness({ search: "qa" });
	h.decorate();
	assert.equal(hidden(h), 0);
	assert.equal(h.more.length, 0);
});

test("a closing drawer keeps its page, a desktop has no paging at all", () => {
	// The drawer slide-out is 300ms; dropping the page at the same instant
	// would paint the whole catalog while the list is still leaving.
	const closed = pagingHarness({ drawer: "closed" });
	closed.decorate();
	assert.equal(hidden(closed), 1, "the page stays applied while the drawer closes");
	const desktop = pagingHarness({ phone: false });
	desktop.rows[3].setAttribute("data-rdsh-session-overflow", "");
	desktop.decorate();
	assert.equal(hidden(desktop), 0, "a desktop keeps every session row");
});


// ---------------------------------------------------------------------------
// #142: the keyboard pin leaves the drawer alone
// ---------------------------------------------------------------------------

const FIT_START = "    function fitVisualViewport() {";
const FIT_END = "    function measureSafeArea()";

function pinHarness({ drawer = "open", dialog = null } = {}) {
	const html = {
		attributes: new Set(),
		getAttribute(name) { return name === "data-rdsh-drawer" ? drawer : null; },
		hasAttribute(name) { return this.attributes.has(name); },
		setAttribute(name, value) { this.attributes.add(name); this.lastSet = [name, value]; },
		removeAttribute(name) { this.attributes.delete(name); },
		toggleAttribute(name, on) { if (on) this.attributes.add(name); else this.attributes.delete(name); },
		style: { values: new Map(), setProperty(name, value) { this.values.set(name, value); } },
	};
	const sandbox = {
		document: { documentElement: html, querySelector: (selector) => (/\[role="dialog"\]/.test(selector) ? dialog : null) },
		window: { innerWidth: 390, innerHeight: 844, visualViewport: { height: 500, offsetTop: 0, scale: 1 } },
		phone: () => true,
		keyboardOpen: () => true,
	};
	vm.runInNewContext(slice(FIT_START, FIT_END) + "\nthis.fit = fitVisualViewport;", sandbox);
	return { html, sandbox, fit: () => sandbox.fit() };
}

test("the open drawer keeps the full-height layout while the keyboard is up", () => {
	const h = pinHarness();
	h.fit();
	assert.equal(h.html.hasAttribute("data-rdsh-keyboard"), false, "no keyboard pin while the drawer is open");
});

test("the chat screen still pins itself to the keyboard", () => {
	const h = pinHarness({ drawer: "closed" });
	h.fit();
	assert.equal(h.html.hasAttribute("data-rdsh-keyboard"), true);
	assert.equal(h.html.style.values.get("--rdsh-vv-height"), "500px");
});

test("a dialog keeps owning its own geometry", () => {
	const h = pinHarness({ drawer: "closed", dialog: {} });
	h.fit();
	assert.equal(h.html.hasAttribute("data-rdsh-keyboard"), false);
});


// ---------------------------------------------------------------------------
// #144: a cold start records baselines instead of typing every title
// ---------------------------------------------------------------------------

const TYPING_START = "    const UNTITLED = probeRegex(";
const TYPING_END = '    /** Upward travel that counts as "flick the banner away". */';

function typingHarness({ mobile = true } = {}) {
	let clock = 2_000_000;
	class Title {
		constructor() { this.childNodes = [{ nodeType: 3, nodeValue: "" }]; this.attributes = new Set(); }
		set value(text) { this.childNodes = [{ nodeType: 3, nodeValue: text }]; }
		hasAttribute(name) { return this.attributes.has(name); }
		removeAttribute(name) { this.attributes.delete(name); }
		setAttribute(name, value) { this.attributes.set(name, String(value)); }
		querySelector() { return null; }
		append() {}
		remove() {}
	}
	class Row {
		constructor(id, title) { this.key = "session:" + id; this.title = title; this.attributes = new Set(); }
		getAttribute(name) { return name === "data-row-key" ? this.key : null; }
		hasAttribute(name) { return this.attributes.has(name); }
		setAttribute(name) { this.attributes.add(name); }
	}
	const rows = [];
	const animations = [];
	const document = {
		querySelector: () => null,
		querySelectorAll: (selector) => (selector === "[data-rdsh-session-title]" ? rows.map((row) => row.title) : []),
		createElement: () => new Title(),
	};
	const sandbox = {
		document, MutationObserver: class { observe() {} disconnect() {} },
		phone: () => mobile,
		probeRegex: () => /^(new session|new chat|untitled)$/i,
		__RDSH_MOBILE_UX_RUNNING__: new Set(),
		Date: { now: () => clock },
	};
	vm.runInNewContext(slice(TYPING_START, TYPING_END) + "\nthis.decorate = decorateSessionTitleTyping; this.setAnimate = (fn) => { animateSessionTitle = fn; };", sandbox);
	sandbox.setAnimate((element, next, previous) => {
		animations.push({ next, previous });
		return { visible: () => next, cancel() {}, reattach() {} };
	});
	return {
		rows, animations, sandbox,
		add(id, text) {
			const title = new Title();
			title.value = text;
			const row = new Row(id, title);
			title.closest = () => row;
			rows.push(row);
			return { row, title, set: (value) => { title.value = value; } };
		},
		decorate: () => sandbox.decorate(),
	};
}

test("existing titles on the first pass never type", () => {
	const h = typingHarness();
	h.add("a", "Alpha"); h.add("b", "Beta"); h.add("c", "Gamma");
	h.decorate();
	assert.equal(h.animations.length, 0, "the boot catalog is a baseline");
});

test("a cold start that paints empty rows before the titles still never types", () => {
	const h = typingHarness();
	const a = h.add("a", ""); const b = h.add("b", "");
	h.decorate();
	a.set("Alpha"); b.set("Beta");
	h.decorate();
	assert.equal(h.animations.length, 0, "placeholder to title is the baseline");
});

test("a cold start that paints raw ids before the titles still never types", () => {
	const h = typingHarness();
	const a = h.add("a", "a"); const b = h.add("b", "b");
	h.decorate();
	a.set("Alpha"); b.set("Beta");
	h.decorate();
	assert.equal(h.animations.length, 0, "the id fallback is not a naming event");
});

test("only a title that changes after the baseline types", () => {
	const h = typingHarness();
	const a = h.add("a", "Alpha"); h.add("b", "Beta");
	h.decorate();
	a.set("Alpha renamed");
	h.decorate();
	assert.deepEqual(h.animations, [{ next: "Alpha renamed", previous: "Alpha" }]);
});

test("a session being named still types its first title", () => {
	const h = typingHarness();
	const a = h.add("a", "New session");
	// decorateSessionRows() tags the row while its session is in the running
	// set; that tag is what the typing pass reads.
	a.row.setAttribute("data-rdsh-running", "");
	h.decorate();
	a.set("Generated name");
	h.decorate();
	assert.deepEqual(h.animations, [{ next: "Generated name", previous: "New session" }]);
});

test("a desktop pass animates nothing", () => {
	const h = typingHarness({ mobile: false });
	const a = h.add("a", "Alpha");
	h.decorate();
	a.set("Alpha renamed");
	h.decorate();
	assert.equal(h.animations.length, 0);
});


// ---------------------------------------------------------------------------
// #145: iOS text autosizing is disabled on the phone sheet only
// ---------------------------------------------------------------------------

function stylesheet(name) {
	const marker = "const " + name + " = " + String.fromCharCode(96);
	const at = CLIENT.indexOf(marker);
	assert.ok(at >= 0, name + " exists");
	const end = CLIENT.indexOf(String.fromCharCode(96) + ";", at + marker.length);
	assert.ok(end > at, name + " is closed");
	return CLIENT.slice(at + marker.length, end);
}

test("the phone sheet stops iOS from autosizing the transcript", () => {
	const phone = stylesheet("CSS_PHONE");
	assert.match(phone, /html \{\s*-webkit-text-size-adjust: 100%;\s*text-size-adjust: 100%;\s*\}/, "both declarations, on html");
	const desktop = stylesheet("CSS_DEVICE");
	assert.ok(!desktop.includes("text-size-adjust"), "a desktop keeps the browser default");
});


// --------------------------------------------------------------------------
// #146: a modal's own text field keeps focus and stays 16px
// --------------------------------------------------------------------------

test("a field inside a modal is not blurred by the focus guard", () => {
	const src = CLIENT.slice(CLIENT.indexOf("    function modalOwnedField("), CLIENT.indexOf("    function onFocusInGuard("));
	assert.ok(src.includes("modalOwnedField"), "the helper is present");
	const body = CLIENT.slice(CLIENT.indexOf("    function modalOwnedField("), CLIENT.indexOf("\n    }\n", CLIENT.indexOf("    function modalOwnedField(")) + 6);
	const sandbox = {
		field: null,
	};
	vm.createContext(sandbox);
	vm.runInContext(body, sandbox);
	const shell = { closest: () => null };
	const modal = { closest: (sel) => sel === '[role="dialog"]' ? shell : null };
	const nested = { closest: (sel) => sel === '[role="dialog"]' ? modal : null };
	assert.equal(sandbox.modalOwnedField(nested), true, "a nested dialog's field is the user's");
	assert.equal(sandbox.modalOwnedField({ closest: () => shell }), false, "the shell alone is not a modal");
	assert.equal(sandbox.modalOwnedField({ closest: () => null }), false, "a plain field is untouched");
});

test("a modal's fields are pinned to 16px on the phone only", () => {
	const tick = String.fromCharCode(96);
	const at = CLIENT.indexOf("const CSS_PHONE = " + tick);
	const end = CLIENT.indexOf(tick + ";\n", at);
	assert.ok(at > 0 && end > at, "the phone sheet exists");
	const phone = CLIENT.slice(at, end);
	assert.match(phone, /\[role="dialog"\] \[role="dialog"\] \[contenteditable="true"\]/, "the modal's editable field is matched");
	assert.match(phone, /font-size: 16px !important/, "iOS is not given a reason to zoom");
	const desktop = CLIENT.slice(CLIENT.indexOf("const CSS_DEVICE"), CLIENT.indexOf("const CSS_PHONE"));
	assert.ok(!desktop.includes('role="dialog"] [role="dialog"]'), "a desktop keeps its own sizes");
});

// --------------------------------------------------------------------------
// #147: the terminal key row owns paste
// --------------------------------------------------------------------------

function pasteHarness(readText) {
	const at = CLIENT.indexOf("    function pasteTerminalClipboard(");
	const end = CLIENT.indexOf("\n    }\n", at);
	assert.ok(at > 0 && end > at, "pasteTerminalClipboard exists");
	const state = { sent: [] };
	const sandbox = {
		navigator: { clipboard: { readText } },
		sendTerminalBytes: (section, text) => state.sent.push({ section, text }),
	};
	vm.createContext(sandbox);
	vm.runInContext(CLIENT.slice(at, end + "\n    }".length), sandbox);
	return { state, sandbox };
}

test("the paste key sends the clipboard into the terminal", async () => {
	const h = pasteHarness(async () => "echo hi");
	h.sandbox.pasteTerminalClipboard({ section: "s1" });
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(h.state.sent, [{ section: "s1", text: "echo hi" }]);
});

test("a refused clipboard leaves the paste key a no-op", async () => {
	const h = pasteHarness(async () => { throw new Error("denied"); });
	h.sandbox.pasteTerminalClipboard({ section: "s1" });
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(h.state.sent, []);
});

// --------------------------------------------------------------------------
// #148: the conversation is sized from the upstream slot, not the late hook
// --------------------------------------------------------------------------

test("the conversation width applies before this plugin's hook exists", () => {
	const tick = String.fromCharCode(96);
	const at = CLIENT.indexOf("const CSS_PHONE = " + tick);
	const end = CLIENT.indexOf(tick + ";\n", at);
	assert.ok(at > 0 && end > at, "the phone sheet exists");
	const phone = CLIENT.slice(at, end);
	assert.match(phone, /\[data-slot="conversation"\],/, "the upstream slot carries the sizing");
	assert.match(phone, /\[data-slot="main.conversation"\],/, "the main slot too");
	assert.match(phone, /\[data-slot="conversation"\] > \*/, "its children are sized the same way");
});

// --------------------------------------------------------------------------
// #148: the conversation is sized from the upstream slot, not the late hook
// --------------------------------------------------------------------------

test("the conversation width applies before this plugin's hook exists", () => {
	const tick = String.fromCharCode(96);
	const at = CLIENT.indexOf("const CSS_PHONE = " + tick);
	const end = CLIENT.indexOf(tick + ";\n", at);
	assert.ok(at > 0 && end > at, "the phone sheet exists");
	const phone = CLIENT.slice(at, end);
	assert.match(phone, /\[data-slot="conversation"\],/, "the upstream slot carries the sizing");
	assert.match(phone, /\[data-slot="main.conversation"\],/, "the main slot too");
	assert.match(phone, /\[data-slot="conversation"\] > \*/, "its children are sized the same way");
});

// --------------------------------------------------------------------------
// #149: the OS edge-back gesture is cancelled on a phone
// --------------------------------------------------------------------------

test("the left-edge touch is cancelled so the OS cannot navigate", () => {
	assert.match(CLIENT, /const EDGE_SUPPRESS_PX = 28;/, "the edge zone is declared");
	assert.match(CLIENT, /first\.clientX <= EDGE_SUPPRESS_PX && event\.cancelable\) event\.preventDefault\(\)/, "the edge touch is cancelled");
	assert.match(CLIENT, /addEventListener\("touchstart", onEdgeSwipeStart, \{ capture: true, passive: false \}\)/, "a passive listener cannot cancel");
});

// --------------------------------------------------------------------------
// #150: a freshly mounted transcript is retried instead of waiting a second
// --------------------------------------------------------------------------

test("the transcript hook retries while the new session is still unmeasured", () => {
	assert.match(CLIENT, /let transcriptRetries = 0;/, "the retry counter exists");
	assert.match(CLIENT, /if \(transcriptRetries >= 5\) return;/, "the retry is bounded");
	assert.match(CLIENT, /setTimeout\(\(\) => scheduleDecorate\(\), 80 \* transcriptRetries\)/, "the retry re-runs the pass");
	assert.match(CLIENT, /lastSlowAt = 0;/, "a session switch frees the slow gate");
});

// --------------------------------------------------------------------------
// #151: keyboard frames are coalesced and repeated bands are skipped
// --------------------------------------------------------------------------

test("keyboard frames are coalesced into one fit per frame", () => {
	assert.match(CLIENT, /function scheduleFitVisualViewport\(\) \{/, "the coalescer exists");
	assert.match(CLIENT, /addEventListener\("resize", scheduleFitVisualViewport\)/, "resize goes through it");
	assert.match(CLIENT, /addEventListener\("scroll", scheduleFitVisualViewport\)/, "scroll too");
	assert.match(CLIENT, /height === fitHeight\) return;/, "an unchanged band writes nothing");
});

// --------------------------------------------------------------------------
// #156: main-thread cost of the mobile surface
// --------------------------------------------------------------------------

test("decorate is throttled only while a turn streams", () => {
	assert.match(CLIENT, /const DECORATE_MIN_MS = 120;/, "the floor is declared");
	assert.match(CLIENT, /const running = globalThis\.__RDSH_MOBILE_UX_RUNNING__;/, "the storm gate reads the running set");
	assert.match(CLIENT, /const storm = running instanceof Set && running\.size > 0;/, "idle passes keep their frame");
	assert.match(CLIENT, /scheduled = false;\n        if \(!live\) return;/, "the flag clears before the pass runs");
});

test("the safe area is not re-measured on keyboard frames", () => {
	assert.match(CLIENT, /function scheduleMeasureSafeArea\(force = false\)/, "the scheduler exists");
	assert.match(CLIENT, /if \(!force && keyboardOpen\(\)\) return;/, "the keyboard cannot move the glass");
	assert.match(CLIENT, /if \(!force && key === safeAreaKey\) return;/, "an unchanged geometry is skipped");
});

test("a drag resolves its scroll container once", () => {
	assert.match(CLIENT, /function gestureScroller\(target\)/, "the per-gesture cache exists");
	assert.match(CLIENT, /const scroller = gestureScroller\(target\);/, "the drag handler uses it");
	assert.match(CLIENT, /dragScrollerTarget = null;\n      dragScroller = null;/, "a new touch starts a new gesture");
});

test("an idle session stops asking for the live speed", () => {
	assert.match(CLIENT, /timer = window\.setTimeout\(loop, lastTps > 0 \? 500 : 5000\);/, "idle polls back off");
	assert.match(CLIENT, /let lastTps = 0;/, "the last rate is remembered");
});

test("the hamburger answers the touch, not a click the edge claim may eat", () => {
	// The FAB sits at x=8..48, inside the 28px band the iOS edge gesture is
	// claimed in, so the touchstart cancel also killed the synthesized click:
	// taps looked like nothing happened. It acts on touchend instead.
	assert.match(CLIENT, /fab\.addEventListener\("touchend", fabTapEnd\)/, "the FAB waits for a click");
	assert.match(CLIENT, /fab\.addEventListener\("touchmove"/, "a drag is not a tap");
	assert.match(CLIENT, /if \(Date\.now\(\) - fabActedAt < 500\) return;/, "the click repeats the touchend action");
});

test("the update confirmation stays until it is dismissed", () => {
	assert.match(CLIENT, /const UPDATE_DONE_KEY = "dsh-mobile-maxxing:update-done";/, "the done marker is named");
	assert.match(CLIENT, /sessionStorage\.setItem\(UPDATE_DONE_KEY, release\)/, "a finished update is remembered across the remount");
	assert.match(CLIENT, /sessionStorage\.removeItem\(UPDATE_DONE_KEY\)/, "dismissing clears it");
});

test("the updates panel shows both versions without checking GitHub", () => {
	assert.match(CLIENT, /plugin-version\?local=1/, "the versions come from the cheap route");
	assert.match(CLIENT, /t\("update\.row\.plugin"\)/, "the plugin version row");
	assert.match(CLIENT, /t\("update\.row\.dsh"\)/, "the DSH version row");
});

test("closing the update dialog actually closes it", () => {
	// The blanket setPhase("") -> dismiss() rewrite once replaced the body of
	// dismiss() itself: closing recursed until the stack blew, and the dialog
	// stayed on screen.
	const start = CLIENT.indexOf("const dismiss = () => {");
	assert.ok(start > 0, "the dialog has no dismiss");
	const body = CLIENT.slice(start, CLIENT.indexOf("};", start));
	assert.match(body, /setPhase\(""\)/, "dismiss does not clear the phase");
	assert.doesNotMatch(body, /dismiss\(\)/, "dismiss calls itself");
});
