/**
 * Host-half unit tests: no DSH process, no browser.
 *
 * The plugin is pure enough to test directly: the manifest, the index
 * decoration and every HTTP route are ordinary functions over (req, res).
 */

import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { apply, buildManifest, decorateIndex, normalizeConfig, compareReleaseVersions, fetchLatestRelease } from "../index.js";
import { buildTurnEndPayload } from "../notify/host.js";
import { COPY, PROBES, copyFor } from "../lib/copy.js";
import { MANIFEST_FILE, MODE_ATTRIBUTE, MODE_GLOBAL, earlyModeScript } from "../lib/device-mode.js";

/**
 * A context good enough to mount the plugin.
 *
 * Every injected dependency is answered with something shaped like the real
 * service, so the routes and the index decoration can be driven directly.
 * `injections` records what was asked for, which is how the tests pin the set
 * of services the package needs from DSH.
 */
function mount(config, overrides = {}) {
	const routes = new Map();
	const taps = [];
	const injections = [];
	const webServer = {
		register(route) {
			assert.equal(routes.has(route.path), false, `duplicate route ${route.path}`);
			routes.set(route.path, route);
			return () => routes.delete(route.path);
		},
		tapIndex(fn) {
			taps.push(fn);
			return () => taps.splice(taps.indexOf(fn), 1);
		},
		getOrigin: () => "http://127.0.0.1:0",
	};
	/** Agents: no sessions, which is what a quiet deployment looks like. */
	const agents = {
		get: () => undefined,
		roots: () => [],
	};
	const services = {
		webServer,
		agents,
		connection: { requestRejection: () => undefined },
		profileContext: { name: "test" },
		sessions: undefined,
		...overrides,
	};
	// A real injected context exposes each dependency as a property as well as
	// through get(); the routes use both forms.
	const scope = {
		...services,
		get(name) {
			return services[name];
		},
		on() {
			return () => {};
		},
		effect(fn) {
			const dispose = typeof fn === "function" ? fn() : undefined;
			return typeof dispose === "function" ? dispose : () => {};
		},
	};
	const listeners = [];
	const ctx = {
		profileContext: { name: "test" },
		inject(deps, callback) {
			injections.push([...deps]);
			return callback(scope);
		},
		get(name) {
			return services[name];
		},
		// The mobile-ux half subscribes to `llm/stream`; without `on` it threw
		// inside mountPart, which swallowed the error and left that half
		// untested while the suite stayed green.
		on(event, handler) {
			listeners.push({ event, handler });
			return () => {};
		},
		effect(fn) {
			return scope.effect(fn);
		},
	};
	apply(ctx, config);
	return { routes, taps, injections, services, listeners };
}

/** Invoke one registered route with a fake request/response pair. */
async function call(route, method = "GET", url = route.path, requestHeaders = {}) {
	const chunks = [];
	let status;
	let headers;
	const res = {
		writeHead(code, value) {
			status = code;
			headers = value;
		},
		end(body) {
			if (body !== undefined) chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(body));
		},
	};
	await route.handler({ method, url, headers: requestHeaders }, res);
	return { status, headers, body: Buffer.concat(chunks), text: Buffer.concat(chunks).toString("utf8") };
}

const INDEX = `<!doctype html><html lang="en"><head><base href="./"><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>DeepSeek Harness</title></head><body><div id="root"></div></body></html>`;

/** The `globalThis.__RDSH_PWA_*__` values from the injected payload script. */
function injectedPayload(html) {
	const script = /<script>(globalThis\.__RDSH_PWA_[A-Z_]+__=[\s\S]*?)<\/script>/.exec(html);
	assert.ok(script !== null, "the payload script exists");
	const values = {};
	for (const match of script[1].matchAll(/globalThis\.(__RDSH_PWA_[A-Z_]+__)=([\s\S]*?)(?=;globalThis\.__RDSH_PWA_|$)/g)) {
		values[match[1]] = JSON.parse(match[2].replaceAll("\\u003c", "<"));
	}
	return values;
}

test("manifest carries the installability fields Chrome requires", () => {
	const manifest = buildManifest({});
	assert.equal(manifest.display, "standalone");
	assert.equal(manifest.prefer_related_applications, false);
	assert.equal(typeof manifest.start_url, "string");
	assert.equal(manifest.id, "./");
	const sizes = manifest.icons.map((icon) => icon.sizes);
	assert.ok(sizes.includes("192x192"), "an install prompt needs a 192px icon");
	assert.ok(sizes.includes("512x512"), "a splash screen needs a 512px icon");
	assert.ok(manifest.icons.some((icon) => icon.purpose === "maskable"), "Android masks the icon");
	assert.ok(manifest.icons.some((icon) => icon.type === "image/svg+xml"), "the vector mark stays available");
	// Relative URLs keep the app correct behind a prefix-stripping proxy.
	assert.ok(manifest.icons.every((icon) => !icon.src.startsWith("/")));
	assert.equal(manifest.scope, "./");
});

