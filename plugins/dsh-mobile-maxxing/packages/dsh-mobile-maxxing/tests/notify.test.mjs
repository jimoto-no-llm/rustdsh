/**
 * Notification half: payload copy, encryption and the push request shape.
 *
 * The cryptography is checked by decrypting what this module produces with an
 * independent implementation of the receiving side (RFC 8291), which is the
 * only way to know the framing is right without a real push service.
 */

import assert from "node:assert/strict";
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	applyNotify,
	buildQuestionPayload,
	buildTurnEndPayload,
	encryptPushPayload,
	endpointAudience,
	fillTemplate,
	fromBase64Url,
	makePayload,
	normalizeNotifyConfig,
	PushStore,
	toBase64Url,
	vapidAuthorization,
} from "../notify/host.js";
import { copyFor } from "../lib/copy.js";

test("base64url round-trips and drops padding", () => {
	const bytes = randomBytes(37);
	const encoded = toBase64Url(bytes);
	assert.match(encoded, /^[A-Za-z0-9_-]+$/, "no +, / or = survive");
	assert.deepEqual(fromBase64Url(encoded), bytes);
});

test("templates keep unknown placeholders visible", () => {
	assert.equal(fillTemplate("{a} and {b}", { a: "x" }), "x and {b}");
	assert.equal(fillTemplate("{session}", { session: "名前" }), "名前");
});

test("copy config merges over the defaults by type", () => {
	const merged = normalizeNotifyConfig({ appName: "APP", onlyMobileTurns: false, bogus: 1 });
	assert.equal(merged.appName, "APP");
	assert.equal(merged.onlyMobileTurns, false);
	assert.equal("bogus" in merged, false, "unknown keys are ignored");
	assert.equal(normalizeNotifyConfig({ onlyMobileTurns: "yes" }).onlyMobileTurns, true, "a wrong type keeps the default");
});

test("turn-end and question payloads carry the session id", () => {
	const turn = buildTurnEndPayload("session-1", { kind: "completed" }, { session: "テスト", lang: "en" });
	assert.equal(turn.sessionId, "session-1");
	assert.equal(turn.title, "テスト", "the session name is the headline");
	assert.match(turn.url, /session=session-1/);

	const question = buildQuestionPayload(
		{ agent: { id: "session-2" }, questions: [{ header: "確認", question: "進めますか？" }] },
		{ session: "別の名前", lang: "en" },
	);
	assert.equal(question.sessionId, "session-2");
	assert.equal(question.title, "別の名前");
	assert.match(question.body, /進めますか？/);
});

test("an unnamed session falls back to the app prefix", () => {
	const payload = buildTurnEndPayload("s", { kind: "completed" }, { session: "", lang: "en" });
	assert.equal(payload.title, "DSH: Work finished");
});

test("payload copy follows the configured language", () => {
	// English stays available explicitly. Japanese uses COPY.ja per key and
	// falls back to English for keys that have not been translated yet.
	const english = buildTurnEndPayload("s", { kind: "aborted" }, { session: "", lang: "en" });
	assert.equal(english.title, "DSH: Stopped (interrupted)");
	assert.equal(english.body, "End reason: aborted");
	const japaneseStrings = copyFor("ja");
	const japanese = buildTurnEndPayload("s", { kind: "completed" }, { session: "", lang: "ja" });
	assert.equal(japanese.title, `DSH: ${japaneseStrings["notify.turn.completed"]}`);
	assert.equal(japanese.body, japaneseStrings["notify.turn.detailCompleted"]);

	const question = buildQuestionPayload({ agent: { id: "q" }, questions: [{ question: "Proceed?" }] }, { lang: "en" });
	assert.equal(question.title, "DSH: Confirm", "the default question header is English");
});

