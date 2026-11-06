import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { COPY } from "../lib/copy.js";

const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const start = source.indexOf("    // Mobile back navigation (#125).");
const end = source.indexOf("    // Input: Enter inserts", start);
assert.ok(start > 0 && end > start);
const optionalStart = source.indexOf("    function optionalService(");
const optionalEnd = source.indexOf("\n    }", optionalStart) + 6;

class Node {
  constructor(tag = "div") {
    this.tagName = tag;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.isConnected = true;
    this.clicks = 0;
    this.hidden = false;
    this.excluded = false;
    this.textContent = "";
  }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  dispatchEvent(event) { this.listeners.get(event.type)?.(event); return true; }
  click() { this.clicks++; this.dispatchEvent({ type: "click" }); }
  append(...nodes) { this.children.push(...nodes); }
  remove() { this.isConnected = false; }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  hasAttribute(key) { return this.attributes.has(key); }
  querySelector() { return this.close ?? null; }
  closest() { return this.excluded ? this : null; }
  contains(node) { return node === this || this.children.includes(node); }
}

function harness({ ios = false, mobile = true, initialState = { upstream: "kept" } } = {}) {
  const root = new Node("html");
  const body = new Node("body");
  const listeners = new Map();
  const timers = new Map();
  let timer = 0;
  // A controllable clock: the drawer swipe and Safari's trailing popstate are
  // told apart by a timestamp, and a real 600ms wait per case would slow the
  // suite for no added coverage.
  let clock = 1_000_000;
  const state = { session: "session-1", workspace: "workspace-1", openedWorkspaces: [], panel: null, overlays: [], crop: null, detail: null, collapse: null, closes: 0, homes: 0, cleared: 0, drawer: 0, toasts: [] };
  const entries = [{ outside: true }, initialState];
  let index = 1;
  const history = {
    get state() { return entries[index]; },
    replaceState(next) { entries[index] = next; },
    pushState(next) { entries.splice(++index); entries[index] = next; },
  };
  const workspace = {
    selection: { getSnapshot: () => ({ sessionId: state.session }) },
    clearMain() { state.session = ""; state.workspace = ""; state.panel = null; state.homes++; state.cleared++; },
    async openWorkspace(id) {
      state.openedWorkspaces.push(id); state.workspace = id;
      state.session = "blank-" + id; state.blank = true; state.panel = null; state.homes++;
    },
  };
  const layout = { panelInfo: { getSnapshot: () => ({ activePanelId: state.panel }) }, selectPanel(id) { state.panel = id; state.homes++; } };
  const workspaces = { list: { getSnapshot: () => ({ items: state.workspace ? [{ workspaceId: state.workspace, sessionIds: [state.session] }] : [] }) } };
  const doc = {
    documentElement: root, body, activeElement: new Node("input"),
    createElement: (tag) => new Node(tag),
    querySelector: (selector) => selector === "[data-rdsh-crop-overlay]" ? state.crop : null,
    querySelectorAll: () => state.overlays,
    addEventListener: (type, fn) => listeners.set(`document:${type}`, fn),
    removeEventListener: (type, fn) => { if (listeners.get(`document:${type}`) === fn) listeners.delete(`document:${type}`); },
  };
  const sandbox = {
    document: doc, Element: Node, Date: { now: () => clock },
    navigator: { userAgent: ios ? "iPhone" : "Android", platform: ios ? "iPhone" : "Linux", maxTouchPoints: 5 },
    phone: () => mobile,
    hostCtx: { get: (key) => key === "workspaces" ? workspaces : key === "uiWorkspace" ? workspace : key === "layout" ? layout : key === "sessions" ? { list: { getSnapshot: () => ({ byId: { [state.session]: { blank: state.blank === true } } }) } } : undefined },
    shownSessionId: () => state.session,
    routeLaidOut: (node) => !node.hidden,
    visibleCollapseButton: () => state.collapse,
    routeDetailOf: () => state.detail,
    closeCropOverlay: () => { state.crop = null; },
    closeDrawer: () => root.attributes.delete("data-rdsh-drawer"),
    toggleDrawer: () => { state.drawer++; },
    mobileToast: (text) => state.toasts.push(text),
    scrolledLeftAncestor: (target) => target.scrolled ? target : null,
    rightPanelChromeStart: () => false,
    endTerminalDrag() {},
    KeyboardEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    t: (key) => COPY.ja[key],
    clearTimeout: (id) => timers.delete(id),
    wantedSession: "pending-notification", wantedUntil: 999,
    window: {
      history, innerWidth: 390, closed: false,
      close: () => { state.closes++; },
      setTimeout(fn) { timers.set(++timer, fn); return timer; },
      addEventListener: (type, fn) => listeners.set(type, fn),
      removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(optionalStart, optionalEnd) + "\n" + source.slice(start, end) + `
    globalThis.api = { mobileBack, installMobileBack, onEdgeSwipeStart, onEdgeSwipeMove, onEdgeSwipeEnd, iosBackGesture,
      dialog: () => exitDialog, pending: () => wantedSession };
  `, sandbox);
  return {
    ...sandbox.api, state, doc, sandbox, entries, listeners, workspace,
    pop() { index--; listeners.get("popstate")?.({ state: entries[index] }); },
    firePop(value) { listeners.get("popstate")?.({ state: value }); },
    flush() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
    advance(ms) { clock += ms; },
  };
}

function touch(target, x, y, type = "touchmove", count = 1) {
  return { target, type, touches: Array.from({ length: count }, () => ({ clientX: x, clientY: y })), cancelable: true, preventDefault() { this.prevented = true; } };
}

function swipe(h, { target = new Node(), x = 8, dx = 100, dy = 2, cancel = false } = {}) {
  h.onEdgeSwipeStart(touch(target, x, 100, "touchstart"));
  h.onEdgeSwipeMove(touch(target, x + dx, 100 + dy));
  h.onEdgeSwipeEnd(touch(target, x + dx, 100 + dy, cancel ? "touchcancel" : "touchend"));
}

test("Android Back returns session to Home, then confirms and cancels without leaving", () => {
  const h = harness();
  h.installMobileBack();
  h.pop();
  assert.equal(h.state.homes, 1);
  assert.equal(h.dialog(), null);
  assert.equal(h.pending(), "", "a pending notification must not reopen the session");
  h.pop();
  assert.equal(h.dialog().children[0].textContent, "終了しますか？");
  const cancel = h.dialog().children[2].children[0];
  assert.equal(cancel.textContent, "キャンセル");
  // #133: the dialog owns the initial focus, so no button starts ringed; Tab
  // reaches Cancel first, and only that keyboard move paints :focus-visible.
  assert.ok(h.dialog().focused, "the dialog takes the initial focus");
  assert.ok(!cancel.focused, "the safe choice is not focused programmatically");
  cancel.click();
  assert.equal(h.dialog(), null);
  assert.equal(h.state.closes, 0);
  for (let n = 0; n < 20; n++) h.pop();
  assert.equal(h.entries.length, 3, "repeated Back replaces the one guard");
  assert.equal(h.entries[2].upstream, "kept");
  assert.ok(!h.entries[2].outside);
});

test("only Yes attempts closure; refused closure shows manual instructions", () => {
  const h = harness(); h.state.session = "";
  h.mobileBack();
  const dialog = h.dialog();
  const yes = dialog.children[2].children[1];
  assert.equal(yes.textContent, "はい");
  yes.click(); h.flush();
  assert.equal(h.state.closes, 1);
  assert.ok(yes.disabled);
  assert.match(dialog.children[1].textContent, /自動で終了できません/);
  h.mobileBack();
  assert.equal(h.dialog(), null);
});

test("Back closes overlays, drawer and right panel before navigating", () => {
  const h = harness();
  h.state.crop = new Node(); h.mobileBack();
  assert.equal(h.state.crop, null);
  const settings = new Node(); settings.close = new Node("button");
  h.state.overlays = [settings]; h.mobileBack();
  assert.equal(settings.close.clicks, 1);
  h.state.overlays = [];
  h.doc.documentElement.setAttribute("data-rdsh-drawer", "open"); h.mobileBack();
  assert.equal(h.doc.documentElement.getAttribute("data-rdsh-drawer"), null);
  h.state.collapse = new Node("button");
  h.doc.documentElement.setAttribute("data-rdsh-rightpanel-open", ""); h.mobileBack();
  assert.equal(h.state.collapse.clicks, 1);
  assert.equal(h.state.homes, 0);
  assert.equal(h.dialog(), null);
});

test("a generic dialog receives Escape and does not navigate underneath", () => {
  const h = harness(); const overlay = new Node(); h.state.overlays = [overlay];
  let escape;
  overlay.addEventListener("keydown", (event) => { escape = event; });
  h.mobileBack();
  assert.equal(escape.key, "Escape"); assert.ok(escape.bubbles);
  assert.equal(h.state.homes, 0);
});

test("history arms after a trusted interaction on a cold start", () => {
  const h = harness(); h.sandbox.navigator.userActivation = { hasBeenActive: false };
  h.installMobileBack();
  assert.equal(h.entries.length, 2);
  h.listeners.get("document:pointerdown")({ isTrusted: false });
  assert.equal(h.entries.length, 2);
  h.sandbox.navigator.userActivation.hasBeenActive = true;
  h.listeners.get("document:pointerup")({ isTrusted: true });
  assert.equal(h.entries.length, 3);
  h.pop(); assert.equal(h.state.homes, 1);
});

test("unrelated primitive/array history state and a denied History API are preserved", () => {
  for (const initialState of ["upstream", 1, ["upstream"]]) {
    const h = harness({ initialState }); h.installMobileBack();
    assert.equal(h.entries.length, 2);
    assert.equal(h.sandbox.window.history.state, initialState);
  }
  const h = harness(); h.sandbox.window.history.pushState = () => { throw new Error("SecurityError"); };
  assert.doesNotThrow(() => h.installMobileBack());
});

test("missing optional services do not throw or offer exit on a loading screen", () => {
  const h = harness(); h.state.session = "";
  h.sandbox.hostCtx.get = () => { throw new Error("service not ready"); };
  assert.doesNotThrow(() => h.mobileBack());
  assert.equal(h.dialog(), null);
});

test("iOS installs no history guard, so the browser keeps the edge gesture", () => {
  // 1.0.0 had no history entry on iOS; 1.0.1 added one for Android-style
  // Back, and Safari's native edge swipe started popping it (the "the tab
  // went back" report). The guard is Android-only now: the drawer swipe
  // stays, and no entry is pushed.
  const h = harness({ ios: true }); h.installMobileBack();
  swipe(h);
  assert.equal(h.state.drawer, 1, "the drawer still opens on the left edge");
  assert.equal(h.entries.length, 2, "no history entry is pushed on iOS");
  h.pop();
  assert.equal(h.state.drawer, 1, "an unrelated popstate does not close the drawer");
  assert.equal(h.state.homes, 0, "and does not navigate");
});

test("task detail in a wide split returns to its list before Home", () => {
  const h = harness(); const page = new Node(); const pane = new Node(); const list = new Node(); const close = new Node("button");
  close.parentElement = pane; pane.parentElement = page; page.children = [list, pane];
  page.querySelectorAll = () => [close]; close.setAttribute("aria-label", "Close details");
  h.doc.querySelector = () => page; h.doc.querySelectorAll = () => [];
  h.sandbox.probeValues = () => ["Close details"];
  const routeStart = source.indexOf("    function routeDetailOf(");
  const routeEnd = source.indexOf("\n    }", routeStart) + 6;
  const route = vm.runInContext(source.slice(routeStart, routeEnd) + "\nrouteDetailOf", h.sandbox);
  assert.equal(route(), null, "the layout helper still leaves the list visible");
  assert.equal(route(true).source, close, "Back closes the detail even when its list is visible");
});

test("detail returns to its parent before the full-screen panel returns Home", () => {
  const h = harness();
  const container = new Node(); container.close = new Node("button");
  h.state.detail = { container, source: null }; h.mobileBack();
  assert.equal(container.close.clicks, 1);
  const close = new Node("button"); h.state.detail = { container, source: close }; h.mobileBack();
  assert.equal(close.clicks, 1);
  assert.equal(h.state.homes, 0);
  h.state.detail = null; h.state.panel = "plugins"; h.state.session = "";
  h.mobileBack(); assert.equal(h.state.homes, 1); assert.equal(h.state.panel, null);
});

test("iOS left-edge swipe opens the drawer and shows no exit dialog (#141)", () => {
  const h = harness({ ios: true }); h.installMobileBack();
  swipe(h);
  assert.equal(h.state.drawer, 1, "the drawer opens, as on Android");
  assert.equal(h.state.homes, 0, "the swipe is not Back");
  assert.equal(h.dialog(), null, "no exit confirmation on a drawer swipe");
  assert.equal(h.entries.length, 2, "iOS gets no guard entry");
});

test("short, vertical, reversed and central iOS swipes leave the drawer closed", () => {
  for (const options of [{ dx: 30 }, { dy: 120 }, { dx: -80 }, { x: 100 }]) {
    const h = harness({ ios: true }); swipe(h, options);
    assert.equal(h.state.drawer, 0, JSON.stringify(options));
    assert.equal(h.state.homes, 0, JSON.stringify(options));
  }
  // A cancelled touch that already crossed the threshold has opened the
  // drawer, exactly like the Android gesture: the move owns the action.
  const cancelled = harness({ ios: true }); swipe(cancelled, { cancel: true });
  assert.equal(cancelled.state.drawer, 1);
});

test("input and multi-touch gestures retain ownership on iOS", () => {
  const h = harness({ ios: true }); const target = new Node();
  h.onEdgeSwipeStart(touch(target, 8, 100));
  h.onEdgeSwipeMove(touch(target, 100, 100, "touchmove", 2));
  h.onEdgeSwipeMove(touch(target, 150, 100));
  h.onEdgeSwipeEnd(touch(target, 150, 100, "touchend"));
  const input = new Node(); input.excluded = true; swipe(h, { target: input });
  assert.equal(h.state.drawer, 0, "a form field keeps its own gesture");
  assert.equal(h.state.homes, 0);
});

test("Android keeps the existing drawer swipe and desktop stays unchanged", () => {
  const android = harness(); swipe(android);
  assert.equal(android.state.drawer, 1); assert.equal(android.state.homes, 0);
  const desktop = harness({ mobile: false }); desktop.installMobileBack(); desktop.mobileBack(); swipe(desktop);
  assert.equal(desktop.entries.length, 2); assert.equal(desktop.listeners.size, 0);
  assert.equal(desktop.state.homes, 0); assert.equal(desktop.dialog(), null);
});

test("reload reuses the guard, teardown removes listeners and unrelated history is ignored", () => {
  const h = harness(); const dispose = h.installMobileBack();
  h.firePop({ upstreamRoute: true }); assert.equal(h.state.homes, 0);
  dispose(); assert.equal(h.listeners.size, 0);
  h.installMobileBack(); assert.equal(h.entries.length, 3);
  h.state.session = ""; h.mobileBack(); dispose(); assert.equal(h.dialog(), null);
});

test("iPad desktop UA and mobile platform strings select the iOS gesture", () => {
  const h = harness(); h.sandbox.navigator = { userAgent: "Macintosh", platform: "MacIntel", maxTouchPoints: 5 };
  assert.ok(h.iosBackGesture());
  h.sandbox.navigator = { userAgent: "Macintosh", platform: "iPhone", maxTouchPoints: 0 };
  assert.ok(h.iosBackGesture());
});

test("Back never opens the closed right panel whose toggle remains mounted", () => {
  const h = harness(); h.state.collapse = new Node("button");
  h.mobileBack();
  assert.equal(h.state.collapse.clicks, 0);
  assert.equal(h.state.homes, 1);
});

test("a blank session shown as Home immediately offers the exit confirmation", () => {
  const h = harness(); h.state.blank = true;
  h.mobileBack();
  assert.ok(h.dialog());
  assert.equal(h.state.homes, 0);
});

test("Android Back inherits the current Workspace rather than clearing its selection", () => {
  const h = harness(); h.state.workspace = "source-workspace";
  const calls = [];
  const open = h.workspace.openWorkspace;
  h.workspace.openWorkspace = (...args) => { calls.push(args); return open(...args); };
  h.installMobileBack(); h.pop();
  assert.deepEqual(calls, [["source-workspace"]], "use the normal reuse flow without resetting its draft");
  assert.equal(h.state.workspace, "source-workspace");
  assert.equal(h.state.session, "blank-source-workspace");
  assert.equal(h.state.cleared, 0);
  h.pop(); assert.ok(h.dialog(), "the inherited blank is Home on the next Back");
});

test("iOS Back inherits the current Workspace and the next Back confirms exit", () => {
  const h = harness({ ios: true }); h.state.workspace = "ios-workspace";
  h.mobileBack();
  assert.equal(h.state.workspace, "ios-workspace");
  assert.deepEqual(h.state.openedWorkspaces, ["ios-workspace"]);
  assert.equal(h.state.cleared, 0);
  h.mobileBack(); assert.ok(h.dialog());
});

test("leaving a global panel preserves a blank Home and its draft session", () => {
  const h = harness(); h.state.blank = true; h.state.panel = "plugins";
  const session = h.state.session;
  h.mobileBack();
  assert.equal(h.state.session, session);
  assert.equal(h.state.workspace, "workspace-1");
  assert.equal(h.state.panel, null);
  assert.equal(h.state.cleared, 0);
  assert.deepEqual(h.state.openedWorkspaces, []);
  assert.equal(h.dialog(), null);
});

test("leaving a global panel above a conversation opens Home in that Workspace", () => {
  const h = harness(); h.state.panel = "tasks";
  h.mobileBack();
  assert.equal(h.state.workspace, "workspace-1");
  assert.equal(h.state.session, "blank-workspace-1");
  assert.equal(h.state.panel, null);
  assert.equal(h.state.cleared, 0);
});

test("failed Workspace connection keeps the conversation and does not confirm exit", async () => {
  const h = harness();
  h.workspace.openWorkspace = async () => { throw new Error("host refused"); };
  h.mobileBack(); await Promise.resolve();
  assert.equal(h.state.session, "session-1");
  assert.equal(h.state.workspace, "workspace-1");
  assert.equal(h.state.cleared, 0);
  assert.equal(h.dialog(), null);
});

test("an unavailable Workspace navigation API does not discard its selection", () => {
  const h = harness(); delete h.workspace.openWorkspace;
  h.mobileBack();
  assert.equal(h.state.session, "session-1");
  assert.equal(h.state.cleared, 0);
  assert.equal(h.state.toasts.length, 1);
});

test("sessions without a Workspace still return to Home", () => {
  const h = harness(); h.state.workspace = "";
  h.mobileBack();
  assert.equal(h.state.session, "");
  assert.equal(h.state.cleared, 1);
});


test("the exit confirmation is a bottom sheet with a keyboard-only focus ring (#133)", () => {
  // The dialog is the screen a phone user meets at Home, so its layout is part
  // of this flow. The rule lives in the mobile sheet, which is the only sheet
  // that carries it: a desktop keeps the stock centred dialog.
  const phoneAt = source.indexOf("const CSS_PHONE = " + String.fromCharCode(96));
  const phoneEnd = source.indexOf(String.fromCharCode(96) + ";\n", phoneAt);
  assert.ok(phoneAt > 0 && phoneEnd > phoneAt, "the phone sheet exists");
  const phone = source.slice(phoneAt, phoneEnd);
  const at = phone.indexOf(".rdsh-mux-exit {");
  assert.ok(at > 0, "the exit rule is in the phone sheet");
  const block = phone.slice(at, phone.indexOf(".rdsh-mux-exit::backdrop"));
  assert.match(block, /inset: auto 0 0 0/, "the sheet is anchored to the bottom edge");
  assert.match(block, /max-height: calc\(100svh/, "the sheet's height is capped");
  assert.match(block, /overflow-y: auto/, "a tall message scrolls inside the sheet");
  assert.match(block, /env\(safe-area-inset-bottom/, "the home-indicator strip is padded");
  assert.match(phone, /\.rdsh-mux-exit button:focus-visible \{/, "the ring is keyboard-only");
  assert.match(phone, /\.rdsh-mux-exit button:focus \{ outline: none; \}/, "focus alone paints no ring");
  assert.ok(!source.slice(source.indexOf("const CSS_DEVICE"), phoneAt).includes("rdsh-mux-exit"),
    "the desktop half of the sheet carries no exit rule");
});



test("only the presented-file card gives up text selection (#138)", () => {
  // The card owns a long press: the system's selection and the iOS callout
  // ("Copy", "Look Up") must not fight it. Everything else in the transcript
  // keeps the stock selection, so the rule is scoped to the card and its
  // children, and lives in the phone sheet only.
  const phoneAt = source.indexOf("const CSS_PHONE = " + String.fromCharCode(96));
  const phoneEnd = source.indexOf(String.fromCharCode(96) + ";\n", phoneAt);
  assert.ok(phoneAt > 0 && phoneEnd > phoneAt, "the phone sheet exists");
  const phone = source.slice(phoneAt, phoneEnd);
  assert.match(phone, /\[data-presented-file\],\n  \[data-presented-file\] \* \{/, "the card and its children are exempt");
  assert.match(phone, /\[data-presented-file\] \*\s*\{[^}]*user-select: none !important/, "children cannot be selected");
  assert.match(phone, /-webkit-touch-callout: none !important/, "the iOS callout is suppressed");
  const desktop = source.slice(source.indexOf("const CSS_DEVICE"), phoneAt);
  assert.ok(!desktop.includes("data-presented-file"), "a desktop keeps the stock selection");
});
