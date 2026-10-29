/**
 * dsh-mobile-maxxing — host half.
 *
 * Serves what the browser needs to treat the DSH Web GUI as an installable
 * app, without patching the installed DSH dist:
 *
 *   /dsh-mobile-maxxing.webmanifest
 *                           a real manifest (PNG + maskable icons, standalone
 *                           display, id, theme/background colors, screenshots)
 *   /sw.js                  an app-shell service worker (offline launch, static
 *                           asset caching, never caches /api)
 *   /pwa/*.png              icons, the Apple touch icon and store screenshots
 *
 * and puts the device-mode decision at the top of the served index.html, ahead
 * of the module loader: the browser classifies itself there and publishes one
 * global, and the browser half reads it instead of classifying again.
 *
 * A desktop browser gets no document write from this package: the head keeps
 * the stock viewport and carries none of the home-screen metadata, because a
 * shared document cannot be trimmed per client. Only a mobile browser adds the
 * metadata (from that same inline script), and the viewport stays stock for
 * both: the mobile bundle merges `viewport-fit=cover` itself. The document is
 * one shared byte sequence for every client — this is not server negotiation,
 * and no response varies by user agent.
 *
 * Every route is registered on the Web server's exact-route table, so it wins
 * over the SPA fallback and stays alive across HMR recompositions.
 *
 * @module dsh-mobile-maxxing
 */

import { createHash } from "node:crypto";
import { applyNotify, normalizeNotifyConfig } from "./notify/host.js";
import { apply as applyMobileUx } from "./lib/mobile-ux.js";
import { COPY, PROBES, copyFor, serviceWorkerCopy } from "./lib/copy.js";
import { copyTable } from "./lib/copy-source.js";
import { MANIFEST_FILE, MODE_GLOBAL, earlyModeScript } from "./lib/device-mode.js";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

/** Stable Cordis plugin name. */
export const name = "dsh-mobile-maxxing";

/** HTTP routes need `webServer`; mount lazily so headless profiles stay clean. */
export const inject = [];

/**
 * Marker proving the index already carries our metadata block.
 *
 * Deliberately unchanged from the split-plugin version: old and new taps must
 * recognise each other's output, so a version bump here would make each tap
 * add a second set of PWA meta tags to the same response.
 */
const INDEX_MARKER = "<!--dsh-mobile-maxxing-->";

/** The browser half reads these globals; presence is what "payload injected" means. */
const COPY_ASSIGNMENT = /(?:globalThis|self|window)\.__RDSH_PWA_COPY__\s*=/;
const PROBES_ASSIGNMENT = /(?:globalThis|self|window)\.__RDSH_PWA_PROBES__\s*=/;
const LANG_ASSIGNMENT = /(?:globalThis|self|window)\.__RDSH_PWA_LANG__\s*=/;
/**
 * The early device-mode script, recognised so a re-tap never adds a second one.
 *
 * A plain assignment only. `globalThis.__RDSH_DEVICE_MODE__ === "mobile"` is
 * how a consumer *reads* the mode, and a shell that already reads it still
 * needs the bootstrap that defines it. The negative lookahead keeps `==`,
 * `===` and a following `=>` out of the match.
 */
const MODE_ASSIGNMENT = new RegExp(`(?:globalThis|self|window)\\.${MODE_GLOBAL}\\s*=(?![=>])`);

/** Manifest and viewport limits we normalize before serving. */
const DISPLAY_MODES = new Set(["standalone", "minimal-ui", "fullscreen", "browser", "window-controls-overlay"]);

/**
 * Configurable knobs. Defaults target the DSH dark shell; every value is a
 * string/number/boolean so the profile patch stays readable.
 */
export const DEFAULTS = {
	name: "DeepSeek Harness",
	shortName: "DSH",
	// Kept for callers that read DEFAULTS directly; normalizeConfig picks the
	// description from lib/copy.js for the effective `lang`, so an en profile
	// still serves the en string.
	description: "DeepSeek Harness をアプリのように起動します。",
	lang: "ja",
	display: "standalone",
	themeColor: "#151517",
	backgroundColor: "#151517",
	// Lets iOS use the fixed top-edge element instead of forcing edge-to-edge.
	appleStatusBarStyle: "default",
	enableServiceWorker: true,
	navigationTimeoutMs: 1500,
};

