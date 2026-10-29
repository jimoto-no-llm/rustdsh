/**
 * dsh-mobile-maxxing — notifications, host half.
 *
 * Web Push written directly against the RFCs on `node:crypto` alone:
 *
 *   - RFC 8292 — VAPID: an ES256 JWT in the `Authorization` header.
 *   - RFC 8291 — the `aes128gcm` payload: ECDH + HKDF + AES-128-GCM.
 *   - RFC 8188 — the record framing that carries the ciphertext.
 *
 * No push library is involved, so the package installs nothing beyond DSH
 * itself. The HTTP shape (`/api/dsh-mobile-maxxing/push/...`) and the service-worker
 * message contract are this package's own; the plugin this replaces
 * (`dsh-notify-push`) is credited in README.md as the reference for the
 * overall design, not as a source of code.
 *
 * @module dsh-mobile-maxxing/notify/host
 */
import {
	createCipheriv,
	createECDH,
	createPrivateKey,
	generateKeyPairSync,
	hkdfSync,
	randomBytes,
	sign,
} from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { copyFor } from "../lib/copy.js";
import { securePushRequest } from "./secure-push.js";

/** How long a push stays queued when the phone is offline. */
const PUSH_TTL_SECONDS = 600;
/** VAPID tokens are short-lived on purpose; 12h is the common ceiling. */
const VAPID_TTL_SECONDS = 12 * 60 * 60;
/** Refuse new subscriptions at capacity instead of dropping another device. */
const MAX_SUBSCRIPTIONS = 32;
/** A slow or unreachable push service must not delay delivery indefinitely. */
const PUSH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** base64url without padding, the encoding every part of Web Push uses. */
export function toBase64Url(buffer) {
	return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Inverse of {@link toBase64Url}. */
export function fromBase64Url(text) {
	const padded = String(text).replace(/-/g, "+").replace(/_/g, "/");
	return Buffer.from(padded + "=".repeat((4 - (padded.length % 4)) % 4), "base64");
}

/** Write a file so a crash cannot leave a half-written state behind. */
function writeJsonAtomically(file, value) {
	mkdirSync(dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
	renameSync(temporary, file);
}

/** Read JSON, or the fallback when the file is absent or unreadable. */
function readJson(file, fallback) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return fallback;
	}
}

/** Where this package keeps its state. `DSH_HOME` wins when it is set. */
export function stateDirectory() {
	const home = typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME !== ""
		? process.env.DSH_HOME
		: join(homedir(), ".dsh");
	return join(home, "dsh-mobile-maxxing");
}

// ---------------------------------------------------------------------------
// VAPID (RFC 8292)
// ---------------------------------------------------------------------------

/**
 * Create the long-lived VAPID key pair.
 *
 * @returns {{publicKey: string, privateKey: string}} base64url uncompressed
 *   point for the browser, and a PKCS#8 PEM for signing.
 */
export function generateVapidKeys() {
	const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	// The browser wants the raw point (0x04 || X || Y); SPKI ends with it.
	const spki = publicKey.export({ type: "spki", format: "der" });
	return {
		publicKey: toBase64Url(spki.subarray(spki.length - 65)),
		privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
	};
}

/**
 * Build the `Authorization` header value for one push service origin.
 *
 * @param {object} options
 * @param {{publicKey: string, privateKey: string}} options.keys - VAPID pair.
 * @param {string} options.audience - push service origin, e.g. `https://web.push.apple.com`.
 * @param {string} options.subject - `mailto:` or `https:` contact for the operator.
 * @param {number} [options.now] - milliseconds since the epoch.
 * @returns {string} `vapid t=<jwt>, k=<public key>`.
 */
export function vapidAuthorization({ keys, audience, subject, now = Date.now() }) {
	const header = toBase64Url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
	const claims = toBase64Url(Buffer.from(JSON.stringify({
		aud: audience,
		exp: Math.floor(now / 1000) + VAPID_TTL_SECONDS,
		sub: subject,
	})));
	const signingInput = `${header}.${claims}`;
	// JWS wants the raw r||s pair, not the DER wrapper OpenSSL defaults to.
	const signature = sign("sha256", Buffer.from(signingInput), {
		key: createPrivateKey(keys.privateKey),
		dsaEncoding: "ieee-p1363",
	});
	return `vapid t=${signingInput}.${toBase64Url(signature)}, k=${keys.publicKey}`;
}

/** The origin a subscription's endpoint belongs to. */
export function endpointAudience(endpoint) {
	try {
		return new URL(endpoint).origin;
	} catch {
		return "";
	}
}

// ---------------------------------------------------------------------------
// Payload encryption (RFC 8291 + RFC 8188)
// ---------------------------------------------------------------------------

/** The record size advertised in the framing header. */
const RECORD_SIZE = 4096;

/**
 * Encrypt one push payload for one subscription.
 *
 * @param {{keys: {p256dh: string, auth: string}}} subscription - as stored.
 * @param {string|Buffer} plaintext - the JSON the service worker will read.
 * @returns {Buffer} the complete `aes128gcm` body.
 */
