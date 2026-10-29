/**
 * Device-local chat preferences (work details, collapse, busy Enter, performance).
 *
 * The four upstream policies keep their live value in a client snapshot store
 * that upstream's own Settings rows receive as a slot hook. This bundle writes
 * that store only: the shared configuration form and the upstream `set*`
 * functions (which persist to the Host) must never be called.
 *
 * Corrected ABI (#63): a StoredEntry keeps its inject face at the top level
 * (`entry.inject`). `entry.options` carries only id/order, so the previous
 * `entry.options.inject` lookup could never find the store. The fakes below
 * put `inject` at the top level and deliberately keep it off `options`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { COPY } from "../lib/copy.js";

const CLIENT = readFileSync(new URL("../client.js", import.meta.url), "utf8");

/** VM-created objects carry another realm's prototypes; compare their data. */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** A synchronous snapshot store, the shape upstream's policies expose. */
function snapshotStore(initial) {
	let value = initial;
	const listeners = new Set();
	const writes = [];
	return {
		getSnapshot: () => value,
		set(next) {
			value = next;
			writes.push(next);
			for (const listener of [...listeners]) listener();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** Test-only: an accepted Host value arriving from upstream. */
		adopt(next) {
			value = next;
			for (const listener of [...listeners]) listener();
		},
		writes,
		listenerCount: () => listeners.size,
	};
}

/** The three upstream settings entries, with throwing Host setters. */
function upstreamEntries() {
	const hostCalls = [];
	const hostSetter = (name) => (...args) => {
		hostCalls.push([name, ...args]);
		throw new Error(`${name} must never be called (it writes the Host configuration)`);
	};
	const transcript = snapshotStore("detailed");
	const collapse = snapshotStore("completion");
	const performance = snapshotStore("detailed");
	const busyEnter = snapshotStore("queue");
	// The corrected entry shape: id/order in options, inject at the top level.
	const entries = [
		{
			options: { id: "transcript-view", order: 12 },
			inject: () => ({
				hooks: { transcriptView: transcript, collapseTiming: collapse },
				setTranscriptView: hostSetter("setTranscriptView"),
				setCollapseTiming: hostSetter("setCollapseTiming"),
			}),
		},
		{
			options: { id: "performance-usage", order: 30 },
			inject: () => ({ hooks: { performanceUsage: performance }, setPerformanceUsage: hostSetter("setPerformanceUsage") }),
		},
		{
			options: { id: "composer-enter", order: 20 },
			inject: () => ({ hooks: { busyEnter }, setBusyEnter: hostSetter("setBusyEnter") }),
		},
	];
	return { entries, transcript, collapse, performance, busyEnter, hostCalls };
}

/** A localStorage that remembers one key at a time and records every call. */
function createStorage(seed = {}) {
	const map = new Map(Object.entries(seed));
	const calls = [];
	return {
		map,
		calls,
		getItem(key) {
			calls.push(["get", key]);
			return map.has(key) ? map.get(key) : null;
		},
		setItem(key, value) {
			calls.push(["set", key]);
			map.set(key, String(value));
		},
		removeItem(key) {
			calls.push(["remove", key]);
			map.delete(key);
		},
	};
}

/**
 * Load the real bundle and hand back the local-chat runtime from its test seam.
 *
 * The seam sits after the desktop gate, so a desktop boot never installs it.
 * The harness never builds the React parts: it only needs the slots service.
 */
function boot({ entries = { value: [] }, storage = createStorage(), mode = "mobile" } = {}) {
	let definition;
	const entryRef = Array.isArray(entries) ? { value: entries } : entries;
	const slotListeners = new Set();
	const configWrites = [];
	const errors = [];
	const sandbox = {
		window: {
			__ModuleLoader__: {
				load(value) {
					definition = value;
				},
			},
		},
		document: {
			documentElement: {
				lang: "en",
				getAttribute: () => null,
				setAttribute() {},
				removeAttribute() {},
				hasAttribute: () => false,
			},
		},
		localStorage: storage,
		console: { error: (...args) => errors.push(args), warn() {}, log() {} },
		__RDSH_DEVICE_MODE__: mode,
		__RDSH_LOCAL_CHAT_TEST__: {},
	};
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(CLIENT, sandbox, { filename: "client.js" });
	const plugin = definition.factory(() => ({}));
	const runtime = sandbox.__RDSH_LOCAL_CHAT_TEST__.localChat;
	const ctx = {
		slots: {
			entries: (name) => (name === "settings.general.item" ? entryRef.value : []),
			subscribe: (name, listener) => {
				assert.equal(name, "settings.general.item");
				slotListeners.add(listener);
				return () => slotListeners.delete(listener);
			},
		},
		effect(fn) {
			const dispose = fn();
			sandbox.__dispose = dispose;
			return dispose;
		},
		// The Host configuration transport this bundle must never reach.
		configForms: {
			set(...args) {
				configWrites.push(["set", ...args]);
				throw new Error("ConfigForm.set must never be called");
			},
			mutate(...args) {
				configWrites.push(["mutate", ...args]);
				throw new Error("ConfigForm.mutate must never be called");
			},
		},
	};
	return { runtime, plugin, ctx, storage, entryRef, slotListeners, sandbox, configWrites, errors };
}

test("all four device choices write the live stores and never the shared form", () => {
	const up = upstreamEntries();
	const h = boot({ entries: up.entries });
	h.runtime.attachLocalChat(h.ctx);

	assert.equal(h.runtime.setLocalChatValue("workDetails", "verbose"), true);
	assert.equal(h.runtime.setLocalChatValue("collapse", "next-input"), true);
	assert.equal(h.runtime.setLocalChatValue("busyEnter", "steer"), true);
	assert.equal(h.runtime.setLocalChatValue("performance", "compact"), true);

	assert.equal(up.transcript.getSnapshot(), "verbose", "work details were not applied");
	assert.equal(up.collapse.getSnapshot(), "next-input", "collapse timing was not applied");
	assert.equal(up.busyEnter.getSnapshot(), "steer", "busy Enter was not applied");
	assert.equal(up.performance.getSnapshot(), "compact", "performance detail was not applied");

	// The host setters would have thrown if the runtime had reached for them.
	assert.deepEqual(up.hostCalls, [], "a Host setter was called");
	assert.deepEqual(h.configWrites, [], "the shared configuration form was written");
	assert.deepEqual(plain(JSON.parse(h.storage.getItem(h.runtime.key))), {
		workDetails: "verbose",
		collapse: "next-input",
		busyEnter: "steer",
		performance: "compact",
	}, "the device choices were not saved");

	const status = h.runtime.status();
	assert.deepEqual(plain(status.available), {
		workDetails: true,
		collapse: true,
		busyEnter: true,
		performance: true,
	});
	assert.deepEqual(plain(status.local), {
		workDetails: "verbose",
		collapse: "next-input",
		busyEnter: "steer",
		performance: "compact",
	});
});

test("binding without a device choice leaves every Host store untouched", () => {
	const up = upstreamEntries();
	const h = boot({ entries: up.entries });
	h.runtime.attachLocalChat(h.ctx);

	assert.deepEqual(up.transcript.writes, [], "work details were written without a device choice");
	assert.deepEqual(up.collapse.writes, [], "collapse timing was written without a device choice");
	assert.deepEqual(up.busyEnter.writes, [], "busy Enter was written without a device choice");
	assert.deepEqual(up.performance.writes, [], "performance detail was written without a device choice");
	assert.deepEqual(up.hostCalls, []);
	assert.deepEqual(h.configWrites, []);
	assert.equal(h.storage.map.has(h.runtime.key), false, "an empty choice was saved");
	assert.deepEqual(plain(h.runtime.status().local), {});
});

test("device choices persist across a reload and are reapplied to fresh stores", () => {
	const storage = createStorage();
	const first = boot({ entries: upstreamEntries().entries, storage });
	first.runtime.attachLocalChat(first.ctx);
	assert.equal(first.runtime.setLocalChatValue("workDetails", "verbose"), true);
	assert.equal(first.runtime.setLocalChatValue("collapse", "next-input"), true);
	assert.equal(first.runtime.setLocalChatValue("busyEnter", "steer"), true);
	assert.equal(first.runtime.setLocalChatValue("performance", "compact"), true);
	first.runtime.disposeLocalChat();

	// A reload creates new upstream policies with their Host defaults.
	const up = upstreamEntries();
	const second = boot({ entries: up.entries, storage });
	second.runtime.attachLocalChat(second.ctx);
	assert.equal(up.transcript.getSnapshot(), "verbose", "work details were not reapplied");
	assert.equal(up.collapse.getSnapshot(), "next-input", "collapse timing was not reapplied");
	assert.equal(up.busyEnter.getSnapshot(), "steer", "busy Enter was not reapplied");
	assert.equal(up.performance.getSnapshot(), "compact", "performance detail was not reapplied");
	assert.deepEqual(up.hostCalls, [], "the reload wrote the Host");
	assert.deepEqual(second.configWrites, []);

	// A Host push arriving right after the rebind must still lose.
	up.transcript.adopt("standard");
	assert.equal(up.transcript.getSnapshot(), "verbose", "a post-reload Host push overwrote the device value");
});

test("an upstream adopt becomes the baseline but never overwrites a device choice", () => {
	const up = upstreamEntries();
	const h = boot({ entries: up.entries });
	h.runtime.attachLocalChat(h.ctx);
	assert.equal(h.runtime.setLocalChatValue("workDetails", "verbose"), true);
	assert.equal(h.runtime.setLocalChatValue("collapse", "next-input"), true);
	assert.equal(h.runtime.setLocalChatValue("busyEnter", "steer"), true);
	assert.equal(h.runtime.setLocalChatValue("performance", "compact"), true);

	// Upstream accepts new Host values while every device override is active.
	up.transcript.adopt("compact");
	up.collapse.adopt("completion");
	up.busyEnter.adopt("queue");
	up.performance.adopt("detailed");
	assert.equal(up.transcript.getSnapshot(), "verbose", "work details were silently overwritten");
	assert.equal(up.collapse.getSnapshot(), "next-input", "collapse timing was silently overwritten");
	assert.equal(up.busyEnter.getSnapshot(), "steer", "busy Enter was silently overwritten");
	assert.equal(up.performance.getSnapshot(), "compact", "performance detail was silently overwritten");

	// Following the Host restores the latest accepted value, not the old one.
	assert.equal(h.runtime.resetLocalChat("workDetails"), true);
	assert.equal(h.runtime.resetLocalChat("collapse"), true);
	assert.equal(h.runtime.resetLocalChat("busyEnter"), true);
	assert.equal(h.runtime.resetLocalChat("performance"), true);
	assert.equal(up.transcript.getSnapshot(), "compact");
	assert.equal(up.collapse.getSnapshot(), "completion");
	assert.equal(up.busyEnter.getSnapshot(), "queue");
	assert.equal(up.performance.getSnapshot(), "detailed");
	assert.deepEqual(plain(h.runtime.status().local), {}, "a reset choice stayed saved");
	assert.deepEqual(up.hostCalls, []);
});

test("the inject face is read from the entry, never from options", () => {
	// The old lookup. The store is reachable, but only through the wrong key,
	// so the row must stay unavailable instead of pretending to work.
	const busyEnter = snapshotStore("queue");
	const legacy = [{
		options: {
			id: "composer-enter",
			inject: () => ({ hooks: { busyEnter } }),
		},
	}];
	const h = boot({ entries: legacy });
	h.runtime.attachLocalChat(h.ctx);
	const status = h.runtime.status();
	assert.equal(status.available.busyEnter, false, "a legacy options.inject was accepted");
	assert.equal(status.reason.busyEnter, "inject-missing");
	assert.equal(h.runtime.setLocalChatValue("busyEnter", "steer"), false);
	assert.deepEqual(busyEnter.writes, [], "an unreachable store was written");
	assert.equal(h.storage.map.has(h.runtime.key), false, "an unavailable row saved a value");
});

test("a missing entry or malformed inject is reported and never saved", () => {
	const up = upstreamEntries();
	const withoutBusy = up.entries.filter((entry) => entry.options.id !== "composer-enter");
	const missing = boot({ entries: withoutBusy });
	missing.runtime.attachLocalChat(missing.ctx);
	const missingStatus = missing.runtime.status();
	assert.equal(missingStatus.available.busyEnter, false, "a missing entry looked adjustable");
	assert.equal(missingStatus.reason.busyEnter, "entry-missing");
	assert.equal(missingStatus.available.workDetails, true, "the other rows stopped working");
	assert.equal(missing.runtime.setLocalChatValue("busyEnter", "steer"), false);
	assert.equal(missing.storage.map.has(missing.runtime.key), false);

	const throwing = boot({ entries: [{ options: { id: "transcript-view" }, inject: () => { throw new Error("boom"); } }] });
	throwing.runtime.attachLocalChat(throwing.ctx);
	assert.equal(throwing.runtime.status().available.workDetails, false);
	assert.equal(throwing.runtime.status().reason.workDetails, "inject-failed");

	const noHooks = boot({ entries: [{ options: { id: "performance-usage" }, inject: () => ({}) }] });
	noHooks.runtime.attachLocalChat(noHooks.ctx);
	assert.equal(noHooks.runtime.status().available.performance, false);
	assert.equal(noHooks.runtime.status().reason.performance, "hook-missing");

	const badShape = boot({ entries: [{ options: { id: "performance-usage" }, inject: () => ({ hooks: { performanceUsage: {} } }) }] });
	badShape.runtime.attachLocalChat(badShape.ctx);
	assert.equal(badShape.runtime.status().available.performance, false);
	assert.equal(badShape.runtime.status().reason.performance, "hook-shape");
});

test("a late settings entry re-binds through the slot subscription", () => {
	const up = upstreamEntries();
	const ref = { value: [] };
	const h = boot({ entries: ref });
	h.runtime.attachLocalChat(h.ctx);
	assert.equal(h.runtime.status().available.workDetails, false, "the row bound before the entry existed");
	ref.value = up.entries;
	assert.equal(h.slotListeners.size, 1, "the slot subscription was not installed");
	for (const listener of [...h.slotListeners]) listener();
	assert.equal(h.runtime.status().available.workDetails, true, "the late entry was not bound");
	assert.equal(h.runtime.setLocalChatValue("workDetails", "compact"), true);
	assert.equal(up.transcript.getSnapshot(), "compact");
});

test("the effect disposer unsubscribes and restores the Host value", () => {
	const up = upstreamEntries();
	const h = boot({ entries: up.entries });
	h.runtime.attachLocalChat(h.ctx);
	assert.equal(h.runtime.setLocalChatValue("collapse", "next-input"), true);
	assert.equal(h.slotListeners.size, 1);
	const dispose = h.sandbox.__dispose;
	assert.equal(typeof dispose, "function", "attachLocalChat did not register an effect");
	dispose();
	assert.equal(h.slotListeners.size, 0, "the slot subscription outlived the disposer");
	assert.equal(up.collapse.listenerCount(), 0, "a store subscription outlived the disposer");
	assert.equal(up.collapse.getSnapshot(), "completion", "the Host value was not restored on teardown");
	assert.equal(h.storage.getItem(h.runtime.key) !== null, true, "teardown discarded the saved device choice");
});

test("a desktop boot installs no runtime and never touches storage", () => {
	const storage = createStorage();
	const h = boot({ entries: upstreamEntries().entries, storage, mode: "desktop" });
	assert.equal(h.runtime, undefined, "a desktop installed the local chat runtime");
	assert.equal(Object.hasOwn(h.sandbox.__RDSH_LOCAL_CHAT_TEST__, "localChat"), false);
	assert.deepEqual(storage.calls, [], "a desktop read or wrote local storage");
	assert.equal(h.plugin.inject, undefined, "a desktop plugin declared slot dependencies");
	// A desktop plugin is a hard no-op: no context access at all.
	assert.doesNotThrow(() => h.plugin.apply(new Proxy({}, {
		get() {
			throw new Error("the desktop plugin used its context");
		},
	})));
});

test("the runtime and the UI stay device-local", () => {
	const start = CLIENT.indexOf("    const LOCAL_CHAT_KEY");
	const end = CLIENT.indexOf("\n    // Shared clipboard + toast", start);
	assert.notEqual(start, -1, "the local chat runtime is missing");
	assert.notEqual(end, -1, "the local chat runtime moved");
	const codeOnly = CLIENT.slice(start, end)
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "");

	assert.match(codeOnly, /const inject = found\.entry\.inject;/, "the runtime does not read the top-level inject face");
	assert.doesNotMatch(codeOnly, /options\??\.inject/, "the runtime still reads options.inject");
	assert.match(codeOnly, /\.store\.set\(/, "the runtime no longer writes the live store");
	assert.doesNotMatch(codeOnly, /configForms|remote\.settings|\.mutate\(|setTranscriptView|setPerformanceUsage|setBusyEnter/,
		"the runtime reaches the shared settings transport");
	assert.match(CLIENT, /attachLocalChat\(ctx\)/, "the runtime is not attached");
	assert.match(CLIENT, /function LocalChatSettingsSection\(\)/, "the Settings card is missing");
	assert.match(CLIENT, /onPhone \? h\("details"[\s\S]*h\(LocalChatSettingsSection\)/, "the card is not in Mobile settings");
	// An unavailable row must not look saved: it shows the Host/fallback value
	// disabled, and only an available local choice offers "follow Host".
	assert.match(CLIENT, /value: available \? \(local \?\? hostValue\) : hostValue/);
	assert.match(CLIENT, /disabled: !available/);
	assert.match(CLIENT, /available && local !== undefined/);
});

test("both shipped packs carry the four settings' copy", () => {
	const keys = [
		"localChat.title",
		"localChat.desc",
		"localChat.note",
		"localChat.followHost",
		"localChat.unavailable",
		"localChat.workDetails",
		"localChat.workDetails.compact",
		"localChat.workDetails.standard",
		"localChat.workDetails.detailed",
		"localChat.workDetails.verbose",
		"localChat.collapse",
		"localChat.collapse.completion",
		"localChat.collapse.next-input",
		"localChat.busyEnter",
		"localChat.busyEnter.queue",
		"localChat.busyEnter.steer",
		"localChat.performance",
		"localChat.performance.compact",
		"localChat.performance.detailed",
	];
	for (const key of keys) {
		assert.equal(typeof COPY.en[key], "string", `${key} is missing from en`);
		assert.equal(typeof COPY.ja[key], "string", `${key} is missing from ja`);
	}
});