/** Static files we own, keyed by the public route path. */
const ASSETS = new Map([
	["/pwa/icon-192.png", { file: "assets/icon-192.png", type: "image/png" }],
	["/pwa/icon-512.png", { file: "assets/icon-512.png", type: "image/png" }],
	["/pwa/icon-maskable-192.png", { file: "assets/icon-maskable-192.png", type: "image/png" }],
	["/pwa/icon-maskable-512.png", { file: "assets/icon-maskable-512.png", type: "image/png" }],
	["/pwa/apple-touch-icon.png", { file: "assets/apple-touch-icon.png", type: "image/png" }],
	["/pwa/badge-96.png", { file: "assets/badge-96.png", type: "image/png" }],
	["/pwa/screenshot-mobile.png", { file: "assets/screenshot-mobile.png", type: "image/png" }],
	["/pwa/screenshot-desktop.png", { file: "assets/screenshot-desktop.png", type: "image/png" }],
]);

/** One day for icons: long enough to save the repeat fetch, short enough to pick up a redraw. */
const ICON_CACHE_CONTROL = "public, max-age=86400";
const SHELL_CACHE_CONTROL = "no-cache";
const JS_CACHE_CONTROL = "no-cache, no-store, must-revalidate";

function text(value, fallback, limit) {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	if (trimmed === "") return fallback;
	return trimmed.slice(0, limit);
}

function color(value, fallback) {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	// Accept #rgb/#rrggbb/#rrggbbaa and CSS color functions/keywords only.
	if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(trimmed)) return trimmed;
	if (/^(?:rgb|hsl)a?\([\d\s.,%/-]+\)$/i.test(trimmed)) return trimmed;
	if (/^[a-z]{3,20}$/i.test(trimmed)) return trimmed;
	return fallback;
}

/** Normalize user config; never throw on a bad profile patch. */
export function normalizeConfig(input) {
	const src = input !== null && typeof input === "object" && !Array.isArray(input) ? input : {};
	const display = text(src.display, DEFAULTS.display, 32);
	const timeout = Number(src.navigationTimeoutMs);
	// Only languages the dictionary carries are accepted, so the manifest and
	// the injected copy can never disagree about what `lang` means.
	const requested = text(src.lang, DEFAULTS.lang, 12);
	const lang = Object.hasOwn(COPY, requested) ? requested : DEFAULTS.lang;
	const strings = copyFor(lang);
	return {
		name: text(src.name, DEFAULTS.name, 80),
		shortName: text(src.shortName, DEFAULTS.shortName, 24),
		description: text(src.description, strings["manifest.description"], 300),
		lang,
		display: DISPLAY_MODES.has(display) ? display : DEFAULTS.display,
		themeColor: color(src.themeColor, DEFAULTS.themeColor),
		backgroundColor: color(src.backgroundColor, DEFAULTS.backgroundColor),
		appleStatusBarStyle: /^(?:default|black|black-translucent)$/.test(String(src.appleStatusBarStyle))
			? src.appleStatusBarStyle
			: DEFAULTS.appleStatusBarStyle,
		enableServiceWorker: src.enableServiceWorker !== false,
		navigationTimeoutMs: Number.isFinite(timeout) ? Math.min(10000, Math.max(300, Math.round(timeout))) : DEFAULTS.navigationTimeoutMs,
	};
}

/**
 * Build the manifest document.
 *
 * Relative URLs keep the app working when a proxy mounts DSH under a prefix:
 * the browser resolves them against the manifest URL, not the site root.
 *
 * @param {object} [config] - profile config for this plugin.
 * @returns {object} a JSON-serializable Web App Manifest.
 */
