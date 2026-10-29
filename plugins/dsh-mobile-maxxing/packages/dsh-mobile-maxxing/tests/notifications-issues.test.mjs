/**
 * Behavioural regression tests for the notification issues #27 and #28.
 *
 * The setup is deliberately the awkward one: two DSH processes share one
 * `DSH_HOME` (therefore one `push.json`) and serve two different origins.
 * Every test drives the real route handlers and the real `PushStore`; only
 * `fetch` is stubbed, so the assertions are about routing and pruning, not
 * about the Web Push wire format (that lives in notify.test.mjs).
 * The writes are sequential: a concurrent read-modify-write race between two
 * processes is a documented risk and is not asserted to be safe here.
 *
 * The last block loads `sw.js` in a `node:vm` sandbox with a fake CacheStorage
 * to pin the assumptions behind "the two apps' caches cannot interfere":
 * CacheStorage is per origin, and the worker only touches its own origin.
 *
 * #27 settled the unknown-origin question in favour of dropping the push:
 * an event with no origin of its own goes to the newest origin this process
 * has learned, and nowhere when it has learned none. The tests pin that,
 * including the explicit log that makes the drop observable, and cover #28's
 * requirement that a session opened in both apps is notified once.
 */

import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import vm from "node:vm";
import { applyNotify, PushStore, toBase64Url } from "../notify/host.js";

const NEW_ORIGIN = "https://app.example:8446";
const OLD_ORIGIN = "https://app.example:8444";
const INTERNAL_ORIGIN = "http://127.0.0.1:3207";
const WAIT_MS = 1550;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Remove only a throwaway directory this test file created with `mkdtemp`.
 *
 * `rmSync` is recursive, so verify the target twice before touching it: the
 * resolved directory must sit directly under the OS tmpdir and keep the
 * `rdsh-issues-notify-` prefix `mkdtemp` generated. Anything else (a user
 * directory, a symlinked path, a vanished temp dir) is left alone.
 */
function removeTemporaryHome(home) {
	try {
		if (typeof home !== "string" || home === "") return;
		const root = realpathSync(tmpdir());
		const target = realpathSync(home);
		if (dirname(target) !== root) return;
		if (!basename(target).startsWith("rdsh-issues-notify-")) return;
		if (!lstatSync(target).isDirectory()) return;
		rmSync(target, { recursive: true, force: true });
	} catch {
		/* already removed, or never created: nothing to clean */
	}
}

/** A throwaway home with an empty push store; the env and directory go after. */
function withHome(run) {
	return async () => {
		const home = mkdtempSync(join(tmpdir(), "rdsh-issues-notify-"));
		const previous = process.env.DSH_HOME;
		process.env.DSH_HOME = home;
		try {
			await run(home, join(home, "dsh-mobile-maxxing", "push.json"));
		} finally {
			if (previous === undefined) delete process.env.DSH_HOME;
			else process.env.DSH_HOME = previous;
			removeTemporaryHome(home);
		}
	};
}

/** A browser-shaped subscription for one push endpoint. */
function subscription(endpoint) {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	return {
		endpoint,
		keys: { p256dh: toBase64Url(ecdh.getPublicKey()), auth: toBase64Url(randomBytes(16)) },
	};
}

/** A seed subscription already stored under one origin. */
function seed(file, endpoint, origin) {
	const store = new PushStore(file);
	store.add(subscription(endpoint), { label: "seed", origin });
	return store;
}

/**
 * One plugin process: its own routes, listeners and learned-origin list, all
 * reading the shared state file through `DSH_HOME`.
 */
function makeInstance({ getOrigin = INTERNAL_ORIGIN, config = {}, rejection = undefined, profileName = undefined } = {}) {
	const listeners = new Map();
	const routes = new Map();
	const agentsById = new Map();
	const roots = [];
	const agents = {
		get: (id) => agentsById.get(id),
		roots: () => roots,
	};
	const services = {
		agents,
		profileContext: profileName === undefined ? undefined : { name: profileName },
		connection: { requestRejection: () => rejection },
		webServer: {
			register(route) {
				routes.set(route.path, route);
				return () => routes.delete(route.path);
			},
			tapIndex() {
				return () => {};
			},
			getOrigin: () => getOrigin,
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
		effect: (fn) => scope.effect(fn),
	};
	const api = applyNotify(ctx, { onlyMobileTurns: true, ...config }, { transport: (...args) => globalThis.fetch(...args) });
	return {
		fanOut: api.fanOut,
		listeners,
		routes,
		addRoot(id) {
			const agent = { id, header: { cwd: "/tmp/qa" }, session: { id, header: { cwd: "/tmp/qa" } } };
			agentsById.set(id, agent);
			roots.push(agent);
			return agent;
		},
	};
}

/** Call one registered route with an optional browser origin. */
async function request(instance, path, { method = "POST", body, origin, referer } = {}) {
	const route = instance.routes.get(path);
	assert.ok(route !== undefined, `${path} is registered`);
	const text = body === undefined ? "" : JSON.stringify(body);
	const req = Readable.from(text === "" ? [] : [Buffer.from(text)]);
	req.method = method;
	req.url = path;
	req.headers = {};
	if (origin !== undefined) req.headers.origin = origin;
	if (referer !== undefined) req.headers.referer = referer;
	let status = 0;
	let responseBody = "";
	await route.handler(req, {
		writeHead(code) {
			status = code;
		},
		end(chunk) {
			if (typeof chunk === "string") responseBody += chunk;
		},
	});
	let json = null;
	try {
		json = responseBody === "" ? null : JSON.parse(responseBody);
	} catch {
		/* the status is what matters when a route answers plain text */
	}
	return { status, json };
}

/** Let the fire-and-forget `fanOut` promises settle. */
function settle() {
	return new Promise((resolve) => setTimeout(resolve, WAIT_MS));
}

/** Fire the plugin's session event for a turn. */
function turn(instance, id, type) {
	const listener = instance.listeners.get("session/event");
	assert.ok(listener !== undefined, "the session listener is mounted");
	listener({ id }, { type, data: { reason: { kind: "completed" } } });
	if (type === "turn/start") listener({ id }, { type: "user/message", data: { source: { rpcId: "mobile-test-id" } } });
}

/** Fire the plugin's question listener. */
function question(instance, id) {
	const listener = instance.listeners.get("user-questions/request");
	assert.ok(listener !== undefined, "the question listener is mounted");
	listener({
		agent: { id, session: { id, header: { cwd: "/tmp/qa" } } },
		questions: [{ header: "Confirm", question: "Continue?" }],
	}, () => {});
}

/** Replace global fetch and record every push endpoint it is asked to hit. */
function withFetch(handler) {
	const previous = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url) => {
		const target = String(url);
		calls.push(target);
		return handler(target);
	};
	return { calls, restore: () => { globalThis.fetch = previous; } };
}

