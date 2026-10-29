/**
 * #98: one device must not accumulate push endpoints.
 *
 * Every push is delivered to the endpoint it was sent to, and the service
 * worker has to show every push it receives (WebKit revokes a subscription
 * after silent pushes). A registration the browser replaced is unreachable
 * from the page but still reaches the same phone, so a store that keeps it
 * turns one foreground event into a banner plus a system notification. These
 * tests pin the explicit endpoint a browser names as its previous one
 * and the multi-device rules that must survive it: an endpoint is one
 * browser registration, while an origin is shared by every device using it.
 *
 * The route tests drive the real handlers and the real store; only `fetch` is
 * stubbed, as in notifications-issues.test.mjs.
 */

import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { applyNotify, PushStore, toBase64Url } from "../notify/host.js";

const ORIGIN_A = "https://app.example:8444";
const ORIGIN_B = "https://app.example:8446";
const LABEL_PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile";
const LABEL_TABLET = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Mobile";
const DAY_MS = 24 * 60 * 60 * 1000;

const SUBSCRIBE = "/api/dsh-mobile-maxxing/push/subscribe";
const ACK = "/api/dsh-mobile-maxxing/push/ack";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A browser-shaped subscription: P-256 point plus 16-byte auth secret. */
function subscription(endpoint) {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	return {
		endpoint,
		keys: { p256dh: toBase64Url(ecdh.getPublicKey()), auth: toBase64Url(randomBytes(16)) },
	};
}

/** Remove only the throwaway directory this file created with `mkdtemp`. */
function removeTemporaryHome(home) {
	try {
		if (typeof home !== "string" || home === "") return;
		const root = realpathSync(tmpdir());
		const target = realpathSync(home);
		if (dirname(target) !== root) return;
		if (!basename(target).startsWith("rdsh-endpoints-")) return;
		if (!lstatSync(target).isDirectory()) return;
		rmSync(target, { recursive: true, force: true });
	} catch {
		/* already removed, or never created */
	}
}

/** Run one test against its own DSH_HOME and push store. */
function withHome(run) {
	return async () => {
		const home = mkdtempSync(join(tmpdir(), "rdsh-endpoints-"));
		const previous = process.env.DSH_HOME;
		process.env.DSH_HOME = home;
		const file = join(home, "dsh-mobile-maxxing", "push.json");
		mkdirSync(dirname(file), { recursive: true });
		try {
			await run(file, home);
		} finally {
			if (previous === undefined) delete process.env.DSH_HOME;
			else process.env.DSH_HOME = previous;
			removeTemporaryHome(home);
		}
	};
}

/** Backdate one stored entry, as an untouched registration would look. */
function age(file, endpoint, days) {
	const store = new PushStore(file);
	const item = store.subscriptions().find((entry) => entry.endpoint === endpoint);
	assert.ok(item !== undefined, `${endpoint} is not stored`);
	item.addedAt = Date.now() - days * DAY_MS;
	store.save();
}

const endpoints = (file) => new PushStore(file).subscriptions().map((item) => item.endpoint);

// ---------------------------------------------------------------------------
// Store: the previous endpoint of this browser
// ---------------------------------------------------------------------------

test("a re-subscribe retires the endpoint this browser replaced", withHome(async (file) => {
	const store = new PushStore(file);
	const old = subscription("https://web.push.apple.com/phone-old");
	const live = subscription("https://web.push.apple.com/phone-new");

	store.add(old, { label: LABEL_PHONE, origin: ORIGIN_A });
	// The page names its own previous endpoint; the store ends up with one.
	assert.equal(store.add(live, { label: LABEL_PHONE, origin: ORIGIN_A, previousEndpoint: old.endpoint }), 1);
	assert.deepEqual(endpoints(file), [live.endpoint], "the replaced registration is still a fan-out target");
}));

test("a previous endpoint belonging to another origin is left alone", withHome(async (file) => {
	const store = new PushStore(file);
	const otherApp = subscription("https://web.push.apple.com/other-app");
	const live = subscription("https://web.push.apple.com/phone-new");

	store.add(otherApp, { label: LABEL_PHONE, origin: ORIGIN_A });
	// Origins are shared across deployments of the same host: a cleanup for
	// one app must never retire the other app's live registration.
	store.add(live, { label: LABEL_PHONE, origin: ORIGIN_B, previousEndpoint: otherApp.endpoint });
	assert.deepEqual(endpoints(file).sort(), [otherApp.endpoint, live.endpoint].sort());
}));

test("another device on the same origin keeps its registration", withHome(async (file) => {
	const store = new PushStore(file);
	const phoneOld = subscription("https://web.push.apple.com/phone-old");
	const tablet = subscription("https://web.push.apple.com/tablet");
	const phoneNew = subscription("https://web.push.apple.com/phone-new");

	store.add(phoneOld, { label: LABEL_PHONE, origin: ORIGIN_A });
	store.add(tablet, { label: LABEL_TABLET, origin: ORIGIN_A });
	// Both devices use the same origin; only the endpoint the phone itself
	// held last goes away.
	store.add(phoneNew, { label: LABEL_PHONE, origin: ORIGIN_A, previousEndpoint: phoneOld.endpoint });
	assert.deepEqual(endpoints(file).sort(), [phoneNew.endpoint, tablet.endpoint].sort());
}));

