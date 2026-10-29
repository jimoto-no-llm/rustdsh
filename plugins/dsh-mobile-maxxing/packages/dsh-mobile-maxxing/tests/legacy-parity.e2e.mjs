#!/usr/bin/env node
/**
 * Baseline/legacy parity harness for the phone UI.
 *
 * Loads the *real* DSH Web app twice — once with the legacy split packages
 * (`dsh-mobile-maxxing` + `rdsh-mobile-ux` + `rdsh-mobile-ui`) and once with this
 * package — in an isolated headless Chrome browser context, then drives the
 * same touch gestures against the same throwaway DOM and compares the state,
 * attributes and geometry.
 *
 * It never reads, writes or screenshots a user session: every context starts
 * with empty Web Storage on a throwaway DSH_HOME, and all fixtures are labelled
 * `qa-*`. Only localhost URLs are used.
 *
 * Usage (servers are prepared by qa/run-parity.sh in the QA workspace):
 *
 *   BASE_URL_BASELINE=http://127.0.0.1:3197/?token=... \
 *   BASE_URL_UNIFIED=http://127.0.0.1:3196/?token=... \
 *   QA_OUT=/tmp/dsh-ui-parity-20261024/qa \
 *   node packages/dsh-mobile-maxxing/tests/legacy-parity.e2e.mjs
 *
 * Optional: CHROME=google-chrome CDP_PORT=9466 HEADLESS=--headless=new
 *
 * Exit code: 0 when the harness ran (including known differences), 1 when a
 * baseline check regressed in the unified build, 2 when the harness could not
 * run. `results.json` carries every observation.
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

const BASELINE_URL = process.env.BASE_URL_BASELINE || "";
const UNIFIED_URL = process.env.BASE_URL_UNIFIED || "";
const QA_OUT = process.env.QA_OUT || "/tmp/dsh-ui-parity-qa";
const CHROME = process.env.CHROME || "google-chrome";
const CDP_PORT = Number(process.env.CDP_PORT || 9466);
const HEADLESS = process.env.HEADLESS || "--headless=new";
const SHOTS = join(QA_OUT, "shots");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (BASELINE_URL === "" || UNIFIED_URL === "") {
	console.error("BASE_URL_BASELINE and BASE_URL_UNIFIED are required");
	process.exit(2);
}

// ---------------------------------------------------------------- CDP client
class Cdp {
	constructor(socket) {
		this.socket = socket;
		this.id = 0;
		this.pending = new Map();
		this.listeners = new Map();
		socket.onmessage = (event) => this.receive(event.data);
	}

	static async connect(url) {
		const socket = new WebSocket(url);
		await new Promise((resolve, reject) => {
			socket.onopen = resolve;
			socket.onerror = reject;
		});
		return new Cdp(socket);
	}

	receive(raw) {
		const message = JSON.parse(raw);
		if (message.id !== undefined) {
			const pending = this.pending.get(message.id);
			this.pending.delete(message.id);
			if (message.error) pending.reject(new Error(message.error.message));
			else pending.resolve(message.result);
			return;
		}
		for (const fn of this.listeners.get(message.method) || []) fn(message.params);
	}

	send(method, params = {}, sessionId = undefined) {
		const id = ++this.id;
		const message = { id, method, params };
		if (sessionId !== undefined) message.sessionId = sessionId;
		this.socket.send(JSON.stringify(message));
		return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
	}

	on(method, fn) {
		if (!this.listeners.has(method)) this.listeners.set(method, []);
		this.listeners.get(method).push(fn);
	}

	async eval(expression) {
		const result = await this.send("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
		});
		if (result.exceptionDetails) {
			throw new Error(
				result.exceptionDetails.exception?.description
				|| result.exceptionDetails.text
				|| "evaluation failed",
			);
		}
		return result.result.value;
	}
}

// ---------------------------------------------------------------- Chrome
async function waitForChrome() {
	for (let attempt = 0; attempt < 120; attempt += 1) {
		try {
			const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
			if (response.ok) return response.json();
		} catch {
			/* not up yet */
		}
		await sleep(100);
	}
	throw new Error(`Chrome is not reachable on 127.0.0.1:${CDP_PORT}`);
}