// ---------------------------------------------------------------------------
// #28: two stores, one DSH_HOME
// ---------------------------------------------------------------------------

test("sequential writes from independent stores preserve existing subscriptions", withHome(async (home, file) => {
	// Two store instances alternate writes over the same file. This covers the
	// sequential interleaving that reload-before-save handles; it does NOT
	// claim two processes writing concurrently are safe. The read-modify-write
	// window between another process's reload and save is a documented risk,
	// not something this test can rule out.
	mkdirSync(dirname(file), { recursive: true });
	const first = new PushStore(file);
	const second = new PushStore(file);

	const phone = subscription("https://web.push.apple.com/phone");
	const old = subscription("https://web.push.apple.com/old");
	const desktop = subscription("https://web.push.apple.com/desktop");

	first.add(phone, { origin: NEW_ORIGIN });
	second.add(old, { origin: OLD_ORIGIN });
	// Re-reading before the third write is what keeps the second store's
	// entry: a blind save would drop it.
	first.add(desktop, { origin: NEW_ORIGIN });

	assert.deepEqual(
		second.subscriptions().map((item) => item.endpoint).sort(),
		[phone.endpoint, old.endpoint, desktop.endpoint].sort(),
		"a later write erased a subscription the other store had written",
	);
	assert.equal(
		first.keys().publicKey,
		second.keys().publicKey,
		"the shared store must present one VAPID key to every instance",
	);

	// Removing through one store is visible to the other without a restart.
	second.remove(old.endpoint);
	assert.deepEqual(
		first.subscriptions().map((item) => item.endpoint).sort(),
		[phone.endpoint, desktop.endpoint].sort(),
		"a removal made by the other store was not picked up",
	);
	assert.equal(home, process.env.DSH_HOME, "the test ran against its throwaway home");
}));

test("a subscribe without body.origin falls back to the request origin", withHome(async (home, file) => {
	mkdirSync(dirname(file), { recursive: true });
	const newApp = makeInstance();
	const oldApp = makeInstance();
	const phone = subscription("https://web.push.apple.com/phone");
	const old = subscription("https://web.push.apple.com/old");

	// Defensive fallback, not a known client regression: every current and
	// known legacy client sends `body.origin`. A hand-rolled request or a
	// future client that omits it still has the browser's Origin header, so
	// the entry stays addressable by origin-scoped routing.
	assert.equal(
		(await request(newApp, "/api/dsh-mobile-maxxing/push/subscribe", { body: { subscription: phone, label: "phone" }, origin: NEW_ORIGIN })).status,
		200,
	);
	assert.equal(
		(await request(oldApp, "/api/dsh-mobile-maxxing/push/subscribe", { body: { subscription: old, label: "old" }, origin: OLD_ORIGIN })).status,
		200,
	);

	const stored = new PushStore(file).subscriptions();
	assert.deepEqual(
		stored.map((item) => [item.endpoint, item.origin]).sort(),
		[[phone.endpoint, NEW_ORIGIN], [old.endpoint, OLD_ORIGIN]].sort(),
		"an origin-less subscribe was stored as a legacy, unroutable entry",
	);

	const fetchRecorder = withFetch(() => ({ status: 201, ok: true }));
	try {
		fetchRecorder.calls.length = 0;
		assert.equal((await request(newApp, "/api/dsh-mobile-maxxing/push/test", { body: {}, origin: NEW_ORIGIN })).status, 200);
		await settle();
		assert.deepEqual(fetchRecorder.calls, [phone.endpoint], "the new app's test push reached the wrong app or none");

		fetchRecorder.calls.length = 0;
		assert.equal((await request(oldApp, "/api/dsh-mobile-maxxing/push/test", { body: {}, origin: OLD_ORIGIN })).status, 200);
		await settle();
		assert.deepEqual(fetchRecorder.calls, [old.endpoint], "the old app's test push reached the wrong app or none");

		// A process that has seen no request has no origin to target. Since #27
		// it must not fan out to every stored subscription: that is the double
		// notification both installed apps would show. It reports the drop
		// instead of pretending the push was delivered.
		const coldApp = makeInstance();
		fetchRecorder.calls.length = 0;
		const coldPush = await request(coldApp, "/api/dsh-mobile-maxxing/push/test", { body: {} });
		await settle();
		assert.equal(coldPush.status, 200);
		assert.equal(coldPush.json.ok, false, "an undeliverable test push reported success");
		assert.equal(coldPush.json.reason, "no-origin", "the drop did not name its reason");
		assert.deepEqual(fetchRecorder.calls, [], "an unknown origin was fanned out to every subscription");
	} finally {
		fetchRecorder.restore();
	}
	assert.equal(home, process.env.DSH_HOME);
}));

test("an explicit body.origin wins over a proxy's inner request origin", withHome(async (home, file) => {
	mkdirSync(dirname(file), { recursive: true });
	const app = makeInstance();
	const phone = subscription("https://web.push.apple.com/phone");

	// A reverse proxy (or the host's own --public-url setup) can present the
	// inner http origin in Origin/Referer while the page still reports the
	// public https origin in the body. Overwriting the body with the header
	// would store the wrong owner and misroute later pushes.
	const registered = await request(app, "/api/dsh-mobile-maxxing/push/subscribe", {
		body: { subscription: phone, label: "proxy", origin: NEW_ORIGIN },
		origin: INTERNAL_ORIGIN,
	});
	assert.equal(registered.status, 200);

	const stored = new PushStore(file).subscriptions();
	assert.deepEqual(
		stored.map((item) => [item.endpoint, item.origin]),
		[[phone.endpoint, NEW_ORIGIN]],
		"the inner proxy origin overwrote the page's public origin",
	);

	const fetchRecorder = withFetch(() => ({ status: 201, ok: true }));
	try {
		assert.equal((await request(app, "/api/dsh-mobile-maxxing/push/test", { body: {}, origin: NEW_ORIGIN })).status, 200);
		await settle();
		assert.deepEqual(fetchRecorder.calls, [phone.endpoint], "the public-origin test push could not find the subscription");
	} finally {
		fetchRecorder.restore();
	}
	assert.equal(home, process.env.DSH_HOME);
}));

