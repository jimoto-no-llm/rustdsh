/**
 * rdsh-mobile-ux — host half.
 *
 * The browser half owns layout, input handling, notifications and the hide
 * list. The host half also exposes per-session live output speed, measured
 * from the stream's text deltas.
 *
 * @module rdsh-mobile-ux
 */
export const inject = [];

import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

/** Accepted config keys (documented in README.md). */
export const DEFAULTS = {
	/** Extra labels to hide on phones, merged with the built-in list. */
	hideLabels: [],
	/** Disable hiding entirely (debugging). */
	showHiddenControls: false,
	/** Session-label activity animation: aurora | breathing | outline | none. */
	runningAnimation: "outline",
	/**
	 * Provider ids whose streams feed the live speed readout. An empty list
	 * means every provider. Restrict it only when one provider's deltas are
	 * known to be meaningless (for example a proxy that streams whole blocks).
	 */
	liveSpeedProviders: [],
};

const LIVE_SPEED_PATH = "/api/rdsh-mobile-ux/live-speed";
export const DOWNLOAD_PATH = "/api/rdsh-mobile-ux/download";

const DOWNLOAD_MIME = {
	txt: "text/plain", log: "text/plain", md: "text/markdown", json: "application/json",
	csv: "text/csv", html: "text/html", png: "image/png", jpg: "image/jpeg",
	jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
	pdf: "application/pdf", zip: "application/zip", mp4: "video/mp4", mp3: "audio/mpeg",
};

/**
 * Resolve one download request to a regular file inside the session's
 * workspace. Anything else — a missing session, a path escaping the
 * workspace (including through a symlink), a directory — is refused by
 * returning null, so the route can answer a plain 404 for all of them.
 *
 * @param {object} sessions - the host sessions service.
 * @param {string} sessionId - session the file was presented in.
 * @param {string} requested - absolute path or workspace-relative path.
 * @returns {Promise<{target: string, name: string, size: number} | null>}
 */
