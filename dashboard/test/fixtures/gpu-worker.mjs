import path from "node:path";
import { GpuLeases } from "../../gpu-leases.mjs";
import { lockGpuLedger } from "../../gpu-lock.mjs";
import { parseGpuInventory } from "../../gpu-telemetry.mjs";

process.send({ ready: true });
process.on("message", async (message) => {
  try {
    if (message.operation === "acquire") {
      const leases = new GpuLeases({
        home: message.home,
        observe: async () => parseGpuInventory(message.inventory),
      });
      process.send({ result: await leases.acquire(message.input) });
    } else if (message.operation === "lock") {
      await lockGpuLedger(path.join(message.home, "leases.lock"));
      process.send({ locked: true });
    } else if (message.operation === "crash") process.exit(23);
  } catch (error) {
    process.send({ error: error.code || "fixture_failed" });
  }
});