test("a new subscription with a non-canonical origin still receives exact-origin pushes", withHome(async (home, file) => {
	mkdirSync(dirname(file), { recursive: true });
	const app = makeInstance();
	const slash = subscription("https://web.push.apple.com/slash-new");
	const defaultPort = subscription("https://web.push.apple.com/default-port-new");

	// The body origin is valid but not canonical (`/` or an explicit `:443`).
	// Storing it verbatim would miss exact-origin routing, which compares
	// against the request's normalized URL.origin.
	assert.equal(
		(await request(app, "/api/dsh-mobile-maxxing/push/subscribe", {
			body: { subscription: slash, label: "slash", origin: `${NEW_ORIGIN}/` },
			origin: INTERNAL_ORIGIN,
		})).status,
		200,
	);
	assert.equal(
		(await request(app, "/api/dsh-mobile-maxxing/push/subscribe", {
			body: { subscription: defaultPort, label: "port", origin: "https://app.example:443" },
			origin: INTERNAL_ORIGIN,
		})).status,
		200,
	);

	assert.deepEqual(
		new PushStore(file).subscriptions().map((item) => [item.endpoint, item.origin]).sort(),
		[[slash.endpoint, NEW_ORIGIN], [defaultPort.endpoint, "https://app.example"]].sort(),
		"a non-canonical origin was stored verbatim",
	);

	const fetchRecorder = withFetch(() => ({ status: 201, ok: true }));
	try {
		assert.equal((await request(app, "/api/dsh-mobile-maxxing/push/test", { body: {}, origin: NEW_ORIGIN })).status, 200);
		await settle();
		assert.deepEqual(fetchRecorder.calls, [slash.endpoint], "the trailing-slash subscription was not delivered to");

		fetchRecorder.calls.length = 0;
		assert.equal((await request(app, "/api/dsh-mobile-maxxing/push/test", { body: {}, origin: "https://app.example" })).status, 200);
		await settle();
		assert.deepEqual(fetchRecorder.calls, [defaultPort.endpoint], "the :443 subscription was not delivered to");
	} finally {
		fetchRecorder.restore();
	}

	// An origin that cannot be parsed is kept as text for compatibility.
	const unusual = subscription("https://web.push.apple.com/unusual");
	new PushStore(file).add(unusual, { origin: "not an origin" });
	assert.equal(
		new PushStore(file).subscriptions().find((item) => item.endpoint === unusual.endpoint).origin,
		"not an origin",
		"an unparsable origin was rewritten or dropped",
	);
	assert.equal(home, process.env.DSH_HOME);
}));

// ---------------------------------------------------------------------------
// #27: startup before config, learned origins, no all-subscriptions fallback
// ---------------------------------------------------------------------------

test("an event with no origin of its own reaches only the newest app, never all of them", withHome(async (home, file) => {
	mkdirSync(dirname(file), { recursive: true });
	const phone = subscription("https://web.push.apple.com/phone");
	const old = subscription("https://web.push.apple.com/old");
	seed(file, phone.endpoint, NEW_ORIGIN);
	seed(file, old.endpoint, OLD_ORIGIN);

	const app = makeInstance();
	app.addRoot("session-1");
	const warnings = [];
	const previousWarn = console.warn;
	console.warn = (...args) => warnings.push(args.map(String).join(" "));
	const fetchRecorder = withFetch(() => ({ status: 201, ok: true }));
	try {
		// Nothing has told this process which app it serves: the question is
		// dropped (#27), and the log is the only signal that it happened.
		question(app, "session-1");
		await settle();
		assert.deepEqual(fetchRecorder.calls, [], "an unknown origin was fanned out to every app");
		assert.match(warnings.join("\n"), /push skipped: no app origin/, "the drop was silent");

		// The first app to talk to the process becomes the target.
		assert.equal((await request(app, "/api/dsh-mobile-maxxing/push/config", { method: "GET", origin: NEW_ORIGIN })).status, 200);
		fetchRecorder.calls.length = 0;
		question(app, "session-1");
		await settle();
		assert.deepEqual(fetchRecorder.calls, [phone.endpoint], "the learned origin did not scope the question");

		// Opening the other app on the same phone makes it the newest origin.
		// The question must go to that one app only: sending to both is the
		// duplicate system notification #28 is about.
		assert.equal((await request(app, "/api/dsh-mobile-maxxing/push/config", { method: "GET", origin: OLD_ORIGIN })).status, 200);
		fetchRecorder.calls.length = 0;
		question(app, "session-1");
		await settle();
		assert.deepEqual(fetchRecorder.calls, [old.endpoint], "the older learned origin also received the question");

		// Back to the unified app: the target follows the newest request, not
		// the order the subscriptions were stored in.
		assert.equal((await request(app, "/api/dsh-mobile-maxxing/push/config", { method: "GET", origin: NEW_ORIGIN })).status, 200);
		fetchRecorder.calls.length = 0;
		question(app, "session-1");
		await settle();
		assert.deepEqual(fetchRecorder.calls, [phone.endpoint], "the newest origin did not win");

		// The desktop browser talks to the same process but has no push
		// subscription. It must not become a dead target: the newest origin
		// that can actually receive the push is used instead.
		assert.equal((await request(app, "/api/dsh-mobile-maxxing/push/config", { method: "GET", origin: "http://127.0.0.1:3080" })).status, 200);
		fetchRecorder.calls.length = 0;
		question(app, "session-1");
		await settle();
		assert.deepEqual(fetchRecorder.calls, [phone.endpoint], "an origin without a subscription swallowed the push");

		// Origins are per process: a second process sharing DSH_HOME must not
		// inherit the first one's learned origins, and must not fall back to
		// every subscription either.
		const other = makeInstance();
		other.addRoot("session-1");
		fetchRecorder.calls.length = 0;
		question(other, "session-1");
		await settle();
		assert.deepEqual(fetchRecorder.calls, [], "one process adopted another process's origin");
	} finally {
		console.warn = previousWarn;
		fetchRecorder.restore();
	}
	assert.equal(home, process.env.DSH_HOME);
}));

