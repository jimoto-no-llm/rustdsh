// Deliberately killed by its owning test, never used by the production CLI.
import fs from "node:fs/promises";
import { RunHistory } from "../../run-history.mjs";
import { readProcessIdentity } from "../../process-identity.mjs";

const [encoded, runId, point] = process.argv.slice(2);
const { project, counter } = JSON.parse(encoded);
const history = await RunHistory.open(project);
const pause = async () => {
  process.send({ point });
  await new Promise(() => {
    setInterval(() => {}, 1000);
  });
};
if (point === "stale-lock") {
  const owner = await readProcessIdentity(process.pid);
  const lock = await fs.open(history.lock, "wx", 0o600);
  await lock.writeFile(
    JSON.stringify({ owner_id: history.owner_id, identity: owner.identity }),
  );
  await lock.sync();
  await pause();
} else if (point === "torn-tail") {
  const handle = await fs.open(history.file, "a");
  await handle.write('{"schema":1,"fixture_torn');
  await handle.sync();
  await pause();
} else {
  if (point === "before-write") await pause();
  const commandId = await history.recordCommand(runId, "send");
  if (point === "after-write") await pause();
  await history.transition(runId, "running", "cli_prompt_pending");
  await history.commandPhase(commandId, "dispatched");
  // A harmless counter stands in for the external operation already performed.
  await fs.appendFile(counter, "one-fixture-effect\n");
  if (point === "before-ack") await pause();
  await history.commandPhase(
    commandId,
    "acknowledged",
    "prompt_result_received",
  );
  if (point === "after-ack") await pause();
  throw new Error("Unknown crash fixture point");
}
