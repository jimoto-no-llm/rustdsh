import assert from "node:assert/strict";
import { test } from "node:test";
import { apply, recordLiveToken } from "../lib/mobile-ux.js";

const LIVE_SPEED_PATH = "/api/rdsh-mobile-ux/live-speed";

function mount(config = {}) {
  const routes = new Map();
  let streamHook;
  const webServer = {
    tapIndex() {
      return () => {};
    },
    register(route) {
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  };
  // Every route in this package answers 401/403 the same way, so the fake
  // context has to offer the same seam.
  const connection = { requestRejection: () => undefined };
  const ctx = {
    on(event, handler, options) {
      assert.equal(event, "llm/stream");
      assert.deepEqual(options, { global: true });
      streamHook = handler;
    },
    inject(dependencies, callback) {
      assert.deepEqual(dependencies, ["webServer", "connection"]);
      callback({ webServer, connection });
    },
  };
  apply(ctx, config);
  return { routes, streamHook };
}

function request(route, method = "GET", url = route.path) {
  const result = { status: undefined, headers: undefined, body: "" };
  route.handler({ method, url }, {
    writeHead(status, headers) {
      result.status = status;
      result.headers = headers;
    },
    end(body) {
      result.body = body ?? "";
    },
  });
  return result;
}

test("live rate uses a one-second sliding window and waits for two samples", () => {
  const samples = [];
  assert.equal(recordLiveToken(samples, 1000), null);
  assert.equal(recordLiveToken(samples, 1100), 10);
  assert.equal(recordLiveToken(samples, 2101), null);
  assert.deepEqual(samples, [2101]);
});

test("an ordinary stream publishes rate for its own session", async () => {
  const { routes, streamHook } = mount();
  const route = routes.get(LIVE_SPEED_PATH);
  const other = (async function* () { yield { type: "text-delta", text: "x" }; })();
  // A session-title request is not a turn: it must pass straight through.
  assert.equal(streamHook({ provider: "any-provider", sessionId: "session-a", purpose: "session-title" }, () => other), other);
  // Nor is a call without a session.
  assert.equal(streamHook({ provider: "any-provider" }, () => other), other);

  async function* source() {
    yield { type: "text-delta", text: "a" };
    await new Promise((resolve) => setTimeout(resolve, 25));
    yield { type: "text-delta", text: "b" };
  }
  const iterator = streamHook({ provider: "any-provider", sessionId: "session-a" }, source)[Symbol.asyncIterator]();
  assert.deepEqual((await iterator.next()).value, { type: "text-delta", text: "a" });
  assert.deepEqual((await iterator.next()).value, { type: "text-delta", text: "b" });

  const live = request(route, "GET", `${LIVE_SPEED_PATH}?sessionId=session-a`);
  assert.equal(live.status, 200);
  assert.equal(live.headers["cache-control"], "no-store");
  assert.ok(JSON.parse(live.body).tps > 0);
  assert.equal(JSON.parse(request(route, "GET", `${LIVE_SPEED_PATH}?sessionId=session-b`).body), null);

  await iterator.next();
  assert.equal(JSON.parse(request(route, "GET", `${LIVE_SPEED_PATH}?sessionId=session-a`).body), null);
});

test("throttling the readout to listed providers passes others through", async () => {
  const { routes, streamHook } = mount({ liveSpeedProviders: ["fast"] });
  const route = routes.get(LIVE_SPEED_PATH);
  const other = (async function* () { yield { type: "text-delta", text: "x" }; })();
  assert.equal(streamHook({ provider: "slow", sessionId: "session-c" }, () => other), other);
  assert.equal(JSON.parse(request(route, "GET", `${LIVE_SPEED_PATH}?sessionId=session-c`).body), null);

  async function* source() {
    yield { type: "text-delta", text: "a" };
    await new Promise((resolve) => setTimeout(resolve, 25));
    yield { type: "text-delta", text: "b" };
  }
  const iterator = streamHook({ provider: "fast", sessionId: "session-d" }, source)[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.next();
  assert.ok(JSON.parse(request(route, "GET", `${LIVE_SPEED_PATH}?sessionId=session-d`).body).tps > 0);
});

test("the route refuses a request the connection rejects", () => {
  const routes = new Map();
  const webServer = {
    tapIndex: () => () => {},
    register(route) { routes.set(route.path, route); return () => routes.delete(route.path); },
  };
  const ctx = {
    on() {},
    inject(dependencies, callback) {
      callback({ webServer, connection: { requestRejection: () => 403 } });
    },
  };
  apply(ctx, {});
  const denied = request(routes.get(LIVE_SPEED_PATH));
  assert.equal(denied.status, 403);
});

test("live-speed route is read-only and supports HEAD", () => {
  const { routes } = mount();
  const route = routes.get(LIVE_SPEED_PATH);
  const rejected = request(route, "POST");
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.allow, "GET, HEAD");
  const head = request(route, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
});