test("restart restores only each profile's learned subscribed origin", withHome(async (_home, file) => {
	mkdirSync(dirname(file), { recursive: true });
	const phone = "https://web.push.apple.com/profile-a", other = "https://web.push.apple.com/profile-b";
	seed(file, phone, NEW_ORIGIN);
	seed(file, other, OLD_ORIGIN);
	const a = makeInstance({ profileName: "alpha" });
	const b = makeInstance({ profileName: "beta" });
	await request(a, "/api/dsh-mobile-maxxing/push/config", { method: "GET", origin: NEW_ORIGIN });
	await request(b, "/api/dsh-mobile-maxxing/push/config", { method: "GET", origin: OLD_ORIGIN });
	// An internal server URL can coincide with a subscription belonging to a different profile.
	const restartedA = makeInstance({ profileName: "alpha", getOrigin: OLD_ORIGIN });
	const restartedB = makeInstance({ profileName: "beta" });
	const unrelated = makeInstance({ profileName: "other" });
	const recorder = withFetch(() => ({ status: 201, ok: true }));
	try {
		assert.equal((await restartedA.fanOut({ kind: "test", title: "test" })).ok, true);
		assert.deepEqual(recorder.calls, [phone]);
		recorder.calls.length = 0;
		assert.equal((await restartedB.fanOut({ kind: "test", title: "test" })).ok, true);
		assert.deepEqual(recorder.calls, [other]);
		recorder.calls.length = 0;
		assert.equal((await unrelated.fanOut({ kind: "test", title: "test" })).reason, "no-origin");
		assert.deepEqual(recorder.calls, []);
		new PushStore(file).remove(phone, NEW_ORIGIN);
		const afterRemoval = makeInstance({ profileName: "alpha" });
		assert.equal((await afterRemoval.fanOut({ kind: "test", title: "test" })).reason, "no-origin");
	} finally { recorder.restore(); }
}));

test("request IDs prevent queued mobile sends from marking the running turn and survive restart", withHome(async (_home, file) => {
	mkdirSync(dirname(file), { recursive: true });
	const endpoint = "https://web.push.apple.com/queued";
	seed(file, endpoint, NEW_ORIGIN);
	const app = makeInstance({ profileName: "queued" });
	app.addRoot("session-1");
	const event = app.listeners.get("session/event");
	event({ id: "session-1" }, { type: "turn/start", data: { turn: 1 } });
	assert.equal((await request(app, "/api/dsh-mobile-maxxing/push/mobile-send", { body: { sessionId: "session-1", requestId: "queued-rpc" }, origin: NEW_ORIGIN })).status, 200);
	const recorder = withFetch(() => ({ status: 201, ok: true }));
	try {
		event({ id: "session-1" }, { type: "user/message", data: { source: { kind: "user", rpcId: "desktop-rpc" } } });
		event({ id: "session-1" }, { type: "turn/end", data: { reason: { kind: "completed" } } });
		await settle();
		assert.deepEqual(recorder.calls, [], "the unrelated running turn must not notify");
		const restarted = makeInstance({ profileName: "queued" });
		restarted.addRoot("session-1");
		const next = restarted.listeners.get("session/event");
		next({ id: "session-1" }, { type: "turn/start", data: { turn: 2 } });
		next({ id: "session-1" }, { type: "user/message", data: { source: { kind: "user", rpcId: "queued-rpc" } } });
		next({ id: "session-1" }, { type: "turn/end", data: { reason: { kind: "completed" } } });
		await settle();
		assert.deepEqual(recorder.calls, [endpoint], "only the matching queued request must notify");
	} finally { recorder.restore(); }
}));

test("legacy markers without a request ID are rejected instead of marking a later turn", withHome(async () => {
	const app = makeInstance({ profileName: "legacy" });
	assert.equal((await request(app, "/api/dsh-mobile-maxxing/push/mobile-send", { body: { sessionId: "session-1" }, origin: NEW_ORIGIN })).status, 400);
}));

test("a phone turn only notifies the app that started it, even with the other app configured", withHome(async (home, file) => {
	mkdirSync(dirname(file), { recursive: true });
	const phone = subscription("https://web.push.apple.com/phone");
	const old = subscription("https://web.push.apple.com/old");
	seed(file, phone.endpoint, NEW_ORIGIN);
	seed(file, old.endpoint, OLD_ORIGIN);

	const newApp = makeInstance();
	const oldApp = makeInstance();
	newApp.addRoot("session-1");
	oldApp.addRoot("session-1");
	await request(newApp, "/api/dsh-mobile-maxxing/push/config", { method: "GET", origin: NEW_ORIGIN });
	await request(oldApp, "/api/dsh-mobile-maxxing/push/config", { method: "GET", origin: OLD_ORIGIN });

	const fetchRecorder = withFetch(() => ({ status: 201, ok: true }));
	try {
		assert.equal(
			(await request(newApp, "/api/dsh-mobile-maxxing/push/mobile-send", { body: { sessionId: "session-1", requestId: "mobile-test-id" }, origin: NEW_ORIGIN })).status,
			200,
		);
		turn(newApp, "session-1", "turn/start");
		turn(newApp, "session-1", "turn/end");
		await settle();
		assert.deepEqual(fetchRecorder.calls, [phone.endpoint], "turn-end was pushed to the other app as well");

		// A question in that session keeps following the turn's origin.
		fetchRecorder.calls.length = 0;
		question(newApp, "session-1");
		await settle();
		assert.deepEqual(fetchRecorder.calls, [phone.endpoint], "the question did not follow the turn origin");

		// A desktop turn stays silent under the default onlyMobileTurns.
		fetchRecorder.calls.length = 0;
		turn(oldApp, "session-1", "turn/start");
		turn(oldApp, "session-1", "turn/end");
		await settle();
		assert.deepEqual(fetchRecorder.calls, [], "a desktop turn was notified even though onlyMobileTurns is true");
	} finally {
		fetchRecorder.restore();
	}
	assert.equal(home, process.env.DSH_HOME);
}));

// ---------------------------------------------------------------------------
// #28: unsubscribe and dead-subscription pruning
// ---------------------------------------------------------------------------