test("encryption round-trips against an independent receiver", () => {
	// The browser side: a P-256 key pair and a 16-byte auth secret.
	const userAgent = createECDH("prime256v1");
	userAgent.generateKeys();
	const authSecret = randomBytes(16);
	const subscription = {
		endpoint: "https://push.example/abc",
		keys: { p256dh: toBase64Url(userAgent.getPublicKey()), auth: toBase64Url(authSecret) },
	};
	const plaintext = JSON.stringify({ title: "t", body: "b" });
	const body = encryptPushPayload(subscription, plaintext);

	// aes128gcm framing: salt(16) | record size(4) | key id len(1) | key id | data
	const salt = body.subarray(0, 16);
	const recordSize = body.readUInt32BE(16);
	const keyIdLength = body.readUInt8(20);
	const asPublic = body.subarray(21, 21 + keyIdLength);
	const ciphertext = body.subarray(21 + keyIdLength);
	assert.equal(recordSize, 4096);
	assert.equal(keyIdLength, 65, "an uncompressed P-256 point");
	assert.equal(asPublic[0], 4, "the point is uncompressed");

	// The receiver's half of RFC 8291 §3.4.
	const sharedSecret = userAgent.computeSecret(asPublic);
	const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), userAgent.getPublicKey(), asPublic]);
	const inputKeyMaterial = Buffer.from(hkdfSync("sha256", sharedSecret, authSecret, keyInfo, 32));
	const contentKey = Buffer.from(hkdfSync("sha256", inputKeyMaterial, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
	const nonce = Buffer.from(hkdfSync("sha256", inputKeyMaterial, salt, Buffer.from("Content-Encoding: nonce\0"), 12));

	const decipher = createDecipheriv("aes-128-gcm", contentKey, nonce);
	decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
	const record = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);

	// The last record ends with the 0x02 padding delimiter.
	assert.equal(record[record.length - 1], 2);
	assert.equal(record.subarray(0, record.length - 1).toString("utf8"), plaintext);
});

test("each message uses a fresh ephemeral key", () => {
	const userAgent = createECDH("prime256v1");
	userAgent.generateKeys();
	const subscription = {
		endpoint: "https://push.example/abc",
		keys: { p256dh: toBase64Url(userAgent.getPublicKey()), auth: toBase64Url(randomBytes(16)) },
	};
	const first = encryptPushPayload(subscription, "a").subarray(21, 86);
	const second = encryptPushPayload(subscription, "a").subarray(21, 86);
	assert.notDeepEqual(first, second, "reusing the key would let a captured message be replayed");
});

test("VAPID produces a signed ES256 JWT for the endpoint origin", async () => {
	const { generateVapidKeys } = await import("../notify/host.js");
	const keys = generateVapidKeys();
	const header = vapidAuthorization({ keys, audience: "https://web.push.apple.com", subject: "https://app.example" });
	assert.match(header, /^vapid t=[^,]+, k=[A-Za-z0-9_-]+$/);
	const jwt = header.slice("vapid t=".length, header.indexOf(", k="));
	const [head, claims] = jwt.split(".");
	const decodedHeader = JSON.parse(Buffer.from(fromBase64Url(head)).toString("utf8"));
	const decodedClaims = JSON.parse(Buffer.from(fromBase64Url(claims)).toString("utf8"));
	assert.deepEqual(decodedHeader, { typ: "JWT", alg: "ES256" });
	assert.equal(decodedClaims.aud, "https://web.push.apple.com");
	assert.equal(decodedClaims.sub, "https://app.example");
	assert.ok(decodedClaims.exp > Date.now() / 1000, "the token is in the future");
});

test("the endpoint origin is what VAPID signs for", () => {
	assert.equal(endpointAudience("https://web.push.apple.com/QPuf3"), "https://web.push.apple.com");
	assert.equal(endpointAudience("not a url"), "");
});

test("the store persists a subscription and picks the VAPID subject", () => {
	const file = join(mkdtempSync(join(tmpdir(), "dsh-mobile-maxxing-")), "push.json");
	const store = new PushStore(file);
	const userAgent = createECDH("prime256v1");
	userAgent.generateKeys();
	const subscription = {
		endpoint: "https://web.push.apple.com/abc",
		keys: { p256dh: toBase64Url(userAgent.getPublicKey()), auth: toBase64Url(randomBytes(16)) },
	};
	assert.equal(store.subscriptions().length, 0);
	assert.equal(store.add(subscription, { label: "iOS", origin: "https://app.example:8444" }), 1);
	assert.equal(store.subscriptions()[0].origin, "https://app.example:8444");
	// Apple rejects mailto:root@localhost, so the app origin is preferred.
	assert.equal(store.subject(""), "https://app.example:8444");
	assert.equal(store.subject("mailto:me@example.com"), "mailto:me@example.com", "an explicit subject wins");
	assert.equal(store.remove(subscription.endpoint), true);
	assert.equal(store.subscriptions().length, 0);

	// A second store instance reads the same file back.
	const again = new PushStore(file);
	assert.equal(again.keys().publicKey, store.keys().publicKey, "the VAPID pair is stable across restarts");
});

