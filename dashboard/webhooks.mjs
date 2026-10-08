import https from "node:https";
import dns from "node:dns/promises";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import ipaddr from "ipaddr.js";
import { Webhook } from "standardwebhooks";
import { writeJson } from "./state.mjs";

export function isPublicAddress(address) {
  try {
    const parsed = ipaddr.process(address);
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}
export async function validateCallback(destination, lookup = dns.lookup) {
  const url = new URL(destination);
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error(
      "Callback must be an HTTPS URL without credentials or a fragment",
    );
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (
    !addresses.length ||
    addresses.some((item) => !isPublicAddress(item.address))
  )
    throw new Error("Callback must resolve only to public addresses");
  return { url, addresses };
}
export async function publicWebhookPost(destination, headers, body) {
  const { url, addresses } = await validateCallback(destination);
  const selected = addresses[0];
  // Pin the checked address on the actual connection, retaining hostname/SNI for TLS verification.
  return await new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "POST",
        headers: { ...headers, "content-length": Buffer.byteLength(body) },
        timeout: 10000,
        lookup: (_host, options, callback) =>
          options.all
            ? callback(null, [selected])
            : callback(null, selected.address, selected.family),
      },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 8192)
            request.destroy(new Error("Callback response exceeds limit"));
          else chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        response.on("error", reject);
      },
    );
    request.on("timeout", () => request.destroy(new Error("Callback timeout")));
    request.on("error", reject);
    request.end(body);
  });
}
const names = [
  "dashboard.answer.created",
  "dashboard.question.created",
  "dashboard.task.updated",
  "dashboard.progress.updated",
  "dashboard.metrics.updated",
];
export const eventDefinitions = names.map((name) => ({
  name,
  description: {
    "dashboard.answer.created":
      "A human answered a project question. Retrieve the durable reply and continue the assigned work.",
    "dashboard.question.created":
      "A new project question requires human input.",
    "dashboard.task.updated": "A project task changed status.",
    "dashboard.progress.updated":
      "New progress or an artifact reference was reported.",
    "dashboard.metrics.updated": "Measured project metrics were updated.",
  }[name],
  delivery: ["webhook"],
  inputSchema: {
    type: "object",
    properties: { project_id: { type: "string" } },
    required: ["project_id"],
    additionalProperties: false,
  },
  payloadSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
      revision: { type: "integer" },
      entity_id: { type: "string" },
      summary: { type: "string" },
    },
    required: ["project_id", "revision", "entity_id", "summary"],
    additionalProperties: false,
  },
}));
export function signingSecret(secret) {
  if (
    typeof secret !== "string" ||
    !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)
  )
    throw new Error("Invalid webhook signing secret");
  const key = Buffer.from(secret.slice(6), "base64");
  if (
    key.length < 24 ||
    key.length > 64 ||
    key.toString("base64").replace(/=+$/, "") !==
      secret.slice(6).replace(/=+$/, "")
  )
    throw new Error("Webhook signing key must decode to 24–64 bytes");
  return secret;
}
export class EventsHub {
  constructor(project, getState, post = publicWebhookPost) {
    this.project = project;
    this.getState = getState;
    this.post = post;
    this.subscriptions = [];
    this.deliveryHistory = [];
    this.busy = false;
    this.queue = Promise.resolve();
    this.verified = new Map();
  }
  static async open(project, getState, post) {
    const hub = new EventsHub(project, getState, post);
    try {
      const saved = JSON.parse(
        await fs.readFile(path.join(project.directory, "events.json"), "utf8"),
      );
      if (saved.schema !== 1 || !Array.isArray(saved.subscriptions))
        throw new Error("Invalid event subscription state");
      hub.subscriptions = saved.subscriptions;
      if (saved.deliveries !== undefined) {
        if (
          !Array.isArray(saved.deliveries) ||
          saved.deliveries.length > 1000 ||
          saved.deliveries.some(
            (item) =>
              !item ||
              typeof item.event_id !== "string" ||
              typeof item.subscription_id !== "string" ||
              !["delivered", "retrying", "failed"].includes(item.status) ||
              !Number.isFinite(Date.parse(item.observed_at)) ||
              Object.keys(item).some(
                (key) =>
                  ![
                    "event_id",
                    "subscription_id",
                    "status",
                    "observed_at",
                  ].includes(key),
              ),
          )
        )
          throw new Error("Invalid event delivery history");
        hub.deliveryHistory = saved.deliveries;
      }
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    return hub;
  }
  persist() {
    return writeJson(path.join(this.project.directory, "events.json"), {
      schema: 1,
      subscriptions: this.subscriptions,
      ...(this.deliveryHistory.length
        ? { deliveries: this.deliveryHistory }
        : {}),
    });
  }
  serial(work) {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  identity(params) {
    if (
      !names.includes(params.name) ||
      params.arguments?.project_id !== this.project.id ||
      Object.keys(params.arguments).length !== 1 ||
      params.delivery?.mode !== "webhook"
    )
      throw new Error("Unknown event or unauthorized project filter");
    const url = new URL(params.delivery.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      throw new Error("Invalid callback URL");
    return createHash("sha256")
      .update(
        JSON.stringify([
          this.project.id,
          url.href,
          params.name,
          { project_id: this.project.id },
        ]),
      )
      .digest("hex")
      .slice(0, 32);
  }
  async signedPost(subscription, event, verification = false) {
    const body = JSON.stringify(event),
      id = verification
        ? `msg_verification_${randomBytes(16).toString("hex")}`
        : event.eventId,
      now = new Date();
    if (Buffer.byteLength(body) > 262144)
      throw new Error("Event payload exceeds 256 KiB");
    let signature = new Webhook(subscription.secret).sign(id, now, body);
    if (subscription.old_secret && Date.now() < subscription.rotation_until)
      signature +=
        " " + new Webhook(subscription.old_secret).sign(id, now, body);
    return await this.post(
      subscription.url,
      {
        "content-type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": String(Math.floor(now.getTime() / 1000)),
        "webhook-signature": signature,
        "X-MCP-Subscription-Id": subscription.id,
      },
      body,
    );
  }
  async subscribe(params) {
    const id = this.identity(params),
      secret = signingSecret(params.delivery.secret);
    if (
      params.ttlMs !== undefined &&
      params.ttlMs !== null &&
      (!Number.isSafeInteger(params.ttlMs) || params.ttlMs <= 0)
    )
      throw new Error("Invalid ttlMs");
    return await this.serial(async () => {
      const previous = this.subscriptions.find((item) => item.id === id);
      const subscription = {
        id,
        name: params.name,
        arguments: { project_id: this.project.id },
        url: new URL(params.delivery.url).href,
        secret,
        expires_at: Date.now() + Math.min(params.ttlMs ?? 86400000, 604800000),
        last_revision: previous?.last_revision ?? this.getState().revision,
        attempts: 0,
        next_attempt: 0,
        last_error: null,
      };
      if (previous?.secret !== secret && previous?.secret) {
        subscription.old_secret = previous.secret;
        subscription.rotation_until = Date.now() + 300000;
      }
      const verificationKey = createHash("sha256")
        .update(JSON.stringify([this.project.id, subscription.url, secret]))
        .digest("hex");
      const challenge = randomBytes(24).toString("hex");
      if ((this.verified.get(verificationKey) || 0) <= Date.now()) {
        try {
          const response = await this.signedPost(
            subscription,
            { type: "verification", challenge },
            true,
          );
          const echoed = JSON.parse(response.body).challenge;
          if (
            response.status < 200 ||
            response.status >= 300 ||
            typeof echoed !== "string" ||
            Buffer.byteLength(echoed) !== Buffer.byteLength(challenge) ||
            !timingSafeEqual(Buffer.from(echoed), Buffer.from(challenge))
          )
            throw new Error("challenge_failed");
        } catch (error) {
          const failure = new Error("Callback verification failed");
          failure.code = -32015;
          failure.data = {
            reason: /timeout/i.test(error.message)
              ? "timeout"
              : "challenge_failed",
          };
          throw failure;
        }
        for (const [key, expiry] of this.verified)
          if (expiry <= Date.now()) this.verified.delete(key);
        this.verified.set(verificationKey, Date.now() + 60000);
      }
      if (previous)
        this.subscriptions[this.subscriptions.indexOf(previous)] = subscription;
      else this.subscriptions.push(subscription);
      await this.persist();
      return {
        id,
        refreshBefore: new Date(subscription.expires_at).toISOString(),
        cursor: null,
        truncated: false,
      };
    });
  }
  async unsubscribe(params) {
    const id = this.identity(params);
    return this.serial(async () => {
      this.subscriptions = this.subscriptions.filter((item) => item.id !== id);
      await this.persist();
      return {};
    });
  }
  async revoke() {
    return this.serial(async () => {
      this.subscriptions = [];
      this.verified.clear();
      await this.persist();
    });
  }
  status() {
    return {
      active: this.subscriptions.filter((item) => item.expires_at > Date.now())
        .length,
      failures: this.subscriptions.filter((item) => item.last_error).length,
    };
  }
  deliveries() {
    return Object.fromEntries(
      [...new Set(this.deliveryHistory.map((item) => item.event_id))].map(
        (id) => [
          id,
          this.deliveryHistory
            .filter((item) => item.event_id === id)
            .map((item) => ({ ...item })),
        ],
      ),
    );
  }
  async flush() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.serial(async () => {
        const state = this.getState();
        let dirty = false;
        for (const sub of this.subscriptions) {
          if (sub.expires_at <= Date.now() || sub.next_attempt > Date.now())
            continue;
          const next = (state.changes || []).find(
            (event) =>
              event.data.revision > sub.last_revision &&
              event.name === sub.name,
          );
          if (!next) continue;
          let response;
          try {
            response = await this.signedPost(sub, next);
          } catch {
            response = { status: 0 };
          }
          dirty = true;
          const success = response.status >= 200 && response.status < 300;
          const permanent =
            response.status === 410 ||
            response.status === 413 ||
            (response.status >= 400 &&
              response.status < 500 &&
              response.status !== 429);
          this.deliveryHistory = this.deliveryHistory.filter(
            (item) =>
              item.event_id !== next.eventId || item.subscription_id !== sub.id,
          );
          this.deliveryHistory.push({
            event_id: next.eventId,
            subscription_id: sub.id,
            status: success
              ? "delivered"
              : permanent || sub.attempts >= 4
                ? "failed"
                : "retrying",
            observed_at: new Date().toISOString(),
          });
          this.deliveryHistory = this.deliveryHistory.slice(-1000);
          if (success || permanent || sub.attempts >= 4) {
            sub.last_revision = next.data.revision;
            sub.last_error = success
              ? null
              : `Delivery failed (${response.status || "network"})`;
            sub.attempts = 0;
            sub.next_attempt = 0;
            if (response.status === 410) sub.expires_at = Date.now();
          } else {
            sub.attempts++;
            sub.next_attempt =
              Date.now() + Math.min(60000, 1000 * 2 ** (sub.attempts - 1));
            sub.last_error = `Delivery retry ${sub.attempts}`;
          }
        }
        if (dirty) await this.persist();
      });
    } finally {
      this.busy = false;
    }
  }
}