export async function resolveDownloadTarget(sessions, sessionId, requested) {
	if (typeof sessionId !== "string" || sessionId === "") return null;
	if (typeof requested !== "string" || requested === "" || requested.includes("\0")) return null;
	const header = sessions?.get?.(sessionId)?.header;
	const rootRaw = header?.cwd;
	if (typeof rootRaw !== "string" || rootRaw === "") return null;
	try {
		const root = await realpath(rootRaw);
		const candidate = path.isAbsolute(requested) ? requested : path.resolve(root, requested);
		const target = await realpath(candidate);
		const relative = path.relative(root, target);
		if (relative === "" || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return null;
		const info = await stat(target);
		if (!info.isFile()) return null;
		return { target, name: path.basename(target), size: info.size };
	} catch {
		return null;
	}
}

/** Content-Disposition for a download, with a UTF-8 filename. */
function downloadDisposition(name) {
	const fallback = name.replace(/[^ -~]/g, "_").replace(/["\\]/g, "_") || "download";
	return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
const LIVE_SPEED_WINDOW_MS = 1000;
const LIVE_SPEED_STALE_MS = 1500;

// shortcut: counts text-delta events as tokens, switch to adapter token counts when available.
export function recordLiveToken(samples, now) {
	samples.push(now);
	while (samples.length > 0 && now - samples[0] > LIVE_SPEED_WINDOW_MS) samples.shift();
	if (samples.length < 2 || now <= samples[0]) return null;
	return Math.round((samples.length - 1) * 1000 / (now - samples[0]));
}

/**
 * @param {object} [config] - profile config for this plugin.
 * @returns {object} normalized config.
 */
export function normalizeConfig(config) {
	const source = config !== null && typeof config === "object" && !Array.isArray(config) ? config : {};
	const labels = Array.isArray(source.hideLabels)
		? source.hideLabels.filter((label) => typeof label === "string" && label.trim() !== "").map((label) => label.trim())
		: [];
	const animation = ["aurora", "breathing", "outline", "none"].includes(source.runningAnimation)
		? source.runningAnimation
		: DEFAULTS.runningAnimation;
	const providers = Array.isArray(source.liveSpeedProviders)
		? source.liveSpeedProviders.filter((id) => typeof id === "string" && id.trim() !== "").map((id) => id.trim())
		: [];
	return {
		hideLabels: labels,
		showHiddenControls: source.showHiddenControls === true,
		runningAnimation: animation,
		liveSpeedProviders: providers,
	};
}

/**
 * Publish the normalized config to the browser half through the served index.
 * The client bundle is static, so this one-time injection is how profile
 * config reaches it; the tap composes with every other index tap.
 *
 * @param {object} ctx - plugin context.
 * @param {object} [config] - profile config for this plugin.
 */
export function apply(ctx, config) {
	const normalized = normalizeConfig(config);
	const payload = JSON.stringify(normalized).replaceAll("<", "\\u003c");
	const liveBySession = new Map();
	/** An empty allowlist means every provider: the readout is generic. */
	const providerAllowed = (provider) => normalized.liveSpeedProviders.length === 0
		|| normalized.liveSpeedProviders.includes(provider);

	ctx.on("llm/stream", (options, next) => {
		// A session-title generation would show up as output speed for the
		// session the user is reading, so only real turns are measured.
		if (!providerAllowed(options.provider) || options.sessionId === undefined || options.purpose !== undefined) return next();
		const state = { samples: [], snapshot: null };
		liveBySession.set(options.sessionId, state);
		return (async function* () {
			try {
				for await (const chunk of next()) {
					if (chunk.type === "text-delta" && chunk.text.length > 0) {
						const now = Date.now();
						const tps = recordLiveToken(state.samples, now);
						state.snapshot = tps === null ? null : { tps, updatedAt: now };
					}
					yield chunk;
				}
			} finally {
				if (liveBySession.get(options.sessionId) === state) liveBySession.delete(options.sessionId);
			}
		})();
	}, { global: true });

	// `connection` is only needed to answer 401/403 like every other route in
	// this package; without it the readout would be world-readable.
	ctx.inject(["webServer", "connection"], (webCtx) => {
		const disposeIndex = webCtx.webServer.tapIndex((html) => html.replace(
			/<head(\s[^>]*)?>/i,
			(open) => `${open}<script>globalThis.__RDSH_MOBILE_UX_CONFIG__=${payload}<\/script>`,
		));
		const disposeRoute = webCtx.webServer.register({
			kind: "exact",
			path: LIVE_SPEED_PATH,
			handler(req, res) {
				const rejection = webCtx.connection?.requestRejection(req);
				if (rejection !== undefined) {
					res.writeHead(rejection);
					res.end(rejection === 401 ? "unauthorized" : "forbidden");
					return;
				}
				if (req.method !== "GET" && req.method !== "HEAD") {
					res.writeHead(405, { allow: "GET, HEAD" });
					res.end();
					return;
				}
				const sessionId = new URL(req.url || "/", "http://dsh.local").searchParams.get("sessionId");
				const snapshot = sessionId === null ? null : liveBySession.get(sessionId)?.snapshot;
				const fresh = snapshot !== null && snapshot !== undefined && Date.now() - snapshot.updatedAt <= LIVE_SPEED_STALE_MS;
				const body = JSON.stringify(fresh ? { tps: snapshot.tps } : null);
				res.writeHead(200, {
					"content-type": "application/json; charset=utf-8",
					"cache-control": "no-store",
				});
				res.end(req.method === "HEAD" ? undefined : body);
			},
		});
		return () => {
			if (typeof disposeIndex === "function") disposeIndex();
			if (typeof disposeRoute === "function") disposeRoute();
		};
	});

	// Presented-file downloads. A phone browser/WebView cannot be relied on
	// to save a blob: URL created after an async read (Android hands blob
	// downloads to the system, where they fail), so the file is also offered
	// as a plain streamed HTTP download. Only files inside the session's
	// own workspace are served; resolveDownloadTarget keeps this from
	// becoming a general file-reading route.
	ctx.inject(["webServer", "connection", "sessions"], (dlCtx) => {
		const disposeRoute = dlCtx.webServer.register({
			kind: "exact",
			path: DOWNLOAD_PATH,
			handler(req, res) {
				void (async () => {
					const rejection = dlCtx.connection?.requestRejection(req);
					if (rejection !== undefined) {
						res.writeHead(rejection);
						res.end(rejection === 401 ? "unauthorized" : "forbidden");
						return;
					}
					if (req.method !== "GET" && req.method !== "HEAD") {
						res.writeHead(405, { allow: "GET, HEAD" });
						res.end();
						return;
					}
					const query = new URL(req.url || "/", "http://dsh.local").searchParams;
					const found = await resolveDownloadTarget(
						dlCtx.sessions,
						query.get("sessionId") ?? "",
						query.get("path") ?? "",
					);
					if (found === null) {
						res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
						res.end("not found");
						return;
					}
					const ext = found.name.toLowerCase().split(".").pop() ?? "";
					res.writeHead(200, {
						"content-type": DOWNLOAD_MIME[ext] ?? "application/octet-stream",
						"content-length": String(found.size),
						"content-disposition": downloadDisposition(found.name),
						"cache-control": "no-store",
					});
					if (req.method === "HEAD") {
						res.end();
						return;
					}
					const stream = createReadStream(found.target);
					stream.on("error", () => res.destroy());
					stream.pipe(res);
				})().catch(() => {
					if (!res.headersSent) res.writeHead(500);
					res.end();
				});
			},
		});
		return () => {
			if (typeof disposeRoute === "function") disposeRoute();
		};
	});
}