test("a subscription without keys is refused", () => {
	const file = join(mkdtempSync(join(tmpdir(), "dsh-mobile-maxxing-")), "push.json");
	const store = new PushStore(file);
	assert.throws(() => store.add({ endpoint: "https://x/y" }), /client keys/);
	assert.throws(() => store.add({ keys: {} }), /endpoint/);
});

test("push endpoints must be real https push services", () => {
	const file = join(mkdtempSync(join(tmpdir(), "dsh-mobile-maxxing-")), "push.json");
	const store = new PushStore(file);
	const userAgent = createECDH("prime256v1");
	userAgent.generateKeys();
	const keys = { p256dh: toBase64Url(userAgent.getPublicKey()), auth: toBase64Url(randomBytes(16)) };
	// The host POSTs to whatever is stored, so anything that is not a public
	// https push service has to be refused at subscribe time.
	for (const endpoint of [
		"http://web.push.apple.com/abc",
		"https://127.0.0.1:9999/x",
		"https://169.254.169.254/latest/meta-data",
		"https://10.0.0.5/x",
		"https://192.168.1.10/x",
		"https://172.16.0.9/x",
		"https://localhost/x",
		"https://printer.local/x",
		"not-a-url",
	]) {
		assert.throws(() => store.add({ endpoint, keys }), /subscription endpoint/, endpoint);
	}
	assert.equal(store.subscriptions().length, 0, "nothing was stored");
	// A real push service is accepted.
	assert.equal(store.add({ endpoint: "https://web.push.apple.com/abc", keys }, { origin: "https://app.example" }), 1);
});

test("a phone send marks its own turn; a desktop send does not", async () => {
	const home = mkdtempSync(join(tmpdir(), "rdsh-fromphone-"));
	const file = join(home, "dsh-mobile-maxxing", "push.json");
	mkdirSync(join(home, "dsh-mobile-maxxing"), { recursive: true });
	const makeKeys = () => {
		const ecdh = createECDH("prime256v1");
		ecdh.generateKeys();
		return { p256dh: toBase64Url(ecdh.getPublicKey()), auth: toBase64Url(randomBytes(16)) };
	};
	const store = new PushStore(file);
	store.add({ endpoint: "https://web.push.apple.com/phone", keys: makeKeys() }, { origin: "https://app.example:8446" });
	store.add({ endpoint: "https://web.push.apple.com/old", keys: makeKeys() }, { origin: "https://app.example:8444" });

	const previousHome = process.env.DSH_HOME;
	const previousFetch = globalThis.fetch;
	process.env.DSH_HOME = home;
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		return { status: 201, ok: true };
	};
	try {
		const listeners = new Map();
		const agent = { id: "s1" };
		const agents = { get: (id) => (id === "s1" ? agent : undefined), roots: () => [agent] };
		const routes = new Map();
		const services = {
			agents,
			connection: { requestRejection: () => undefined },
			webServer: {
				register(route) { routes.set(route.path, route); return () => routes.delete(route.path); },
				tapIndex() { return () => {}; },
				getOrigin: () => "https://app.example:8446",
			},
		};
		const scope = {
			...services,
			get: (name) => services[name],
			on(event, handler) { listeners.set(event, handler); return () => listeners.delete(event); },
			effect(fn) { const dispose = fn(); return typeof dispose === "function" ? dispose : () => {}; },
		};
		const ctx = {
			inject(deps, callback) { return callback(scope); },
			get: (name) => services[name],
			on(event, handler) { listeners.set(event, handler); return () => {}; },
			effect(fn) { return scope.effect(fn); },
		};
		applyNotify(ctx, { onlyMobileTurns: true }, { transport: (...args) => globalThis.fetch(...args) });
		const mobileSend = routes.get("/api/dsh-mobile-maxxing/push/mobile-send");
		const post = async (path, body) => {
			const req = Readable.from([Buffer.from(JSON.stringify(body))]);
			req.method = "POST";
			req.url = path;
			req.headers = { origin: "https://app.example:8446" };
			let status = 0;
			await routes.get(path).handler(req, { writeHead(code) { status = code; }, end() {} });
			return status;
		};
		const wait = () => new Promise((resolve) => setTimeout(resolve, 1550));

		assert.equal(await post("/api/dsh-mobile-maxxing/push/mobile-send", { sessionId: "s1", requestId: "mobile-test-id" }), 200);
		listeners.get("session/event")({ id: "s1" }, { type: "turn/start" });
		listeners.get("session/event")({ id: "s1" }, { type: "user/message", data: { source: { rpcId: "mobile-test-id" } } });
		listeners.get("session/event")({ id: "s1" }, { type: "turn/end", data: { reason: { kind: "completed" } } });
		await wait();
		assert.deepEqual(calls, ["https://web.push.apple.com/phone"], "only the origin that sent the turn is pushed");

		calls.length = 0;
		listeners.get("session/event")({ id: "s2" }, { type: "turn/start" });
		listeners.get("session/event")({ id: "s2" }, { type: "turn/end", data: { reason: { kind: "completed" } } });
		await wait();
		assert.deepEqual(calls, [], "a desktop turn is not pushed when onlyMobileTurns is true");
	} finally {
		globalThis.fetch = previousFetch;
		if (previousHome === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previousHome;
	}
});