test("unsubscribe drops only that endpoint; 404/410 prune retired ones", withHome(async (home, file) => {
	mkdirSync(dirname(file), { recursive: true });
	const liveNew = subscription("https://web.push.apple.com/live-new");
	const liveOld = subscription("https://web.push.apple.com/live-old");
	const gone410 = subscription("https://web.push.apple.com/gone-410");
	const gone404 = subscription("https://web.push.apple.com/gone-404");
	seed(file, liveNew.endpoint, NEW_ORIGIN);
	seed(file, liveOld.endpoint, OLD_ORIGIN);
	seed(file, gone410.endpoint, NEW_ORIGIN);
	seed(file, gone404.endpoint, NEW_ORIGIN);

	const newApp = makeInstance();
	const oldApp = makeInstance();

	const fetchRecorder = withFetch((url) => {
		if (url.endsWith("/gone-410")) return { status: 410, ok: false };
		if (url.endsWith("/gone-404")) return { status: 404, ok: false };
		return { status: 201, ok: true };
	});
	try {
		// One app cannot retire the other app's subscription even if it names
		// the endpoint: the store is shared, so the delete is origin-scoped.
		const crossOrigin = await request(oldApp, "/api/dsh-mobile-maxxing/push/unsubscribe", {
			body: { endpoint: liveNew.endpoint },
			origin: OLD_ORIGIN,
		});
		assert.equal(crossOrigin.status, 200);
		assert.equal(crossOrigin.json.removed, false, "the old app deleted the new app's subscription");
		assert.equal(
			new PushStore(file).subscriptions().some((item) => item.endpoint === liveNew.endpoint),
			true,
			"a cross-origin unsubscribe pruned a live subscription",
		);

		// Unsubscribing the new app's own endpoint must leave the old app's
		// subscription untouched (they share one file).
		const removed = await request(newApp, "/api/dsh-mobile-maxxing/push/unsubscribe", {
			body: { endpoint: liveNew.endpoint },
			origin: NEW_ORIGIN,
		});
		assert.equal(removed.status, 200);
		assert.equal(removed.json.removed, true);
		assert.deepEqual(
			new PushStore(file).subscriptions().map((item) => item.endpoint).sort(),
			[liveOld.endpoint, gone410.endpoint, gone404.endpoint].sort(),
			"unsubscribe removed something other than the named endpoint",
		);

		// A push to a retired endpoint is the only signal the host gets when
		// an app is deleted without calling /unsubscribe. 404/410 must prune
		// that endpoint and still report the live one.
		const testPush = await request(newApp, "/api/dsh-mobile-maxxing/push/test", { body: {}, origin: NEW_ORIGIN });
		assert.equal(testPush.status, 200);
		await settle();
		assert.deepEqual(
			fetchRecorder.calls.sort(),
			[gone410.endpoint, gone404.endpoint].sort(),
			"the live new-app subscription is missing or the retired ones were skipped",
		);
		const statuses = (testPush.json.results ?? []).map((item) => item.status).sort((a, b) => a - b);
		assert.deepEqual(statuses, [404, 410], "the prune results do not surface the push-service status");
		assert.deepEqual(
			new PushStore(file).subscriptions().map((item) => item.endpoint).sort(),
			[liveOld.endpoint].sort(),
			"404/410 subscriptions were not pruned from the shared store",
		);

		// The other app still receives its own notification afterwards.
		fetchRecorder.calls.length = 0;
		assert.equal((await request(oldApp, "/api/dsh-mobile-maxxing/push/test", { body: {}, origin: OLD_ORIGIN })).status, 200);
		await settle();
		assert.deepEqual(fetchRecorder.calls, [liveOld.endpoint], "pruning in one app broke the other app's delivery");

		// A subscription written before origins existed must still be
		// removable, or an upgrade can never clean it up.
		const legacy = subscription("https://web.push.apple.com/legacy");
		new PushStore(file).add(legacy, {});
		const cleaned = await request(newApp, "/api/dsh-mobile-maxxing/push/unsubscribe", {
			body: { endpoint: legacy.endpoint },
			origin: NEW_ORIGIN,
		});
		assert.equal(cleaned.json.removed, true, "a legacy origin-less subscription can no longer be removed");
		assert.equal(new PushStore(file).subscriptions().some((item) => item.endpoint === legacy.endpoint), false);

		// Older entries may carry a trailing slash or an explicit default port.
		// Their own app must still be able to remove them; normalization must
		// not make a same-origin comparison fail.
		const slash = subscription("https://web.push.apple.com/slash");
		new PushStore(file).add(slash, { origin: `${NEW_ORIGIN}/` });
		const slashRemoved = await request(newApp, "/api/dsh-mobile-maxxing/push/unsubscribe", {
			body: { endpoint: slash.endpoint },
			origin: NEW_ORIGIN,
		});
		assert.equal(slashRemoved.json.removed, true, "a trailing-slash origin cannot remove its own subscription");

		const defaultPort = subscription("https://web.push.apple.com/default-port");
		new PushStore(file).add(defaultPort, { origin: "https://app.example:443" });
		const portRemoved = await request(newApp, "/api/dsh-mobile-maxxing/push/unsubscribe", {
			body: { endpoint: defaultPort.endpoint },
			origin: "https://app.example",
		});
		assert.equal(portRemoved.json.removed, true, "an explicit default port cannot remove its own subscription");

		// Normalization must not blur two different origins.
		const otherSlash = subscription("https://web.push.apple.com/other-slash");
		new PushStore(file).add(otherSlash, { origin: `${OLD_ORIGIN}/` });
		const crossSlash = await request(newApp, "/api/dsh-mobile-maxxing/push/unsubscribe", {
			body: { endpoint: otherSlash.endpoint },
			origin: NEW_ORIGIN,
		});
		assert.equal(crossSlash.json.removed, false, "normalizing a trailing slash crossed the origin boundary");
		assert.equal(new PushStore(file).subscriptions().some((item) => item.endpoint === otherSlash.endpoint), true);
	} finally {
		fetchRecorder.restore();
	}
	assert.equal(home, process.env.DSH_HOME);
}));

// ---------------------------------------------------------------------------
// #27/#28: one phone, two installed apps, one notification
// ---------------------------------------------------------------------------

test("a session opened in both apps is notified once per event", withHome(async (home, file) => {
	mkdirSync(dirname(file), { recursive: true });
	const phone = subscription("https://web.push.apple.com/phone");
	const old = subscription("https://web.push.apple.com/old");
	seed(file, phone.endpoint, NEW_ORIGIN);
	seed(file, old.endpoint, OLD_ORIGIN);

	// `onlyMobileTurns: false` is the profile that also notifies desktop
	// turns, so an event with no phone origin of its own is exactly where a
	// duplicate notification used to appear.
	const app = makeInstance({ config: { onlyMobileTurns: false } });
	app.addRoot("session-1");

	const fetchRecorder = withFetch(() => ({ status: 201, ok: true }));
	try {
		// One phone, two installed origins, both talking to this process.
		assert.equal((await request(app, "/api/dsh-mobile-maxxing/push/config", { method: "GET", origin: NEW_ORIGIN })).status, 200);
		assert.equal((await request(app, "/api/dsh-mobile-maxxing/push/config", { method: "GET", origin: OLD_ORIGIN })).status, 200);

		// A desktop-originated turn has no origin of its own. Two subscriptions
		// for one phone must still mean one notification.
		turn(app, "session-1", "turn/start");
		turn(app, "session-1", "turn/end");
		await settle();
		assert.deepEqual(fetchRecorder.calls, [old.endpoint], "one desktop turn was pushed to both apps");

		// The same session is opened in the unified app and a phone send starts
		// a turn: exactly that app's subscription is targeted.
		fetchRecorder.calls.length = 0;
		assert.equal(
			(await request(app, "/api/dsh-mobile-maxxing/push/mobile-send", { body: { sessionId: "session-1", requestId: "mobile-test-id" }, origin: NEW_ORIGIN })).status,
			200,
		);
		turn(app, "session-1", "turn/start");
		turn(app, "session-1", "turn/end");
		await settle();
		assert.deepEqual(fetchRecorder.calls, [phone.endpoint], "the turn reached the wrong app or both apps");

		// A question in the same session follows the turn's origin: the
		// specific signal beats the newest learned origin.
		fetchRecorder.calls.length = 0;
		question(app, "session-1");
		await settle();
		assert.deepEqual(fetchRecorder.calls, [phone.endpoint], "the question did not follow the turn origin");
	} finally {
		fetchRecorder.restore();
	}
	assert.equal(home, process.env.DSH_HOME);
}));