export function encryptPushPayload(subscription, plaintext) {
	const userAgentPublic = fromBase64Url(subscription.keys.p256dh);
	const authSecret = fromBase64Url(subscription.keys.auth);

	// A fresh key pair per message: the RFC requires it, and it keeps the
	// ECDH secret one-shot. ECDH speaks the raw uncompressed point that the
	// subscription carries, so no DER wrapping is involved.
	const ephemeral = createECDH("prime256v1");
	ephemeral.generateKeys();
	const asPublic = ephemeral.getPublicKey();
	const sharedSecret = ephemeral.computeSecret(userAgentPublic);

	const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), userAgentPublic, asPublic]);
	const inputKeyMaterial = Buffer.from(hkdfSync("sha256", sharedSecret, authSecret, keyInfo, 32));

	const salt = randomBytes(16);
	const contentEncryptionKey = Buffer.from(hkdfSync(
		"sha256",
		inputKeyMaterial,
		salt,
		Buffer.from("Content-Encoding: aes128gcm\0"),
		16,
	));
	const nonce = Buffer.from(hkdfSync(
		"sha256",
		inputKeyMaterial,
		salt,
		Buffer.from("Content-Encoding: nonce\0"),
		12,
	));

	// One record only: append the 0x02 padding delimiter that marks the last.
	const record = Buffer.concat([Buffer.from(plaintext, "utf8"), Buffer.from([2])]);
	const cipher = createCipheriv("aes-128-gcm", contentEncryptionKey, nonce);
	const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

	const header = Buffer.concat([
		salt,
		(() => {
			const size = Buffer.alloc(4);
			size.writeUInt32BE(RECORD_SIZE, 0);
			return size;
		})(),
		Buffer.from([asPublic.length]),
		asPublic,
	]);
	return Buffer.concat([header, ciphertext]);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * One-line description of a failed push, including the `fetch` cause.
 *
 * Undici reports a rejected request as `TypeError: fetch failed` and puts the
 * actionable part (for example `UND_ERR_INVALID_ARG`) in `cause`. The cause
 * carries no endpoint or keys, so it is safe to log and show.
 *
 * @param {unknown} error - whatever the send threw.
 * @returns {string} e.g. `fetch failed (UND_ERR_INVALID_ARG: invalid content-length header)`.
 */
export function describePushError(error) {
	const message = String(error?.message ?? error);
	const cause = error?.cause;
	const code = typeof cause?.code === "string" ? cause.code : "";
	const detail = typeof cause?.message === "string" ? cause.message : "";
	const suffix = code !== "" && detail !== "" ? `${code}: ${detail}` : code || detail;
	return suffix === "" ? message : `${message} (${suffix})`;
}

/**
 * Deliver one push message.
 *
 * @param {object} subscription - `{ endpoint, keys }`.
 * @param {object} payload - JSON-serializable notification.
 * @param {object} options
 * @param {{publicKey: string, privateKey: string}} options.keys - VAPID pair.
 * @param {string} options.subject - VAPID contact.
 * @returns {Promise<{ok: boolean, status: number, gone: boolean}>}
 */
export async function sendWebPush(subscription, payload, { keys, subject, transport = securePushRequest }) {
	const audience = endpointAudience(subscription.endpoint);
	if (audience === "") return { ok: false, status: 0, gone: true };

	let body;
	try {
		body = encryptPushPayload(subscription, JSON.stringify(payload));
	} catch {
		// A corrupt or foreign subscription key can never be encrypted for.
		return { ok: false, status: 0, gone: true };
	}

	const response = await transport(subscription.endpoint, {
		method: "POST",
		headers: {
			authorization: vapidAuthorization({ keys, audience, subject }),
			"content-encoding": "aes128gcm",
			"content-type": "application/octet-stream",
			// Let the HTTP transport frame the encrypted bytes (#85).
			ttl: String(PUSH_TTL_SECONDS),
			urgency: "high",
		},
		body,
		redirect: "error",
		signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
	});
	// 404 and 410 are the two ways a push service retires a subscription.
	return { ok: response.status >= 200 && response.status < 300, status: response.status, gone: response.status === 404 || response.status === 410 };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Notification copy and behaviour.
 *
 * Every string is a template. Unknown placeholders survive verbatim so a typo
 * is visible rather than silently dropped.
 */
export const NOTIFY_DEFAULTS = {
	/** Prefix exposed as `{app}`; "" drops it. */
	appName: "DSH",
	/** Language the payload copy is rendered in. */
	lang: "en",
	/** VAPID contact. "" means "use the app's own origin". */
	subject: "",
	/** Only tell the phone about turns the phone itself started. */
	onlyMobileTurns: true,
	turnEndTitle: "{session}",
	turnEndBody: "{detail}",
	questionTitle: "{session}",
	questionBody: "{question}",
};

/** Merge a profile's notification config over the defaults. */
export function normalizeNotifyConfig(input) {
	const source = input !== null && typeof input === "object" && !Array.isArray(input) ? input : {};
	const output = { ...NOTIFY_DEFAULTS };
	for (const key of Object.keys(NOTIFY_DEFAULTS)) {
		if (typeof source[key] === typeof NOTIFY_DEFAULTS[key]) output[key] = source[key];
	}
	return output;
}

/** Replace `{name}` tokens from a plain map. */
export function fillTemplate(template, values) {
	return String(template).replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));
}

/** Fill `{name}` tokens and tolerate a missing dictionary entry. */
function fillCopy(template, values) {
	return typeof template === "string" ? fillTemplate(template, values) : "";
}

/** The dictionary for one payload, defaulting to English. */
function stringsFor(context) {
	return copyFor(typeof context?.lang === "string" ? context.lang : "en");
}

/** Title for a turn-end notification. */
export function buildTurnEndPayload(sessionId, reason, context = {}) {
	const kind = typeof reason?.kind === "string" ? reason.kind : "unknown";
	const strings = stringsFor(context);
	const status = fillCopy(
		strings[`notify.turn.${kind}`] ?? strings["notify.turn.other"],
		{ kind },
	);
	const detail = kind === "completed"
		? strings["notify.turn.detailCompleted"]
		: fillCopy(strings["notify.turn.detailReason"], { kind });
	const copy = context.copy ?? NOTIFY_DEFAULTS;
	const values = {
		app: copy.appName,
		session: context.session ?? "",
		status,
		detail,
		reason: kind,
		header: status,
		question: "",
		count: "",
	};
	return makePayload(
		sessionId,
		"turn-end",
		fillTemplate(copy.turnEndTitle, values) || fillTemplate(copy.appName === "" ? "{status}" : "{app}: {status}", values),
		fillTemplate(copy.turnEndBody, values),
	);
}