test("notification fan-out targets the app that started the turn or request, never every app", async () => {
	const home = mkdtempSync(join(tmpdir(), "rdsh-targeting-"));
	const file = join(home, "dsh-mobile-maxxing", "push.json");
	mkdirSync(join(home, "dsh-mobile-maxxing"), { recursive: true });
	const makeKeys = () => {
		const ecdh = createECDH("prime256v1");
		ecdh.generateKeys();
		return { p256dh: toBase64Url(ecdh.getPublicKey()), auth: toBase64Url(randomBytes(16)) };
	};
	const store = new PushStore(file);
	store.add({ endpoint: "https://web.push.apple.com/phone", keys: makeKeys() }, { origin: "https://app.example:8446" });
	store.add({ endpoint: "https://web.push.apple.com/old", keys: makeKeys() }, { origin: "https://app.example:8444" });

	const previousHome = process.env.DSH_HOME;
	const previousFetch = globalThis.fetch;
	process.env.DSH_HOME = home;
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		return { status: 201, ok: true };
	};
	const wait = () => new Promise((resolve) => setTimeout(resolve, 1550));
	const harness = (getOrigin) => {
		const listeners = new Map();
		const routes = new Map();
		const agent = { id: "s1" };
		const agents = { get: (id) => (id === "s1" ? agent : undefined), roots: () => [agent] };
		const services = {
			agents,
			connection: { requestRejection: () => undefined },
			webServer: {
				register(route) { routes.set(route.path, route); return () => routes.delete(route.path); },
				tapIndex() { return () => {}; },
				getOrigin: () => getOrigin,
			},
		};
		const scope = {
			...services,
			get: (name) => services[name],
			on(event, handler) { listeners.set(event, handler); return () => listeners.delete(event); },
			effect(fn) { const dispose = fn(); return typeof dispose === "function" ? dispose : () => {}; },
		};
		const ctx = {
			inject(deps, callback) { return callback(scope); },
			get: (name) => services[name],
			on(event, handler) { listeners.set(event, handler); return () => {}; },
			effect(fn) { return scope.effect(fn); },
		};
		applyNotify(ctx, { onlyMobileTurns: true }, { transport: (...args) => globalThis.fetch(...args) });
		return { routes, listeners };
	};
	const request = async (target, path, { method = "POST", body = undefined, origin = undefined, capture = undefined } = {}) => {
		const text = body === undefined ? "" : JSON.stringify(body);
		const req = Readable.from(text === "" ? [] : [Buffer.from(text)]);
		req.method = method;
		req.url = path;
		req.headers = origin === undefined ? {} : { origin };
		let status = 0;
		let responseBody = "";
		await target.routes.get(path).handler(req, {
			writeHead(code) { status = code; },
			end(chunk) { if (typeof chunk === "string") responseBody += chunk; },
		});
		if (capture !== undefined) capture.text = responseBody;
		return status;
	};
	const turn = (target, id, type) => {
		const listener = target.listeners.get("session/event");
		listener({ id }, { type, data: { reason: { kind: "completed" } } });
		if (type === "turn/start") listener({ id }, { type: "user/message", data: { source: { rpcId: "mobile-test-id" } } });
	};
	const question = (target) => target.listeners.get("user-questions/request")({ agent: { id: "s1", session: { id: "s1" } }, questions: [{ header: "Q", question: "Continue?" }] }, () => {});

	const warnings = [];
	const previousWarn = console.warn;
	console.warn = (...args) => warnings.push(args.map(String).join(" "));
	try {
		// Nothing has told this process which app is its own: /test sends
		// nothing (#27). The old all-subscriptions fallback is gone because it
		// delivered the same event twice on a phone with both apps installed
		// (#28).
		const legacy = harness("http://127.0.0.1:3207");
		assert.equal(await request(legacy, "/api/dsh-mobile-maxxing/push/test", { body: {} }), 200);
		await wait();
		assert.deepEqual(calls, [], "an origin-less test push fanned out to every subscription");
		assert.ok(warnings.some((line) => /push skipped: no app origin/.test(line)), "the dropped test push was not logged");

		// An origin-less mobile-send follows the same rule: the turn is
		// dropped and logged, not sent to every app.
		calls.length = 0;
		warnings.length = 0;
		assert.equal(await request(legacy, "/api/dsh-mobile-maxxing/push/mobile-send", { body: { sessionId: "s1", requestId: "mobile-test-id" } }), 200);
		turn(legacy, "s1", "turn/start");
		turn(legacy, "s1", "turn/end");
		await wait();
		assert.deepEqual(calls, [], "an origin-less turn fanned out to every subscription");
		assert.ok(warnings.some((line) => /push skipped: no app origin/.test(line)), "the dropped turn was not logged");

		// /test with an explicit origin sends only to that app.
		calls.length = 0;
		assert.equal(await request(legacy, "/api/dsh-mobile-maxxing/push/test", { body: {}, origin: "https://app.example:8446" }), 200);
		await wait();
		assert.deepEqual(calls, ["https://web.push.apple.com/phone"]);

		// Once an app has talked to the process, an event without an origin of
		// its own uses that app rather than every subscription.
		calls.length = 0;
		assert.equal(await request(legacy, "/api/dsh-mobile-maxxing/push/mobile-send", { body: { sessionId: "s1", requestId: "mobile-test-id" } }), 200);
		turn(legacy, "s1", "turn/start");
		turn(legacy, "s1", "turn/end");
		await wait();
		assert.deepEqual(calls, ["https://web.push.apple.com/phone"], "the learned origin was not used for an origin-less turn");

		// mobile-send with the page origin pins turn/end to that app.
		calls.length = 0;
		assert.equal(await request(legacy, "/api/dsh-mobile-maxxing/push/mobile-send", { body: { sessionId: "s1", requestId: "mobile-test-id", origin: "https://app.example:8446" } }), 200);
		turn(legacy, "s1", "turn/start");
		turn(legacy, "s1", "turn/end");
		await wait();
		assert.deepEqual(calls, ["https://web.push.apple.com/phone"]);

		// webServer.getOrigin() matching a stored subscription seeds the
		// learned origin.
		calls.length = 0;
		const seeded = harness("https://app.example:8446");
		question(seeded);
		await wait();
		assert.deepEqual(calls, ["https://web.push.apple.com/phone"], "a matching server origin was not adopted");

		// A non-matching internal origin is not adopted, and nothing is sent.
		calls.length = 0;
		const internal = harness("http://127.0.0.1:3207");
		question(internal);
		await wait();
		assert.deepEqual(calls, [], "an internal origin was incorrectly adopted");

		// Question fallback: the learned origin when no turn origin is known.
		calls.length = 0;
		const own = harness("http://127.0.0.1:3207");
		assert.equal(await request(own, "/api/dsh-mobile-maxxing/push/vapid", { method: "GET", origin: "https://app.example:8444" }), 200);
		question(own);
		await wait();
		assert.deepEqual(calls, ["https://web.push.apple.com/old"]);

		// Question priority: the turn's origin wins over the learned origin.
		calls.length = 0;
		assert.equal(await request(own, "/api/dsh-mobile-maxxing/push/mobile-send", { body: { sessionId: "s1", requestId: "mobile-test-id", origin: "https://app.example:8446" } }), 200);
		turn(own, "s1", "turn/start");
		question(own);
		await wait();
		assert.deepEqual(calls, ["https://web.push.apple.com/phone"], "the turn origin did not win over the learned origin");

		// #88: /push/test reports the real status of each delivery, not just
		// whether some listener was found.
		const deliveredCapture = {};
		assert.equal(await request(own, "/api/dsh-mobile-maxxing/push/test", {
			body: {},
			origin: "https://app.example:8446",
			capture: deliveredCapture,
		}), 200);
		const delivered = JSON.parse(deliveredCapture.text);
		assert.equal(delivered.ok, true);
		assert.equal(delivered.results.length, 1);
		assert.equal(delivered.results[0].ok, true);
		assert.equal(delivered.results[0].status, 201);
		assert.equal("error" in delivered, false, "a delivered push carries no error");

		// #85: a transport failure must stay visible with its undici cause.
		globalThis.fetch = async () => {
			throw new TypeError("fetch failed", {
				cause: Object.assign(new Error("invalid content-length header"), { code: "UND_ERR_INVALID_ARG" }),
			});
		};
		const failedCapture = {};
		assert.equal(await request(own, "/api/dsh-mobile-maxxing/push/test", {
			body: {},
			origin: "https://app.example:8446",
			capture: failedCapture,
		}), 200);
		const failed = JSON.parse(failedCapture.text);
		assert.equal(failed.ok, false);
		assert.equal(failed.results.length, 1);
		assert.equal(failed.results[0].status, 0);
		assert.match(failed.results[0].error, /UND_ERR_INVALID_ARG: invalid content-length header/);
		assert.match(failed.error, /UND_ERR_INVALID_ARG/, "the route error names the cause");
	} finally {
		console.warn = previousWarn;
		globalThis.fetch = previousFetch;
		if (previousHome === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previousHome;
	}
});