test("one endpoint stored twice is pushed to only once", withHome(async (home, file) => {
	mkdirSync(dirname(file), { recursive: true });
	seed(file, "https://web.push.apple.com/phone", NEW_ORIGIN);
	// An older host (or an interleaved write) can leave one registration in
	// the file twice. `PushStore.add` would collapse it, so write the duplicate
	// past the store to model that file.
	const state = JSON.parse(readFileSync(file, "utf8"));
	state.subscriptions = [
		state.subscriptions[0],
		{ ...state.subscriptions[0], addedAt: state.subscriptions[0].addedAt - 1000 },
	];
	writeFileSync(file, JSON.stringify(state, null, "\t"));

	const app = makeInstance();
	app.addRoot("session-1");
	const fetchRecorder = withFetch(() => ({ status: 201, ok: true }));
	try {
		assert.equal((await request(app, "/api/dsh-mobile-maxxing/push/config", { method: "GET", origin: NEW_ORIGIN })).status, 200);
		const push = await request(app, "/api/dsh-mobile-maxxing/push/test", { body: {}, origin: NEW_ORIGIN });
		await settle();
		assert.equal(push.status, 200);
		assert.deepEqual(fetchRecorder.calls, ["https://web.push.apple.com/phone"], "the duplicate endpoint was pushed twice");
		assert.equal((push.json.results ?? []).length, 1, "the duplicate endpoint was counted twice");
	} finally {
		fetchRecorder.restore();
	}
	assert.equal(home, process.env.DSH_HOME);
}));

test("a retired subscription is pruned while the other app keeps its own", withHome(async (home, file) => {
	mkdirSync(dirname(file), { recursive: true });
	const phone = subscription("https://web.push.apple.com/phone");
	const gone = subscription("https://web.push.apple.com/gone");
	const old = subscription("https://web.push.apple.com/old");
	seed(file, phone.endpoint, NEW_ORIGIN);
	seed(file, gone.endpoint, NEW_ORIGIN);
	seed(file, old.endpoint, OLD_ORIGIN);

	const app = makeInstance();
	app.addRoot("session-1");
	const previousWarn = console.warn;
	console.warn = () => {};
	const fetchRecorder = withFetch((url) => (url.endsWith("/gone") ? { status: 410, ok: false } : { status: 201, ok: true }));
	try {
		// The newest learned app is the unified one; its dead registration is
		// discovered by an ordinary event, not by an explicit test push.
		assert.equal((await request(app, "/api/dsh-mobile-maxxing/push/config", { method: "GET", origin: NEW_ORIGIN })).status, 200);
		question(app, "session-1");
		await settle();
		assert.deepEqual(
			fetchRecorder.calls.sort(),
			[gone.endpoint, phone.endpoint].sort(),
			"the retired endpoint of the learned app was skipped",
		);
		assert.deepEqual(
			new PushStore(file).subscriptions().map((item) => item.endpoint).sort(),
			[old.endpoint, phone.endpoint].sort(),
			"the 410 registration was not pruned, or the other app's subscription was touched",
		);

		// The next event goes to the live subscription only.
		fetchRecorder.calls.length = 0;
		question(app, "session-1");
		await settle();
		assert.deepEqual(fetchRecorder.calls, [phone.endpoint], "the pruned endpoint was still pushed to");
	} finally {
		console.warn = previousWarn;
		fetchRecorder.restore();
	}
	assert.equal(home, process.env.DSH_HOME);
}));

test("a legacy entry with a non-canonical origin still matches its own app", withHome(async (home, file) => {
	mkdirSync(dirname(file), { recursive: true });
	const phone = subscription("https://web.push.apple.com/phone");
	seed(file, phone.endpoint, NEW_ORIGIN);
	// Simulate an entry written before `PushStore.add` normalized origins: a
	// trailing slash must not make the app's own subscription unroutable.
	const state = JSON.parse(readFileSync(file, "utf8"));
	state.subscriptions[0].origin = `${NEW_ORIGIN}/`;
	writeFileSync(file, JSON.stringify(state, null, "\t"));

	const app = makeInstance();
	app.addRoot("session-1");
	const fetchRecorder = withFetch(() => ({ status: 201, ok: true }));
	try {
		assert.equal((await request(app, "/api/dsh-mobile-maxxing/push/config", { method: "GET", origin: NEW_ORIGIN })).status, 200);
		question(app, "session-1");
		await settle();
		assert.deepEqual(fetchRecorder.calls, [phone.endpoint], "a trailing-slash origin missed its own subscription");
	} finally {
		fetchRecorder.restore();
	}
	assert.equal(home, process.env.DSH_HOME);
}));

test("a rejected request cannot teach the host a target origin", withHome(async (home, file) => {
	mkdirSync(dirname(file), { recursive: true });
	const phone = subscription("https://web.push.apple.com/phone");
	const old = subscription("https://web.push.apple.com/old");
	seed(file, phone.endpoint, NEW_ORIGIN);
	seed(file, old.endpoint, OLD_ORIGIN);

	const refused = makeInstance({ rejection: 403 });
	refused.addRoot("session-1");
	const fetchRecorder = withFetch(() => ({ status: 201, ok: true }));
	try {
		// A request the Web server refuses must not become the push target: the
		// guard learns origins only after the rejection check.
		assert.equal(
			(await request(refused, "/api/dsh-mobile-maxxing/push/config", { method: "GET", origin: OLD_ORIGIN })).status,
			403,
		);
		question(refused, "session-1");
		await settle();
		assert.deepEqual(fetchRecorder.calls, [], "a rejected request taught the host an origin");

		// An accepted request from the same process still routes normally.
		const accepted = makeInstance();
		accepted.addRoot("session-1");
		assert.equal(
			(await request(accepted, "/api/dsh-mobile-maxxing/push/config", { method: "GET", origin: NEW_ORIGIN })).status,
			200,
		);
		question(accepted, "session-1");
		await settle();
		assert.deepEqual(fetchRecorder.calls, [phone.endpoint], "an accepted origin did not route the question");
	} finally {
		fetchRecorder.restore();
	}
	assert.equal(home, process.env.DSH_HOME);
}));