test("two devices with the same user agent are both kept", withHome(async (file) => {
	const store = new PushStore(file);
	const first = subscription("https://web.push.apple.com/first");
	const second = subscription("https://web.push.apple.com/second");

	// Identical labels are possible (two phones on one iOS version), so the
	// label is not an identity: only a named previous endpoint removes
	// another entry during registration.
	store.add(first, { label: LABEL_PHONE, origin: ORIGIN_A });
	store.add(second, { label: LABEL_PHONE, origin: ORIGIN_A, previousEndpoint: first.endpoint });
	assert.deepEqual(endpoints(file), [second.endpoint]);

	// A re-subscribe that names nothing keeps what is already live.
	store.add(first, { label: LABEL_PHONE, origin: ORIGIN_A, previousEndpoint: "" });
	assert.deepEqual(endpoints(file).sort(), [first.endpoint, second.endpoint].sort());
}));

test("re-registering the same endpoint stores it once", withHome(async (file) => {
	const store = new PushStore(file);
	const live = subscription("https://web.push.apple.com/phone");
	store.add(live, { label: LABEL_PHONE, origin: ORIGIN_A });
	// A launch-time re-register names its own endpoint; that must not delete
	// the registration it is refreshing.
	assert.equal(store.add(live, { label: LABEL_PHONE, origin: ORIGIN_A, previousEndpoint: live.endpoint }), 1);
	assert.deepEqual(endpoints(file), [live.endpoint]);
}));

// ---------------------------------------------------------------------------
// Store: inactive devices and capacity
// ---------------------------------------------------------------------------

test("an inactive device with the same user agent is not retired", withHome(async (file) => {
	const store = new PushStore(file);
	const leftover = subscription("https://web.push.apple.com/left-behind");
	const live = subscription("https://web.push.apple.com/phone");
	store.add(leftover, { label: LABEL_PHONE, origin: ORIGIN_A });
	age(file, leftover.endpoint, 8);
	// A different phone may have the same user agent and not open for a week.
	store.add(live, { label: LABEL_PHONE, origin: ORIGIN_A, previousEndpoint: "" });
	assert.deepEqual(endpoints(file).sort(), [leftover.endpoint, live.endpoint].sort());
}));

test("registration keeps other devices and origins", withHome(async (file) => {
	const store = new PushStore(file);
	const otherDevice = subscription("https://web.push.apple.com/other-device");
	const otherApp = subscription("https://web.push.apple.com/other-app");
	const live = subscription("https://web.push.apple.com/phone");

	store.add(otherDevice, { label: LABEL_PHONE, origin: ORIGIN_A });
	store.add(otherApp, { label: LABEL_PHONE, origin: ORIGIN_B });
	age(file, otherApp.endpoint, 8);
	store.add(live, { label: LABEL_PHONE, origin: ORIGIN_A });

	assert.deepEqual(
		endpoints(file).sort(),
		[otherDevice.endpoint, otherApp.endpoint, live.endpoint].sort(),
		"an entry that is fresh, or belongs to another app, was pruned",
	);
}));

test("a legacy entry without an origin is not pruned by registration", withHome(async (file) => {
	const store = new PushStore(file);
	const legacy = subscription("https://web.push.apple.com/legacy");
	const live = subscription("https://web.push.apple.com/phone");
	// An entry written before origins were recorded cannot be attributed, so
	// nothing may claim it is stale; 404/410 is what retires those.
	store.add(legacy, { label: LABEL_PHONE });
	age(file, legacy.endpoint, 30);
	store.add(live, { label: LABEL_PHONE, origin: ORIGIN_A });
	assert.deepEqual(endpoints(file).sort(), [legacy.endpoint, live.endpoint].sort());
}));

test("at capacity a new device is rejected without evicting existing devices", withHome(async (file) => {
	const store = new PushStore(file);
	for (let i = 0; i < 32; i++) store.add(subscription(`https://web.push.apple.com/${i}`), { label: LABEL_PHONE, origin: ORIGIN_A });
	const before = endpoints(file);
	assert.throws(() => store.add(subscription("https://web.push.apple.com/new"), { label: LABEL_PHONE, origin: ORIGIN_A }), /subscription limit/);
	assert.deepEqual(endpoints(file), before);
	store.add(subscription("https://web.push.apple.com/new"), { label: LABEL_PHONE, origin: ORIGIN_A, previousEndpoint: before[0] });
	assert.equal(endpoints(file).length, 32);
	assert.equal(endpoints(file).includes(before[0]), false);
}));

// ---------------------------------------------------------------------------
// Routes: subscribe + fan-out
// ---------------------------------------------------------------------------

