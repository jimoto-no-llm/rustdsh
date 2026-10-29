/**
 * Web Push delivery regressions for #85 and #88.
 *
 * A manual `content-length` header made the runtime's fetch (undici) reject
 * every send with `TypeError: fetch failed` before any bytes left the host.
 * These tests pin the request shape, prove one POST over a real socket, and
 * check that the undici cause survives into the diagnostic string.
 */

import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import {
	describePushError,
	generateVapidKeys,
	sendWebPush,
	toBase64Url,
} from "../notify/host.js";

const KEYS = generateVapidKeys();

/** A browser-shaped PushSubscription: P-256 public point plus 16-byte auth. */
function subscription(endpoint) {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	return {
		endpoint,
		keys: { p256dh: toBase64Url(ecdh.getPublicKey()), auth: toBase64Url(randomBytes(16)) },
	};
}

/** Headers fetch must own; a sender that sets them breaks the request. */
function assertNoForbiddenHeaders(headers) {
	const names = Object.keys(headers).map((name) => name.toLowerCase());
	assert.equal(
		names.includes("content-length"),
		false,
		`content-length must be computed by fetch: ${names.join(", ")}`,
	);
	for (const forbidden of ["connection", "host", "transfer-encoding", "keep-alive", "upgrade", "expect", "trailer"]) {
		assert.equal(names.includes(forbidden), false, `${forbidden} must not be sent by this module`);
	}
}

test("sendWebPush lets fetch frame the body and reports the push status", async () => {
	const previousFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url, options) => {
		calls.push({ url: String(url), options });
		return { status: 201, ok: true };
	};
	try {
		const target = subscription("https://web.push.apple.com/abc");
		const result = await sendWebPush(
			target,
			{ title: "t", body: "b" },
			{ keys: KEYS, subject: "https://app.example", transport: (...args) => globalThis.fetch(...args) },
		);

		assert.equal(calls.length, 1, "one push endpoint means one request");
		assert.equal(calls[0].url, target.endpoint);
		const { options } = calls[0];
		assert.equal(options.method, "POST");
		assert.equal(options.redirect, "error");
		assert.ok(options.signal instanceof AbortSignal);
		assertNoForbiddenHeaders(options.headers);
		assert.equal(options.headers["content-encoding"], "aes128gcm");
		assert.equal(options.headers["content-type"], "application/octet-stream");
		assert.match(options.headers.authorization, /^vapid t=/);
		assert.equal(options.headers.ttl, "600");
		assert.equal(options.headers.urgency, "high");
		assert.ok(
			Buffer.isBuffer(options.body) || ArrayBuffer.isView(options.body),
			"the body is bytes, not a string",
		);
		assert.ok(options.body.length > 0, "the encrypted payload is not empty");
		assert.deepEqual(result, { ok: true, status: 201, gone: false });
	} finally {
		globalThis.fetch = previousFetch;
	}
});

test("sendWebPush delivers a POST through a real socket", async () => {
	const previousFetch = globalThis.fetch;
	const received = [];
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			received.push({
				method: req.method,
				url: req.url,
				headers: req.headers,
				body: Buffer.concat(chunks),
			});
			res.writeHead(201, { connection: "close" });
			res.end();
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	// Still the real fetch, but every outgoing request is inspected first: a
	// local server alone would tolerate a manual content-length.
	const realFetch = previousFetch;
	globalThis.fetch = async (url, options) => {
		assertNoForbiddenHeaders(options.headers);
		return realFetch(url, options);
	};
	try {
		const { port } = server.address();
		const target = subscription(`http://127.0.0.1:${port}/push/abc`);
		const result = await sendWebPush(
			target,
			{ title: "t", body: "b" },
			{ keys: KEYS, subject: "https://app.example", transport: (...args) => globalThis.fetch(...args) },
		);

		assert.equal(received.length, 1, "the local push service received one request");
		assert.equal(received[0].method, "POST");
		assert.equal(received[0].url, "/push/abc");
		assert.equal(received[0].headers["content-encoding"], "aes128gcm");
		assert.ok(received[0].body.length > 0, "the encrypted payload arrived");
		assert.equal(result.ok, true);
		assert.equal(result.status, 201);
		assert.equal(result.gone, false);
	} finally {
		globalThis.fetch = previousFetch;
		server.close();
		await once(server, "close");
	}
});

test("describePushError surfaces the undici cause code, without the endpoint", async () => {
	const previousFetch = globalThis.fetch;
	const cause = Object.assign(new Error("invalid content-length header"), {
		code: "UND_ERR_INVALID_ARG",
	});
	globalThis.fetch = async () => {
		throw new TypeError("fetch failed", { cause });
	};
	try {
		const target = subscription("https://web.push.apple.com/abc");
		await assert.rejects(
			() => sendWebPush(target, { title: "t" }, { keys: KEYS, subject: "https://app.example", transport: (...args) => globalThis.fetch(...args) }),
			(error) => {
				const text = describePushError(error);
				assert.match(text, /^fetch failed/);
				assert.match(text, /UND_ERR_INVALID_ARG/);
				assert.match(text, /invalid content-length header/);
				assert.equal(text.includes(target.endpoint), false, "the endpoint stays out of the log");
				return true;
			},
		);
		assert.equal(describePushError(new Error("plain failure")), "plain failure");
	} finally {
		globalThis.fetch = previousFetch;
	}
});
