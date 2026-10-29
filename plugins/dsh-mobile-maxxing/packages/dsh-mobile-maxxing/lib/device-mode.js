/**
 * dsh-mobile-maxxing — the one device-mode decision.
 *
 * One shared index document is served to every browser (`tapIndex` sees the
 * HTML string and nothing else — there is no request-aware index hook), so the
 * mode is decided inside the document at the top of `<head>`, before the module
 * loader and the app bundle run. This module *is* that decision:
 * {@link classifyDevice} is serialized by {@link earlyModeScript} into a single
 * inline script. The browser half gives a valid `__RDSH_DEVICE_MODE__` priority,
 * falls back to a valid `data-rdsh-device-mode` attribute, and uses
 * `"desktop"` when neither signal is valid.
 *
 * Width is deliberately absent. A narrow desktop window stays desktop, a wide
 * phone or tablet stays mobile; responsive breakpoints remain layout-only.
 *
 * @module dsh-mobile-maxxing/device-mode
 */

/** `<html>` attribute carrying the decided mode. */
export const MODE_ATTRIBUTE = "data-rdsh-device-mode";

/** Global carrying the decided mode; the browser half's first choice before the attribute fallback. */
export const MODE_GLOBAL = "__RDSH_DEVICE_MODE__";

/**
 * Filename of this plugin's Web App Manifest.
 *
 * A root-level name of its own, never the stock `manifest.webmanifest`: the
 * stock document links that path, so overriding it changed the manifest a
 * desktop browser would install from. It stays in the same directory as the
 * stock file — `id`, `start_url` and `scope` are relative to the manifest URL,
 * so a subdirectory would move the installed app off the site root.
 */
export const MANIFEST_FILE = "dsh-mobile-maxxing.webmanifest";

/**
 * Which UI this browser should get.
 *
 * `nav` is a `navigator`-shaped object. Only same-document signals count: the
 * legacy UA string, `navigator.platform`, `navigator.maxTouchPoints` and the
 * low-entropy `navigator.userAgentData.mobile` / `.platform`. High-entropy
 * client hints are asynchronous, so they cannot decide the first paint.
 *
 * Phones and tablets both answer `"mobile"`: the mode picks the interaction
 * model, the width only picks geometry. Everything unidentified answers
 * `"desktop"` — upstream's own layout — so an unknown browser is never given
 * the phone surface by accident. A Windows touch PC lands there too: a touch
 * screen is not a tablet signal.
 *
 * Self-contained by contract: `earlyModeScript` inlines this function with
 * `Function.prototype.toString()`, so the body may not reference module scope.
 *
 * @param {object} [nav] - the browser's navigator.
 * @returns {"mobile" | "desktop"} the mode for this document.
 */
export function classifyDevice(nav) {
	const source = nav !== null && typeof nav === "object" ? nav : {};
	const ua = typeof source.userAgent === "string" ? source.userAgent : "";
	const platform = typeof source.platform === "string" ? source.platform : "";
	const touch = typeof source.maxTouchPoints === "number" && source.maxTouchPoints > 1;
	let data;
	try {
		data = source.userAgentData;
	} catch {
		data = undefined;
	}
	const hints = data !== null && typeof data === "object" ? data : {};
	const hintsPlatform = typeof hints.platform === "string" ? hints.platform : "";
	// Chromium client hints, and only a positive answer means anything: a
	// desktop-site toggle or an Android tablet reports mobile:false without
	// being a desktop.
	if (hints.mobile === true) return "mobile";
	// iPhone and iPod; also the iPad UA that "Request Mobile Website" sends, and
	// a device that asked for a desktop site and kept the Apple platform string
	// ("iPhone"/"iPad") while the UA turned into a Macintosh one. Platform is a
	// positive device signal on its own, so it does not need touch points.
	if (/iPhone|iPod|iPad/i.test(ua) || /iPhone|iPod|iPad/i.test(platform)) return "mobile";
	// iPadOS asks for the desktop site by default and sends a Macintosh UA.
	// Touch points are then the only same-document signal left, and no Mac has
	// them. This also covers an iPad that overrode "Request Desktop Site".
	if (platform === "MacIntel" && touch) return "mobile";
	// Android phones and tablets (the tablet UA drops "Mobile"); the hint
	// covers the reduced UA that carries neither token.
	if (/Android/i.test(ua) || hintsPlatform === "Android") return "mobile";
	return "desktop";
}

/**
 * The inline script that decides and publishes the mode.
 *
 * A classic (not module) script, so it runs while `<head>` is parsed: the app
 * bundle is a deferred module and the loader script comes later in the same
 * head, so no mode-dependent style or hook can be applied before this has run.
 * The classifier decides first; if it throws, the script's initial
 * `"desktop"` stands.
 *
 * Desktop browsers get no document write at all: the decided mode travels as a
 * JavaScript global, so a PC keeps the stock head exactly — no viewport
 * rewrite, no home-screen metadata, no attribute. Only a mobile browser gets
 * the metadata a home-screen launch needs, plus the `data-rdsh-device-mode`
 * attribute the browser half reads. The viewport is deliberately untouched: a
 * second viewport meta written this early would race the stock one, and the
 * mobile bundle already merges `viewport-fit=cover` itself. Any failure while
 * adding the metadata is contained: the stock head stays rather than a
 * half-applied phone surface.
 *
 * @param {string} [statusBarStyle] - normalized apple status bar style.
 * @returns {string} one `<script>` element carrying the classifier.
 */
export function earlyModeScript(statusBarStyle = "default") {
	const source = classifyDevice.toString();
	// Our own source, but it lands inside a script element: a body that could
	// close the element is a broken build, not something to render. The script
	// then still publishes the fail-closed answer instead of guessing.
	const inline = /<\/script|<!--/i.test(source) ? "" : source;
	const decide = inline === ""
		? ""
		: `try{m=(${inline})(navigator)==="mobile"?"mobile":"desktop"}catch(e){}`;
	const meta = [
		["mobile-web-app-capable", "yes"],
		["apple-mobile-web-app-status-bar-style", String(statusBarStyle)],
		// Code samples carry numbers; iOS must not turn them into call links.
		["format-detection", "telephone=no"],
	].map(([name, content], index) => {
		const element = `e${index}`;
		return `var ${element}=document.createElement("meta");`
			+ `${element}.setAttribute("name",${scriptJson(name)});`
			+ `${element}.setAttribute("content",${scriptJson(content)});`
			+ `h.appendChild(${element});`;
	}).join("");
	return `<script>(function(){var m="desktop";${decide}`
		+ `try{globalThis.${MODE_GLOBAL}=m}catch(e){}`
		+ `if(m!=="mobile")return;`
		+ `try{var h=document.head||document.documentElement;`
		+ `var d=document.documentElement;if(d)d.setAttribute(${JSON.stringify(MODE_ATTRIBUTE)},"mobile");`
		+ `${meta}`
		+ `var i=document.createElement("link");i.setAttribute("rel","apple-touch-icon");`
		+ `i.setAttribute("href","pwa/apple-touch-icon.png");h.appendChild(i);`
		// First in the head, so the browser reads this manifest and not the
		// stock one the document links further down. A desktop adds neither.
		+ `var f=document.createElement("link");f.setAttribute("rel","manifest");`
		+ `f.setAttribute("href",${scriptJson(MANIFEST_FILE)});h.appendChild(f)`
		+ `}catch(e){}})()<\/script>`;
}

/** JSON safe to embed in an inline script (`<` would open a tag). */
function scriptJson(value) {
	return JSON.stringify(value).replaceAll("<", "\\u003c");
}