/**
 * One plugin process: its routes, its listeners and an agent to notify.
 * `fetch` is replaced by the caller so no real push leaves the process.
 */
function makeInstance() {
	const listeners = new Map();
	const routes = new Map();
	const agent = { id: "s1", header: { cwd: "/tmp/qa" }, session: { id: "s1", header: { cwd: "/tmp/qa" } } };
	const agents = { get: (id) => (id === "s1" ? agent : undefined), roots: () => [agent] };
	const services = {
		agents,
		connection: { requestRejection: () => undefined },
		webServer: {
			register(route) {
				routes.set(route.path, route);
				return () => routes.delete(route.path);
			},
			tapIndex() {
				return () => {};
			},
			getOrigin: () => "http://127.0.0.1:3207",
		},
	};
	const scope = {
		...services,
		get: (name) => services[name],
		on(event, handler) {
			listeners.set(event, handler);
			return () => listeners.delete(event);
		},
		effect(fn) {
			const dispose = fn();
			return typeof dispose === "function" ? dispose : () => {};
		},
	};
	const ctx = {
		inject(deps, callback) {
			return callback(scope);
		},
		get: (name) => services[name],
		on(event, handler) {
			listeners.set(event, handler);
			return () => {};
		},
		effect(fn) {
			return scope.effect(fn);
		},
	};
	applyNotify(ctx, { onlyMobileTurns: false }, { transport: (...args) => globalThis.fetch(...args) });
	return { listeners, routes };
}

/** Call one registered route with a browser origin, as the page does. */
async function post(instance, path, body, origin = ORIGIN_A) {
	const req = Readable.from([Buffer.from(JSON.stringify(body))]);
	req.method = "POST";
	req.url = path;
	req.headers = { origin };
	let status = 0;
	let text = "";
	await instance.routes.get(path).handler(req, {
		writeHead(code) {
			status = code;
		},
		end(chunk) {
			if (typeof chunk === "string") text += chunk;
		},
	});
	return { status, json: text === "" ? null : JSON.parse(text) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 1600));

/** Record every push endpoint the host POSTs to. */
function withFetch() {
	const previous = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		return { status: 201, ok: true };
	};
	return { calls, restore: () => { globalThis.fetch = previous; } };
}

test("a foreground turn reaches no endpoint once the stale ones are retired", withHome(async () => {
	const instance = makeInstance();
	const origin = ORIGIN_A;
	const old1 = subscription("https://web.push.apple.com/old-1");
	const old2 = subscription("https://web.push.apple.com/old-2");
	const live = subscription("https://web.push.apple.com/live");

	await post(instance, SUBSCRIBE, { subscription: old1, label: LABEL_PHONE, origin });
	// Chain: each registration names the one it replaced, as a page that kept
	// its endpoint in localStorage does after a rotation.
	await post(instance, SUBSCRIBE, { subscription: old2, label: LABEL_PHONE, origin, previousEndpoint: old1.endpoint });
	const saved = await post(instance, SUBSCRIBE, { subscription: live, label: LABEL_PHONE, origin, previousEndpoint: old2.endpoint });
	assert.equal(saved.json.count, 1, "the same device stored more than one endpoint");

	const recorder = withFetch();
	try {
		instance.listeners.get("session/event")({ id: "s1", header: { cwd: "/tmp/qa" } }, { type: "turn/end", data: { reason: { kind: "completed" } } });
		const ack = await post(instance, ACK, { endpoint: live.endpoint, sessionId: "s1", kind: "turn-end", origin });
		assert.equal(ack.json.acknowledged, true, "the visible page's acknowledgement was not accepted");
		await settle();
		assert.deepEqual(recorder.calls, [], "a retired endpoint of this device still received a push");
	} finally {
		recorder.restore();
	}
}));

test("two devices on one origin both receive a turn; one ACK skips one endpoint", withHome(async () => {
	const instance = makeInstance();
	const origin = ORIGIN_A;
	const phone = subscription("https://web.push.apple.com/phone");
	const tablet = subscription("https://web.push.apple.com/tablet");

	// Different devices, same origin. An acknowledgement is per endpoint, so
	// the phone's banner must not silence the tablet.
	await post(instance, SUBSCRIBE, { subscription: phone, label: LABEL_PHONE, origin });
	await post(instance, SUBSCRIBE, { subscription: tablet, label: LABEL_TABLET, origin });

	const recorder = withFetch();
	try {
		instance.listeners.get("session/event")({ id: "s1", header: { cwd: "/tmp/qa" } }, { type: "turn/end", data: { reason: { kind: "completed" } } });
		const ack = await post(instance, ACK, { endpoint: phone.endpoint, sessionId: "s1", kind: "turn-end", origin });
		assert.equal(ack.json.acknowledged, true);
		await settle();
		assert.deepEqual(recorder.calls, [tablet.endpoint], "the other device on the same origin lost its push");
	} finally {
		recorder.restore();
	}
}));