test("a broken push store does not stop the PWA routes", async () => {
	// applyNotify opens a state file; when that throws, the rest of the plugin
	// must still mount. Mount with a context whose file cannot be written.
	const { apply: applyPlugin } = await import("../index.js");
	const routes = new Map();
	const webServer = {
		register(route) { routes.set(route.path, route); return () => routes.delete(route.path); },
		tapIndex() { return () => {}; },
		getOrigin: () => "http://127.0.0.1:0",
	};
	const services = {
		webServer,
		agents: { get: () => undefined, roots: () => [] },
		connection: { requestRejection: () => undefined },
	};
	const scope = {
		...services,
		get: (name) => services[name],
		on: () => () => {},
		effect: (fn) => { const dispose = fn(); return typeof dispose === "function" ? dispose : () => {}; },
	};
	const ctx = {
		inject: (deps, callback) => callback(scope),
		get: (name) => services[name],
		effect: (fn) => scope.effect(fn),
	};
	// A directory where the state file should be makes the write fail.
	const blocked = join(mkdtempSync(join(tmpdir(), "dsh-mobile-maxxing-")), "dsh-mobile-maxxing");
	mkdtempSync(blocked);
	const previous = process.env.DSH_HOME;
	process.env.DSH_HOME = join(blocked, "..");
	try {
		// Force the store path to be a directory so PushStore cannot save.
		mkdirSync(join(blocked, "push.json"), { recursive: true });
		applyPlugin(ctx, {});
	} finally {
		if (previous === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previous;
	}
	assert.ok(routes.has("/dsh-mobile-maxxing.webmanifest"), "the PWA routes still mounted");
	assert.ok(routes.has("/sw.js"));
});

/**
 * Boot applyNotify for the event acknowledgement tests: a temp DSH_HOME with
 * endpoints subscribed to one origin, a fetch stub that records every send,
 * and the registered routes.
 */
function acknowledgementHarness(endpoints) {
	const home = mkdtempSync(join(tmpdir(), "rdsh-ack-"));
	mkdirSync(join(home, "dsh-mobile-maxxing"), { recursive: true });
	const store = new PushStore(join(home, "dsh-mobile-maxxing", "push.json"));
	const add = (endpoint) => {
		const ecdh = createECDH("prime256v1");
		ecdh.generateKeys();
		store.add(
			{ endpoint, keys: { p256dh: toBase64Url(ecdh.getPublicKey()), auth: toBase64Url(randomBytes(16)) } },
			{ origin: "https://app.example:8446" },
		);
	};
	for (const endpoint of endpoints) add(endpoint);
	const previousHome = process.env.DSH_HOME;
	const previousFetch = globalThis.fetch;
	process.env.DSH_HOME = home;
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		return { status: 201, ok: true };
	};
	const listeners = new Map();
	const routes = new Map();
	const agent = { id: "s1" };
	const agents = { get: (id) => (id === "s1" ? agent : undefined), roots: () => [agent] };
	const services = {
		agents,
		connection: { requestRejection: () => undefined },
		webServer: {
			register(route) { routes.set(route.path, route); return () => routes.delete(route.path); },
			tapIndex() { return () => {}; },
			getOrigin: () => "https://app.example:8446",
		},
	};
	const scope = {
		...services,
		get: (name) => services[name],
		on(event, handler) { listeners.set(event, handler); return () => listeners.delete(event); },
		effect(fn) { const dispose = fn(); return typeof dispose === "function" ? dispose : () => {}; },
	};
	const ctx = {
		inject(deps, callback) { return callback(scope); },
		get: (name) => services[name],
		on(event, handler) { listeners.set(event, handler); return () => {}; },
		effect(fn) { return scope.effect(fn); },
	};
	// The host half already returns its seams; keep them so a test can drive one
	// event and read its own result instead of counting pushes.
	const api = applyNotify(ctx, { onlyMobileTurns: false }, { transport: (...args) => globalThis.fetch(...args) });
	const post = async (path, body) => {
		const text = body === undefined ? "" : JSON.stringify(body);
		const req = Readable.from(text === "" ? [] : [Buffer.from(text)]);
		req.method = "POST";
		req.url = path;
		req.headers = { origin: "https://app.example:8446" };
		let status = 0;
		let responseText = "";
		await routes.get(path).handler(req, {
			writeHead(code) { status = code; },
			end(chunk) { if (typeof chunk === "string") responseText += chunk; },
		});
		return { status, body: responseText === "" ? null : JSON.parse(responseText) };
	};
	return {
		store,
		add,
		routes,
		listeners,
		calls,
		post,
		fanOut: api.fanOut,
		turnEnded() {
			listeners.get("session/event")(agent, { type: "turn/end", data: { reason: { kind: "completed" } } });
		},
		restore() {
			globalThis.fetch = previousFetch;
			if (previousHome === undefined) delete process.env.DSH_HOME;
			else process.env.DSH_HOME = previousHome;
		},
	};
}

