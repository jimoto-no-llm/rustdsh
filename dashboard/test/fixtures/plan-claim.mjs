import fs from "node:fs/promises";
import { ExecutionPlans } from "../../execution-plan.mjs";
const input = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
try {
  const claim = await ExecutionPlans.open(input.project).admit(
    input.id,
    input.hash,
    input.request,
  );
  process.stdout.write(
    JSON.stringify({ allowed: true, claim_id: claim.claim_id }),
  );
} catch (error) {
  process.stdout.write(JSON.stringify({ allowed: false, reason: error.code }));
}