/** Payload for one forwarded question request. */
export function buildQuestionPayload(request, context = {}) {
	const questions = Array.isArray(request?.questions) ? request.questions : [];
	const first = questions[0] ?? {};
	const strings = stringsFor(context);
	const header = typeof first.header === "string" && first.header !== "" ? first.header : strings["notify.questionHeader"];
	const question = typeof first.question === "string" ? first.question : "";
	const count = questions.length > 1
		? fillCopy(strings["notify.questionMore"], { count: questions.length - 1 })
		: "";
	const copy = context.copy ?? NOTIFY_DEFAULTS;
	const values = {
		app: copy.appName,
		session: context.session ?? "",
		status: header,
		detail: question,
		reason: "",
		header,
		question,
		count,
	};
	const sessionId = typeof request?.agent?.id === "string" ? request.agent.id : "";
	return makePayload(
		sessionId,
		"question",
		fillTemplate(copy.questionTitle, values) || fillTemplate(copy.appName === "" ? "{header}" : "{app}: {header}", values),
		fillTemplate(copy.questionBody, values),
	);
}

/**
 * One notification payload.
 *
 * `sessionId` rides along so the service worker can tag per session and hand
 * the id back to a live window: the SPA has no URL routing.
 */
export function makePayload(sessionId, kind, title, body) {
	const id = typeof sessionId === "string" ? sessionId : "";
	return {
		title: clip(title, MAX_TITLE_CHARS),
		body: clip(body, MAX_BODY_CHARS),
		kind,
		sessionId: id,
		url: id === "" ? "./" : `./?session=${encodeURIComponent(id)}`,
	};
}

/**
 * Notification copy is capped so one payload stays inside a single
 * `aes128gcm` record. RFC 8188 puts the record size in the header and this
 * implementation declares 4096 bytes; a longer body would produce a body that
 * no receiver can parse.
 */
const MAX_TITLE_CHARS = 120;
const MAX_BODY_CHARS = 700;

/**
 * Cut a string to a character budget, marking the cut with an ellipsis.
 *
 * @param {string} value - text to shorten.
 * @param {number} limit - maximum characters kept.
 * @returns {string} the text, at most `limit` characters plus the ellipsis.
 */
function clip(value, limit) {
	const text = typeof value === "string" ? value : "";
	if (text.length <= limit) return text;
	return `${text.slice(0, limit - 1)}…`;
}

/**
 * Normalize an app origin for storage and comparison.
 *
 * `URL.origin` drops a trailing slash and an explicit default port, so a
 * subscription registered as `https://app.example:443/` matches the request
 * origin `https://app.example`. Values that cannot be parsed are kept as
 * trimmed text so an unusual but previously accepted entry is not discarded.
 *
 * @param {string} value - stored or requested origin.
 * @returns {string} the normalized origin, or "" when absent.
 */
function normalizeOrigin(value) {
	const text = typeof value === "string" ? value.trim() : "";
	if (text === "") return "";
	try {
		return new URL(text).origin;
	} catch {
		return text;
	}
}

/**
 * Whether two recorded app origins name the same deployment.
 *
 * A legacy entry may carry a trailing slash or an explicit default port while
 * the request's origin is the normalized `URL.origin`. Compare the normalized
 * forms so that app can still retire its own subscription.
 *
 * @param {string} left - stored origin.
 * @param {string} right - requesting origin.
 * @returns {boolean} true when both name the same origin.
 */
function sameOrigin(left, right) {
	const a = normalizeOrigin(left);
	const b = normalizeOrigin(right);
	return a !== "" && b !== "" && a === b;
}

// ---------------------------------------------------------------------------
// Store + fan-out
// ---------------------------------------------------------------------------

/**
 * Why an endpoint is not a push service, or undefined when it is.
 *
 * Push endpoints are always https URLs on the service's own host. Anything
 * else (http, loopback, a metadata address, a redirector) is refused: the
 * host POSTs to this URL on every notification.
 *
 * @param {string} endpoint - the subscription endpoint.
 * @returns {string|undefined} a reason to reject, or undefined to accept.
 */
function rejectEndpoint(endpoint) {
	let url;
	try {
		url = new URL(endpoint);
	} catch {
		return "subscription endpoint is not a URL";
	}
	if (url.protocol !== "https:") return "subscription endpoint must be https";
	// A push service is a public host; anything the OS resolves locally is not.
	const host = url.hostname;
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
		return "subscription endpoint must be a public push service";
	}
	if (/^(?:127\.|10\.|192\.168\.|169\.254\.|\[|0\.)/.test(host)) return "subscription endpoint must be a public push service";
	if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) return "subscription endpoint must be a public push service";
	return undefined;
}

/**
 * One entry per endpoint.
 *
 * An endpoint is one browser registration, so pushing to it twice is two
 * system notifications on one device. `PushStore.add` already replaces an
 * endpoint, but a store written by an older host (or by two processes that
 * interleaved a write) can still hold the same endpoint twice; the fan-out
 * must not trust the store to be free of duplicates (#28).
 *
 * @param {object[]} subscriptions - stored entries, newest first.
 * @returns {object[]} the first entry for each endpoint.
 */
function uniqueByEndpoint(subscriptions) {
	const seen = new Set();
	const unique = [];
	for (const item of subscriptions) {
		const endpoint = typeof item?.endpoint === "string" ? item.endpoint : "";
		if (endpoint === "" || seen.has(endpoint)) continue;
		seen.add(endpoint);
		unique.push(item);
	}
	return unique;
}

/** Subscriptions and the VAPID pair, persisted together. */
export class PushStore {
	/**
	 * @param {string} file - JSON file to read and write.
	 */
	constructor(file) {
		this.file = file;
		this.state = readJson(file, null) ?? { vapid: null, subscriptions: [] };
		if (this.state.vapid === null || typeof this.state.vapid.publicKey !== "string") {
			this.state.vapid = generateVapidKeys();
			this.save();
		}
		if (!Array.isArray(this.state.subscriptions)) this.state.subscriptions = [];
	}