const ACK = "/api/dsh-mobile-maxxing/push/ack";
const TEST_PUSH = "/api/dsh-mobile-maxxing/push/test";
const TEST_ORIGIN = "https://app.example:8446";

test("a slow endpoint does not delay starting other push deliveries", async () => {
	const slow = "https://web.push.apple.com/slow", fast = "https://web.push.apple.com/fast";
	const harness = acknowledgementHarness([fast, slow]);
	const started = [];
	let finishSlow;
	globalThis.fetch = (url, options) => {
		started.push(String(url));
		assert.ok(options.signal instanceof AbortSignal);
		return String(url) === slow ? new Promise((resolve) => { finishSlow = resolve; }) : Promise.resolve({ status: 201 });
	};
	try {
		const pending = harness.fanOut({ kind: "test", title: "test" }, { origin: TEST_ORIGIN });
		assert.deepEqual(started.sort(), [fast, slow].sort(), "both endpoints must start before the slow one completes");
		finishSlow({ status: 201 });
		assert.equal((await pending).ok, true);
	} finally { harness.restore(); }
});

test("only the endpoint that acknowledged this notice skips push", async () => {
	const visibleEndpoint = "https://web.push.apple.com/visible";
	const otherEndpoint = "https://web.push.apple.com/other";
	const harness = acknowledgementHarness([visibleEndpoint, otherEndpoint]);
	try {
		// No pending event means no ACK can silence future push.
		const early = await harness.post(ACK, { endpoint: visibleEndpoint, sessionId: "s1", kind: "turn-end", origin: TEST_ORIGIN });
		assert.equal(early.body.acknowledged, false);
		harness.turnEnded();
		const received = await harness.post(ACK, { endpoint: visibleEndpoint, sessionId: "s1", kind: "turn-end", origin: TEST_ORIGIN });
		assert.equal(received.status, 200);
		assert.equal(received.body.acknowledged, true);
		assert.equal((await harness.post(ACK, { endpoint: visibleEndpoint, sessionId: "s1", kind: "turn-end", origin: TEST_ORIGIN })).body.acknowledged, false);
		await new Promise((resolve) => setTimeout(resolve, 1550));
		assert.deepEqual(harness.calls, [otherEndpoint], "the unacknowledged device still receives push");
		// Tests explicitly exercise the real push path even while foregrounded.
		await harness.post(TEST_PUSH, { sessionId: "s1", origin: TEST_ORIGIN });
		assert.equal(harness.calls.length, 3, "the test endpoint must not be suppressed by an earlier ACK");
	} finally {
		harness.restore();
	}
});

