import { createHash, randomUUID } from "node:crypto";

const sha256 = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const timestamp = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
const bySequence = (left, right) => left.sequence - right.sequence;

function source({ id, uri, selector, recordedAt, value, capturedAt }) {
  return {
    id,
    uri,
    selector,
    recorded_at: timestamp(recordedAt),
    captured_at: capturedAt,
    fingerprint: sha256(value),
  };
}

function targetSummary(value) {
  if (!value || typeof value !== "object") return null;
  return {
    observed_at: timestamp(value.observed_at),
    head_sha: value.head_sha ?? null,
    branch: value.branch ?? null,
    inputs_hash: value.inputs_hash ?? null,
    worktree_hash: value.worktree_hash ?? null,
    environment_hash: value.environment_hash ?? null,
    status: value.status ?? "unknown",
    reason: value.reason ?? "unknown",
  };
}

function evidenceSummary(record) {
  return {
    evidence_id: record.evidence_id,
    scope: record.scope,
    status: record.status,
    phase: record.phase ?? "unknown",
    freshness: record.freshness?.state ?? "unknown",
    eligible_pass: record.eligible_pass === true,
    command_integrity: record.command_integrity ?? "unknown",
    artifacts: (record.artifacts ?? []).map((artifact) => ({
      name: artifact.name,
      integrity: artifact.integrity ?? "unknown",
      source: artifact.source ?? "unknown",
    })),
  };
}

function verificationSummary(inspection) {
  const conditions = Array.isArray(inspection?.conditions)
    ? inspection.conditions
    : [];
  return {
    acceptance_defined: inspection?.acceptance_defined === true,
    verification_status: inspection?.verification?.status ?? "unverified",
    all_declared_full_checks_pass:
      inspection?.verification?.all_declared_full_checks_pass === true,
    human_review: inspection?.verification?.human_review ?? "not_assessed",
    production_adoption:
      inspection?.verification?.production_adoption ?? "not_assessed",
    conditions: conditions.map((condition) => ({
      criterion: {
        id: condition.criterion?.id ?? "unknown",
        description: condition.criterion?.description ?? "unknown",
      },
      status: condition.status ?? "not-run",
      verified_full_check: condition.verified_full_check === true,
      current_target: targetSummary(condition.current_target),
      evidence: (condition.evidence ?? []).map(evidenceSummary),
    })),
  };
}

function taskSource(task, taskId, capturedAt) {
  return source({
    id: `task:${taskId}`,
    uri: "dashboard://state",
    selector: { kind: "task", id: taskId },
    recordedAt: task?.updated_at,
    value: task
      ? {
          id: task.id,
          title: task.title,
          status: task.status,
          milestone: task.milestone ?? "",
          blocker: task.blocker ?? "",
          updated_at: task.updated_at,
          ...(typeof task.next_action === "string"
            ? { next_action: task.next_action }
            : {}),
        }
      : null,
    capturedAt,
  });
}