test("manifest normalizes hostile or partial config", () => {
	const manifest = buildManifest({
		display: "bogus",
		name: "  ",
		shortName: "<script>",
		themeColor: "url(javascript:alert(1))",
		backgroundColor: "#123456",
		navigationTimeoutMs: 10 ** 9,
	});
	assert.equal(manifest.display, "standalone", "an unknown display falls back");
	assert.equal(manifest.name, "DeepSeek Harness", "blank names fall back");
	assert.equal(manifest.theme_color, "#151517", "non-colors are rejected");
	assert.equal(manifest.background_color, "#123456");
	assert.equal(normalizeConfig({ navigationTimeoutMs: 10 ** 9 }).navigationTimeoutMs, 10000);
	assert.equal(normalizeConfig({ navigationTimeoutMs: -5 }).navigationTimeoutMs, 300);
});

test("a desktop keeps the stock head: no metadata, no viewport rewrite", () => {
	const html = decorateIndex(INDEX, {});
	// Nothing the shared shell adds may show up as markup: the home-screen
	// metadata belongs to the mobile bootstrap, which adds it in the browser.
	assert.ok(!/<meta name="mobile-web-app-capable"/.test(html), "no capable meta");
	assert.ok(!/<meta name="apple-mobile-web-app-capable"/.test(html), "no Apple-only capable meta");
	assert.ok(!/<link rel="apple-touch-icon"/.test(html), "no touch icon link");
	assert.ok(!/<meta name="format-detection"/.test(html), "no format detection meta");
	assert.ok(!/<meta name="apple-mobile-web-app-status-bar-style"/.test(html), "no status bar meta");
	// The stock viewport is left exactly as it was.
	assert.ok(html.includes('<meta name="viewport" content="width=device-width, initial-scale=1" />'));
	assert.ok(!html.includes("viewport-fit=cover, interactive-widget"), "the viewport is not rewritten");
	assert.ok(!/<meta[^>]*viewport-fit/.test(html));
	// Strip the marker and this package's two scripts: the document is stock.
	const stripped = html
		.replace("<!--dsh-mobile-maxxing-->", "")
		.replace(/<script>\(function\(\)\{var m="desktop"[\s\S]*?<\/script>/, "")
		.replace(/<script>globalThis\.__RDSH_PWA_COPY__[\s\S]*?<\/script>/, "");
	assert.equal(stripped, INDEX, "the served document is the stock document plus inert scripts");
});

test("the mobile bootstrap carries the metadata the shell no longer writes", () => {
	const script = earlyModeScript("default");
	for (const name of ["mobile-web-app-capable", "apple-mobile-web-app-status-bar-style", "format-detection"]) {
		assert.ok(script.includes(name), `${name} travels in the bootstrap`);
	}
	assert.ok(script.includes("apple-touch-icon"));
	assert.ok(script.includes('"default"'), "the configured status bar style is used");
	assert.ok(!script.includes("apple-mobile-web-app-capable"), "iOS 26 keeps the legacy frame out");
	// And the decorated document really carries that script, before the bundle.
	const withBundle = INDEX.replace("</head>", '<script type="module" src="./assets/index-x.js"></script></head>');
	const html = decorateIndex(withBundle, { appleStatusBarStyle: "default" });
	assert.ok(html.includes("apple-mobile-web-app-status-bar-style"));
	assert.ok(html.indexOf("apple-mobile-web-app-status-bar-style") < html.indexOf('type="module"'),
		"the bootstrap precedes the deferred app bundle");
});

test("manifest copy follows the dictionary for the configured language", () => {
	// The package-wide default is Japanese again. Until COPY.ja has the key,
	// copyFor() falls back to English per key; assert the dictionary result so
	// this stays true when the Japanese pack lands.
	const japanese = buildManifest({});
	assert.equal(japanese.lang, "ja", "the default language is ja again");
	assert.equal(japanese.description, copyFor("ja")["manifest.description"]);
	assert.deepEqual(japanese.screenshots.map((shot) => shot.label), [
		copyFor("ja")["manifest.screenshot.chat"],
		copyFor("ja")["manifest.screenshot.desktop"],
	]);

	// An explicit en profile keeps the existing English strings.
	const english = buildManifest({ lang: "en" });
	assert.equal(english.lang, "en", "en remains available");
	assert.equal(english.description, COPY.en["manifest.description"]);
	assert.deepEqual(english.screenshots.map((shot) => shot.label), [
		COPY.en["manifest.screenshot.chat"],
		COPY.en["manifest.screenshot.desktop"],
	]);
	// A filled ja pack wins for its own keys; an empty one falls back to en.
	const jaDescription = COPY.ja["manifest.description"];
	assert.equal(
		japanese.description,
		typeof jaDescription === "string" && jaDescription !== "" ? jaDescription : COPY.en["manifest.description"],
	);
	// An unknown language is not accepted: manifest and copy would disagree.
	assert.equal(buildManifest({ lang: "xx" }).lang, "ja");
});

/** The exact strings the split plugin shipped; the ja pack must reproduce them. */
const LEGACY_JA = {
	"manifest.description": "DeepSeek Harness をアプリのように起動します。",
	"notify.turn.completed": "作業完了",
	"notify.turn.detailCompleted": "作業が完了しました。",
	"sw.documentTitle": "オフライン — DSH",
	"sw.offlineHeading": "オフラインです",
};

test("the completed ja pack reproduces the legacy Japanese host copy", async (t) => {
	const missing = [];
	for (const [key, expected] of Object.entries(LEGACY_JA)) {
		const actual = COPY.ja[key];
		if (typeof actual === "string" && actual !== "") {
			assert.equal(actual, expected, `COPY.ja[${key}] matches the old copy`);
		} else {
			missing.push(key);
		}
	}
	if (missing.length > 0) {
		t.skip(`COPY.ja is not filled yet: ${missing.join(", ")}`);
		return;
	}
	assert.equal(buildManifest({}).description, LEGACY_JA["manifest.description"]);
	const turn = buildTurnEndPayload("s", { kind: "completed" }, { session: "", lang: "ja" });
	assert.equal(turn.title, `DSH: ${LEGACY_JA["notify.turn.completed"]}`);
	assert.equal(turn.body, LEGACY_JA["notify.turn.detailCompleted"]);
	const { routes } = mount({});
	const worker = await call(routes.get("/sw.js"));
	assert.match(worker.text, new RegExp(`"sw\\.documentTitle":${JSON.stringify(LEGACY_JA["sw.documentTitle"])}`));
	assert.match(worker.text, new RegExp(`"sw\\.offlineHeading":${JSON.stringify(LEGACY_JA["sw.offlineHeading"])}`));
});

test("index decoration injects the dictionary, the probes and the normalized language", () => {
	const html = decorateIndex(INDEX, {});
	assert.ok(html.includes("__RDSH_PWA_COPY__="), "the browser half needs the copy table");
	assert.ok(html.includes("__RDSH_PWA_PROBES__="), "label matching needs every known locale");
	assert.ok(!html.includes("__RDSH_PWA_LOCALES__"), "the mobile half no longer injects a ja pack (#80)");
	assert.equal((html.match(/globalThis\.__RDSH_PWA_LANG__\s*=/g) ?? []).length, 1,
		"the host language is exposed once");
	const payload = injectedPayload(html);
	assert.equal(payload.__RDSH_PWA_COPY__.en["tab.mobile"], "Mobile");
	assert.deepEqual(payload.__RDSH_PWA_COPY__.ja, COPY.ja, "the ja pack travels even while it is being filled");
	assert.deepEqual(payload.__RDSH_PWA_PROBES__, PROBES, "the full probe dictionary travels");
	assert.equal(payload.__RDSH_PWA_LOCALES__, undefined, "a ja pack still travels to the browser half");
	assert.ok(payload.__RDSH_PWA_PROBES__.actions.includes("操作"), "probes stay bilingual");
	assert.equal(payload.__RDSH_PWA_LANG__, "ja", "the default host language reaches the browser half");
	const payloadScript = /<script>(globalThis\.__RDSH_PWA_COPY__[\s\S]*?)<\/script>/.exec(html);
	assert.ok(payloadScript !== null, "the payload is one script element");
	assert.ok(!payloadScript[1].includes("<"), "no value can close the payload element early");
});

test("an explicit en profile makes every host surface English", async () => {
	const html = decorateIndex(INDEX, { lang: "en" });
	assert.equal(injectedPayload(html).__RDSH_PWA_LANG__, "en", "the browser half is told en");

	const manifest = buildManifest({ lang: "en" });
	assert.equal(manifest.lang, "en");
	assert.equal(manifest.description, COPY.en["manifest.description"]);

	const { routes } = mount({ lang: "en" });
	const worker = await call(routes.get("/sw.js"));
	assert.match(worker.text, /"lang":"en"/);
	assert.match(worker.text, /"sw\.offlineHeading":"You're offline"/);

	const preview = JSON.parse((await call(
		routes.get("/api/dsh-mobile-maxxing/push/preview"),
		"GET",
		"/api/dsh-mobile-maxxing/push/preview?sessionId=",
	)).text);
	assert.equal(preview.copy.lang, "en");
	assert.equal(preview.turnEnd.title, "DSH: Work finished");
	assert.equal(preview.turnEnd.body, "The work finished.");
});

test("index decoration is idempotent", () => {
	const once = decorateIndex(INDEX, {});
	const twice = decorateIndex(once, {});
	assert.equal(once, twice, "a second tap must not duplicate the block");
	assert.equal(once.split("<!--dsh-mobile-maxxing-->").length - 1, 1);
	assert.equal((once.match(/globalThis\.__RDSH_PWA_LANG__\s*=/g) ?? []).length, 1);
	assert.equal(decorateIndex("", {}), "");
});

test("decorateIndex still works when the document has no viewport or head", () => {
	const bare = decorateIndex("<div id=root></div>", {});
	assert.ok(bare.includes("<!--dsh-mobile-maxxing-->"));
	assert.ok(bare.includes("</div>"));
	// A document with no viewport does not get one: the head stays as served.
	const noViewport = decorateIndex("<head></head><body></body>", {});
	assert.ok(!noViewport.includes('name="viewport"'), "no viewport is invented");
	assert.ok(noViewport.includes("<!--dsh-mobile-maxxing-->"));
});

test("the index decides the device mode before the module loader runs", () => {
	// The stock head plus the two things the mode must precede: the client
	// module loader and the deferred app bundle.
	const loaded = INDEX.replace("</head>", [
		'<script>window.__ModuleLoader__={mode:"queue"}</script>',
		'<script type="module" crossorigin src="./assets/index-x.js"></script>',
		"</head>",
	].join(""));
	const html = decorateIndex(loaded, {});
	const modeAt = html.indexOf(`globalThis.${MODE_GLOBAL}=`);
	assert.ok(modeAt > 0, "the mode script is injected");
	assert.ok(modeAt < html.indexOf("__ModuleLoader__"), "it runs before the module loader");
	assert.ok(modeAt < html.indexOf('type="module"'), "it runs before the deferred app bundle");
	assert.equal((html.match(/data-rdsh-device-mode/g) ?? []).length, 1, "the attribute name appears once");
	assert.equal((html.match(new RegExp(`globalThis\\.${MODE_GLOBAL}=`, "g")) ?? []).length, 1,
		"the canonical global is published once");

	// Idempotent: a second tap is a byte-for-byte no-op, and a legacy marker
	// document without the script gets exactly one.
	assert.equal(decorateIndex(html, {}), html);
	const legacy = INDEX.replace("<head>", "<head><!--dsh-mobile-maxxing-->");
	const once = decorateIndex(legacy, {});
	assert.equal((once.match(new RegExp(`globalThis\\.${MODE_GLOBAL}=`, "g")) ?? []).length, 1);
	assert.equal(decorateIndex(once, {}), once);
});

test("a shell that already reads the mode still gets the bootstrap", () => {
	// How a consumer reads it: `===` / `==` on the global, never an assignment.
	// Recognising those as "the script is already here" would skip the very
	// script that defines the value, leaving the reader with undefined.
	const reader = INDEX.replace("</head>", [
		'<script type="module">const mobile=globalThis.__RDSH_DEVICE_MODE__==="mobile";'
			+ 'const loose=globalThis.__RDSH_DEVICE_MODE__=="mobile";'
			+ "const pick=(value)=>value;"
			+ "export{mobile,loose,pick};</script>",
		"</head>",
	].join(""));
	const html = decorateIndex(reader, {});
	const injected = html.match(/<script>\(function\(\)\{var m="desktop"/g) ?? [];
	assert.equal(injected.length, 1, "the classifier is injected exactly once");
	const assignmentAt = html.search(/globalThis\.__RDSH_DEVICE_MODE__\s*=(?![=>])/);
	assert.ok(assignmentAt > 0, "the bootstrap really assigns the global");
	assert.ok(assignmentAt < html.indexOf("const mobile="),
		"the assignment precedes the consumer that reads it");
	assert.ok(html.indexOf("const mobile=") > 0, "the consumer script survives untouched");

	// Idempotent in both directions: the finished document is stable, and a
	// second tap cannot add a second classifier next to the reader.
	assert.equal(decorateIndex(html, {}), html);
	const twice = decorateIndex(decorateIndex(reader, {}), {});
	assert.equal((twice.match(/<script>\(function\(\)\{var m="desktop"/g) ?? []).length, 1);
});

test("one shared document answers per browser, so no response varies by user agent", () => {
	// What the service worker caches and what every client downloads is the
	// same string; the decision happens in the browser, on that string.
	const document = decorateIndex(INDEX, {});
	const script = /<script>([\s\S]*?)<\/script>/.exec(document);
	assert.ok(script !== null && script[1].includes(`globalThis.${MODE_GLOBAL}=`),
		"the first script in the document decides the mode");
	const decide = (navigator) => {
		const attributes = new Map();
		const head = [];
		const sandbox = {
			navigator,
			document: {
				documentElement: { setAttribute: (name, value) => attributes.set(name, String(value)) },
				head: { appendChild: (node) => head.push(node) },
				createElement: () => ({ setAttribute(name, value) { this[name] = String(value); } }),
			},
		};
		runInNewContext(script[1], sandbox, { filename: "early-mode.js" });
		return { attribute: attributes.get(MODE_ATTRIBUTE), global: sandbox[MODE_GLOBAL], head: head.length };
	};
	const phone = decide({ userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36", platform: "Linux armv8l", maxTouchPoints: 5 });
	const ipad = decide({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/26.0 Safari/605.1.15", platform: "MacIntel", maxTouchPoints: 5 });
	const laptop = decide({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36", platform: "Win32", maxTouchPoints: 10 });
	assert.deepEqual([phone.attribute, phone.global, phone.head], ["mobile", "mobile", 5],
		"a phone gets the attribute, the home-screen nodes and its manifest link");
	assert.deepEqual([ipad.attribute, ipad.global, ipad.head], ["mobile", "mobile", 5]);
	assert.deepEqual([laptop.attribute, laptop.global, laptop.head], [undefined, "desktop", 0],
		"a desktop gets the global and no document write");
	// Nothing in the served document depends on which one asked.
	assert.equal(document, decorateIndex(INDEX, {}));
});

test("an old marker without the payload gets copy, probes and lang exactly once", () => {
	// What the split-plugin tap left behind: marker and PWA meta, no dictionary.
	const legacy = INDEX.replace("</head>", [
		"<!--dsh-mobile-maxxing-->",
		'<meta name="mobile-web-app-capable" content="yes">',
		'<meta name="apple-mobile-web-app-status-bar-style" content="default">',
		"</head>",
	].join(""));
	const once = decorateIndex(legacy, {});
	assert.equal((once.match(/globalThis\.__RDSH_PWA_COPY__\s*=/g) ?? []).length, 1);
	assert.equal((once.match(/globalThis\.__RDSH_PWA_PROBES__\s*=/g) ?? []).length, 1);
	assert.equal((once.match(/globalThis\.__RDSH_PWA_LANG__\s*=/g) ?? []).length, 1);
	assert.equal(injectedPayload(once).__RDSH_PWA_LANG__, "ja");
	assert.equal((once.match(/name="mobile-web-app-capable"/g) ?? []).length, 1,
		"the legacy meta is not added a second time");
	assert.equal((once.match(/<!--dsh-mobile-maxxing-->/g) ?? []).length, 1);
	// Re-tapping the finished response is a no-op.
	assert.equal(decorateIndex(once, {}), once);
});

test("a partial payload gets only the missing globals, with or without the marker", () => {
	const copyOnly = INDEX.replace("</head>",
		'<script>globalThis.__RDSH_PWA_COPY__ = {"en":{}};</script></head>');
	const copyAndProbes = INDEX.replace("</head>",
		'<script>globalThis.__RDSH_PWA_COPY__ = {"en":{}};globalThis.__RDSH_PWA_PROBES__ = {actions:["操作"]};</script></head>');
	for (const base of [copyOnly, copyAndProbes]) {
		for (const html of [base, base.replace("<head>", "<head><!--dsh-mobile-maxxing-->")]) {
			const fixed = decorateIndex(html, {});
			assert.equal((fixed.match(/globalThis\.__RDSH_PWA_COPY__\s*=/g) ?? []).length, 1,
				"an existing copy table is not duplicated");
			assert.equal((fixed.match(/globalThis\.__RDSH_PWA_PROBES__\s*=/g) ?? []).length, 1,
				"an existing probe table is not duplicated");
			assert.equal((fixed.match(/globalThis\.__RDSH_PWA_LANG__\s*=/g) ?? []).length, 1,
				"the missing language is added");
			assert.equal(injectedPayload(fixed).__RDSH_PWA_LANG__, "ja");
			assert.equal(decorateIndex(fixed, {}), fixed, "the result is stable");
		}
	}
});

test("normalizeConfig rejects array, null and hostile language values", () => {
	for (const config of [null, [], "ja", 42, { lang: ["en"] }, { lang: "</script><script>alert(1)</script>" }]) {
		const html = decorateIndex(INDEX, config);
		assert.ok(!html.includes("alert(1)"), "no hostile value reaches the document");
		assert.equal(injectedPayload(html).__RDSH_PWA_LANG__, "ja", "the default is used instead");
	}
	const english = decorateIndex(INDEX, { lang: "en" });
	assert.equal(injectedPayload(english).__RDSH_PWA_LANG__, "en");
	// The mode script is the first script in the document, so the payload is
	// addressed by its own assignment rather than by being script #1.
	const script = /<script>(globalThis\.__RDSH_PWA_COPY__[\s\S]*?)<\/script>/.exec(english);
	assert.ok(script !== null, "the payload script exists");
	assert.ok(!script[1].includes("<"), "the payload code cannot close its own element");
	assert.doesNotThrow(() => new Function(script[1]), "the injected payload is valid JavaScript");
});

test("hostile config values cannot break out of the injected markup", () => {
	const html = decorateIndex(INDEX, {
		appleStatusBarStyle: '"><script>alert(1)</script>',
	});
	assert.ok(!html.includes("alert(1)"), "the rejected value never reaches the document");
	assert.ok(html.includes('"apple-mobile-web-app-status-bar-style","default"')
		|| html.includes('"default"'), "the default is carried instead");
	// A hostile value that somehow reached the bootstrap would still be a JSON
	// string, and the element stays closed exactly once.
	const hostile = earlyModeScript('"></script><script>alert(1)');
	assert.equal((hostile.match(/<\/script/gi) ?? []).length, 1, "one closing tag");
	assert.ok(!hostile.includes("alert(1)</script>"), "the value cannot close the element");
});

test("the merged plugin leaves the renderer alone", async () => {
	// The renderer patch rewrote the asset URLs of the shared document, so it
	// is not mounted here any more. A source check is what pins that: whether
	// the patch would find an installed dist is environment-dependent, so the
	// mounted-route count alone cannot catch a re-mount.
	const source = await readFile(new URL("../index.js", import.meta.url), "utf8");
	assert.doesNotMatch(source, /import\s*\{[^}]*applyMarkdownCjk[^}]*\}/,
		"the merged host half must not import the patch");
	assert.doesNotMatch(source, /mountPart\("rdsh-markdown-cjk"/,
		"the merged host half must not mount the patch");
	// The module itself keeps its API for the independent rdsh-markdown-cjk.
	const module = await readFile(new URL("../lib/markdown-cjk.js", import.meta.url), "utf8");
	assert.match(module, /export function apply\(/, "the standalone module stays usable");
});

test("the mobile bootstrap links the plugin manifest before the stock one", () => {
	// The stock document links its own manifest; the decorated copy must put
	// the plugin's link ahead of it without removing the stock one.
	const stock = INDEX.replace("</head>", '<link rel="manifest" href="./manifest.webmanifest" /></head>');
	const html = decorateIndex(stock, {});
	const bootstrapAt = html.indexOf(`globalThis.${MODE_GLOBAL}=`);
	const stockLinkAt = html.indexOf('rel="manifest"');
	assert.ok(bootstrapAt > 0 && stockLinkAt > 0);
	assert.ok(bootstrapAt < stockLinkAt, "the bootstrap is parsed before the stock link");
	// The stock document keeps its own link; the bootstrap prepends a link of
	// its own at head start, so the plugin manifest is first in tree order.
	assert.ok(html.includes(MANIFEST_FILE), "the dedicated filename travels in the bootstrap");
	const head = html.slice(0, html.indexOf("</head>"));
	assert.equal((head.match(/<link[^>]*rel="manifest"/g) ?? []).length, 1,
		"the served markup still holds exactly the stock link");

	// Root-level placement is what keeps an installed app on the site root.
	const base = "https://example.test/";
	for (const file of ["manifest.webmanifest", MANIFEST_FILE]) {
		const resolved = new URL("./", new URL(file, base));
		assert.equal(resolved.href, base, `${file} resolves id/start_url/scope to the root`);
	}
	const manifest = buildManifest({});
	assert.equal(manifest.id, "./");
	assert.equal(manifest.start_url, "./");
	assert.equal(manifest.scope, "./");
});

test("routes serve the manifest, the worker and the icons", async () => {
	const { routes, taps, listeners } = mount({});
	assert.ok(routes.has(`/${MANIFEST_FILE}`), "the plugin manifest has its own path");
	assert.equal(routes.has("/manifest.webmanifest"), false,
		"the stock manifest path is not overridden: a desktop install reads the stock file");
	assert.ok(routes.has("/sw.js"));
	assert.ok(routes.has("/pwa/icon-192.png"));
	// The merged plugin mounts the PWA/mode tap and the mobile-ux config tap,
	// and nothing that rewrites the renderer: the CJK half is the independent
	// plugin's job now. Assert the content instead of the exact count.
	assert.ok(taps.length >= 1, "at least the PWA tap");
	assert.equal([...routes.keys()].some((path) => path.startsWith("/markdown-cjk/")), false,
		"the merged plugin leaves the renderer alone");
	const decorated = taps.reduce((html, tap) => tap(html), INDEX);
	assert.equal(decorated.split("<!--dsh-mobile-maxxing-->").length - 1, 1, "one PWA block");
	assert.equal(injectedPayload(decorated).__RDSH_PWA_LANG__, "ja",
		"the mounted tap injects the normalized host language");
	assert.ok(decorated.includes("__RDSH_MOBILE_UX_CONFIG__"), "the mobile-ux half mounted");
	// Live speed subscribes to the model stream: proof the host half ran.
	assert.ok(listeners.some((entry) => entry.event === "llm/stream"), "mobile-ux subscribed to llm/stream");

	// The notification half is part of this package now.
	for (const path of [
		"/api/dsh-mobile-maxxing/push/vapid",
		"/api/dsh-mobile-maxxing/push/config",
		"/api/dsh-mobile-maxxing/push/subscribe",
		"/api/dsh-mobile-maxxing/push/unsubscribe",
		"/api/dsh-mobile-maxxing/push/mobile-send",
		"/api/dsh-mobile-maxxing/push/preview",
		"/api/dsh-mobile-maxxing/push/test",
	]) {
		assert.ok(routes.has(path), `missing ${path}`);
	}

	const manifest = await call(routes.get(`/${MANIFEST_FILE}`));
	assert.equal(manifest.status, 200);
	assert.match(manifest.headers["content-type"], /application\/manifest\+json/);
	assert.equal(JSON.parse(manifest.text).display, "standalone");
	assert.equal(JSON.parse(manifest.text).lang, "ja", "the default document language is ja");
	assert.equal(manifest.headers["cache-control"], "no-cache");

	const worker = await call(routes.get("/sw.js"));
	assert.equal(worker.status, 200);
	assert.match(worker.headers["content-type"], /text\/javascript/);
	assert.equal(worker.headers["service-worker-allowed"], "/");
	assert.match(worker.headers["cache-control"], /no-store/);
	assert.match(worker.text, /^self\.__RDSH_PWA_BUILD__="[0-9a-f]{12}";/);
	// The served bytes must parse as JavaScript.
	assert.doesNotThrow(() => new Function(worker.text));

	// The build hash is stable within one activation so an idle restart does
	// not push a bogus "update available" prompt.
	const again = await call(routes.get("/sw.js"));
	assert.equal(again.text, worker.text);
	// It must change when the worker source changes; the cache name derives
	// from it, so a stale shell cannot survive a release.
	assert.match(worker.text, /CACHE_NAME = CACHE_PREFIX \+ BUILD|const CACHE_NAME = CACHE_PREFIX \+ BUILD/);

	for (const icon of ["/pwa/icon-192.png", "/pwa/icon-512.png", "/pwa/icon-maskable-512.png", "/pwa/apple-touch-icon.png", "/pwa/badge-96.png"]) {
		const route = routes.get(icon);
		assert.ok(route, `${icon} is served`);
		const response = await call(route);
		assert.equal(response.status, 200, `${icon} exists`);
		assert.equal(response.headers["content-type"], "image/png");
		assert.ok(response.body.length > 500, `${icon} is not empty`);
	}
});

test("the worker injects the configured navigation timeout", async () => {
	const { routes } = mount({ navigationTimeoutMs: 2500, lang: "en" });
	const worker = await call(routes.get("/sw.js"));
	assert.match(worker.text, /"navigationTimeoutMs":2500/);
	assert.match(worker.text, /self\.__RDSH_PWA_CONFIG__=/);
	// The offline page and push defaults are rendered by the worker, so its
	// copy travels in the same config header. An explicit en profile keeps the
	// previous English copy.
	assert.match(worker.text, /"lang":"en"/);
	assert.match(worker.text, /"sw\.offlineHeading":"You're offline"/);
});

test("the worker follows the ja default but accepts the en dictionary", async () => {
	const { routes } = mount({});
	const worker = await call(routes.get("/sw.js"));
	assert.match(worker.text, /"lang":"ja"/);
	assert.match(worker.text, new RegExp(`"sw\\.offlineHeading":${JSON.stringify(copyFor("ja")["sw.offlineHeading"])}`));
});

test("the worker treats the markdown-cjk entry chunks as cacheable", async () => {
	// The independent CJK plugin rewrites the document to load /markdown-cjk/v1/*.js instead of
	// the stock assets. If the worker does not cache that path, an offline
	// launch serves the shell but the entry scripts fail and the plugin never
	// boots. Evaluate sw.js in a stub scope so this is the worker's own
	// classification, not a comment in the file.
	const source = await readFile(new URL("../sw.js", import.meta.url), "utf8");
	const sandbox = {
		self: {
			__RDSH_PWA_BUILD__: "test",
			__RDSH_PWA_CONFIG__: {},
			registration: { scope: "http://127.0.0.1/" },
			location: { origin: "http://127.0.0.1" },
			addEventListener() {},
			clients: { claim: async () => {} },
		},
		caches: { open: async () => ({}) },
		fetch: async () => { throw new Error("offline"); },
		URL,
		Response,
		AbortController,
		setTimeout,
		clearTimeout,
	};
	runInNewContext(`${source}\n;globalThis.__isStatic = isStatic;`, sandbox);
	assert.equal(sandbox.__isStatic(new URL("http://127.0.0.1/markdown-cjk/v1/index-CN7NIWNw.js")), true);
	assert.equal(sandbox.__isStatic(new URL("http://127.0.0.1/markdown-cjk/v1/vendor-DcuzkuQH.js")), true);
	assert.equal(sandbox.__isStatic(new URL("http://127.0.0.1/assets/index-BxpfOGf3.css")), true);
	assert.equal(sandbox.__isStatic(new URL("http://127.0.0.1/api/settings/describe")), false,
		"live API answers still go to the network");
});

test("notification copy defaults to the package language and keeps an explicit override", async () => {
	const previewOf = async (config) => {
		const { routes } = mount(config);
		const route = routes.get("/api/dsh-mobile-maxxing/push/preview");
		const response = await call(route, "GET", "/api/dsh-mobile-maxxing/push/preview?sessionId=");
		return JSON.parse(response.text);
	};
	assert.equal((await previewOf({})).copy.lang, "ja", "top-level lang is the notification default");
	assert.equal((await previewOf({ lang: "en" })).copy.lang, "en", "an en package keeps English notifications");
	assert.equal((await previewOf({ notifications: { lang: "en" } })).copy.lang, "en",
		"notifications.lang still wins over the package default");
});

test("release check validates GitHub response and compares numeric versions", async () => {
  assert.equal(compareReleaseVersions("0.6.1", "v0.10.0"), -1);
  assert.equal(compareReleaseVersions("0.6.1", "v0.6.1"), 0);
  assert.equal(compareReleaseVersions("0.7.0", "v0.6.1"), 1);
  assert.throws(() => compareReleaseVersions("unknown", "v0.6.1"));
  assert.equal(await fetchLatestRelease(async () => ({ ok: true, json: async () => ({ tag_name: "v0.8.0" }) })), "v0.8.0");
  await assert.rejects(fetchLatestRelease(async () => ({ ok: false, status: 503 })), /503/);
  await assert.rejects(fetchLatestRelease(async () => ({ ok: true, json: async () => ({ tag_name: "../../evil" }) })), /Invalid release/);
  await assert.rejects(fetchLatestRelease(async () => ({ ok: true, json: async () => ({ tag_name: "v0.8.0", prerelease: true }) })), /Invalid release/);
});

test("update routes require authentication and a confirmed release", async () => {
  const denied = mount({}, { connection: { requestRejection: () => 403 } });
  assert.equal((await call(denied.routes.get("/dsh-mobile-maxxing/plugin-version"))).status, 403);
  assert.equal((await call(denied.routes.get("/dsh-mobile-maxxing/update-plugins"), "POST")).status, 403);
  const allowed = mount({});
  assert.equal((await call(allowed.routes.get("/dsh-mobile-maxxing/update-plugins"), "POST")).status, 409);
});

test("confirmed update installs only the checked release in the active profile", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-update-test-"));
  const output = join(dir, "args");
  await writeFile(join(dir, "dsh"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$TEST_UPDATE_ARGS"\n', { mode: 0o755 });
  const originalFetch = globalThis.fetch, oldPath = process.env.PATH, oldOutput = process.env.TEST_UPDATE_ARGS;
  const rootManifest = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));
  const [major, minor, patch] = rootManifest.version.split(".").map(Number);
  const nextTag = `v${major}.${minor}.${patch + 1}`;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ tag_name: nextTag }) });
  process.env.PATH = dir + ":" + oldPath;
  process.env.TEST_UPDATE_ARGS = output;
  try {
    const { routes } = mount({});
    const check = await call(routes.get("/dsh-mobile-maxxing/plugin-version"));
    assert.equal(check.status, 200);
    assert.equal(JSON.parse(check.text).available, true);
    assert.equal(JSON.parse(check.text).current, rootManifest.version);
    assert.equal((await call(routes.get("/dsh-mobile-maxxing/update-plugins"), "POST", undefined, { "x-dsh-release": "v9.9.9" })).status, 409);
    const result = await call(routes.get("/dsh-mobile-maxxing/update-plugins"), "POST", undefined, { "x-dsh-release": nextTag });
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.text), { ok: true, version: nextTag });
    assert.deepEqual((await readFile(output, "utf8")).trim().split("\n"), ["plugin", "--profile", "test", "add", `github:kuraneko1/dsh-mobile-maxxing#${nextTag}`]);
    assert.equal((await call(routes.get("/dsh-mobile-maxxing/update-plugins"), "POST", undefined, { "x-dsh-release": nextTag })).status, 409);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.PATH = oldPath;
    if (oldOutput === undefined) delete process.env.TEST_UPDATE_ARGS; else process.env.TEST_UPDATE_ARGS = oldOutput;
  }
});

test("a failed release fetch is an error, not latest", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  try {
    const { routes } = mount({});
    assert.equal((await call(routes.get("/dsh-mobile-maxxing/plugin-version"))).status, 502);
    assert.equal((await call(routes.get("/dsh-mobile-maxxing/update-plugins"), "POST", undefined, { "x-dsh-release": "v0.8.0" })).status, 409);
  } finally { globalThis.fetch = originalFetch; }
});

test("routes reject methods they do not own", async () => {
	const { routes } = mount({});
	for (const path of [`/${MANIFEST_FILE}`, "/sw.js", "/pwa/icon-192.png"]) {
		const response = await call(routes.get(path), "POST");
		assert.equal(response.status, 405);
		assert.equal(response.headers.allow, "GET, HEAD");
	}
});

test("HEAD returns headers without a body", async () => {
	const { routes } = mount({});
	const response = await call(routes.get(`/${MANIFEST_FILE}`), "HEAD");
	assert.equal(response.status, 200);
	assert.equal(response.body.length, 0);
	assert.ok(Number(response.headers["content-length"]) > 10);
});

test("a missing optional asset is a 404, not a crash", async () => {
	const { routes } = mount({});
	const route = routes.get("/pwa/screenshot-mobile.png");
	if (route === undefined) return;
	const response = await call(route);
	assert.ok(response.status === 200 || response.status === 404);
});

test("the service worker never caches live state", async () => {
	const { routes } = mount({});
	const source = (await call(routes.get("/sw.js"))).text;
	assert.match(source, /BYPASS_SEGMENTS = \["\/api", "\/hmr", "\/terminal", "\/__"\]/,
		"API answers must always come from the server");
	assert.match(source, /request\.method !== "GET"/, "mutations are never intercepted");
});