test("lost, mismatched, or stale acknowledgements never suppress push", async () => {
	const endpoint = "https://web.push.apple.com/gated";
	const harness = acknowledgementHarness([endpoint]);
	try {
		harness.turnEnded();
		for (const body of [
			{ endpoint, sessionId: "s1", kind: "question", origin: TEST_ORIGIN },
			{ endpoint, sessionId: "not-s1", kind: "turn-end", origin: TEST_ORIGIN },
			{ endpoint: "https://web.push.apple.com/foreign", sessionId: "s1", kind: "turn-end", origin: TEST_ORIGIN },
			{ endpoint, sessionId: "s1", kind: "turn-end", origin: "https://foreign.example" },
			{ endpoint: 7, sessionId: "s1", kind: "turn-end", origin: TEST_ORIGIN },
		]) {
			assert.equal((await harness.post(ACK, body)).body.acknowledged, false);
		}
		await new Promise((resolve) => setTimeout(resolve, 1550));
		assert.deepEqual(harness.calls, [endpoint], "the unacknowledged event was lost");
		const stale = await harness.post(ACK, { endpoint, sessionId: "s1", kind: "turn-end", origin: TEST_ORIGIN });
		assert.equal(stale.body.acknowledged, false, "a late ACK must not silence the next event");
	} finally {
		harness.restore();
	}
});