function decisionCards(state, taskId) {
  return Object.entries(state.question_contracts?.cards ?? {})
    .map(([id, card]) => ({ id, card }))
    .filter(({ card }) => card.snapshot?.decision?.target?.task_id === taskId)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function decisionAnswers(state, taskId) {
  return (state.feedback ?? [])
    .filter((item) => item.target?.task_id === taskId)
    .sort(bySequence);
}

function packetSourceRefs(packet) {
  return packet.sections
    ? [
        ...new Map(
          Object.values(packet.sections)
            .flatMap((section) =>
              (section.items ?? []).flatMap((item) =>
                item.source ? [item.source] : [],
              ),
            )
            .map((item) => [item.id, item]),
        ).values(),
      ]
    : [];
}

export function buildHandoff(state, taskId, acceptance, now = new Date()) {
  if (typeof taskId !== "string" || !taskId.trim() || taskId.length > 160)
    throw new Error("task_id must be a non-empty string (max 160 characters)");
  const capturedAt = now.toISOString();
  const task = (state.tasks ?? []).find((item) => item.id === taskId) ?? null;
  const taskRef = taskSource(task, taskId, capturedAt);
  const verification = verificationSummary(acceptance);
  const refs = [];
  const withSource = (item, sourceRef) => {
    refs.push(sourceRef);
    return { ...item, source: sourceRef };
  };
  const noSource = (status, reason) => ({ status, reason });

  const purposeItems = task
    ? [
        withSource(
          { status: "reported", reported_task_title: task.title },
          taskRef,
        ),
      ]
    : [
        withSource(
          noSource("unknown", "task_not_found"),
          taskRef,
        ),
      ];

  const remainingItems = [];
  if (!task) {
    remainingItems.push(
      withSource(noSource("unknown", "task_not_found"), taskRef),
    );
  } else {
    remainingItems.push(
      withSource(
        {
          status: task.status === "done" ? "reported_done" : "reported_open",
          reported_status: task.status,
          milestone: task.milestone || null,
          blocker: task.blocker || null,
          completion_claim: "dashboard_task_status_only",
        },
        taskRef,
      ),
    );
    if (
      typeof task.next_action === "string" &&
      task.next_action.trim().length > 0
    ) {
      remainingItems.push(
        withSource(
          { status: "reported", reported_next_action: task.next_action },
          taskRef,
        ),
      );
    }
  }

  const constraints = [];
  if (task?.blocker) {
    constraints.push(
      withSource(
        { status: "reported", type: "task_blocker", text: task.blocker },
        taskRef,
      ),
    );
  }
  for (const { id, card } of decisionCards(state, taskId)) {
    const decision = card.snapshot.decision;
    if (!decision.conditions) continue;
    const cardRef = source({
      id: `decision-card:${id}`,
      uri: "dashboard://state",
      selector: { kind: "question_contract", id },
      recordedAt: card.updated_at,
      value: {
        id,
        status: card.status,
        revision: card.revision,
        target: decision.target,
        conditions: decision.conditions,
      },
      capturedAt,
    });
    constraints.push(
      withSource(
        {
          status: "reported",
          type: "task_scoped_decision_condition",
          question_id: id,
          text: decision.conditions,
        },
        cardRef,
      ),
    );
  }
  if (!constraints.length) {
    const scopedCards = decisionCards(state, taskId);
    const constraintSet = scopedCards.map(({ id, card }) => ({
      id,
      status: card.status,
      updated_at: card.updated_at,
      conditions: card.snapshot?.decision?.conditions ?? "",
    }));
    const constraintRef = source({
      id: `constraint-set:${taskId}`,
      uri: "dashboard://state",
      selector: { kind: "task_scoped_decision_conditions", task_id: taskId },
      recordedAt:
        scopedCards.map(({ card }) => card.updated_at).filter(Boolean).sort().at(-1) ??
        task?.updated_at,
      value: { blocker: task?.blocker ?? null, cards: constraintSet },
      capturedAt,
    });
    constraints.push(
      withSource(
        noSource("unknown", "no_task_scoped_constraint_recorded"),
        constraintRef,
      ),
    );
  }

  const decisions = decisionAnswers(state, taskId).map((answer) => {
    const answerRef = source({
      id: `answer:${answer.sequence}`,
      uri: "dashboard://feedback",
      selector: { sequence: answer.sequence },
      recordedAt: answer.created_at,
      value: {
        sequence: answer.sequence,
        question_id: answer.question_id,
        question: answer.question,
        answer: answer.answer,
        choice_id: answer.choice_id ?? null,
        target: answer.target,
        contract_fingerprint: answer.contract_fingerprint ?? null,
        contract_validity: answer.contract_validity ?? "not_typed",
        invalidation_reason: answer.invalidation_reason ?? null,
      },
      capturedAt,
    });
    return withSource(
      {
        status: "reported",
        question_id: answer.question_id,
        question: answer.question,
        answer: answer.answer,
        choice_id: answer.choice_id ?? null,
        contract_validity: answer.contract_validity ?? "not_typed",
        invalidation_reason: answer.invalidation_reason ?? null,
        execution_authorized: false,
      },
      answerRef,
    );
  });
  if (!decisions.length) {
    const decisionSet = (state.feedback ?? [])
      .filter((item) => item.target?.task_id === taskId)
      .map((item) => ({
        sequence: item.sequence,
        question_id: item.question_id,
        created_at: item.created_at,
        answer: item.answer,
      }));
    const decisionRef = source({
      id: `decision-set:${taskId}`,
      uri: "dashboard://feedback",
      selector: { task_id: taskId },
      recordedAt: null,
      value: decisionSet,
      capturedAt,
    });
    decisions.push(
      withSource(
        noSource("unknown", "no_explicit_task_scoped_decision"),
        decisionRef,
      ),
    );
  }

  const artifacts = (state.events ?? [])
    .filter((event) => event.type === "artifact" && event.artifact)
    .sort(bySequence)
    .slice(-25)
    .map((event) => {
      const explicitTaskId = event.task_id ?? event.observation?.task_id ?? null;
      const eventRef = source({
        id: `event:${event.sequence}`,
        uri: "dashboard://state",
        selector: { kind: "event", sequence: event.sequence },
        recordedAt: event.created_at,
        value: {
          sequence: event.sequence,
          type: event.type,
          title: event.title,
          detail: event.detail ?? "",
          artifact: event.artifact,
          task_id: explicitTaskId,
        },
        capturedAt,
      });
      return withSource(
        {
          status: "reference_only",
          title: event.title,
          reference: event.artifact,
          contents: "not_opened",
          task_association:
            explicitTaskId === taskId
              ? "explicitly_linked"
              : explicitTaskId
                ? "linked_to_another_task"
                : "unknown",
        },
        eventRef,
      );
    });
  if (!artifacts.length) {
    const artifactSet = (state.events ?? [])
      .filter((event) => event.type === "artifact" && event.artifact)
      .slice(-25)
      .map((event) => ({
        sequence: event.sequence,
        created_at: event.created_at,
        artifact: event.artifact,
      }));
    const artifactRef = source({
      id: `artifact-set:${taskId}`,
      uri: "dashboard://state",
      selector: { kind: "events", type: "artifact", limit: 25 },
      recordedAt: null,
      value: artifactSet,
      capturedAt,
    });
    artifacts.push(
      withSource(
        noSource("unknown", "no_artifact_reference_recorded"),
        artifactRef,
      ),
    );
  }

  const verificationItems = verification.conditions.map((condition) => {
    const sourceId = `acceptance:${taskId}:${condition.criterion.id}`;
    const sourceRef = source({
      id: sourceId,
      uri: "dashboard://acceptance",
      selector: { task_id: taskId, criterion_id: condition.criterion.id },
      recordedAt: condition.current_target?.observed_at,
      value: {
        acceptance_defined: verification.acceptance_defined,
        criterion: condition.criterion,
        status: condition.status,
        verified_full_check: condition.verified_full_check,
        current_target: condition.current_target
          ? Object.fromEntries(
              Object.entries(condition.current_target).filter(
                ([key]) => key !== "observed_at",
              ),
            )
          : null,
        evidence: condition.evidence,
      },
      capturedAt,
    });
    return withSource(
      {
        status: condition.status,
        criterion: condition.criterion,
        verified_full_check: condition.verified_full_check,
        current_target: condition.current_target,
        evidence: condition.evidence,
      },
      sourceRef,
    );
  });
  if (!verificationItems.length) {
    const acceptanceRef = source({
      id: `acceptance:${taskId}:definition`,
      uri: "dashboard://acceptance",
      selector: { task_id: taskId },
      recordedAt: null,
      value: {
        acceptance_defined: verification.acceptance_defined,
        conditions: [],
      },
      capturedAt,
    });
    verificationItems.push(
      withSource(
        {
          status: "unverified",
          reason: verification.acceptance_defined
            ? "no_acceptance_conditions_returned"
            : "acceptance_criteria_not_defined",
          current_target: null,
          evidence: [],
        },
        acceptanceRef,
      ),
    );
  }
  for (const check of verificationItems.filter(
    (item) => item.verified_full_check !== true,
  )) {
    remainingItems.push({
      status: "verification_unconfirmed",
      type: "acceptance_check",
      criterion: check.criterion ?? null,
      result_status: check.status,
      reason: check.reason ?? "full_check_not_verified",
      source: check.source,
    });
  }

  const nextStepItems = [
    task && typeof task.next_action === "string" && task.next_action.trim()
      ? withSource(
          { status: "reported", text: task.next_action },
          taskRef,
        )
      : task
        ? withSource(
            {
              status: "unknown",
              reason: "no_explicit_next_action_recorded",
            },
            taskRef,
          )
        : withSource(
            noSource("unknown", "task_not_found"),
            taskRef,
          ),
  ];

  return {
    schema: 1,
    packet_id: `handoff_${randomUUID()}`,
    task_id: taskId,
    created_at: capturedAt,
    snapshot_revision: Number.isSafeInteger(state.revision) ? state.revision : 0,
    sections: {
      purpose: {
        status: task ? "reported" : "unknown",
        items: purposeItems,
      },
      remaining: {
        status: task ? "reported" : "unknown",
        items: remainingItems,
      },
      constraints: {
        status: constraints.some((item) => item.status === "reported")
          ? "reported"
          : "unknown",
        items: constraints,
      },
      decisions: {
        status: decisions.some((item) => item.status === "reported")
          ? "reported"
          : "unknown",
        items: decisions,
      },
      deliverables: {
        status: artifacts.some((item) => item.status === "reference_only")
          ? "reference_only"
          : "unknown",
        items: artifacts,
      },
      verification: {
        status: verification.verification_status,
        human_review: verification.human_review,
        production_adoption: verification.production_adoption,
        all_declared_full_checks_pass:
          verification.all_declared_full_checks_pass,
        items: verificationItems,
      },
      next_step: {
        status: nextStepItems[0].status,
        items: nextStepItems,
      },
    },
    source_refs: [...new Map(refs.map((item) => [item.id, item])).values()],
  };
}

export function handoffFreshness(packet, state, acceptance) {
  const current = buildHandoff(state, packet.task_id, acceptance, new Date(packet.created_at));
  const previousRefs = packetSourceRefs(packet);
  const currentRefs = packetSourceRefs(current);
  const previousById = new Map(previousRefs.map((item) => [item.id, item]));
  const currentById = new Map(currentRefs.map((item) => [item.id, item]));
  const staleReferences = [];
  for (const prior of previousRefs) {
    const latest = currentById.get(prior.id);
    if (!latest) {
      staleReferences.push({
        id: prior.id,
        uri: prior.uri,
        selector: prior.selector,
        state: "missing",
        recorded_at: prior.recorded_at,
        current_recorded_at: null,
      });
    } else if (prior.fingerprint !== latest.fingerprint) {
      staleReferences.push({
        id: prior.id,
        uri: prior.uri,
        selector: prior.selector,
        state: "changed",
        recorded_at: prior.recorded_at,
        current_recorded_at: latest.recorded_at,
      });
    }
  }
  const newReferences = currentRefs
    .filter((item) => !previousById.has(item.id))
    .map((item) => ({
      id: item.id,
      uri: item.uri,
      selector: item.selector,
      recorded_at: item.recorded_at,
    }));
  return {
    status: staleReferences.length || newReferences.length ? "stale" : "current",
    created_at: packet.created_at,
    snapshot_revision: packet.snapshot_revision,
    current_revision: Number.isSafeInteger(state.revision) ? state.revision : 0,
    state_revision_changed:
      (Number.isSafeInteger(state.revision) ? state.revision : 0) !==
      packet.snapshot_revision,
    stale_references: staleReferences,
    new_references: newReferences,
  };
}

export function handoffResource(packet, freshness = null) {
  if (!packet)
    return {
      schema: 1,
      status: "unknown",
      reason: "handoff_packet_not_created",
      sections: Object.fromEntries(
        [
          "purpose",
          "remaining",
          "constraints",
          "decisions",
          "deliverables",
          "verification",
          "next_step",
        ].map((key) => [key, { status: "unknown", items: [] }]),
      ),
      source_refs: [],
    };
  return { ...structuredClone(packet), freshness };
}

export function acceptanceHandoffView(inspection) {
  const summary = verificationSummary(inspection);
  return {
    schema: 1,
    task_id: inspection?.task_id ?? null,
    reported_task_status: inspection?.reported_task_status ?? "unknown",
    acceptance_defined: summary.acceptance_defined,
    verification: {
      status: summary.verification_status,
      all_declared_full_checks_pass: summary.all_declared_full_checks_pass,
      human_review: summary.human_review,
      production_adoption: summary.production_adoption,
    },
    conditions: summary.conditions,
    replayed_tests: inspection?.replayed_tests ?? 0,
    permission_expanded: false,
  };
}

export function isHandoffPacket(value) {
  const sectionNames = [
    "purpose",
    "remaining",
    "constraints",
    "decisions",
    "deliverables",
    "verification",
    "next_step",
  ];
  return (
    value !== null &&
    typeof value === "object" &&
    value.schema === 1 &&
    typeof value.packet_id === "string" &&
    typeof value.task_id === "string" &&
    timestamp(value.created_at) !== null &&
    Number.isSafeInteger(value.snapshot_revision) &&
    value.sections !== null &&
    typeof value.sections === "object" &&
    sectionNames.every(
      (name) =>
        value.sections[name] && Array.isArray(value.sections[name].items),
    ) &&
    Array.isArray(value.source_refs) &&
    value.source_refs.every(
      (item) =>
        item &&
        typeof item.id === "string" &&
        [
          "dashboard://state",
          "dashboard://feedback",
          "dashboard://acceptance",
        ].includes(item.uri) &&
        item.selector &&
        typeof item.selector === "object" &&
        timestamp(item.captured_at) !== null &&
        /^[0-9a-f]{64}$/.test(item.fingerprint),
    )
  );
}
