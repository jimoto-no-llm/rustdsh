// Optional reports and fixed milestone criteria; no execution or check results.
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const fields = (value, keys) =>
  object(value) && Object.keys(value).every((key) => keys.includes(key));
const text = (value, maximum = 160) =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= maximum;
function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
const reportFields = [
  "purpose",
  "owner",
  "latest_outcome",
  "next_step",
  "acceptance_task_id",
];
const limits = {
  purpose: 4000,
  owner: 1000,
  latest_outcome: 4000,
  next_step: 2000,
  acceptance_task_id: 160,
};
function report(input) {
  requireValue(fields(input, reportFields), "Invalid outcome report fields");
  for (const [key, value] of Object.entries(input))
    requireValue(
      value === null || text(value, limits[key]),
      `Invalid outcome ${key}`,
    );
  return { ...input };
}
function milestone(input) {
  requireValue(
    fields(input, ["id", "title", "criteria"]) &&
      text(input.id) &&
      text(input.title, 1000),
    "Invalid milestone contract",
  );
  requireValue(
    Array.isArray(input.criteria) &&
      input.criteria.length > 0 &&
      input.criteria.length <= 50,
    "Invalid milestone criteria",
  );
  const criteria = input.criteria.map((criterion) => {
    requireValue(
      fields(criterion, ["task_id", "criterion_id", "description"]) &&
        text(criterion.task_id) &&
        typeof criterion.criterion_id === "string" &&
        /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(criterion.criterion_id) &&
        text(criterion.description, 1000),
      "Invalid milestone criterion",
    );
    return {
      task_id: criterion.task_id,
      criterion_id: criterion.criterion_id,
      description: criterion.description,
    };
  });
  requireValue(
    new Set(
      criteria.map((criterion) =>
        JSON.stringify([criterion.task_id, criterion.criterion_id]),
      ),
    ).size === criteria.length,
    "Duplicate milestone criterion",
  );
  return { id: input.id, title: input.title, criteria };
}
export function applyTaskOutcomes(state, input) {
  if (
    !Object.hasOwn(input, "outcome") &&
    !Object.hasOwn(input, "milestone_contract")
  )
    return;
  const next = structuredClone(
    state.task_outcomes || { schema: 1, tasks: [], milestones: [] },
  );
  if (Object.hasOwn(input, "outcome")) {
    const update = report(input.outcome);
    const index = next.tasks.findIndex((item) => item.task_id === input.id);
    const current = index < 0 ? { task_id: input.id } : next.tasks[index];
    const value = { ...current, ...update };
    if (index < 0) {
      requireValue(next.tasks.length < 200, "Outcome task limit reached");
      next.tasks.push(value);
    } else next.tasks[index] = value;
  }
  if (Object.hasOwn(input, "milestone_contract")) {
    const value = milestone(input.milestone_contract);
    requireValue(
      input.milestone === value.id,
      "Milestone contract must match the task milestone",
    );
    const current = next.milestones.find((item) => item.id === value.id);
    if (current)
      requireValue(
        JSON.stringify(current) === JSON.stringify(value),
        "Milestone criteria are fixed; declare changed criteria with a new milestone ID",
      );
    else {
      requireValue(next.milestones.length < 200, "Milestone limit reached");
      next.milestones.push(value);
    }
  }
  state.task_outcomes = next;
}
export function validateTaskOutcomes(state) {
  const value = state.task_outcomes;
  if (value === undefined) return;
  requireValue(
    fields(value, ["schema", "tasks", "milestones"]) &&
      value.schema === 1 &&
      Array.isArray(value.tasks) &&
      value.tasks.length <= 200 &&
      Array.isArray(value.milestones) &&
      value.milestones.length <= 200,
    "Invalid task outcomes",
  );
  const ids = new Set();
  for (const task of value.tasks) {
    requireValue(
      fields(task, ["task_id", ...reportFields]) &&
        text(task.task_id) &&
        state.tasks.some((item) => item.id === task.task_id) &&
        !ids.has(task.task_id),
      "Invalid outcome task",
    );
    ids.add(task.task_id);
    const { task_id, ...details } = task;
    report(details);
  }
  ids.clear();
  for (const item of value.milestones) {
    const normalized = milestone(item);
    requireValue(!ids.has(normalized.id), "Duplicate milestone");
    ids.add(normalized.id);
  }
}
export const outcomeSchema = {
  type: "object",
  additionalProperties: false,
  properties: Object.fromEntries(
    reportFields.map((key) => [
      key,
      { type: ["string", "null"], minLength: 1, maxLength: limits[key] },
    ]),
  ),
};
export const milestoneSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "title", "criteria"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 160 },
    title: { type: "string", minLength: 1, maxLength: 1000 },
    criteria: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["task_id", "criterion_id", "description"],
        properties: {
          task_id: { type: "string", minLength: 1, maxLength: 160 },
          criterion_id: {
            type: "string",
            pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$",
          },
          description: { type: "string", minLength: 1, maxLength: 1000 },
        },
      },
    },
  },
};