test("a late ACK consumes the oldest unacknowledged event, not a newer one", async () => {
	const endpoint = "https://web.push.apple.com/stacked";
	const harness = acknowledgementHarness([endpoint]);
	const payload = (title, body) => ({ title, body, sessionId: "s1", kind: "turn-end", url: "/?session=s1" });
	try {
		// Two events of the same session and kind are in flight. There is no
		// event id in the payload or the status hook, so an ACK cannot name its
		// event: the host consumes the oldest unacknowledged one and leaves the
		// newer event its push.
		const older = harness.fanOut(payload("Older", "first"), { origin: TEST_ORIGIN, awaitAck: true });
		await new Promise((resolve) => setTimeout(resolve, 100));
		const newer = harness.fanOut(payload("Newer", "second"), { origin: TEST_ORIGIN, awaitAck: true });
		await new Promise((resolve) => setTimeout(resolve, 50));
		const acked = await harness.post(ACK, { endpoint, sessionId: "s1", kind: "turn-end", origin: TEST_ORIGIN });
		assert.equal(acked.body.acknowledged, true);
		const olderResult = await older;
		const newerResult = await newer;
		assert.equal(olderResult.results[0]?.skipped, "acknowledged", "the delayed ACK did not consume the oldest unacknowledged event");
		assert.equal(newerResult.results[0]?.skipped, undefined, "the newer event was suppressed by an ACK for the older one");
		assert.equal(newerResult.results[0]?.status, 201, "the newer event never reached the push service");
	} finally {
		harness.restore();
	}
});

test("payload shape is what the service worker reads", () => {
	const payload = makePayload("session-9", "question", "t", "b");
	assert.deepEqual(Object.keys(payload).sort(), ["body", "kind", "sessionId", "title", "url"]);
	assert.equal(payload.kind, "question");
	assert.match(payload.url, /^\/?(\?|.*[?&])session=session-9$/, "a relative URL the worker can navigate to");
});
