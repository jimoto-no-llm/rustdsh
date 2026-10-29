import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:net";
import { test } from "node:test";
import { createSafeLookup, createSecurePushTransport, isPublicPushAddress } from "../notify/secure-push.js";

const options = { method: "POST", headers: {}, body: Buffer.from("test"), signal: AbortSignal.timeout(1000) };

test("push IP policy rejects local, reserved and tunneled addresses", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "100.64.1.2", "169.254.169.254", "172.31.0.1", "192.168.1.1", "198.18.0.1", "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "2001:db8::1", "2001:2::1", "2001:20::1", "2002:7f00:1::", "not-an-ip"]) assert.equal(isPublicPushAddress(address), false, address);
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) assert.equal(isPublicPushAddress(address), true, address);
});

test("DNS lookup returns only the validated addresses and rejects mixed results", async () => {
  let calls = 0;
  const lookup = createSafeLookup((hostname, opts, callback) => {
    calls++;
    assert.equal(hostname, "push.example");
    assert.equal(opts.all, true);
    callback(null, [{ address: "8.8.8.8", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }]);
  });
  const addresses = await new Promise((resolve, reject) => lookup("push.example", { all: true }, (error, result) => error ? reject(error) : resolve(result)));
  assert.equal(calls, 1);
  assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }]);
  const mixed = createSafeLookup((_hostname, _opts, callback) => callback(null, [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]));
  await assert.rejects(new Promise((resolve, reject) => mixed("example", { all: true }, (error, result) => error ? reject(error) : resolve(result))), /non-public/);
});

test("private DNS answer is rejected before a real socket is opened", async () => {
  let connections = 0;
  const server = createServer((socket) => { connections++; socket.destroy(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const transport = createSecurePushTransport((_name, _options, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }]));
    await assert.rejects(transport(`https://push.example:${server.address().port}/abc`, options), /non-public/);
    assert.equal(connections, 0);
    assert.throws(() => transport("https://127.0.0.1/abc", options), /public address/);
    assert.throws(() => transport("http://example.com/abc", options), /https/);
  } finally { server.close(); await once(server, "close"); }
});

test("HTTPS redirects are returned rather than followed", async () => {
  let requests = 0;
  const fakeRequest = (_url, _opts, onResponse) => {
    requests++;
    const req = new EventEmitter();
    req.end = () => onResponse({ statusCode: 302, resume() {} });
    return req;
  };
  const transport = createSecurePushTransport(() => { throw new Error("unexpected DNS"); }, fakeRequest);
  assert.deepEqual(await transport("https://push.example/abc", options), { status: 302 });
  assert.equal(requests, 1);
});

test("abort stops a pending DNS lookup before connecting", async () => {
  const controller = new AbortController();
  const transport = createSecurePushTransport(() => {});
  const pending = transport("https://push.example/abc", { ...options, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});