	/**
	 * Persist the current state.
	 *
	 * Several profiles can share one `DSH_HOME`, so the push state is read
	 * fresh before every write and only this process's change is applied. A
	 * blind overwrite would let whichever instance saved last erase the other
	 * profile's subscriptions.
	 */
	save() {
		writeJsonAtomically(this.file, this.state);
	}

	/** Re-read the file, keeping this process's VAPID pair. */
	reload() {
		const fresh = readJson(this.file, null);
		if (fresh !== null && typeof fresh === "object" && Array.isArray(fresh.subscriptions)) {
			this.state.subscriptions = fresh.subscriptions;
		}
	}

	/** The VAPID pair, generating it on first use. */
	keys() {
		return this.state.vapid;
	}

	/**
	 * Every live subscription, as stored right now.
	 *
	 * @param {object} [filter] - `{ origins }`: keep only these origins (plus
	 *   entries written before the origin was recorded). `{ exactOrigins: true }`
	 *   drops those legacy entries and matches only the named origins.
	 * @returns {object[]} matching subscriptions.
	 */
	subscriptions(filter) {
		this.reload();
		const origins = filter?.origins;
		if (!Array.isArray(origins) || origins.length === 0) return this.state.subscriptions;
		// Compare through `sameOrigin`, not string equality: an entry written
		// before origins were normalized can carry a trailing slash or an
		// explicit `:443` and must still route to its own app.
		const requested = (item) => origins.some((origin) => sameOrigin(item.origin, origin));
		if (filter?.exactOrigins === true) {
			return this.state.subscriptions.filter((item) => typeof item.origin === "string" && requested(item));
		}
		return this.state.subscriptions.filter((item) => typeof item.origin !== "string" || item.origin === "" || requested(item));
	}

	/**
	 * Add or refresh one subscription, retiring the registration it replaced.
	 *
	 * A browser can replace its push registration (reinstall, RFC 8030
	 * rotation). The replaced endpoint is unreachable from the page but still
	 * delivered to the same device, so leaving it stored makes every
	 * notification arrive twice — the foreground banner plus a system
	 * notification from the stale copy (#98). The page names the endpoint it
	 * held last, and only that exact entry is dropped.
	 *
	 * The endpoint is per browser registration, not per origin or user agent.
	 * If a device cannot name its old endpoint, only an explicit unsubscribe
	 * or a 404/410 from the push service can safely retire it.
	 *
	 * @param {object} subscription - `{ endpoint, keys }` from the browser.
	 * @param {object} [meta] - `{ label, origin, previousEndpoint }` for the
	 *   VAPID contact and for the registration this browser replaced.
	 * @returns {number} how many subscriptions are stored now.
	 */
	add(subscription, meta = {}) {
		const endpoint = subscription?.endpoint;
		if (typeof endpoint !== "string" || endpoint === "") throw new Error("subscription has no endpoint");
		if (typeof subscription?.keys?.p256dh !== "string" || typeof subscription?.keys?.auth !== "string") {
			throw new Error("subscription has no client keys");
		}
		// The host POSTs to whatever is stored here, so an unvalidated endpoint
		// would let a caller park an internal URL in the store and have every
		// later notification hit it. Accept only real push services over https.
		const rejection = rejectEndpoint(endpoint);
		if (rejection !== undefined) throw new Error(rejection);
		const entry = {
			endpoint,
			keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
			label: typeof meta.label === "string" ? meta.label.slice(0, 120) : "",
			// Store the canonical origin so exact-origin routing (which compares
			// against a request's URL.origin) cannot miss a new subscription
			// just because the caller sent a trailing slash or `:443`. Entries
			// already on disk are not rewritten: an unnormalized legacy entry
			// can still miss exact routing until the app subscribes again.
			origin: normalizeOrigin(meta.origin),
			addedAt: Date.now(),
		};
		const previous = typeof meta.previousEndpoint === "string" ? meta.previousEndpoint : "";
		this.reload();
		let kept = this.state.subscriptions.filter((item) => item.endpoint !== endpoint);
		// Same origin only: the endpoint came from this browser, but an entry
		// owned by another app is not this registration's to remove.
		if (previous !== "" && previous !== endpoint) {
			kept = kept.filter((item) => !(item.endpoint === previous && sameOrigin(item.origin, entry.origin)));
		}
		if (kept.length >= MAX_SUBSCRIPTIONS) throw new Error("push subscription limit reached; remove an obsolete subscription first");
		this.state.subscriptions = [entry, ...kept];
		this.save();
		return this.state.subscriptions.length;
	}

	/**
	 * Drop one subscription.
	 *
	 * @param {string} endpoint - the endpoint to forget.
	 * @param {string} [origin] - the requesting app's origin. When it is known
	 *   and the stored entry belongs to another origin, the entry is kept:
	 *   profiles share this file, and one app's Settings should not retire the
	 *   other app's live subscription. This is an ownership-consistency check,
	 *   not an authentication boundary (the endpoint is not a secret). A
	 *   missing/legacy origin stays removable so an upgrade can clean up (and
	 *   404/410 pruning passes no origin at all). Origins are compared through
	 *   `URL`, so a trailing slash or an explicit default port in an older
	 *   entry does not stop its own app from removing it.
	 * @returns {boolean} whether anything was removed.
	 */
	remove(endpoint, origin = "") {
		this.reload();
		const before = this.state.subscriptions.length;
		this.state.subscriptions = this.state.subscriptions.filter((item) => {
			if (item.endpoint !== endpoint) return true;
			const requester = typeof origin === "string" ? origin : "";
			const owner = typeof item.origin === "string" ? item.origin : "";
			return requester !== "" && owner !== "" && !sameOrigin(owner, requester);
		});
		if (this.state.subscriptions.length !== before) this.save();
		return this.state.subscriptions.length !== before;
	}

