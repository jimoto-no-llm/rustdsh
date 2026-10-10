import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { identity, ProjectStore } from "../../state.mjs";
import { AcceptanceStore } from "../../acceptance.mjs";

const exec = promisify(execFile);
export async function createOutcomeProject(directory) {
  const root = path.join(directory, "project");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "module.mjs"),
    "export const answer = 1;\n",
  );
  await fs.writeFile(
    path.join(root, "check.mjs"),
    "import {answer} from './module.mjs'; if (answer !== 1) process.exit(1); console.log('fixture-private-output');\n",
  );
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: directory };
  await fs.writeFile(
    path.join(root, "check-shape.mjs"),
    "import * as result from './module.mjs'; if (typeof result.answer !== 'number' || Object.keys(result).join(',') !== 'answer') process.exit(1); console.log('fixture-private-shape-output');\n",
  );
  await exec("git", ["-C", root, "init", "-b", "outcome-fixture"], {
    env,
    windowsHide: true,
  });
  await exec(
    "git",
    ["-C", root, "add", "--", "module.mjs", "check.mjs", "check-shape.mjs"],
    {
      env,
      windowsHide: true,
    },
  );
  await exec(
    "git",
    [
      "-C",
      root,
      "-c",
      "user.name=Outcome Fixture",
      "-c",
      "user.email=outcomes@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Fixture inputs",
    ],
    { env, windowsHide: true },
  );
  const project = await identity(root);
  project.directory = path.join(directory, "state", project.id);
  const state = await ProjectStore.open(project);
  const definition = [
    {
      id: "value",
      description: "戻り値が要件と一致する",
      inputs: ["module.mjs", "check.mjs"],
    },
    {
      id: "shape",
      description: "必要な出力形式を検査する",
      inputs: ["module.mjs", "check-shape.mjs"],
    },
  ];
  const contract = {
    id: "M1",
    title: "成果の受入",
    criteria: definition.map((criterion) => ({
      task_id: "goal",
      criterion_id: criterion.id,
      description: criterion.description,
    })),
  };
  await state.mutate("task", {
    id: "goal",
    title: "受入対象の成果",
    status: "done",
    milestone: "M1",
    blocker: "レビューを待っています",
    outcome: {
      purpose: "必要な値と出力を提供する",
      owner: "実装担当",
      latest_outcome: "修正を提出しました",
      next_step: "受入条件を確認する",
    },
    milestone_contract: contract,
  });
  const acceptance = await AcceptanceStore.open(project);
  await acceptance.define("goal", definition);
  const run = (criterion_id, scope = "full") =>
    acceptance.perform({
      task_id: "goal",
      criterion_id,
      scope,
      argv: [
        process.execPath,
        criterion_id === "shape" ? "check-shape.mjs" : "check.mjs",
      ],
    });
  return { root, project, state, acceptance, definition, contract, run };
}