// ---------------------------------------------------------------------------
// #28: service-worker cache isolation assumptions
// ---------------------------------------------------------------------------

const SW_SOURCE = readFileSync(new URL("../sw.js", import.meta.url), "utf8");

class FakeCache {
	constructor(origin, name) {
		this.origin = origin;
		this.name = name;
		this.entries = new Map();
	}

	key(request) {
		return typeof request === "string" ? new URL(request, this.origin).href : request.url;
	}

	async put(request, response) {
		this.entries.set(this.key(request), response);
	}

	async match(request) {
		return this.entries.get(this.key(request));
	}

	async keys() {
		return [...this.entries.keys()].map((url) => ({ url }));
	}

	async delete(request) {
		return this.entries.delete(this.key(request));
	}
}

/** The browser gives every origin its own CacheStorage; model exactly that. */
class FakeCacheStorage {
	constructor(origin) {
		this.origin = origin;
		this.caches = new Map();
	}

	async open(name) {
		let cache = this.caches.get(name);
		if (cache === undefined) {
			cache = new FakeCache(this.origin, name);
			this.caches.set(name, cache);
		}
		return cache;
	}

	async keys() {
		return [...this.caches.keys()];
	}

	async delete(name) {
		return this.caches.delete(name);
	}
}

/** Load sw.js into a sandbox that looks like one service-worker global. */
function loadServiceWorker({ origin, build = "build-a", cacheStorage, network = "ok", clients = [], timers = {}, fetchImpl = null, pushManager = null, log = console }) {
	const listeners = new Map();
	const shown = [];
	const self = {
		registration: { scope: `${origin}/`, pushManager, showNotification: async (...args) => { shown.push(args); } },
		location: { origin },
		clients: { matchAll: async () => clients, claim: async () => {} },
		addEventListener(type, handler) {
			listeners.set(type, handler);
		},
		skipWaiting() {},
		__RDSH_PWA_BUILD__: build,
		__RDSH_PWA_CONFIG__: {},
	};
	const context = {
		self,
		caches: cacheStorage,
		URL,
		Response: class {
			static error() {
				return { error: true };
			}
		},
		fetch: fetchImpl ?? (async (url) => {
			if (network !== "ok") throw new Error("network down");
			return { ok: true, type: "basic", clone() { return this; }, url: String(url) };
		}),
		console: log,
		atob: (value) => Buffer.from(value, "base64").toString("binary"),
		navigator: { userAgent: "test-device" },
		setTimeout: timers.setTimeout ?? setTimeout,
		clearTimeout: timers.clearTimeout ?? clearTimeout,
	};
	vm.createContext(context);
	new vm.Script(SW_SOURCE, { filename: "sw.js" }).runInContext(context);
	return { listeners, self, shown };
}

test("worker reports failed rotation and preserves the previous endpoint", async () => {
	const posts = [], warnings = [];
	const worker = loadServiceWorker({
		origin: NEW_ORIGIN, cacheStorage: new FakeCacheStorage(),
		pushManager: { subscribe: async () => ({ toJSON: () => ({ endpoint: "https://web.push.apple.com/new" }) }) },
		fetchImpl: async (url, options) => {
			if (String(url).endsWith("/vapid")) return { ok: true, json: async () => ({ publicKey: "AQ" }) };
			posts.push(JSON.parse(options.body));
			return { ok: false, status: 503 };
		},
		log: { warn: (...args) => warnings.push(args) },
	});
	let work;
	worker.listeners.get("pushsubscriptionchange")({ oldSubscription: { endpoint: "https://web.push.apple.com/old" }, waitUntil(promise) { work = promise; } });
	await work;
	assert.equal(posts.length, 1);
	assert.equal(posts[0].previousEndpoint, "https://web.push.apple.com/old");
	assert.equal(warnings.length, 1);
});

/** Run one lifecycle event and wait for its work. */
async function fire(listeners, type, data) {
	const work = [];
	const listener = listeners.get(type);
	assert.ok(listener !== undefined, `the ${type} listener is mounted`);
	listener({ data: data === undefined ? null : { json: () => data }, waitUntil(promise) { work.push(promise); } });
	await Promise.all(work);
}

/** A request-like object the worker's fetch handler understands. */
function fetchEvent(url, { method = "GET", mode = "no-cors", cache = "default", range = null } = {}) {
	return {
		request: {
			url,
			method,
			mode,
			cache,
			headers: { get: (name) => (name === "range" ? range : null) },
		},
		respondWith(promise) {
			this.responded = true;
			this.response = promise;
		},
	};
}

test("the worker never intercepts another origin or live state", () => {
	const origin = "https://app.example:8446";
	const storage = new FakeCacheStorage(origin);
	const { listeners } = loadServiceWorker({ origin, cacheStorage: storage });

	const crossOrigin = fetchEvent("https://other.example/assets/app.js");
	listeners.get("fetch")(crossOrigin);
	assert.notEqual(crossOrigin.responded, true, "a cross-origin request must stay with the browser");

	const api = fetchEvent(`${origin}/api/dsh-mobile-maxxing/push/config`);
	listeners.get("fetch")(api);
	assert.notEqual(api.responded, true, "live API state must never be served from cache");

	const hmr = fetchEvent(`${origin}/hmr/client.js`);
	listeners.get("fetch")(hmr);
	assert.notEqual(hmr.responded, true, "HMR must not be intercepted");

	const post = fetchEvent(`${origin}/assets/app.js`, { method: "POST" });
	listeners.get("fetch")(post);
	assert.notEqual(post.responded, true, "only GET is cacheable");

	const ranged = fetchEvent(`${origin}/assets/app.js`, { range: "bytes=0-10" });
	listeners.get("fetch")(ranged);
	assert.notEqual(ranged.responded, true, "a ranged asset must reach the server");

	const asset = fetchEvent(`${origin}/assets/app.js`);
	listeners.get("fetch")(asset);
	assert.equal(asset.responded, true, "a same-origin static asset should use the cache path");

	const navigation = fetchEvent(`${origin}/`, { mode: "navigate" });
	listeners.get("fetch")(navigation);
	assert.equal(navigation.responded, true, "a navigation should use the shell path");
});