	/**
	 * The VAPID contact to use.
	 *
	 * Apple rejects `mailto:root@localhost` with 403 BadJwtToken, so an https
	 * origin is the reliable fallback; the newest subscription remembers the
	 * origin the app was served from.
	 *
	 * @param {string} configured - the profile's `subject`, or "".
	 * @returns {string} a `mailto:` or `https:` contact.
	 */
	subject(configured) {
		if (typeof configured === "string" && configured !== "") return configured;
		for (const item of this.state.subscriptions) {
			if (typeof item.origin === "string" && item.origin.startsWith("https://")) return item.origin;
		}
		return "mailto:dsh@example.com";
	}
}

// ---------------------------------------------------------------------------
// Session names
// ---------------------------------------------------------------------------

/**
 * One-line session name for a notification.
 *
 * The title service is the source of truth; before a title exists the session
 * is known by its working directory, which is what the header shows too.
 *
 * @param {object} ctx - plugin context (for the optional title service).
 * @param {object} session - live session.
 * @returns {string} the name, or "" when neither source has one.
 */
export function sessionNameOf(ctx, session) {
	try {
		const title = ctx.sessionTitle?.get(session)?.title;
		if (typeof title === "string" && title.trim() !== "") return title.trim();
	} catch {
		/* the title plugin is optional */
	}
	const cwd = typeof session?.header?.cwd === "string" ? session.header.cwd : "";
	const base = cwd.split(/[\\/]/).filter(Boolean).pop();
	return typeof base === "string" ? base : "";
}

// ---------------------------------------------------------------------------
// Plugin half
// ---------------------------------------------------------------------------

/** Read a request body as UTF-8, refusing anything oversized. */
function readBody(req, limit = 64 * 1024) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/** Parse a JSON body, tolerating an empty one. */
async function readJsonBody(req) {
	try {
		const text = await readBody(req);
		return text === "" ? {} : JSON.parse(text);
	} catch {
		return {};
	}
}

/**
 * Mount notifications: routes for the browser half plus the push fan-out.
 *
 * @param {object} ctx - plugin context.
 * @param {object} config - normalized notification config.
 */
