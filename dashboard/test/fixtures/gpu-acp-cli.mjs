// An original-ACP peer fixture; it never allocates VRAM or calls a model.
import fs from "node:fs";
import path from "node:path";
if (!process.argv.includes("--version")) {
  const body = JSON.parse(
    fs.readFileSync(
      path.join(process.env.RDSH_GPU_FIXTURE_HOME, "leases.json"),
      "utf8",
    ),
  );
  const lease = body.payload.leases.find(
    (item) => item.request.device_id === process.env.CUDA_VISIBLE_DEVICES,
  );
  if (!lease || !["launching", "bound"].includes(lease.phase))
    throw new Error("GPU must already be reserved at native process entry");
  fs.writeFileSync(
    process.env.RDSH_GPU_FIXTURE_ENTRY,
    JSON.stringify({
      lease_id: lease.lease_id,
      pid: process.pid,
      phase: lease.phase,
      device_id: process.env.CUDA_VISIBLE_DEVICES,
    }) + "\n",
  );
  if (process.env.RDSH_GPU_FIXTURE_EXIT_FILE) {
    const timer = setInterval(() => {
      if (fs.existsSync(process.env.RDSH_GPU_FIXTURE_EXIT_FILE))
        process.exit(17);
    }, 25);
    timer.unref();
  }
}
await import("./acp-cli.mjs");