export function buildManifest(config) {
	const cfg = normalizeConfig(config);
	const strings = copyFor(cfg.lang);
	return {
		id: "./",
		name: cfg.name,
		short_name: cfg.shortName,
		description: cfg.description,
		lang: cfg.lang,
		dir: "ltr",
		start_url: "./",
		scope: "./",
		display: cfg.display,
		// explicit fallbacks: fullscreen degrades to standalone on desktop, and
		// minimal-ui keeps a back affordance on platforms without our layout.
		display_override: [cfg.display, "minimal-ui"],
		orientation: "any",
		background_color: cfg.backgroundColor,
		theme_color: cfg.themeColor,
		categories: ["productivity", "developer"],
		// Chrome treats a related-app preference as "do not install the PWA".
		prefer_related_applications: false,
		// Clicking the installed icon focuses the running window instead of
		// navigating it, so a live agent session survives the relaunch.
		launch_handler: { client_mode: "focus-existing" },
		icons: [
			{ src: "pwa/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
			{ src: "pwa/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
			{ src: "pwa/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
			{ src: "pwa/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
			{ src: "favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
		],
		screenshots: [
			// `sizes` is the intrinsic pixel size of the file, which is the CSS
			// size times the capture scale (3x on a phone, 2x on a desktop).
			{ src: "pwa/screenshot-mobile.png", sizes: "1170x2532", type: "image/png", form_factor: "narrow", label: strings["manifest.screenshot.chat"] },
			{ src: "pwa/screenshot-desktop.png", sizes: "2560x1600", type: "image/png", form_factor: "wide", label: strings["manifest.screenshot.desktop"] },
		],
	};
}

/** JSON safe to embed in an inline script (`<` would open a tag). */
function scriptJson(value) {
	return JSON.stringify(value).replaceAll("<", "\\u003c");
}

/**
 * The inline payload the browser half needs, containing only the globals the
 * document does not already define.
 *
 * `lang` is normalized before it reaches this function, so it can only be a
 * key of the copy table; `scriptJson` still escapes `<` so a future locale id
 * can never terminate the script tag.
 *
 * @param {object} parts - which globals are missing.
 * @param {boolean} parts.copy - include `__RDSH_PWA_COPY__`.
 * @param {boolean} parts.probes - include `__RDSH_PWA_PROBES__`.
 * @param {string} [parts.lang] - include `__RDSH_PWA_LANG__` with this value.
 * @param {object} table - the dictionary snapshot for this document.
 * @returns {string} a script tag, or "" when nothing is missing.
 */
function payloadScript({ copy, probes, lang }, table) {
	const assignments = [];
	if (copy) assignments.push(`globalThis.__RDSH_PWA_COPY__=${scriptJson(table.COPY)}`);
	if (probes) assignments.push(`globalThis.__RDSH_PWA_PROBES__=${scriptJson(table.PROBES)}`);
	if (typeof lang === "string" && lang !== "") assignments.push(`globalThis.__RDSH_PWA_LANG__=${scriptJson(lang)}`);
	return assignments.length === 0 ? "" : `<script>${assignments.join(";")}<\/script>`;
}

/** Insert a fragment at the top of `<head>`, or at the top of the document. */
function insertInHead(html, fragment) {
	const open = /<head(?:\s[^>]*)?>/i.exec(html);
	if (open !== null) return `${html.slice(0, open.index + open[0].length)}${fragment}${html.slice(open.index + open[0].length)}`;
	return `${fragment}${html}`;
}

/**
 * Add the metadata a home-screen launch needs, plus the early device-mode
 * decision. Pure and idempotent: the returned HTML carries
 * {@link INDEX_MARKER} exactly once, and a document that already decided the
 * mode does not get a second script.
 *
 * The mode script is the first element of the injected block, so it is parsed
 * and executed before the module loader and the app bundle. It carries no
 * per-request data: the classifier runs in the browser, which is the only
 * place the iPad's desktop-like UA and touch points can be told apart.
 *
 * A document that already has the marker may come from the split-plugin tap,
 * which did not inject `__RDSH_PWA_COPY__` / `__RDSH_PWA_PROBES__` /
 * `__RDSH_PWA_LANG__`. In that case only the missing payload is added:
 * re-running the whole decoration would duplicate the PWA meta tags in the
 * same response. The browser half prefers this normalized language over the
 * shell's `document.lang`, so the plugin UI follows the profile without
 * rewriting the shell document.
 *
 * The dictionary is read per call, not captured at import time: `lib/copy.js`
 * is edited while the host runs, and a wording fix has to reach the next page
 * without a restart. The reader caches on the file's mtime, so an unchanged
 * file costs one `stat`; the fallback is the snapshot this process started
 * with, so a save halfway through can never produce a half document.
 *
 * @param {string} html - the index document the Web server rendered.
 * @param {object} [config] - profile config for this plugin.
 * @returns {string} the decorated document.
 */
export function decorateIndex(html, config) {
	if (typeof html !== "string" || html === "") return html;
	const cfg = normalizeConfig(config);
	// One snapshot per response: the copy and the probes must describe the same
	// file version, and the file can change between two requests.
	const strings = copyTable();
	const payload = payloadScript({
		copy: !COPY_ASSIGNMENT.test(html),
		probes: !PROBES_ASSIGNMENT.test(html),
		lang: LANG_ASSIGNMENT.test(html) ? undefined : cfg.lang,
	}, strings);
	const mode = MODE_ASSIGNMENT.test(html) ? "" : earlyModeScript(cfg.appleStatusBarStyle);
	if (html.includes(INDEX_MARKER)) {
		const missing = `${mode}${payload}`;
		return missing === "" ? html : insertInHead(html, missing);
	}
	const head = [
		INDEX_MARKER,
		// Decided in the browser, first in the document: nothing mode-dependent
		// can run before it. On a desktop this writes the global and nothing
		// else; the phone metadata is added by the same script, mobile only.
		mode,
		// The browser half reads its strings from here; nothing else in the
		// client carries UI copy. PROBES are upstream label vocabularies, not
		// copy, so they travel separately.
		payload,
	].join("");
	return insertInHead(html, head);
}

function respond(res, method, status, headers, body) {
	const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
	res.writeHead(status, { ...headers, "content-length": payload.length });
	if (method === "HEAD") res.end();
	else res.end(payload);
}

function methodNotAllowed(res, allow) {
	res.writeHead(405, { allow, "content-type": "text/plain; charset=utf-8" });
	res.end("method not allowed\n");
}

function readOnly(handler) {
	return async (req, res) => {
		if (req.method !== "GET" && req.method !== "HEAD") {
			methodNotAllowed(res, "GET, HEAD");
			return;
		}
		await handler(req, res);
	};
}

function assetPath(file) {
	return new URL(`./${file}`, import.meta.url);
}


/**
 * Install the confirmed release in the active profile.
 *
 * @returns {Promise<void>}
 */
function runPluginUpdate(profile, tag) {
	return new Promise((resolve, reject) => {
		const child = spawn("dsh", ["plugin", "--profile", profile, "add", `github:kuraneko1/dsh-mobile-maxxing#${tag}`], {
			stdio: ["ignore", "ignore", "pipe"],
			timeout: 120000,
		});
		let stderr = "";
		child.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-16000); });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(stderr.trim() || `exit ${code}`));
		});
	});
}