export function applyNotify(ctx, config, { transport = securePushRequest } = {}) {
	const store = new PushStore(join(stateDirectory(), "push.json"));
	const copy = normalizeNotifyConfig(config);
	/** RPC ids explicitly marked by a browser, consumed by the matching user message. */
	const mobileSends = new Map();
	/** The turn now running in a session: `{ fromPhone, origins }`. */
	const turnMobile = new Map();
	/** The origin that most recently started a turn in a session. */
	const lastTurnOrigin = new Map();

	/**
	 * The public origins this process has served, most recently seen first.
	 *
	 * Profiles share `DSH_HOME`, so one `push.json` can hold subscriptions
	 * created through several instances. Only the instance the browser
	 * actually talked to should deliver to that browser; otherwise the same
	 * event is pushed twice (once per installed origin) and a tap can land on
	 * the other instance. A request's referer is the page that made it, so its
	 * origin is exactly the deployment this process is serving.
	 *
	 * Ordered rather than a Set because the newest origin is the only fallback
	 * target (#27): a phone can have both the legacy and the unified app
	 * installed, and notifying both is the double notification this list
	 * exists to prevent (#28).
	 */
	const ownOrigins = [];
	let originFile = null;
	let savedOrigins = "";

	/** Enough remembered origins for two apps plus a proxy and a stale tab. */
	const MAX_OWN_ORIGINS = 8;

	/** Allow a foreground client to render and acknowledge before sending push. */
	const NOTICE_ACK_GRACE_MS = 1500;
	/** Only actual, in-flight notices are kept: nothing remains after the grace. */
	const pendingNotices = new Set();

	/**
	 * Acknowledge one notice for one subscription, only if that origin is a
	 * target of a currently pending delivery. An unsolicited/stale ack cannot
	 * suppress a later event, and another device still receives its push.
	 *
	 * The oldest unacknowledged event is consumed first. A payload carries no
	 * event id and the status hook exposes none, so an ACK names a session and a
	 * kind, not one event; insertion order is the only rule that leaves a newer,
	 * still-unacknowledged event its push. An ACK that arrives late can still
	 * land on the wrong event of the same session and kind — that gap is known
	 * and accepted, not silently guessed at.
	 */
	function acknowledgeNotice({ endpoint, sessionId, kind, origin }) {
		if (typeof endpoint !== "string" || endpoint === "") return false;
		if (typeof sessionId !== "string" || sessionId === "") return false;
		if (kind !== "turn-end" && kind !== "question") return false;
		for (const pending of pendingNotices) {
			if (pending.payload.sessionId !== sessionId || pending.payload.kind !== kind) continue;
			if (!sameOrigin(pending.origin, origin)) continue;
			if (!pending.endpoints.has(endpoint) || pending.acked.has(endpoint)) continue;
			pending.acked.add(endpoint);
			return true;
		}
		return false;
	}

	/** Record one origin as the most recently served. */
	function learnOrigin(value) {
		const text = typeof value === "string" ? value.trim() : "";
		if (text === "") return;
		let origin;
		try {
			origin = new URL(text).origin;
		} catch {
			/* not an origin (a bare host, a path): not something a request had */
			return;
		}
		if (origin === "" || origin === "null") return;
		const existing = ownOrigins.indexOf(origin);
		if (existing !== -1) ownOrigins.splice(existing, 1);
		ownOrigins.unshift(origin);
		if (ownOrigins.length > MAX_OWN_ORIGINS) ownOrigins.length = MAX_OWN_ORIGINS;
		persistOrigins();
	}

	/** Persist only learned origins that can receive push, isolated per profile. */
	function persistOrigins() {
		if (originFile === null) return;
		const subscriptions = store.subscriptions();
		const origins = ownOrigins.filter((origin) => subscriptions.some((item) => sameOrigin(item.origin, origin)));
		const pending = [...mobileSends].map(([key, item]) => ({ key, ...item }));
		const serialized = JSON.stringify({ origins, pending });
		if (serialized === savedOrigins) return;
		try {
			writeJsonAtomically(originFile, { origins, pending });
			savedOrigins = serialized;
		} catch (error) {
			console.warn("[dsh-mobile-maxxing] cannot save profile push origins:", error?.message ?? error);
		}
	}

	ctx.inject(["profileContext"], (profileCtx) => {
		const profile = profileCtx.profileContext ?? profileCtx.get?.("profileContext");
		if (typeof profile?.name !== "string" || !/^[a-zA-Z0-9._-]+$/.test(profile.name)) return;
		originFile = join(stateDirectory(), `push-origins-${profile.name}.json`);
		const saved = readJson(originFile, {});
		const subscriptions = store.subscriptions();
		if (Array.isArray(saved.origins)) {
			for (const value of saved.origins.slice(0, MAX_OWN_ORIGINS)) {
				const origin = normalizeOrigin(value);
				if (origin && !ownOrigins.includes(origin) && subscriptions.some((item) => sameOrigin(item.origin, origin))) ownOrigins.push(origin);
			}
		}
		if (Array.isArray(saved.pending)) {
			for (const item of saved.pending.slice(0, 2048)) {
				if (typeof item?.key !== "string" || !item.key.includes("\0") || typeof item.at !== "number" || Date.now() - item.at >= 7 * 24 * 60 * 60 * 1000 || typeof item.origin !== "string") continue;
				if (!mobileSends.has(item.key)) mobileSends.set(item.key, { at: item.at, origin: normalizeOrigin(item.origin) || "" });
			}
		}
		persistOrigins();
	});

	/**
	 * The first usable origin on a request: body.origin, Origin, then Referer.
	 *
	 * The page's own claim wins because a reverse proxy (or the host's
	 * `--public-url` setup) can present an inner http origin in the headers
	 * while the browser still reports the public origin in the body. Every
	 * client in this package sends `origin`, so a header is only the fallback
	 * for a hand-rolled request.
	 *
	 * @param {object} req - the HTTP request.
	 * @param {object} [body] - the parsed JSON body, when the route has one.
	 * @returns {string} the normalized origin, or "".
	 */
	function requestOrigin(req, body) {
		const candidates = [
			typeof body?.origin === "string" ? body.origin : undefined,
			req?.headers?.origin,
			req?.headers?.referer,
		];
		for (const candidate of candidates) {
			if (typeof candidate !== "string" || candidate === "") continue;
			try {
				const origin = new URL(candidate).origin;
				if (origin !== "null") return origin;
			} catch {
				/* a malformed header is not worth failing the request over */
			}
		}
		return "";
	}

	/** Remember the app origin a request came from; one origin per request. */
	function noteOrigin(req, body) {
		const origin = requestOrigin(req, body);
		if (origin !== "") learnOrigin(origin);
	}

	/**
	 * The single origin a payload may be delivered to.
	 *
	 * 1. an explicit target (the app that started the turn, or asked for the
	 *    test) — exact match only;
	 * 2. the most recently learned origin that still has a subscription;
	 * 3. "" — the caller sends nothing.
	 *
	 * There is deliberately no all-subscriptions fallback (#27). With both the
	 * legacy and the unified app installed, that fallback delivered one turn
	 * twice, once per app (#28); a background notification that cannot be
	 * attributed is dropped and logged instead of guessed at.
	 *
	 * @param {string} [explicit] - the event's own origin, when it has one.
	 * @returns {string} the target origin, or "" when none is usable.
	 */
	function resolveOrigin(explicit) {
		const requested = normalizeOrigin(explicit);
		if (requested !== "") return requested;
		if (ownOrigins.length === 0) return "";
		const stored = store.subscriptions();
		for (const origin of ownOrigins) {
			// A learned origin with no subscription (the inner side of a proxy,
			// or an app whose notification permission was revoked) would make
			// the push vanish; the newest origin that can actually be reached
			// is still "the app that talked to this host last".
			if (stored.some((item) => sameOrigin(item.origin, origin))) return origin;
		}
		return "";
	}

	/**
	 * Send one payload to the subscriptions this event belongs to.
	 *
	 * @param {object} payload - push payload.
	 * @param {object} [target] - `{ origin }` for an exact origin.
	 * @returns {Promise<object>} per-subscription results, plus `targetOrigin`
	 *   and, when nothing was sent, a `reason` (`no-origin` or
	 *   `no-subscription`).
	 */
	async function fanOut(payload, target = {}) {
		const targetOrigin = resolveOrigin(target.origin);
		if (targetOrigin === "") {
			// The only observable signal for a dropped push, so it is explicit.
			console.warn("[dsh-mobile-maxxing] push skipped: no app origin has talked to this host yet");
			return { ok: false, reason: "no-origin", results: [], targetOrigin: "" };
		}
		// One endpoint is one browser registration; a duplicate would show the
		// same notification twice on one device (#28).
		const subscriptions = uniqueByEndpoint(store.subscriptions({ origins: [targetOrigin], exactOrigins: true }));
		if (subscriptions.length === 0) {
			console.warn(`[dsh-mobile-maxxing] push skipped: ${targetOrigin} has no push subscription`);
			return { ok: false, reason: "no-subscription", results: [], targetOrigin };
		}
		const subject = store.subject(copy.subject);
		const results = [];
		let pending = null;
		if (target.awaitAck === true && typeof payload?.sessionId === "string" && payload.sessionId !== "") {
			pending = {
				payload,
				origin: targetOrigin,
				endpoints: new Set(subscriptions.map((item) => item.endpoint)),
				acked: new Set(),
			};
			pendingNotices.add(pending);
			try {
				await new Promise((resolve) => setTimeout(resolve, NOTICE_ACK_GRACE_MS));
			} finally {
				pendingNotices.delete(pending);
			}
		}
		results.push(...await Promise.all(subscriptions.map(async (subscription) => {
			// Only an acknowledged notice suppresses this particular endpoint.
			if (pending?.acked.has(subscription.endpoint)) return { status: 0, ok: true, skipped: "acknowledged" };
			try {
				const result = await sendWebPush(subscription, payload, { keys: store.keys(), subject, transport });
				if (result.gone) store.remove(subscription.endpoint);
				return { status: result.status, ok: result.ok };
			} catch (error) {
				return { status: 0, ok: false, error: describePushError(error) };
			}
		})));
		const everyDelivered = results.every((item) => item.ok);
		const skipped = results.length > 0 && results.every((item) => item.skipped === "acknowledged")
			? "acknowledged"
			: undefined;
		return { ok: results.length > 0 && everyDelivered, subject, results, targetOrigin, skipped };
	}

	ctx.inject(["agents"], (agentCtx) => {
		const agents = agentCtx.get("agents");
		agentCtx.on("session/event", (session, event) => {
			if (event?.type === "turn/start") {
				turnMobile.set(session.id, { fromPhone: false, origins: new Set() });
				return;
			}
			if (event?.type === "user/message") {
				const id = event.data?.source?.rpcId;
				const key = typeof id === "string" ? session.id + "\0" + id : "";
				const marked = mobileSends.get(key);
				if (marked !== undefined) {
					mobileSends.delete(key);
					persistOrigins();
					const turn = turnMobile.get(session.id);
					if (turn !== undefined && Date.now() - marked.at < 7 * 24 * 60 * 60 * 1000) {
						turn.fromPhone = true;
						if (marked.origin !== "") {
							turn.origins.add(marked.origin);
							lastTurnOrigin.set(session.id, marked.origin);
						}
					}
				}
				return;
			}
			if (event?.type !== "turn/end") return;
			const turn = turnMobile.get(session.id);
			const fromPhone = turn?.fromPhone === true;
			const origins = turn?.origins?.size ? [...turn.origins] : [""];
			turnMobile.delete(session.id);
			if (copy.onlyMobileTurns && !fromPhone) return;
			// Root sessions only: a subagent finishing is not news.
			const agent = agents?.get(session.id);
			if (agent === undefined || !agents.roots().includes(agent)) return;
			const payload = buildTurnEndPayload(session.id, event.data?.reason, {
				copy, lang: copy.lang, session: sessionNameOf(ctx, session),
			});
			for (const origin of origins) void fanOut(payload, { origin, awaitAck: true }).catch((error) => {
				console.error("[dsh-mobile-maxxing] turn-end push failed", error);
			});
		});
		agentCtx.effect(() => agentCtx.on("user-questions/request", function (request, next) {
			// Outermost listener: fire and forget, then let the real answerer run.
			const id = request?.agent?.id;
			const agent = typeof id === "string" ? agents?.get(id) : undefined;
			if (agent !== undefined && agents.roots().includes(agent)) {
				const asking = request?.agent?.session;
				// Prefer the origin that most recently started a turn in this
				// session; otherwise fanOut uses the newest origin this host
				// learned, and sends nothing when it has learned none (#27).
				const origin = typeof id === "string" ? (lastTurnOrigin.get(id) || "") : "";
				void fanOut(buildQuestionPayload(request, {
					copy,
					lang: copy.lang,
					session: asking === undefined ? "" : sessionNameOf(ctx, asking),
				}), { origin, awaitAck: true }).catch((error) => {
					console.error("[dsh-mobile-maxxing] question push failed", error);
				});
			}
			return next();
		}, { prepend: true }), "dsh-mobile-maxxing: question push fan-out");
	});

	ctx.inject(["connection", "webServer"], (routeCtx) => {
		const connection = routeCtx.connection;
		// A restart has not seen a request yet. Adopt webServer.getOrigin()
		// only when it matches an already stored subscription origin; an
		// internal origin behind --public-url would otherwise filter every
		// push out. No guess is made when it does not match. Adopting a
		// matching origin is what keeps background pushes working across a
		// restart without falling back to every stored subscription (#27).
		try {
			const serverOrigin = new URL(routeCtx.webServer.getOrigin()).origin;
			if (ownOrigins.length === 0 && serverOrigin !== "null" && store.subscriptions().some((item) => sameOrigin(item.origin, serverOrigin))) {
				learnOrigin(serverOrigin);
			}
		} catch {
			/* no getOrigin or an unusable value: keep request-derived origins */
		}
		const json = (res, status, value) => {
			res.writeHead(status, {
				"content-type": "application/json; charset=utf-8",
				"cache-control": "no-store",
			});
			res.end(JSON.stringify(value));
		};
		/** Refuse anyone the Web server would not have served anyway. */
		const guard = (req, res, body) => {
			const rejection = connection.requestRejection(req);
			if (rejection !== undefined) {
				res.writeHead(rejection);
				res.end(rejection === 401 ? "unauthorized" : "forbidden");
				return false;
			}
			// Learn the origin only from a request the Web server accepted: an
			// unauthenticated caller must not be able to redirect this host's
			// pushes by claiming an origin.
			noteOrigin(req, body);
			return true;
		};

		const routes = [
			{
				kind: "exact",
				path: "/api/dsh-mobile-maxxing/push/vapid",
				handler: (req, res) => {
					if (!guard(req, res)) return;
					json(res, 200, { ok: true, publicKey: store.keys().publicKey, subject: store.subject(copy.subject) });
				},
			},
			{
				kind: "exact",
				path: "/api/dsh-mobile-maxxing/push/config",
				handler: (req, res) => {
					if (!guard(req, res)) return;
					// The page renders its own in-app banners, so it needs the
					// same copy the host would have pushed.
					json(res, 200, { ok: true, copy: { ...copy, subject: store.subject(copy.subject) } });
				},
			},
			{
				kind: "exact",
				path: "/api/dsh-mobile-maxxing/push/subscribe",
				handler: async (req, res) => {
					if (!guard(req, res)) return;
					if (req.method !== "POST") {
						res.writeHead(405, { allow: "POST" });
						res.end();
						return;
					}
					const body = await readJsonBody(req);
					noteOrigin(req, body);
					try {
						// `requestOrigin` prefers the page's explicit
						// `body.origin`: behind a proxy the request's
						// Origin/Referer can be the inner http origin while the
						// browser still reports the public origin in the body,
						// and overwriting it would misroute the push. The
						// headers remain the fallback for a hand-rolled request.
						const origin = requestOrigin(req, body);
						const count = store.add(body.subscription, {
							label: body.label,
							origin,
							// The endpoint this browser held before this
							// registration; see `PushStore.add` (#98).
							previousEndpoint: body.previousEndpoint,
						});
						persistOrigins();
						json(res, 200, { ok: true, count, subject: store.subject(copy.subject) });
					} catch (error) {
						json(res, 400, { ok: false, error: String(error?.message ?? error) });
					}
				},
			},
			{
				kind: "exact",
				path: "/api/dsh-mobile-maxxing/push/unsubscribe",
				handler: async (req, res) => {
					if (!guard(req, res)) return;
					if (req.method !== "POST") {
						res.writeHead(405, { allow: "POST" });
						res.end();
						return;
					}
					const body = await readJsonBody(req);
					noteOrigin(req, body);
					const endpoint = typeof body.endpoint === "string" ? body.endpoint : body.subscription?.endpoint;
					// Scope the delete to the app that asked: the shared store
					// also holds the other installed origin's subscription.
					const removed = typeof endpoint === "string" ? store.remove(endpoint, requestOrigin(req, body)) : false;
					json(res, 200, { ok: true, removed, count: store.subscriptions().length });
				},
			},
			{
				kind: "exact",
				path: "/api/dsh-mobile-maxxing/push/ack",
				handler: async (req, res) => {
					if (!guard(req, res)) return;
					if (req.method !== "POST") {
						res.writeHead(405, { allow: "POST" });
						res.end();
						return;
					}
					const body = await readJsonBody(req);
					noteOrigin(req, body);
					const acknowledged = acknowledgeNotice({
						endpoint: body?.endpoint,
						sessionId: body?.sessionId,
						kind: body?.kind,
						origin: requestOrigin(req, body),
					});
					json(res, 200, { ok: true, acknowledged });
				},
			},
			{
				kind: "exact",
				path: "/api/dsh-mobile-maxxing/push/mobile-send",
				handler: async (req, res) => {
					if (!guard(req, res)) return;
					if (req.method !== "POST") {
						res.writeHead(405, { allow: "POST" });
						res.end();
						return;
					}
					const body = await readJsonBody(req);
					noteOrigin(req, body);
					if (typeof body.sessionId !== "string" || body.sessionId === "" || body.sessionId.includes("\0")
						|| typeof body.requestId !== "string" || body.requestId === "" || body.requestId.length > 256 || body.requestId.includes("\0")) {
						json(res, 400, { error: "sessionId and requestId are required" });
						return;
					}
					// shortcut: orphaned/failed prompts expire after seven days; extend this for queues kept longer.
					const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
					for (const [key, item] of mobileSends) if (item.at < cutoff) mobileSends.delete(key);
					const key = body.sessionId + "\0" + body.requestId;
					if (!mobileSends.has(key) && mobileSends.size >= 2048) {
						json(res, 429, { error: "too many pending notifications" });
						return;
					}
					mobileSends.set(key, { at: Date.now(), origin: requestOrigin(req, body) });
					persistOrigins();
					json(res, 200, { ok: true });
				},
			},
			{
				kind: "exact",
				path: "/api/dsh-mobile-maxxing/push/preview",
				handler: (req, res) => {
					if (!guard(req, res)) return;
					// Answers "what would you send?" without sending anything.
					const url = new URL(req.url ?? "/", "http://127.0.0.1");
					const sessionId = url.searchParams.get("sessionId") ?? "";
					const previewStrings = copyFor(copy.lang);
					const agents = ctx.get("agents");
					const session = sessionId === "" ? undefined : agents?.get(sessionId)?.session;
					const name = session === undefined ? "" : sessionNameOf(ctx, session);
					json(res, 200, {
						ok: true,
						sessionId,
						sessionName: name,
						copy,
						subject: store.subject(copy.subject),
						turnEnd: buildTurnEndPayload(sessionId, { kind: "completed" }, { copy, lang: copy.lang, session: name }),
						question: buildQuestionPayload({
							agent: { id: sessionId },
							questions: [{
								header: previewStrings["notify.questionHeader"],
								question: previewStrings["notify.previewQuestion"],
							}],
						}, { copy, lang: copy.lang, session: name }),
					});
				},
			},
			{
				kind: "exact",
				path: "/api/dsh-mobile-maxxing/push/test",
				handler: async (req, res) => {
					if (!guard(req, res)) return;
					if (req.method !== "POST") {
						res.writeHead(405, { allow: "POST" });
						res.end();
						return;
					}
					const body = await readJsonBody(req);
					noteOrigin(req, body);
					const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
					const strings = copyFor(copy.lang);
					const result = await fanOut(makePayload(
						sessionId,
						"test",
						strings["notify.testTitle"],
						strings["notify.testPayloadBody"],
					), { origin: requestOrigin(req, body) });
					// A skipped push must not look like a delivered one: the
					// Settings button reads `ok` to decide between "sent" and an
					// error, and a silently empty fan-out used to report success.
					const failure = result.results.find((item) => item.ok === false && typeof item.error === "string");
					const error = result.ok
						? undefined
						: result.reason === "no-origin"
							? "no app origin has talked to this host yet; reload the app once"
							: result.reason === "no-subscription"
								? `no push subscription for ${result.targetOrigin}`
								: failure === undefined
									? "no push was delivered"
									: `no push was delivered: ${failure.error}`;
					json(res, 200, { ok: result.ok, ...result, error, count: store.subscriptions().length });
				},
			},
		];
		for (const route of routes) routeCtx.effect(() => routeCtx.webServer.register(route), `dsh-mobile-maxxing: ${route.path}`);
	});

	return { store, fanOut };
}
