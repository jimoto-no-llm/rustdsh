import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import { writeJson } from "./state.mjs";

export const deviceCapabilities = ["read", "reply", "control"];
const capabilitySet = new Set(deviceCapabilities);
const digest = (token) =>
  createHash("sha256").update(token, "utf8").digest("hex");

function validTimestamp(value) {
  return value === null ||
    (typeof value === "string" && Number.isFinite(Date.parse(value)));
}
function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validateRegistry(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schema !== 1 ||
    !Array.isArray(value.devices)
  )
    throw new Error("Invalid device registry schema");
  if (value.devices.length > 100)
    throw new Error("Device registry limit exceeded");
  const ids = new Set();
  const hashes = new Set();
  for (const device of value.devices) {
    if (
      !device ||
      typeof device !== "object" ||
      typeof device.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        device.id,
      ) ||
      typeof device.name !== "string" ||
      !device.name ||
      device.name.length > 64 ||
      typeof device.token_hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(device.token_hash) ||
      !Array.isArray(device.capabilities) ||
      !device.capabilities.includes("read") ||
      device.capabilities.some((item) => !capabilitySet.has(item)) ||
      new Set(device.capabilities).size !== device.capabilities.length ||
      !validDate(device.created_at) ||
      !validTimestamp(device.last_used_at) ||
      !validTimestamp(device.revoked_at)
    )
      throw new Error("Invalid device registry entry");
    if (ids.has(device.id) || hashes.has(device.token_hash))
      throw new Error("Duplicate device registry entry");
    ids.add(device.id);
    hashes.add(device.token_hash);
  }
}

function publicDevice(device) {
  const { token_hash, ...value } = device;
  return {
    ...value,
    status: device.revoked_at ? "revoked" : "active",
  };
}

export class DeviceRegistry {
  constructor(file, value) {
    this.file = file;
    this.value = value;
    this.saveQueue = Promise.resolve();
    this.touchTimer = null;
  }

  static async open(file) {
    let value;
    try {
      value = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      value = { schema: 1, devices: [] };
    }
    validateRegistry(value);
    return new DeviceRegistry(file, value);
  }

  list() {
    return this.value.devices.map(publicDevice);
  }

  async create(input) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !["name", "capabilities"].includes(key))
    )
      throw new Error("Invalid device fields");
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const capabilities = input.capabilities ?? ["read"];
    if (!name || name.length > 64)
      throw new Error("Device name must contain 1 to 64 characters");
    if (
      !Array.isArray(capabilities) ||
      !capabilities.includes("read") ||
      capabilities.some((item) => !capabilitySet.has(item)) ||
      new Set(capabilities).size !== capabilities.length
    )
      throw new Error("Device capabilities must include read and use known values");
    if (this.value.devices.length >= 100)
      throw new Error("Device registry limit reached");

    const credential = `rdsh_dev_${randomBytes(32).toString("hex")}`;
    const device = {
      id: randomUUID(),
      name,
      capabilities: [...capabilities].sort(),
      token_hash: digest(credential),
      created_at: new Date().toISOString(),
      last_used_at: null,
      revoked_at: null,
    };
    this.value.devices.push(device);
    try {
      await this.persist();
    } catch (error) {
      this.value.devices = this.value.devices.filter((item) => item.id !== device.id);
      throw error;
    }
    return { device: publicDevice(device), credential };
  }

  async revoke(id) {
    const device = this.value.devices.find((item) => item.id === id);
    if (!device) return null;
    if (!device.revoked_at) {
      device.revoked_at = new Date().toISOString();
      await this.persist();
    }
    return publicDevice(device);
  }

  authenticate(credential) {
    if (
      typeof credential !== "string" ||
      credential.length !== 73 ||
      !credential.startsWith("rdsh_dev_") ||
      !/^rdsh_dev_[a-f0-9]{64}$/.test(credential)
    )
      return null;
    const candidate = Buffer.from(digest(credential), "hex");
    let match = null;
    for (const device of this.value.devices) {
      const expected = Buffer.from(device.token_hash, "hex");
      const equal = timingSafeEqual(candidate, expected);
      if (equal && !device.revoked_at) match = device;
    }
    if (!match) return null;
    this.touch(match);
    return {
      role: "device",
      device_id: match.id,
      name: match.name,
      capabilities: [...match.capabilities],
    };
  }

  touch(device) {
    device.last_used_at = new Date().toISOString();
    if (!this.touchTimer) {
      this.touchTimer = setTimeout(() => {
        this.touchTimer = null;
        void this.persist().catch(() => {});
      }, 1000);
      this.touchTimer.unref?.();
    }
  }

  async persist() {
    const snapshot = structuredClone(this.value);
    const pending = this.saveQueue.then(() => writeJson(this.file, snapshot));
    this.saveQueue = pending.catch(() => {});
    return pending;
  }

  async flush() {
    if (this.touchTimer) {
      clearTimeout(this.touchTimer);
      this.touchTimer = null;
    }
    await this.persist();
    await this.saveQueue;
  }
}