export const RELEASE_URL = "https://github.com/kuraneko1/dsh-mobile-maxxing/releases";
const RELEASE_API = "https://api.github.com/repos/kuraneko1/dsh-mobile-maxxing/releases/latest";

export function compareReleaseVersions(current, latest) {
  const parse = (value) => /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)?.slice(1).map(Number);
  const a = parse(current), b = parse(latest);
  if (!a || !b || [...a, ...b].some((part) => !Number.isSafeInteger(part))) throw new Error("Unsupported release version");
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

export async function fetchLatestRelease(fetcher = fetch) {
  const response = await fetcher(RELEASE_API, { headers: { accept: "application/vnd.github+json" }, cache: "no-store", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("GitHub HTTP " + response.status);
  const data = await response.json();
  if (data.draft || data.prerelease || typeof data.tag_name !== "string" || !/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(data.tag_name)) throw new Error("Invalid release tag");
  return data.tag_name;
}

/**
 * Mount the routes, assets and index decoration.
 * @param {object} ctx - plugin context.
 * @param {object} [config] - profile config for this plugin.
 */
export function apply(ctx, config) {
	const cfg = normalizeConfig(config);
	// The host halves of what used to be separate plugins. Each declares the
	// services it needs (`inject` in its own module) and mounts its own routes
	// or hooks, so one failing must not take the others — or the PWA shell —
	// down with it.
	const mountPart = (label, services, mount, settings) => {
		try {
			if (services.length === 0) {
				mount(ctx, settings);
				return;
			}
			ctx.inject(services, (scope) => mount(scope, settings));
		} catch (error) {
			console.error(`[dsh-mobile-maxxing] ${label} host half failed to mount`, error);
		}
	};
	ctx.inject(["webServer", "connection", "profileContext"], (updateCtx) => {
    const webServer = updateCtx.webServer;
    const disposes = [];
    // Only an authenticated, explicit confirmation can install a release.
    const guardUpdate = (req, res) => {
      const connection = updateCtx.connection;
      if (typeof connection?.requestRejection !== "function") { res.writeHead(503); res.end("authentication unavailable"); return false; }
      const rejection = connection.requestRejection(req);
      if (rejection !== undefined) { res.writeHead(rejection); res.end("forbidden"); return false; }
      return true;
    };
    let checkedRelease = null;
    disposes.push(webServer.register({
      kind: "exact",
      path: "/dsh-mobile-maxxing/plugin-version",
      handler: readOnly(async (req, res) => {
        if (!guardUpdate(req, res)) return;
        try {
          checkedRelease = null;
          const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
          const latest = await fetchLatestRelease();
          const comparison = compareReleaseVersions(pkg.version, latest);
          const available = comparison < 0;
          checkedRelease = available ? latest : null;
          respond(res, req.method, 200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, JSON.stringify({ current: pkg.version, latest, available, ahead: comparison > 0, repository: RELEASE_URL }));
        } catch (error) {
          respond(res, req.method, 502, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, JSON.stringify({ error: String(error?.message || error) }));
        }
      }),
    }));
    disposes.push(webServer.register({
      kind: "exact",
      path: "/dsh-mobile-maxxing/update-plugins",
      handler: async (req, res) => {
        if (req.method !== "POST") { methodNotAllowed(res, "POST"); return; }
        if (!guardUpdate(req, res)) return;
        const profile = updateCtx.profileContext?.name;
        if (!profile || !/^[a-zA-Z0-9._-]+$/.test(profile)) { respond(res, "POST", 503, { "content-type": "application/json" }, JSON.stringify({ error: "profile unavailable" })); return; }
        const tag = checkedRelease;
        if (!tag || req.headers?.["x-dsh-release"] !== tag) { respond(res, "POST", 409, { "content-type": "application/json" }, JSON.stringify({ error: "release confirmation required" })); return; }
        checkedRelease = null;
        try {
          await runPluginUpdate(profile, tag);
          respond(res, "POST", 200, { "content-type": "application/json", "cache-control": "no-store" }, JSON.stringify({ ok: true, version: tag }));
        } catch (error) {
          respond(res, "POST", 500, { "content-type": "application/json", "cache-control": "no-store" }, JSON.stringify({ error: String(error?.message || error) }));
        }
      },
    }));
    return () => { for (const dispose of disposes) if (typeof dispose === "function") dispose(); };
  });
	// Notifications are their own module: the copy, the VAPID pair, the push
	// fan-out and the browser-facing routes all live there. It opens a state
	// file, so it is mounted under the same guard as the rest: an unwritable
	// home must not take the PWA routes down with it.
	// The package-wide `lang` is the default for notification copy too; an
	// explicit `notifications.lang` in the profile patch still wins.
	const notifyConfig = normalizeNotifyConfig(config?.notifications);
	if (typeof config?.notifications?.lang !== "string") notifyConfig.lang = cfg.lang;
	mountPart("dsh-mobile-maxxing/notify", [], applyNotify, notifyConfig);
	// mobile-ux injects what it needs inside its own apply.
	mountPart("rdsh-mobile-ux", [], applyMobileUx, config?.mobileUx);
	// The CJK renderer patch is NOT mounted here any more: it rewrote the asset
	// URLs for every client, desktops included. The module (lib/markdown-cjk.js)
	// keeps its standalone API for the independent rdsh-markdown-cjk plugin; the
	// merged plugin stays stock for PC and mobile alike.
	// Read once per activation: a deployment restart is what makes new bytes
	// visible, which is also what bumps the service-worker build hash.
	const files = new Map();
	const readAsset = async (file) => {
		if (!files.has(file)) {
			// Do not cache a rejected read: a transient failure would otherwise
			// make that asset a permanent 404 for the life of the process.
			const pending = readFile(assetPath(file)).catch((error) => {
				files.delete(file);
				throw error;
			});
			files.set(file, pending);
		}
		return files.get(file);
	};

	let build;
	const serviceWorkerSource = async () => {
		if (build !== undefined) return build;
		const source = await readFile(assetPath("sw.js"), "utf8");
		const hash = createHash("sha256").update(source).digest("hex").slice(0, 12);
		const header = `self.__RDSH_PWA_BUILD__=${JSON.stringify(hash)};self.__RDSH_PWA_CONFIG__=${JSON.stringify({
			navigationTimeoutMs: cfg.navigationTimeoutMs,
			lang: cfg.lang,
			copy: serviceWorkerCopy(cfg.lang),
		})};\n`;
		build = header + source;
		return build;
	};

	ctx.inject(["webServer"], (webCtx) => {
		const webServer = webCtx.webServer;
		const disposes = [];

		disposes.push(webServer.register({
			kind: "exact",
			// Its own root-level path: `/manifest.webmanifest` stays the stock
			// file, so a desktop browser installs the stock app instead of ours.
			// The mobile bootstrap links this one first.
			path: `/${MANIFEST_FILE}`,
			handler: readOnly((req, res) => {
				respond(res, req.method, 200, {
					"content-type": "application/manifest+json; charset=utf-8",
					"cache-control": SHELL_CACHE_CONTROL,
				}, JSON.stringify(buildManifest(cfg), null, 2));
			}),
		}));

		if (cfg.enableServiceWorker) {
			disposes.push(webServer.register({
				kind: "exact",
				path: "/sw.js",
				handler: readOnly(async (req, res) => {
					const source = await serviceWorkerSource();
					respond(res, req.method, 200, {
						"content-type": "text/javascript; charset=utf-8",
						"cache-control": JS_CACHE_CONTROL,
						// The worker lives at the root and controls the whole origin.
						"service-worker-allowed": "/",
						"x-content-type-options": "nosniff",
					}, source);
				}),
			}));
		}

		for (const [route, asset] of ASSETS) {
			disposes.push(webServer.register({
				kind: "exact",
				path: route,
				handler: readOnly(async (req, res) => {
					try {
						const body = await readAsset(asset.file);
						respond(res, req.method, 200, {
							"content-type": asset.type,
							"cache-control": ICON_CACHE_CONTROL,
							"x-content-type-options": "nosniff",
						}, body);
					} catch {
						res.writeHead(404);
						res.end();
					}
				}),
			}));
		}

		// The tap is synchronous by contract, so the decoration re-reads
		// `lib/copy.js` itself (mtime-cached) instead of capturing the table at
		// activation: an edit reaches the next document without a restart.
		disposes.push(webServer.tapIndex((html) => decorateIndex(html, cfg)));

		return () => {
			for (const dispose of disposes) if (typeof dispose === "function") dispose();
		};
	});
}
