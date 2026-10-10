import readline from "node:readline";
import { ResourceAdmission } from "../../resource-admission.mjs";

const directory = process.argv[2];
const manager = new ResourceAdmission({ directory });
try {
  const lease = await manager.reserve({
    kind: "heavy-build",
    cpu_cores: 1,
    memory_mib: 1,
  });
  process.stdout.write(
    JSON.stringify({
      status: "reserved",
      lease_id: lease.lease_id,
      owner_identity: lease.owner_identity,
    }) + "\n",
  );
  const input = readline.createInterface({ input: process.stdin });
  await new Promise((resolve) => input.once("line", resolve));
  input.close();
  await manager.abandon(lease.lease_id, lease.owner_identity);
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      status: "rejected",
      code: error.code || "unknown",
    }) + "\n",
  );
}