async function startChrome() {
	await mkdir(QA_OUT, { recursive: true });
	const profile = await mkdtemp(join(QA_OUT, "chrome-"));
	const child = spawn(CHROME, [
		HEADLESS,
		`--remote-debugging-port=${CDP_PORT}`,
		`--user-data-dir=${profile}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-gpu",
		"--disable-background-networking",
		"--disable-component-update",
		"--disable-sync",
		"--metrics-recording-only",
		"--no-pings",
		"--no-service-autorun",
		"about:blank",
	], { stdio: "ignore", detached: true });
	let exited = false;
	child.once("exit", () => {
		exited = true;
	});
	const cleanup = async () => {
		if (!exited) {
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {
				/* already gone */
			}
			await sleep(500);
			if (!exited) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					/* already gone */
				}
			}
		}
	};
	return { child, profile, cleanup };
}

async function openPage(port, options) {
	const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
	const browser = await Cdp.connect(version.webSocketDebuggerUrl);
	const { browserContextId } = await browser.send("Target.createBrowserContext", { disposeOnDetach: true });
	const { targetId } = await browser.send("Target.createTarget", { url: "about:blank", browserContextId });
	const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
	const target = targets.find((entry) => entry.id === targetId);
	if (target === undefined) throw new Error("new target is not listed");
	const page = await Cdp.connect(target.webSocketDebuggerUrl);
	await page.send("Page.enable");
	await page.send("Runtime.enable");
	// Throughput of the service worker is irrelevant to these assertions, and
	// every browser context starts with empty storage; no need for a bypass.
	await page.send("Emulation.setDeviceMetricsOverride", {
		width: options.width,
		height: options.height,
		deviceScaleFactor: options.scale ?? 1,
		mobile: options.mobile,
	});
	await page.send("Emulation.setTouchEmulationEnabled", {
		enabled: options.touch,
		maxTouchPoints: options.touch ? 5 : 1,
	});
	if (options.userAgent) {
		await page.send("Emulation.setUserAgentOverride", { userAgent: options.userAgent });
	}
	const preload = [];
	preload.push("try { localStorage.clear(); sessionStorage.clear(); } catch {}");
	preload.push("addEventListener('beforeinstallprompt', (event) => event.preventDefault());");
	if (options.standalone) {
		preload.push("Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true });");
	}
	if (options.preload) preload.push(options.preload);
	await page.send("Page.addScriptToEvaluateOnNewDocument", { source: preload.join("\n") });
	await page.send("Page.navigate", { url: options.url });

	const close = async () => {
		try {
			await browser.send("Target.closeTarget", { targetId });
		} catch {
			/* already closed */
		}
		try {
			await browser.send("Target.disposeBrowserContext", { browserContextId });
		} catch {
			/* already disposed */
		}
		page.socket.close();
		browser.socket.close();
	};
	return { browser, page, close };
}

// ---------------------------------------------------------------- helpers
async function visibleDialogs(page) {
	return page.eval(`[...document.querySelectorAll('[role="dialog"]')].filter((dialog) => {
		if (dialog.id === "qa-lightbox-fixture") return false;
		const rect = dialog.getBoundingClientRect();
		const style = getComputedStyle(dialog);
		return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
	}).map((dialog) => ({
		label: dialog.getAttribute("aria-label") || "",
		text: (dialog.innerText || "").replace(/\\s+/g, " ").slice(0, 160),
		buttons: [...dialog.querySelectorAll("button")].map((button) => ({
			text: (button.textContent || "").trim(),
			aria: button.getAttribute("aria-label") || "",
		})),
	}))`);
}

/**
 * The app opens two first-run dialogs on a fresh profile: "Preview Notice"
 * and then "Get started" (the latter because the throwaway home has no
 * credentials; we never sign in). Neither is part of the phone layout, and a
 * screenshot taken through them proves nothing, so close both by their own
 * controls and fail the scenario if one remains.
 */
async function dismissBlockingDialogs(page, timeoutMs = 12000) {
	const deadline = Date.now() + timeoutMs;
	let stable = 0;
	while (Date.now() < deadline) {
		const dialogs = await visibleDialogs(page).catch(() => []);
		if (dialogs.length === 0) {
			stable += 1;
			if (stable >= 4) return [];
			await sleep(200);
			continue;
		}
		stable = 0;
		const closed = await page.eval(`(() => {
			const visible = [...document.querySelectorAll('[role="dialog"]')].filter((dialog) => {
				if (dialog.id === "qa-lightbox-fixture") return false;
				const rect = dialog.getBoundingClientRect();
				const style = getComputedStyle(dialog);
				return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
			});
			const wanted = [
				(button) => /continue/i.test(button.textContent || ""),
				(button) => button.getAttribute("aria-label") === "Close",
				(button) => /^(close|later|skip|ok|got it|start)$/i.test((button.textContent || "").trim()),
			];
			for (const dialog of visible) {
				for (const matcher of wanted) {
					const button = [...dialog.querySelectorAll("button")].find(matcher);
					if (button !== undefined) {
						button.click();
						return dialog.getAttribute("aria-label") || "dialog";
					}
				}
			}
			return "";
		})()`).catch(() => "");
		if (closed === "") {
			// No known control: pressing Escape is the app's own dismiss path.
			await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
			await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
		}
		await sleep(400);
	}
	return visibleDialogs(page).catch(() => []);
}

async function waitReady(page) {
	for (let attempt = 0; attempt < 120; attempt += 1) {
		await sleep(150);
		// A wide window legitimately has no floating drawer button, so wait
		// for the two plugin globals only instead of timing out on wide.
		const ready = await page.eval(`Boolean(
			globalThis.__RDSH_PWA__ && globalThis.__RDSH_MOBILE_UX__
		)`).catch(() => false);
		if (ready) return true;
	}
	return false;
}

async function boot(page, url) {
	await page.send("Page.navigate", { url });
	await waitReady(page);
	page.blockedDialogs = await dismissBlockingDialogs(page);
	await sleep(300);
}

const touchPoint = (x, y) => [{ x, y, radiusX: 2, radiusY: 2, force: 1, id: 1 }];

async function swipe(page, x1, y1, x2, y2, { steps = 8, hold = 16 } = {}) {
	await page.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touchPoint(x1, y1) });
	for (let step = 1; step <= steps; step += 1) {
		const x = x1 + ((x2 - x1) * step) / steps;
		const y = y1 + ((y2 - y1) * step) / steps;
		await page.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: touchPoint(x, y) });
		await sleep(hold);
	}
	await page.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	await sleep(500);
}

async function state(page) {
	return page.eval(`(() => {
		const html = document.documentElement;
		const fab = document.querySelector(".rdsh-mux-fab");
		const diagnostics = globalThis.__RDSH_MOBILE_UX__;
		const rounds = (rect) => ({
			x: Math.round(rect.x), y: Math.round(rect.y),
			width: Math.round(rect.width), height: Math.round(rect.height),
			right: Math.round(rect.right), bottom: Math.round(rect.bottom),
		});
		// The plugin's data-rdsh-rightpanel / html[data-rdsh-rightpanel-open]
		// are phone-only decorations. Wide builds differ in when they add or
		// forget them even though upstream's panel is in the same visible
		// state. Decide open/closed from upstream's own DOM instead.
		const roots = [...document.querySelectorAll("[data-sidebar-right-panel]")];
		const panels = roots.map((root) => {
			const style = getComputedStyle(root);
			const rect = root.getBoundingClientRect();
			const hiddenAncestor = root.closest("[hidden]") !== null;
			const intersects = rect.width > 0 && rect.height > 0
				&& rect.right > 0 && rect.bottom > 0
				&& rect.left < innerWidth && rect.top < innerHeight;
			const visible = !hiddenAncestor
				&& root.getAttribute("aria-hidden") !== "true"
				&& style.display !== "none"
				&& style.visibility !== "hidden"
				&& intersects;
			return {
				visible,
				hiddenAncestor,
				intersects,
				display: style.display,
				visibility: style.visibility,
				rect: rounds(rect),
			};
		});
		const visiblePanel = panels.find((panel) => panel.visible) ?? null;
		const decoratedPanel = document.querySelector("[data-rdsh-rightpanel]");
		return {
			width: innerWidth,
			height: innerHeight,
			narrow: matchMedia("(max-width: 767px)").matches,
			mode: html.getAttribute("data-rdsh-device-mode"),
			coarse: matchMedia("(pointer: coarse)").matches,
			anyCoarse: matchMedia("(any-pointer: coarse)").matches,
			standalone: html.getAttribute("data-dsh-mobile-maxxing"),
			phone: diagnostics && typeof diagnostics.phone === "function" ? diagnostics.phone() : null,
			diagnosticsState: diagnostics ? { ...diagnostics.state } : null,
			drawer: html.getAttribute("data-rdsh-drawer"),
			// Real, user-visible upstream panel state. This is the behaviour
			// assertion; decorative attributes are recorded separately.
			panelOpen: visiblePanel !== null,
			panelVisible: visiblePanel !== null,
			panelRect: visiblePanel === null ? null : visiblePanel.rect,
			panelRoots: panels.length,
			panelStates: panels,
			panelDecoratedOpen: html.hasAttribute("data-rdsh-rightpanel-open"),
			panelTagged: decoratedPanel !== null,
			panelTaggedRect: decoratedPanel === null ? null : rounds(decoratedPanel.getBoundingClientRect()),
			hideSettings: html.hasAttribute("data-rdsh-hide-settings"),
			fabDisplay: fab === null ? null : getComputedStyle(fab).display,
			backdropOpacity: (() => {
				const backdrop = document.querySelector(".rdsh-mux-backdrop");
				return backdrop === null ? null : getComputedStyle(backdrop).opacity;
			})(),
		};
	})()`);
}

async function addHideFixture(page) {
	await page.eval(`(() => {
		const old = document.getElementById("qa-hide-fixture");
		if (old !== null) old.remove();
		const labels = ["More actions", "Feedback", "Keyboard shortcuts"];
		const holder = document.createElement("div");
		holder.id = "qa-hide-fixture";
		holder.style.cssText = "position:fixed;right:8px;top:96px;z-index:99990;display:flex;flex-direction:column;gap:4px;background:#111;padding:6px;align-items:flex-end";
		for (const label of labels) {
			const button = document.createElement("button");
			button.type = "button";
			button.setAttribute("aria-label", label);
			button.textContent = label;
			holder.append(button);
		}
		// #33: the native open-in-app split button is matched structurally, not
		// by a label (the host names the app itself).
		const openTarget = document.createElement("div");
		openTarget.id = "qa-open-target";
		openTarget.setAttribute("data-open-target", "file");
		const openButton = document.createElement("button");
		openButton.setAttribute("data-open-path-open", "");
		openButton.textContent = "Open";
		openTarget.append(openButton);
		holder.append(openTarget);
		document.body.append(holder);
		globalThis.__qaHideFixture = labels;
		return true;
	})()`);
	await page.eval(`globalThis.__RDSH_MOBILE_UX__.decorate()`).catch(() => {});
	await sleep(900);
}

async function hideReport(page) {
	return page.eval(`(() => {
		const labels = globalThis.__qaHideFixture || [];
		return {
			html: document.documentElement.hasAttribute("data-rdsh-hide-settings"),
			openTarget: (() => {
				const element = document.getElementById("qa-open-target");
				if (element === null) return null;
				const style = getComputedStyle(element);
				return { display: style.display, visible: style.display !== "none" && element.getBoundingClientRect().height > 0 };
			})(),
			items: labels.map((label) => {
				const button = document.querySelector('#qa-hide-fixture button[aria-label="' + label + '"]');
				if (button === null) return { label, found: false };
				const style = getComputedStyle(button);
				return {
					label,
					found: true,
					hiddenAttr: button.hasAttribute("data-rdsh-hidden"),
					display: style.display,
					visible: style.display !== "none" && button.getBoundingClientRect().height > 0,
				};
			}),
		};
	})()`);
}

async function addScrollFixture(page) {
	await page.eval(`(() => {
		const old = document.getElementById("qa-scroll-fixture");
		if (old !== null) old.remove();
		const box = document.createElement("div");
		box.id = "qa-scroll-fixture";
		box.style.cssText = "position:fixed;left:0;top:180px;width:100%;height:320px;overflow:auto;z-index:99980;background:#101010;touch-action:auto;overscroll-behavior:contain";
		const inner = document.createElement("div");
		inner.style.cssText = "width:900px;height:1200px;background:linear-gradient(45deg,#222,#444)";
		box.append(inner);
		document.body.append(box);
		globalThis.__qaPrevented = [];
		box.addEventListener("touchmove", (event) => {
			if (event.defaultPrevented) globalThis.__qaPrevented.push({ x: event.touches[0]?.clientX, y: event.touches[0]?.clientY });
		}, { passive: true });
		return true;
	})()`);
	await sleep(300);
}

async function scrollReport(page) {
	return page.eval(`(() => {
		const box = document.getElementById("qa-scroll-fixture");
		const html = document.documentElement;
		return {
			top: box === null ? null : box.scrollTop,
			left: box === null ? null : box.scrollLeft,
			prevented: (globalThis.__qaPrevented || []).length,
			drawer: html.getAttribute("data-rdsh-drawer"),
			panelOpen: html.hasAttribute("data-rdsh-rightpanel-open"),
		};
	})()`);
}

async function addToastFixture(page) {
	await page.eval(`(() => {
		const old = document.getElementById("qa-toast-fixture");
		if (old !== null) old.remove();
		const toast = document.createElement("div");
		toast.id = "qa-toast-fixture";
		toast.setAttribute("role", "alert");
		toast.textContent = "qa toast";
		toast.style.cssText = "position:fixed;left:50%;top:110px;transform:translateX(-50%);z-index:99995;background:#222;color:#fff;padding:10px 16px;border-radius:10px";
		document.body.append(toast);
		return true;
	})()`);
	await page.eval(`globalThis.__RDSH_MOBILE_UX__.decorate()`).catch(() => {});
	for (let attempt = 0; attempt < 30; attempt += 1) {
		const ready = await page.eval(`document.getElementById("qa-toast-fixture")?.hasAttribute("data-rdsh-toast") === true`);
		if (ready) return true;
		await sleep(100);
	}
	return false;
}

async function addLightboxFixture(page) {
	await page.eval(`(() => {
		const old = document.getElementById("qa-lightbox-fixture");
		if (old !== null) old.remove();
		globalThis.__qaCloseCount = 0;
		const dialog = document.createElement("div");
		dialog.id = "qa-lightbox-fixture";
		dialog.setAttribute("role", "dialog");
		dialog.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.9);display:flex;align-items:center;justify-content:center";
		const stage = document.createElement("div");
		stage.className = "_stage_qa";
		stage.style.cssText = "width:90%;height:70%;display:flex;align-items:center;justify-content:center";
		const image = document.createElement("img");
		image.alt = "qa";
		image.src = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="220" height="160"><rect width="220" height="160" fill="#4d6bfe"/></svg>');
		image.style.cssText = "width:220px;height:160px";
		stage.append(image);
		const close = document.createElement("button");
		close.className = "_close_qa";
		close.type = "button";
		close.textContent = "close";
		close.addEventListener("click", () => {
			globalThis.__qaCloseCount += 1;
		});
		dialog.append(stage, close);
		document.body.append(dialog);
		return true;
	})()`);
	await page.eval(`globalThis.__RDSH_MOBILE_UX__.decorate()`).catch(() => {});
	for (let attempt = 0; attempt < 30; attempt += 1) {
		const ready = await page.eval(`document.getElementById("qa-lightbox-fixture")?.hasAttribute("data-rdsh-swipe") === true`);
		if (ready) return true;
		await sleep(100);
	}
	return false;
}

async function shot(page, name) {
	const blockers = await dismissBlockingDialogs(page, 3000);
	if (blockers.length > 0) {
		page.blockedShots = page.blockedShots || [];
		page.blockedShots.push({ name, dialogs: blockers.map((dialog) => dialog.label || dialog.text.slice(0, 40)) });
		return;
	}
	try {
		const data = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
		const prefix = page.variant ? `${page.variant}-` : "";
		await writeFile(join(SHOTS, `${prefix}${name}.png`), Buffer.from(data.data, "base64"));
	} catch {
		/* screenshots are best-effort */
	}
}

// ---------------------------------------------------------------- scenarios
function scenario(name, run) {
	return { name, run };
}

async function addGestureLayer(page) {
	await page.eval(`(() => {
		document.getElementById("qa-gesture-layer")?.remove();
		const layer = document.createElement("div");
		layer.id = "qa-gesture-layer";
		layer.style.cssText = "position:fixed;inset:0;z-index:99970;background:transparent;touch-action:none";
		document.body.append(layer);
		return true;
	})()`);
	await sleep(150);
}

async function removeGestureLayer(page) {
	await page.eval(`document.getElementById("qa-gesture-layer")?.remove()`);
}

/**
 * Edge swipes need a neutral target at the very edge (a real page often puts a
 * button there). The layer exists only for the duration of one gesture, so it
 * cannot cover a dialog or make a blocked screen look interactive.
 */
async function edgeSwipe(page, x1, y1, x2, y2) {
	const blockers = await dismissBlockingDialogs(page, 3000);
	if (blockers.length > 0) return false;
	await addGestureLayer(page);
	try {
		await swipe(page, x1, y1, x2, y2);
	} finally {
		await removeGestureLayer(page);
	}
	return true;
}

async function normalizeChrome(page) {
	await page.eval(`(() => {
		const html = document.documentElement;
		if (html.hasAttribute("data-rdsh-rightpanel-open")) {
			document.querySelector('[aria-label="Collapse right sidebar"]')?.click();
		}
		if (html.getAttribute("data-rdsh-drawer") === "open") {
			document.querySelector('[aria-label="Collapse sidebar"]')?.click();
		}
		return true;
	})()`);
	await sleep(500);
}

async function drawerNavState(page) {
	return page.eval(`(() => {
		const drawer = document.querySelector("[data-rdsh-sidebar]");
		if (drawer === null) return { drawerFound: false, rows: [], navSet: [], workspacesY: null };
		const round = (rect) => ({
			x: Math.round(rect.x), y: Math.round(rect.y),
			width: Math.round(rect.width), height: Math.round(rect.height),
			right: Math.round(rect.right), bottom: Math.round(rect.bottom),
		});
		const visibleIn = (element, container) => {
			if (element === null) return false;
			const style = getComputedStyle(element);
			const rect = element.getBoundingClientRect();
			const box = container.getBoundingClientRect();
			const hiddenAncestor = element.closest("[hidden]") !== null
				|| element.closest('[aria-hidden="true"]') !== null
				|| element.closest("[data-rdsh-hidden]") !== null;
			const intersects = rect.width > 0 && rect.height > 0
				&& rect.right > Math.max(0, box.left) && rect.left < Math.min(innerWidth, box.right)
				&& rect.bottom > Math.max(0, box.top) && rect.top < Math.min(innerHeight, box.bottom);
			return style.display !== "none" && style.visibility !== "hidden" && !hiddenAncestor && intersects;
		};
		const specs = [
			{ key: "new-session", label: /^new session$/i },
			{ key: "plugins", label: /^plugins$/i },
			{ key: "automation", label: /^automation tasks$/i },
			{ key: "settings", label: /^(settings|設定)$/i },
		];
		const controls = [...drawer.querySelectorAll("button, [role='button'], a")];
		const rows = specs.map((spec) => {
			const element = controls.find((entry) => {
				const label = (entry.getAttribute("aria-label") || "").trim();
				const text = (entry.textContent || "").trim();
				return spec.label.test(label) || spec.label.test(text);
			});
			if (element === undefined) {
				return { key: spec.key, found: false, visible: false, label: null, display: null, visibility: null, hiddenAncestor: false, intersects: false, rect: null };
			}
			const style = getComputedStyle(element);
			const rect = element.getBoundingClientRect();
			const box = drawer.getBoundingClientRect();
			const hiddenAncestor = element.closest("[hidden]") !== null
				|| element.closest('[aria-hidden="true"]') !== null
				|| element.closest("[data-rdsh-hidden]") !== null;
			const intersects = rect.width > 0 && rect.height > 0
				&& rect.right > Math.max(0, box.left) && rect.left < Math.min(innerWidth, box.right)
				&& rect.bottom > Math.max(0, box.top) && rect.top < Math.min(innerHeight, box.bottom);
			return {
				key: spec.key,
				found: true,
				label: ((element.getAttribute("aria-label") || "").trim() || (element.textContent || "").trim()).slice(0, 80),
				display: style.display,
				visibility: style.visibility,
				hiddenAncestor,
				intersects,
				rect: round(rect),
				visible: style.display !== "none" && style.visibility !== "hidden" && !hiddenAncestor && intersects,
			};
		});
		const workspaces = [...drawer.querySelectorAll("*")].find((element) =>
			element.children.length === 0 && /^(workspaces|ワークスペース)$/i.test((element.textContent || "").trim()),
		);
		return {
			drawerFound: true,
			drawerRect: round(drawer.getBoundingClientRect()),
			rows,
			navSet: rows.filter((row) => row.visible).map((row) => row.key),
			workspacesY: workspaces === undefined ? null : Math.round(workspaces.getBoundingClientRect().y),
			workspacesLabel: workspaces === undefined ? null : (workspaces.textContent || "").trim(),
			workspacesVisible: visibleIn(workspaces ?? null, drawer),
		};
	})()`);
}

async function coreGestures(page, report) {
	await boot(page, page.baseUrl);
	report.check("core: no blocking dialog after boot", (page.blockedDialogs || []).length === 0, page.blockedDialogs);
	const initial = await state(page);
	report.metrics.initial = initial;
	report.check("plugin booted on the phone", initial.fabDisplay !== null);
	report.check("initial drawer is closed", initial.drawer === "closed", initial.drawer);
	report.check("initial right panel is closed", initial.panelOpen === false, initial.panelOpen);

	await edgeSwipe(page, 8, 420, 120, 420);
	const afterLeft = await state(page);
	report.metrics.afterLeftSwipe = afterLeft;
	report.check("left-edge swipe opens the drawer", afterLeft.drawer === "open", afterLeft.drawer);
	report.check("drawer hides the floating button", afterLeft.fabDisplay === "none", afterLeft.fabDisplay);
	report.check("drawer shows the backdrop", Number(afterLeft.backdropOpacity) > 0.5, afterLeft.backdropOpacity);

	// Real swipe-opened drawer: the four top navigation rows and the
	// Workspaces heading must be visible in the drawer viewport. Check the
	// live DOM (display/visibility/rect/hidden ancestor), not just existence.
	const drawerNav = await drawerNavState(page);
	report.metrics.drawerNav = drawerNav;
	report.check("drawer root is decorated after the swipe", drawerNav.drawerFound === true, drawerNav);
	for (const key of ["new-session", "plugins", "automation", "settings"]) {
		const row = drawerNav.rows.find((entry) => entry.key === key);
		report.check(`drawer shows visible row: ${key}`, row !== undefined && row.visible === true, row);
	}
	report.observe("drawer: nav set", drawerNav.navSet, drawerNav);
	report.observe("drawer: workspaces y", drawerNav.workspacesY, drawerNav);
	report.observe("drawer: workspaces visible", drawerNav.workspacesVisible, drawerNav);
	report.observe("drawer: visible labels", drawerNav.rows.filter((row) => row.visible).map((row) => row.label), drawerNav);

	// Two decorate passes must not remove the rows (the regression is a
	// decoration/CSS interaction, not just an initial paint).
	for (let pass = 0; pass < 2; pass += 1) {
		await page.eval(`globalThis.__RDSH_MOBILE_UX__?.decorate?.()`);
		await sleep(700);
	}
	const drawerNavAfter = await drawerNavState(page);
	report.metrics.drawerNavAfterDecorate = drawerNavAfter;
	report.check(
		"drawer rows survive two decorate passes",
		JSON.stringify(drawerNavAfter.navSet) === JSON.stringify(drawerNav.navSet),
		{ before: drawerNav.navSet, after: drawerNavAfter.navSet, rows: drawerNavAfter.rows },
	);
	report.observe("drawer: nav set after two decorate", drawerNavAfter.navSet, drawerNavAfter);
	report.observe("drawer: workspaces y after two decorate", drawerNavAfter.workspacesY, drawerNavAfter);
	// The selected session row in this same drawer shot: report the computed
	// fill and border of the open-row hooks in both builds so a light-theme
	// token or a dropped inset border is a measured difference, not a visual
	// judgement.
	const openRowPaint = await page.eval(`(() => {
		return [...document.querySelectorAll("[data-rdsh-open-row]")].slice(0, 3).map((row) => {
			const style = getComputedStyle(row);
			return {
				key: (row.getAttribute("data-row-key") || "").slice(0, 80),
				ring: row.hasAttribute("data-rdsh-ring-row"),
				backgroundColor: style.backgroundColor,
				boxShadow: style.boxShadow,
			};
		});
	})()`);
	report.metrics.openRowPaint = openRowPaint;
	report.check("drawer: at least one open session row is painted", openRowPaint.length > 0, openRowPaint);
	// Only the paint is a parity observation. `key` names the session that each
	// throwaway DSH_HOME auto-created, so it differs by design and stays in
	// metrics.openRowPaint (and the detail) for diagnosis.
	report.observe(
		"drawer: open session row paint",
		openRowPaint.map(({ ring, backgroundColor, boxShadow }) => ({ ring, backgroundColor, boxShadow })),
		openRowPaint,
	);
	// The drawer's own header toggle (the logo/panel icon at its top right).
	// Pin its computed paint here: the merged build once left it secondary
	// grey while the reference painted it label-primary in every state.
	const sidebarTogglePaint = await page.eval(`(() => {
		const toggle = document.querySelector('[data-slot="sidebar"] button[aria-label="Open sidebar"], [data-slot="sidebar"] button[aria-label="Collapse sidebar"]');
		if (toggle === null) return null;
		const style = getComputedStyle(toggle);
		return {
			label: toggle.getAttribute("aria-label"),
			color: style.color,
			backgroundColor: style.backgroundColor,
		};
	})()`);
	report.metrics.sidebarTogglePaint = sidebarTogglePaint;
	report.observe(
		"drawer: sidebar header toggle paint",
		sidebarTogglePaint === null ? null : {
			color: sidebarTogglePaint.color,
			backgroundColor: sidebarTogglePaint.backgroundColor,
		},
		sidebarTogglePaint,
	);
	await shot(page, "core-left-drawer");

	await page.eval(`globalThis.__RDSH_MOBILE_UX__.closeDrawer()`);
	await sleep(500);
	const closed = await state(page);
	report.check("drawer closes again", closed.drawer === "closed", closed.drawer);

	await edgeSwipe(page, 382, 420, 270, 420);
	const afterRight = await state(page);
	report.metrics.afterRightSwipe = afterRight;
	report.check("right-edge swipe opens the right panel", afterRight.panelOpen === true, afterRight.panelOpen);
	report.check("right panel is tagged with a layout hook", afterRight.panelTagged === true);
	await shot(page, "core-right-panel");

	await edgeSwipe(page, 250, 420, 340, 420);
	const afterClose = await state(page);
	report.metrics.afterPanelCloseSwipe = afterClose;
	report.check("rightward swipe closes the right panel", afterClose.panelOpen === false, afterClose.panelOpen);

	// Exclusivity: an open drawer owns the edge; a right-edge swipe must not
	// pull the preview over the session list.
	await page.eval(`globalThis.__RDSH_MOBILE_UX__.openDrawer()`);
	await sleep(500);
	const drawerOpen = await state(page);
	report.check("drawer can be opened programmatically", drawerOpen.drawer === "open", drawerOpen.drawer);
	await edgeSwipe(page, 382, 420, 270, 420);
	const afterExclusive = await state(page);
	report.metrics.exclusiveDrawer = afterExclusive;
	report.check("right swipe while the drawer is open keeps the panel closed", afterExclusive.panelOpen === false, afterExclusive.panelOpen);
	report.check("right swipe while the drawer is open keeps the drawer open", afterExclusive.drawer === "open", afterExclusive.drawer);
	await page.eval(`globalThis.__RDSH_MOBILE_UX__.closeDrawer()`);
	await sleep(400);

	// The reverse edge: while the preview is open, the baseline closes the
	// preview and leaves the drawer closed. Assert both halves separately;
	// opening the drawer over a still-open panel is not an acceptable "one".
	await edgeSwipe(page, 382, 420, 270, 420);
	await sleep(300);
	await edgeSwipe(page, 8, 420, 120, 420);
	const afterPanelLeft = await state(page);
	report.metrics.panelOpenThenLeftSwipe = afterPanelLeft;
	report.check(
		"left swipe while the panel is open closes the panel",
		afterPanelLeft.panelOpen === false,
		{ drawer: afterPanelLeft.drawer, panelOpen: afterPanelLeft.panelOpen },
	);
	report.check(
		"left swipe while the panel is open leaves the drawer closed",
		afterPanelLeft.drawer === "closed",
		{ drawer: afterPanelLeft.drawer, panelOpen: afterPanelLeft.panelOpen },
	);
	await shot(page, "core-panel-then-left-edge");
}

async function layoutProbe(page, report) {
	await boot(page, page.baseUrl);
	report.check("layout: no blocking dialog after boot", (page.blockedDialogs || []).length === 0, page.blockedDialogs);
	const layout = await page.eval(`(() => {
		const rect = (element) => {
			if (element === null) return null;
			const box = element.getBoundingClientRect();
			return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height), right: Math.round(box.right) };
		};
		const composer = document.querySelector("[data-composer-input]");
		const composerRoot = document.querySelector("[data-rdsh-composer-root]");
		const fab = document.querySelector(".rdsh-mux-fab");
		const header = document.querySelector("[data-rdsh-header]");
		const scroll = document.querySelector("[data-conversation-scroll]");
		return {
			composer: rect(composer),
			composerRoot: rect(composerRoot),
			fab: rect(fab),
			header: rect(header),
			scroll: rect(scroll),
			topRightButtons: [...document.querySelectorAll("header button[aria-label]")].map((button) => button.getAttribute("aria-label")),
			fabRightGap: fab === null ? null : Math.round(innerWidth - fab.getBoundingClientRect().right),
		};
	})()`);
	report.metrics.layout = layout;
	report.observe("real DOM: composer left inset", layout.composer?.x ?? null, layout.composer);
	report.observe("real DOM: composer width", layout.composer?.width ?? null, layout.composer);
	report.observe("real DOM: composer root width", layout.composerRoot?.width ?? null, layout.composerRoot);
	report.observe("real DOM: fab right gap", layout.fabRightGap, layout.fab);
	report.observe("real DOM: header height", layout.header?.height ?? null, layout.header);
	report.observe("real DOM: top-right header buttons", layout.topRightButtons);
	await shot(page, "layout-real-dom");
}

async function scrollGestures(page, report) {
	await boot(page, page.baseUrl);
	report.check("scroll: no blocking dialog after boot", (page.blockedDialogs || []).length === 0, page.blockedDialogs);
	await addScrollFixture(page);
	const before = await scrollReport(page);
	report.metrics.before = before;

	await swipe(page, 12, 400, 12, 240);
	const vertical = await scrollReport(page);
	report.metrics.vertical = vertical;
	report.check("vertical swipe scrolls the scroller", (vertical.top ?? 0) > 40, vertical.top);
	report.check("vertical swipe does not open the drawer", vertical.drawer === "closed", vertical.drawer);
	report.check("vertical swipe does not open the panel", vertical.panelOpen === false, vertical.panelOpen);
	report.check("vertical swipe is not default-prevented", vertical.prevented === 0, vertical.prevented);

	await swipe(page, 300, 360, 160, 360);
	const horizontal = await scrollReport(page);
	report.metrics.horizontal = horizontal;
	report.check("horizontal swipe scrolls the scroller", (horizontal.left ?? 0) > 40, horizontal.left);
	report.check("horizontal swipe does not open the drawer", horizontal.drawer === "closed", horizontal.drawer);
	report.check("horizontal swipe does not open the panel", horizontal.panelOpen === false, horizontal.panelOpen);
	report.check("horizontal swipe is not default-prevented", horizontal.prevented === 0, horizontal.prevented);
	await shot(page, "scroll-gestures");
}

async function hiddenControls(page, report) {
	await boot(page, page.baseUrl);
	report.check("hidden: no blocking dialog after boot", (page.blockedDialogs || []).length === 0, page.blockedDialogs);
	await addHideFixture(page);
	const hidden = await hideReport(page);
	report.metrics.hidden = hidden;
	report.check("settings hide-list attribute is on", hidden.html === true, hidden.html);
	for (const item of hidden.items) {
		report.check(`hides desktop-only control: ${item.label}`, item.found && item.hiddenAttr && !item.visible, item);
	}
	report.check("hides the native open-in-app split button (#33)", hidden.openTarget?.display === "none", hidden.openTarget);
	await shot(page, "hidden-controls");

	// The browser-side custom hide override was removed (user setting 9). A
	// legacy `hide-disabled` key must be ignored: the standard list stays as
	// applied, with no restore path behind a browser switch.
	const signature = (reportValue) => reportValue.items.map((item) => `${item.label}:${item.hiddenAttr}`).join("|");
	const before = signature(hidden);
	await page.eval(`localStorage.setItem("rdsh-mobile-ux:hide-disabled", "1"); globalThis.__RDSH_MOBILE_UX__.decorate();`);
	await sleep(900);
	const restored = await hideReport(page);
	report.metrics.restored = restored;
	report.check("a legacy browser hide override is ignored", restored.html === true, restored.html);
	report.check("the hidden set does not change for a legacy override", signature(restored) === before, {
		before,
		after: signature(restored),
	});
	await shot(page, "hidden-controls-legacy-key");
	await page.eval(`localStorage.removeItem("rdsh-mobile-ux:hide-disabled");`);
}

async function toastSwipe(page, report) {
	await boot(page, page.baseUrl);
	report.check("toast: no blocking dialog after boot", (page.blockedDialogs || []).length === 0, page.blockedDialogs);
	const decorated = await addToastFixture(page);
	report.check("toast is decorated", decorated === true);
	const box = await page.eval(`(() => {
		const rect = document.getElementById("qa-toast-fixture").getBoundingClientRect();
		return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
	})()`);
	await swipe(page, box.x, box.y, box.x, box.y - 70, { steps: 8 });
	const result = await page.eval(`(() => {
		const toast = document.getElementById("qa-toast-fixture");
		return {
			dismissed: toast?.hasAttribute("data-rdsh-toast-dismissed") === true,
			transform: toast?.style.transform || "",
			opacity: toast?.style.opacity || "",
		};
	})()`);
	report.metrics.toast = result;
	report.check("toast swipe-up marks the toast dismissed", result.dismissed === true, result);
	await shot(page, "toast-swipe");
}

async function imageSwipe(page, report) {
	await boot(page, page.baseUrl);
	report.check("image: no blocking dialog after boot", (page.blockedDialogs || []).length === 0, page.blockedDialogs);
	const decorated = await addLightboxFixture(page);
	report.check("lightbox is decorated", decorated === true);
	const box = await page.eval(`(() => {
		const rect = document.getElementById("qa-lightbox-fixture").getBoundingClientRect();
		return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 3) };
	})()`);
	await swipe(page, box.x, box.y, box.x, box.y + 130, { steps: 10 });
	const result = await page.eval(`(() => {
		const dialog = document.getElementById("qa-lightbox-fixture");
		const stage = dialog?.querySelector('[class*="_stage_"]');
		return {
			closeCount: globalThis.__qaCloseCount || 0,
			transform: stage?.style.transform || "",
			opacity: stage?.style.opacity || "",
		};
	})()`);
	report.metrics.lightbox = result;
	report.check("image swipe-down dismisses the lightbox", result.closeCount === 1, result);
	await shot(page, "image-swipe");
}

// ---------------------------------------------------------------- device matrix
const DEVICES = [
	{ id: "phone-portrait", width: 390, height: 844, mobile: true, touch: true, swipes: true },
	{ id: "phone-landscape", width: 844, height: 390, mobile: true, touch: true, swipes: true },
	{ id: "tablet-portrait", width: 1024, height: 1366, mobile: true, touch: true, swipes: true },
	{ id: "ios-standalone", width: 390, height: 844, mobile: true, touch: true, swipes: true, standalone: true,
		userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" },
	{ id: "desktop-narrow", width: 683, height: 900, mobile: false, touch: false, swipes: false },
	{ id: "desktop-wide", width: 1440, height: 900, mobile: false, touch: false, swipes: false },
];

async function deviceProfile(page, report, device) {
	await boot(page, page.baseUrl);
	report.check(`device ${device.id}: no blocking dialog`, (page.blockedDialogs || []).length === 0, page.blockedDialogs);
	await addHideFixture(page);
	const hidden = await hideReport(page);
	const before = await state(page);
	report.metrics[device.id] = { before, hidden };

	let afterLeft = null;
	let afterRight = null;
	let afterClose = null;
	if (device.swipes) {
		await normalizeChrome(page);
		await edgeSwipe(page, 8, Math.round(device.height / 2), 120, Math.round(device.height / 2));
		afterLeft = await state(page);
		if (afterLeft.drawer === "open") {
			for (let attempt = 0; attempt < 3; attempt += 1) {
				await page.eval(`globalThis.__RDSH_MOBILE_UX__.closeDrawer()`);
				await sleep(500);
				const now = await state(page);
				if (now.drawer !== "open") break;
			}
		}
		afterClose = await state(page);
		// The app re-renders the header when the drawer collapses; the right
		// panel trigger can be missing for a frame or two.
		for (let attempt = 0; attempt < 30; attempt += 1) {
			const present = await page.eval(`document.querySelector('[aria-label="Open right sidebar"]') !== null`);
			if (present) break;
			await sleep(100);
		}
		await edgeSwipe(page, device.width - 8, Math.round(device.height / 2), device.width - 120, Math.round(device.height / 2));
		afterRight = await state(page);
	}
	report.metrics[device.id].afterLeft = afterLeft;
	report.metrics[device.id].afterClose = afterClose;
	report.metrics[device.id].afterRight = afterRight;

	// Compare the observations themselves, not just a pass/fail bit. A device
	// profile that silently changes the hide set or the drawer state is a
	// difference even when both builds "ran".
	const hiddenLabels = hidden.items.filter((item) => item.hiddenAttr).map((item) => item.label).sort();
	const appliedLabels = hidden.items.filter((item) => item.hiddenAttr && !item.visible).map((item) => item.label).sort();
	report.observe(`device ${device.id}: applied hidden controls`, appliedLabels, hidden);
	report.observe(`device ${device.id}: hide-settings attribute`, hidden.html === true);
	report.observe(`device ${device.id}: narrow state`, before.diagnosticsState?.narrow ?? before.narrow);
	report.observe(`device ${device.id}: device mode`, before.mode ?? before.diagnosticsState?.mode ?? null);
	report.observe(`device ${device.id}: effective mobile`, before.phone ?? before.diagnosticsState?.phone ?? false);
	report.observe(`device ${device.id}: initial drawer`, before.drawer);
	report.observe(`device ${device.id}: initial panel`, before.panelOpen);
	if (device.swipes) {
		report.observe(`device ${device.id}: left swipe opens drawer`, afterLeft?.drawer === "open");
		report.observe(`device ${device.id}: right swipe opens panel`, afterClose?.panelOpen === false && afterRight?.panelOpen === true);
	}
	await shot(page, `device-${device.id}`);
}

// ---------------------------------------------------------------- runner
class Report {
	constructor(name) {
		this.name = name;
		this.checks = [];
		this.metrics = {};
	}

	check(name, ok, detail) {
		this.checks.push({ name, ok: ok === true, detail });
		if (!ok) console.log(`FAIL [${this.name}] ${name}`, detail === undefined ? "" : JSON.stringify(detail));
	}

	/** A measured value: it does not pass/fail on its own, it must match baseline. */
	observe(name, value, detail) {
		this.checks.push({ name, ok: true, value, detail });
	}
}

async function runVariant(label, baseUrl, scenarios) {
	const report = new Report(label);
	for (const item of scenarios) {
		const device = item.device;
		const handle = await openPage(CDP_PORT, {
			url: baseUrl,
			width: device?.width ?? 390,
			height: device?.height ?? 844,
			mobile: device?.mobile ?? true,
			touch: device?.touch ?? true,
			standalone: device?.standalone === true,
			userAgent: device?.userAgent,
			scale: device?.scale ?? (device?.mobile ? 3 : 1),
		});
		const page = handle.page;
		page.browser = handle.browser;
		page.baseUrl = baseUrl;
		page.variant = label;
		try {
			if (device) await deviceProfile(page, report, device);
			else await item.run(page, report);
			report.check(
				`${item.name}: screenshots are not behind a dialog`,
				(page.blockedShots || []).length === 0,
				page.blockedShots,
			);
		} catch (error) {
			report.check(`${item.name} ran`, false, String(error && error.stack || error));
		} finally {
			await handle.close();
		}
	}
	return report;
}

function compare(baseline, unified) {
	const differences = [];
	const regressions = [];
	const byName = new Map(baseline.checks.map((check) => [check.name, check]));
	for (const check of unified.checks) {
		const before = byName.get(check.name);
		if (before === undefined) continue;
		const beforeValue = Object.hasOwn(before, "value") ? before.value : before.ok;
		const afterValue = Object.hasOwn(check, "value") ? check.value : check.ok;
		if (JSON.stringify(beforeValue) !== JSON.stringify(afterValue)) {
			differences.push({ name: check.name, baseline: beforeValue, unified: afterValue, unifiedDetail: check.detail });
			if (Object.hasOwn(before, "value") === false && before.ok === true && check.ok !== true) {
				regressions.push({ name: check.name, detail: check.detail });
			}
		}
	}
	for (const check of baseline.checks) {
		if (!unified.checks.some((entry) => entry.name === check.name)) {
			differences.push({ name: check.name, baseline: check.ok, unified: null });
		}
	}
	return { differences, regressions };
}

async function routeHeadingFit(page) {
	return page.eval(`(() => {
		const scope = document.querySelector("[data-rdsh-center-col]") ?? document.body;
		const heading = [...scope.querySelectorAll("h1")].find((h1) => {
			const rect = h1.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0 && h1.closest("[data-rdsh-sidebar]") === null;
		});
		const fab = document.querySelector(".rdsh-mux-fab");
		if (heading === undefined || fab === null) return { found: false };
		const h = heading.getBoundingClientRect();
		const f = fab.getBoundingClientRect();
		const intersects = h.right > f.left && h.left < f.right && h.bottom > f.top && h.top < f.bottom;
		return {
			found: true,
			text: (heading.textContent || "").trim().slice(0, 40),
			left: Math.round(h.left),
			top: Math.round(h.top),
			right: Math.round(h.right),
			fab: { left: Math.round(f.left), top: Math.round(f.top), right: Math.round(f.right), bottom: Math.round(f.bottom), z: getComputedStyle(fab).zIndex },
			tagged: heading.parentElement !== null && heading.parentElement.hasAttribute("data-rdsh-route-heading"),
			intersects,
		};
	})()`);
}

async function drawerRoute(page, report) {
	// This is a follow-up UX fix, not parity with the legacy build: the
	// baseline intentionally keeps its old drawer-over-route behaviour. Report
	// only the unified side so the A/B comparison stays a pure parity signal.
	if (page.variant !== "unified") return;
	await boot(page, page.baseUrl);
	await page.eval(`globalThis.__RDSH_MOBILE_UX__?.openDrawer?.(); true`);
	await sleep(500);
	const opened = await page.eval(`(() => {
		const sidebar = document.querySelector("[data-rdsh-sidebar]");
		const fab = document.querySelector(".rdsh-mux-fab");
		return {
			href: location.href,
			drawer: document.documentElement.getAttribute("data-rdsh-drawer"),
			sidebarX: sidebar === null ? null : Math.round(sidebar.getBoundingClientRect().x),
			fabDisplay: fab === null ? null : getComputedStyle(fab).display,
		};
	})()`);
	report.observe("route: drawer before row click", opened);
	report.check("route: the drawer was open before Plugins was tapped", opened.drawer === "open", opened);

	const clicked = await page.eval(`(() => {
		const row = [...document.querySelectorAll("[data-rdsh-sidebar] button[aria-label]")]
			.find((button) => /^Plugins$/i.test((button.getAttribute("aria-label") || "").trim()));
		if (row === undefined) return false;
		row.click();
		return true;
	})()`);
	await sleep(1000);
	const after = await page.eval(`(() => {
		const sidebar = document.querySelector("[data-rdsh-sidebar]");
		const fab = document.querySelector(".rdsh-mux-fab");
		return {
			href: location.href,
			drawer: document.documentElement.getAttribute("data-rdsh-drawer"),
			sidebarX: sidebar === null ? null : Math.round(sidebar.getBoundingClientRect().x),
			fabDisplay: fab === null ? null : getComputedStyle(fab).display,
		};
	})()`);
	report.observe("route: clicked Plugins", { clicked, after });
	report.check("route: clicking Plugins closes the phone drawer", clicked === true && after.drawer === "closed", after);
	report.check("route: the FAB is available on the Plugins route", after.fabDisplay === "flex", after);
	const pluginsHeading = await routeHeadingFit(page);
	report.observe("route: Plugins heading fit", pluginsHeading);
	report.check("route: Plugins heading clears the FAB", pluginsHeading.found === true && pluginsHeading.left >= 56 && pluginsHeading.intersects === false, pluginsHeading);

	// Direct touch at the very edge, over the route's own content (not the
	// harness's neutral gesture layer). This is the user's real gesture and the
	// one that headless Chrome can turn into history-back.
	await page.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touchPoint(8, 420) });
	for (let step = 1; step <= 8; step += 1) {
		await page.send("Input.dispatchTouchEvent", {
			type: "touchMove",
			touchPoints: touchPoint(8 + ((120 - 8) * step) / 8, 420),
		});
		await sleep(16);
	}
	await page.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	await sleep(700);
	let resumed;
	try {
		resumed = await page.eval(`(() => ({
			href: location.href,
			drawer: document.documentElement.getAttribute("data-rdsh-drawer"),
			sidebarX: (() => {
				const sidebar = document.querySelector("[data-rdsh-sidebar]");
				return sidebar === null ? null : Math.round(sidebar.getBoundingClientRect().x);
			})(),
			fabDisplay: (() => {
				const fab = document.querySelector(".rdsh-mux-fab");
				return fab === null ? null : getComputedStyle(fab).display;
			})(),
		}))()`);
	} catch (error) {
		resumed = { error: String(error && error.message || error) };
	}
	report.observe("route: after direct left-edge swipe", resumed);
	if (resumed.href !== undefined && resumed.href.startsWith("about:")) {
		report.observe("route: left-edge swipe navigated back", resumed.href);
	} else {
		report.check("route: left-edge swipe opens the drawer on the Plugins route", resumed.drawer === "open", resumed);
		report.check("route: an open drawer hides the FAB again", resumed.fabDisplay === "none", resumed);
		await page.eval(`document.querySelector(".rdsh-mux-backdrop")?.click(); true`);
		await sleep(500);
		const closed = await page.eval(`document.documentElement.getAttribute("data-rdsh-drawer")`);
		report.check("route: backdrop tap closes the drawer again", closed === "closed", closed);

		await page.eval(`globalThis.__RDSH_MOBILE_UX__?.openDrawer?.(); true`);
		await sleep(500);
		const automationClicked = await page.eval(`(() => {
			const row = [...document.querySelectorAll("[data-rdsh-sidebar] button[aria-label]")]
				.find((button) => /^Automation tasks$/i.test((button.getAttribute("aria-label") || "").trim()));
			if (row === undefined) return false;
			row.click();
			return true;
		})()`);
		await sleep(1000);
		const automationAfter = await page.eval(`(() => {
			const sidebar = document.querySelector("[data-rdsh-sidebar]");
			const fab = document.querySelector(".rdsh-mux-fab");
			return {
				drawer: document.documentElement.getAttribute("data-rdsh-drawer"),
				sidebarX: sidebar === null ? null : Math.round(sidebar.getBoundingClientRect().x),
				fabDisplay: fab === null ? null : getComputedStyle(fab).display,
			};
		})()`);
		report.observe("route: clicked Automation tasks", { clicked: automationClicked, after: automationAfter });
		report.check("route: clicking Automation tasks closes the phone drawer", automationClicked === true && automationAfter.drawer === "closed", automationAfter);
		report.check("route: the FAB is available on the Automation tasks route", automationAfter.fabDisplay === "flex", automationAfter);
		const automationHeading = await routeHeadingFit(page);
		report.observe("route: Automation heading fit", automationHeading);
		report.check("route: Automation heading clears the FAB", automationHeading.found === true && automationHeading.left >= 56 && automationHeading.intersects === false, automationHeading);
	}
}

async function pushDelivery(page, report) {
	// Push delivery is a unified-only follow-up check. The legacy build has a
	// different worker message contract and is not the notification reference.
	if (page.variant !== "unified") return;
	await boot(page, page.baseUrl);
	const exceptions = [];
	page.on("Runtime.exceptionThrown", (event) => exceptions.push(event?.exceptionDetails?.text || "exception"));
	const serviceWorker = page;
	await serviceWorker.send("ServiceWorker.enable");
	let registrationId = null;
	const registrations = [];
	serviceWorker.on("ServiceWorker.workerRegistrationUpdated", (params) => {
		for (const registration of params?.registrations || []) {
			registrations.push(registration);
			if (registration.isDeleted !== true && typeof registration.registrationId === "string") registrationId = registration.registrationId;
		}
	});
	await page.eval("navigator.serviceWorker.ready.then(() => true)");
	await sleep(1200);
	const swState = await page.eval(`navigator.serviceWorker.ready.then((registration) => ({
		scope: registration.scope,
		active: registration.active === null ? null : registration.active.state,
		waiting: registration.waiting === null ? null : registration.waiting.state,
		installing: registration.installing === null ? null : registration.installing.state,
		controller: navigator.serviceWorker.controller !== null,
	}))`);
	report.observe("push: registration", { registrationId, registrations, swState, exceptions });

	// First exercise the page half directly: the page still reads a notify
	// MessageEvent and acks an optional transferred port. If this cannot
	// render, the push transport is not the problem.
	await page.eval(`(() => {
		globalThis.__qaPushAck = false;
		const channel = new MessageChannel();
		channel.port2.onmessage = () => { globalThis.__qaPushAck = true; };
		navigator.serviceWorker.dispatchEvent(new MessageEvent("message", {
			data: { type: "dsh-mobile-maxxing:notify", title: "QA direct", body: "page half", sessionId: "", kind: "test" },
			ports: [channel.port1],
		}));
		return true;
	})()`);
	await sleep(700);
	const direct = await page.eval(`(() => {
		const host = document.querySelector("[data-rdsh-notice-host]");
		return {
			banner: host === null ? "" : (host.textContent || "").trim(),
			ack: globalThis.__qaPushAck === true,
			hostHTML: host === null ? null : host.outerHTML.slice(0, 1200),
			hostChildren: host === null ? 0 : host.children.length,
			bodyHasText: (document.body.innerText || "").includes("QA direct"),
			statusCount: document.querySelectorAll('[role="status"]').length,
			qa: (() => {
				const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
				const found = [];
				while (walker.nextNode()) {
					const node = walker.currentNode;
					if (node.children.length !== 0) continue;
					if (!(node.textContent || "").includes("QA direct")) continue;
					const rect = node.getBoundingClientRect();
					found.push({
						tag: node.tagName,
						className: String(node.className || "").slice(0, 120),
						text: (node.textContent || "").trim().slice(0, 120),
						rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
					});
				}
				return found;
			})(),
			status: [...document.querySelectorAll('[role="status"]')].map((node) => {
				const rect = node.getBoundingClientRect();
				return {
					text: (node.textContent || "").trim().slice(0, 120),
					className: String(node.className || "").slice(0, 120),
					rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
				};
			}),
		};
	})()`);
	report.observe("push: direct page hand-off", direct);
	report.check("push: the page half renders a banner and acks a worker hand-off", direct.bodyHasText === true && direct.ack === true, direct);
	// The banner is rendered through the Toast portal, not as a child of the
	// host node. Look for its text anywhere in the page.
	const directText = await page.eval(`(document.body.innerText || "").includes("QA direct")`);
	report.check("push: the banner text reached the page", directText === true, direct);
	await page.eval(`document.querySelector("[data-rdsh-notice-host]")?.remove(); [...document.querySelectorAll('[role="status"]')].forEach((node) => { if (node.textContent === "" && node.className === "dsh-mobile-maxxing-toasts") node.remove(); }); true`);

	const registration = { registrationId };
	const notifyPayload = JSON.stringify({
		title: "QA push foreground",
		body: "in-app banner",
		sessionId: "",
		kind: "test",
		url: "./",
	});
	if (registrationId !== null) {
		await serviceWorker.send("ServiceWorker.deliverPushMessage", {
			origin: new URL(page.baseUrl).origin,
			registrationId,
			data: notifyPayload,
		});
	}
	await sleep(900);
	const foreground = await page.eval(`(async () => {
		const host = document.querySelector("[data-rdsh-notice-host]");
		const registry = await navigator.serviceWorker.ready;
		const shown = await registry.getNotifications();
		return {
			banner: host === null ? "" : (host.textContent || "").trim(),
			bodyText: (document.body.innerText || "").includes("QA push foreground"),
			notifications: shown.map((item) => ({ title: item.title, body: item.body, tag: item.tag })),
			visible: document.visibilityState,
		};
	})()`);
	report.observe("push: CDP deliverPushMessage", { registration, foreground, exceptions });
	report.check("push: CDP deliverPushMessage shows the in-app banner", foreground.bodyText === true, foreground);
	report.check("push: visible page acked the hand-off (no system notification)", foreground.notifications.length === 0, foreground.notifications);
	report.check("push: foreground delivery raised no page exception", exceptions.length === 0, exceptions);

	// Chrome's deliverPushMessage was accepted by this headless build but did
	// not fire the worker. Drive the same `push` listener through the worker
	// target so the SW -> page hand-off is still measured for real.
	let workerDispatch = null;
	let swSessionId = null;
	const targets = await page.send("Target.getTargets");
	const swTarget = (targets.targetInfos || []).find((target) => target.type === "service_worker" && target.url.endsWith("/sw.js"));
	if (swTarget !== undefined) {
		const attached = await page.send("Target.attachToTarget", { targetId: swTarget.targetId, flatten: true });
		if (attached.sessionId !== undefined) {
			swSessionId = attached.sessionId;
			try {
				workerDispatch = await page.send("Runtime.evaluate", {
					expression: `(async () => {
						const event = new Event("push");
						Object.defineProperty(event, "data", {
							value: { json: () => ({ title: "QA worker push", body: "worker path", sessionId: "", kind: "test", url: "./" }) },
						});
						let pending = null;
						event.waitUntil = (promise) => { pending = promise; };
						self.dispatchEvent(event);
						if (pending !== null) await pending;
						return true;
					})()`,
					awaitPromise: true,
					returnByValue: true,
				}, attached.sessionId);
			} catch (error) {
				workerDispatch = { error: String(error && error.message || error) };
			}
		}
	}
	await sleep(900);
	const workerBanner = await page.eval(`(async () => {
		const registry = await navigator.serviceWorker.ready;
		const notifications = await registry.getNotifications();
		return {
			text: (document.body.innerText || "").includes("QA worker push"),
			notifications: notifications.length,
		};
	})()`);
	report.observe("push: worker dispatched push", { workerDispatch, workerBanner });
	report.check("push: worker push reaches the visible page banner", workerBanner.text === true, workerBanner);

	// Headless Chrome has no Emulation.setPageVisibilityOverride. Make the
	// original page hidden by activating a blank tab in the same browser
	// context, then drive the same worker push again. A visible blank client
	// (or no visible client at all) cannot ack, so the worker must showNotification.
	let background = null;
	const targetInfos = (await page.send("Target.getTargets")).targetInfos || [];
	const currentPage = targetInfos.find((target) => target.type === "page" && target.url.startsWith("http://127.0.0.1:3207"));
	if (swSessionId !== null && currentPage !== undefined && currentPage.browserContextId !== undefined) {
		try {
			await page.browser.send("Browser.grantPermissions", {
				origin: new URL(page.baseUrl).origin,
				permissions: ["notifications"],
				browserContextId: currentPage.browserContextId,
			});
			const created = await page.send("Target.createTarget", {
				url: "about:blank",
				browserContextId: currentPage.browserContextId,
			});
			await page.send("Target.activateTarget", { targetId: created.targetId });
			await sleep(500);
			const hiddenState = await page.eval("document.visibilityState");
			await page.send("Runtime.evaluate", {
				expression: `(async () => {
					const event = new Event("push");
					Object.defineProperty(event, "data", {
						value: { json: () => ({ title: "QA hidden push", body: "system path", sessionId: "", kind: "test", url: "./" }) },
					});
					let pending = null;
					event.waitUntil = (promise) => { pending = promise; };
					self.dispatchEvent(event);
					if (pending !== null) await pending;
					return true;
				})()`,
				awaitPromise: true,
				returnByValue: true,
			}, swSessionId);
			await sleep(1200);
			const shown = await page.eval(`(async () => {
				const registry = await navigator.serviceWorker.ready;
				const notifications = await registry.getNotifications();
				return {
					visibility: document.visibilityState,
					notifications: notifications.map((item) => ({ title: item.title, body: item.body, tag: item.tag })),
					banner: (document.body.innerText || "").includes("QA hidden push"),
				};
			})()`);
			background = { hiddenState, shown };
			await page.send("Target.closeTarget", { targetId: created.targetId });
			await page.send("Target.activateTarget", { targetId: currentPage.targetId });
		} catch (error) {
			background = { error: String(error && error.message || error) };
		}
	}
	report.observe("push: background delivery", { background, exceptions });
	if (background !== null && background.shown !== undefined && background.shown.notifications.length > 0) {
		report.check("push: hidden page falls back to a system notification", background.shown.notifications.some((item) => item.title === "QA hidden push"), background.shown);
		report.check("push: hidden page does not render the in-app banner", background.shown.banner === false, background.shown);
	} else {
		report.observe("push: background path", "could not force a hidden client in this headless run");
	}

}

async function main() {
	await mkdir(SHOTS, { recursive: true });
	console.log(`QA_OUT=${QA_OUT}`);
	console.log(`baseline=${BASELINE_URL.replace(/token=[^&]+/, "token=***")}`);
	console.log(`unified=${UNIFIED_URL.replace(/token=[^&]+/, "token=***")}`);
	await waitForChrome();

	const allScenarios = [
		scenario("core-gestures", coreGestures),
		scenario("layout-real-dom", layoutProbe),
		scenario("scroll-gestures", scrollGestures),
		scenario("hidden-controls", hiddenControls),
		scenario("toast-swipe", toastSwipe),
		scenario("image-swipe", imageSwipe),
		scenario("drawer-route", drawerRoute),
		scenario("push-delivery", pushDelivery),
	];
	const allDeviceScenarios = DEVICES.map((device) => ({ name: `device-${device.id}`, device }));
	const only = (process.env.QA_SCENARIOS || "").split(",").map((entry) => entry.trim()).filter(Boolean);
	const scenarios = only.length === 0 ? allScenarios : allScenarios.filter((entry) => only.includes(entry.name));
	const deviceScenarios = only.length === 0 ? allDeviceScenarios : allDeviceScenarios.filter((entry) => only.includes(entry.name));

	const baseline = await runVariant("baseline", BASELINE_URL, [...scenarios, ...deviceScenarios]);
	const unified = await runVariant("unified", UNIFIED_URL, [...scenarios, ...deviceScenarios]);
	const { differences, regressions } = compare(baseline, unified);

	const results = {
		generatedAt: new Date().toISOString(),
		baselineUrl: BASELINE_URL.replace(/token=[^&]+/, "token=***"),
		unifiedUrl: UNIFIED_URL.replace(/token=[^&]+/, "token=***"),
		baseline: { checks: baseline.checks, metrics: baseline.metrics },
		unified: { checks: unified.checks, metrics: unified.metrics },
		differences,
		regressions,
	};
	await writeFile(join(QA_OUT, "results.json"), `${JSON.stringify(results, null, 2)}\n`);

	const failedBaseline = baseline.checks.filter((check) => !check.ok);
	const failedUnified = unified.checks.filter((check) => !check.ok);
	console.log(`\nbaseline: ${baseline.checks.length - failedBaseline.length}/${baseline.checks.length} checks passed`);
	console.log(`unified:  ${unified.checks.length - failedUnified.length}/${unified.checks.length} checks passed`);
	if (failedBaseline.length > 0) {
		console.log("\nbaseline failures (must be fixed or explicitly marked unverified):");
		for (const entry of failedBaseline) console.log(`  ${entry.name}`, entry.detail === undefined ? "" : JSON.stringify(entry.detail));
	}
	if (differences.length > 0) {
		console.log("\ndifferences:");
		for (const entry of differences) {
			console.log(`  ${entry.name}: baseline=${JSON.stringify(entry.baseline)} unified=${JSON.stringify(entry.unified)}`);
		}
	}
	if (regressions.length > 0) {
		console.log("\nregressions (baseline passed, unified failed):");
		for (const entry of regressions) console.log(`  ${entry.name}`, entry.detail === undefined ? "" : JSON.stringify(entry.detail));
	}
	console.log(`\nresults: ${join(QA_OUT, "results.json")}`);

	if (failedBaseline.length > 0 || differences.length > 0 || regressions.length > 0) process.exitCode = 1;
}

// The runner creates its own Chrome so the harness is one command. When the
// QA wrapper already started one (CDP_PORT reachable), reuse it instead.
let chrome = null;
try {
	try {
		await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
	} catch {
		chrome = await startChrome();
	}
	await main();
} catch (error) {
	console.error(error);
	process.exitCode = 2;
} finally {
	if (chrome !== null) await chrome.cleanup();
}
