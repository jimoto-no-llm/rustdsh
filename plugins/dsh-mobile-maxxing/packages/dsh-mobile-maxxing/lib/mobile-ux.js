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
}