test("install seeds the shell and activate retires only this app's stale builds", async () => {
	const origin = "https://app.example:8446";
	const storage = new FakeCacheStorage(origin);
	// A previous build of this app, plus a cache that belongs to something
	// else on the same origin.
	await storage.open("dsh-mobile-maxxing-previous");
	await storage.open("someone-elses-cache");
	const { listeners } = loadServiceWorker({ origin, cacheStorage: storage });

	await fire(listeners, "install");
	assert.deepEqual(
		(await storage.keys()).sort(),
		["dsh-mobile-maxxing-build-a", "dsh-mobile-maxxing-previous", "someone-elses-cache"].sort(),
	);
	const shell = await (await storage.open("dsh-mobile-maxxing-build-a")).keys();
	assert.deepEqual(
		shell.map((item) => item.url).sort(),
		[`${origin}/`, `${origin}/dsh-mobile-maxxing.webmanifest`].sort(),
		"the offline shell and manifest are not cached under the scope",
	);

	await fire(listeners, "activate");
	assert.deepEqual(
		(await storage.keys()).sort(),
		["dsh-mobile-maxxing-build-a", "someone-elses-cache"].sort(),
		"activate did not retire the previous build, or it deleted a foreign cache",
	);
});

test("two origins keep independent caches and cannot share entries", async () => {
	// CacheStorage is origin-scoped in the browser, so this models two
	// deployments of the same build: 8444 (old app) and 8446 (new app).
	//
	// Known limit, not fixed here: two instances served from the SAME origin
	// under different sub-paths share one CacheStorage, and `activate` retires
	// every `dsh-mobile-maxxing-*` cache it finds there. #28's two apps are distinct
	// origins (the supported case); the same-origin sub-path deployment is
	// recorded as a risk in the handoff rather than guessed at.
	const oldOrigin = "https://app.example:8444";
	const newOrigin = "https://app.example:8446";
	const oldStorage = new FakeCacheStorage(oldOrigin);
	const newStorage = new FakeCacheStorage(newOrigin);
	const oldWorker = loadServiceWorker({ origin: oldOrigin, build: "build-a", cacheStorage: oldStorage });
	const newWorker = loadServiceWorker({ origin: newOrigin, build: "build-a", cacheStorage: newStorage });

	await fire(oldWorker.listeners, "install");
	await fire(newWorker.listeners, "install");
	await oldStorage.open("dsh-mobile-maxxing-stale-old");
	await newStorage.open("dsh-mobile-maxxing-stale-new");

	await fire(newWorker.listeners, "activate");
	assert.deepEqual(
		(await newStorage.keys()).sort(),
		["dsh-mobile-maxxing-build-a"].sort(),
		"the new origin's activation did not clean its own stale build",
	);
	// The old origin is a different CacheStorage: nothing the new worker did
	// can retire (or otherwise touch) either of its caches.
	assert.deepEqual(
		(await oldStorage.keys()).sort(),
		["dsh-mobile-maxxing-build-a", "dsh-mobile-maxxing-stale-old"].sort(),
		"activating one origin deleted the other origin's cache",
	);

	const oldPaths = (await (await oldStorage.open("dsh-mobile-maxxing-build-a")).keys()).map((item) => item.url);
	const newPaths = (await (await newStorage.open("dsh-mobile-maxxing-build-a")).keys()).map((item) => item.url);
	assert.ok(oldPaths.every((url) => url.startsWith(oldOrigin)), "an old-app cache entry points at another origin");
	assert.ok(newPaths.every((url) => url.startsWith(newOrigin)), "a new-app cache entry points at another origin");
});

test("an offline launch falls back to the cached shell, not the network error", async () => {
	const origin = "https://app.example:8446";
	const storage = new FakeCacheStorage(origin);
	const worker = loadServiceWorker({ origin, cacheStorage: storage });
	await fire(worker.listeners, "install");

	// Same worker, now offline: re-loading the module would drop the cache,
	// so the second instance shares the storage object but fails every fetch.
	const offline = loadServiceWorker({ origin, cacheStorage: storage, network: "down" });
	const navigation = fetchEvent(`${origin}/`, { mode: "navigate" });
	offline.listeners.get("fetch")(navigation);
	assert.equal(navigation.responded, true, "the navigation was not handled at all");
	const response = await navigation.response;
	assert.notEqual(response?.error, true, "the offline launch fell through to Response.error() despite a cached shell");
});
// ---------------------------------------------------------------------------
// #25: every received push is user-visible
// ---------------------------------------------------------------------------

test("#25 every received push shows a system notification, even with a visible window", async () => {
	const origin = "https://app.test";
	const storage = new FakeCacheStorage(origin);
	const payload = { title: "Session A", body: "Turn finished", sessionId: "s1", kind: "turn-end" };
	const posted = [];
	const timers = [];
	const clients = [{ visibilityState: "visible", postMessage(...args) { posted.push(args); } }];
	const { listeners, shown } = loadServiceWorker({
		origin,
		cacheStorage: storage,
		clients,
		timers: { setTimeout: (...args) => { timers.push(args); return setTimeout(...args); } },
	});
	await fire(listeners, "push", payload);
	// WebKit revokes a subscription after three pushes that show no
	// notification, and Chromium/Edge substitute a generic banner, so the
	// worker has no "silent because the app is visible" branch. Foreground
	// in-app delivery is the page's own local notice.
	assert.equal(posted.length, 0, "the worker handed the notice to the page instead of showing it");
	assert.deepEqual(timers, [], "the worker waited for an acknowledgment timer");
	assert.equal(shown.length, 1, "a received push must be user-visible");
	const [title, options] = shown[0];
	assert.equal(title, payload.title, "the system banner lost the title");
	assert.equal(options.body, payload.body, "the system banner lost the body");
	assert.equal(options.data.sessionId, payload.sessionId, "the system banner lost the session");
	assert.equal(options.tag, `dsh-mobile-maxxing:${payload.sessionId}`, "the system banner lost its per-session tag");
});

test("#25 with no visible window the push falls back to the system notification", async () => {
	const origin = "https://app.test";
	const storage = new FakeCacheStorage(origin);
	const payload = { title: "Session A", body: "Turn finished", sessionId: "s1", kind: "turn-end" };
	const { listeners, shown } = loadServiceWorker({ origin, cacheStorage: storage, clients: [] });
	await fire(listeners, "push", payload);
	assert.equal(shown.length, 1, "the background push did not reach the system banner");
	const [title, options] = shown[0];
	assert.equal(title, payload.title, "the system banner lost the title");
	assert.equal(options.body, payload.body, "the system banner lost the body");
	assert.equal(options.data.sessionId, payload.sessionId, "the system banner lost the session");
	assert.equal(options.tag, `dsh-mobile-maxxing:${payload.sessionId}`, "the system banner lost its per-session tag");
});
