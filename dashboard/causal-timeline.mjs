// Read-only correlations. Shared task/run identity is not a causal edge.
import { createHash } from "node:crypto";
import { RunHistory } from "./run-history.mjs";
import { AcceptanceStore } from "./acceptance.mjs";
import { AnswerApplicationServer } from "./answer-application-server.mjs";
import { feedbackValidity } from "./question-contracts.mjs";

export const timelineStages = Object.freeze([
  "instruction",
  "receipt",
  "execution",
  "test",
  "question",
  "answer",
  "application",
]);
const stageLabels = {
  instruction: "指示",
  receipt: "受領",
  execution: "入力実行",
  test: "試験",
  question: "質問",
  answer: "回答",
  application: "回答適用",
};
const stable = (...parts) =>
  "tl_" +
  createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
const values = (object) => Object.values(object || {});
const instant = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const latest = (rows, maximum) => rows.slice(-maximum);
const summary = (text) => String(text || "").slice(0, 160);
function questionRecipient(state, question) {
  const decision =
    state.question_contracts?.cards[question.id]?.snapshot.decision;
  const consumer =
    state.answer_applications?.consumers?.[decision?.consumer_id];
  return consumer &&
    decision.target?.run_id === consumer.run_id &&
    decision.target?.session_id === consumer.session_id &&
    (decision.target?.task_id === null ||
      decision.target?.task_id === consumer.task_id)
    ? consumer.consumer_id
    : null;
}

export function timelineProjection(state, consumer, sources = {}) {
  const nodes = [],
    links = [],
    issues = [];
  const traceId = stable(state.project.id, consumer?.consumer_id || "unlinked");
  const add = (stage, kind, sourceId, at, status, raw, note = null) => {
    const id = stable(state.project.id, kind, sourceId);
    if (!nodes.some((node) => node.id === id))
      nodes.push({
        id,
        stage,
        kind,
        source_id: sourceId,
        at: instant(at) ? at : null,
        status,
        note,
        raw: structuredClone(raw),
      });
    return id;
  };
  const link = (from, to, basis) => {
    links.push({ id: stable(from, to, basis), from, to, basis });
    const a = nodes.find((node) => node.id === from),
      b = nodes.find((node) => node.id === to);
    if (a?.at && b?.at && Date.parse(a.at) > Date.parse(b.at))
      issues.push({
        code: "out_of_order",
        node_id: to,
        message: "記録時刻が前後しています。受信順から因果順を補っていません。",
      });
  };
  const unknown = (code, nodeId, message) =>
    issues.push({ code, node_id: nodeId, message });
  if (!consumer) {
    if (
      (state.events || []).length > 100 ||
      (state.questions || []).filter(
        (question) => !questionRecipient(state, question),
      ).length > 100
    )
      unknown(
        "window_limited",
        null,
        "相関のない報告・質問の最新100記録を表示しています。省略区間は未確認です。",
      );
    for (const event of latest(state.events || [], 100))
      add(
        "execution",
        "reported_event",
        String(event.sequence),
        event.created_at,
        "reported",
        event,
        "相関IDのない報告です。実行成功の証拠には接続していません。",
      );
    for (const question of latest(
      (state.questions || []).filter(
        (question) => !questionRecipient(state, question),
      ),
      100,
    )) {
      add(
        "question",
        "unlinked_question",
        question.id,
        question.created_at,
        "uncorrelated",
        question,
      );
    }
    unknown(
      "unlinked_sources",
      null,
      "相関IDのない報告・質問です。近い時刻や似た文章から実行へ結び付けていません。",
    );
  } else {
    const requests = values(state.instructions?.requests).filter(
      (request) => request.consumer_id === consumer.consumer_id,
    );
    const commands = [
      ...values(state.instructions?.commands),
      ...values(state.answer_applications?.commands),
    ].filter((command) => command.consumer_id === consumer.consumer_id);
    const requestMap = new Map(
      requests.map((request) => [request.command_id, request]),
    );
    const feedback = new Map(
      (state.feedback || []).map((message) => [
        message.reply_command_id,
        message,
      ]),
    );
    const includedQuestions = new Map();
    for (const question of state.questions || []) {
      const card = state.question_contracts?.cards[question.id];
      if (questionRecipient(state, question) === consumer.consumer_id)
        includedQuestions.set(question.id, { question, card });
    }
    if (
      commands.length > 100 ||
      requests.length > 100 ||
      includedQuestions.size > 100
    )
      unknown(
        "window_limited",
        null,
        "この実行の最新100入力・100質問を表示しています。省略区間は未確認です。",
      );
    for (const request of latest(requests, 100))
      add(
        "instruction",
        "instruction",
        request.command_id,
        request.created_at,
        request.status,
        request,
      );
    for (const command of latest(commands, 100)) {
      const exactTarget =
        command.project_id === state.project.id &&
        command.run_id === consumer.run_id &&
        command.session_id === consumer.session_id;
      let input = null;
      if (command.source_kind === "instruction") {
        const request = requestMap.get(command.command_id);
        if (
          request &&
          request.run_id === command.run_id &&
          request.session_id === command.session_id
        )
          input = add(
            "instruction",
            "instruction",
            command.command_id,
            request.created_at,
            request.status,
            request,
          );
      } else {
        const message = feedback.get(command.command_id);
        const exactAnswer =
          message &&
          message.question_id === command.question_id &&
          message.contract_revision === command.contract_revision &&
          message.contract_fingerprint === command.contract_fingerprint &&
          message.sequence === command.feedback_sequence &&
          message.consumer_id === consumer.consumer_id;
        if (exactAnswer) {
          const questionId = add(
            "question",
            "question_revision",
            [
              message.question_id,
              message.contract_revision,
              message.contract_fingerprint,
            ],
            null,
            "recorded_revision",
            {
              question_id: message.question_id,
              question: message.question,
              contract_revision: message.contract_revision,
              contract_fingerprint: message.contract_fingerprint,
              decision: message.decision,
            },
            "保存された回答が参照する質問revisionです。質問の観測時刻はこの回答から補っていません。",
          );
          const validity = feedbackValidity(state, message).contract_validity;
          input = add(
            "answer",
            "answer",
            command.command_id,
            message.created_at,
            validity,
            message,
          );
          link(questionId, input, "exact_question_revision_and_feedback");
          if (validity !== "current")
            unknown(
              "invalidated_answer",
              input,
              "旧質問revisionへの回答です。現行条件の完了を意味しません。",
            );
          const change = (state.changes || []).find(
            (event) => event.eventId === command.answer_event_id,
          );
          if (
            change?.name === "dashboard.answer.created" &&
            change.data?.entity_id === command.question_id
          ) {
            const eventId = add(
              "answer",
              "dashboard_change",
              change.eventId,
              change.timestamp,
              "recorded",
              change,
            );
            link(input, eventId, "exact_answer_event_id");
          } else
            unknown(
              "answer_event_missing",
              input,
              "元の回答eventがありません。保存済み回答のIDからevent内容を再生成していません。",
            );
        }
      }
      if (!input || !exactTarget) {
        const id = add(
          command.source_kind === "instruction" ? "instruction" : "answer",
          "unconfirmed_input",
          command.command_id,
          command.saved_at,
          "unknown",
          command,
        );
        unknown(
          "input_binding_unconfirmed",
          id,
          "入力と対象run/sessionの完全な相関が確認できません。",
        );
        continue;
      }
      if (command.read_at) {
        const received = add(
          "receipt",
          "consumer_read",
          command.command_id,
          command.read_at,
          "recorded",
          {
            command_id: command.command_id,
            consumer_id: command.consumer_id,
            run_id: command.run_id,
            session_id: command.session_id,
            read_at: command.read_at,
          },
          "consumerの読取記録です。native実行成功を示す記録ではありません。",
        );
        link(input, received, "exact_input_command_id");
      } else
        unknown("receipt_unknown", input, "対象consumerの受領は未確認です。");
      const proof = sources.proofFor?.(command) || null;
      if (command.native_command_id) {
        const native = sources.history?.commands?.get(
          command.native_command_id,
        );
        const execution = add(
          command.source_kind === "instruction" ? "execution" : "application",
          "native_input",
          command.native_command_id,
          proof?.at || command.started_at,
          proof ? proof.phase : "unknown",
          {
            command_id: command.command_id,
            native_command_id: command.native_command_id,
            attempt_id: command.attempt_id,
            run_id: command.run_id,
            session_id: command.session_id,
            phase: command.phase,
            proof,
            native: native ? { ...native } : null,
          },
          proof
            ? "相関・owner・入力hashを照合したACP入力処理の結果です。taskや受入検証の完了とは別です。"
            : "beginは送信前の永続intentです。native結果の完全な証拠がなく、実行成功は未確認です。",
        );
        if (proof) {
          link(input, execution, "verified_native_owner_session_input_hash");
          if (proof.phase === "failed")
            unknown(
              "native_input_failed",
              execution,
              "ACP入力処理の失敗が記録されています。task全体の結果は別途確認してください。",
            );
        } else
          unknown(
            "native_result_unconfirmed",
            execution,
            "native commandのIDだけでは実行成功を確定できません。",
          );
      } else
        unknown(
          "execution_unknown",
          input,
          "nativeへの送信・処理結果は未確認です。",
        );
    }
    for (const { question, card } of latest(
      [...includedQuestions.values()],
      100,
    ))
      add(
        "question",
        "current_question",
        [question.id, card.revision, card.fingerprint],
        question.created_at,
        card.status,
        { question, contract: card },
        "同じconsumerを明示した質問です。どの指示・試験が原因かは未記録です。",
      );
    if (sources.acceptance) {
      for (const condition of sources.acceptance.conditions) {
        if (condition.evidence.length > 20)
          unknown(
            "test_window_limited",
            null,
            "受入条件ごとの最新20試験記録を表示しています。省略区間は未確認です。",
          );
        for (const record of latest(condition.evidence, 20))
          add(
            "test",
            "acceptance_evidence",
            record.evidence_id,
            record.finished_at || record.started_at,
            record.scope === "full" && record.eligible_pass
              ? "current_full_pass"
              : "unverified",
            {
              evidence_id: record.evidence_id,
              task_id: record.task_id,
              criterion_id: record.criterion_id,
              scope: record.scope,
              source: record.source,
              status: record.status,
              phase: record.phase,
              freshness: record.freshness,
              command_integrity: record.command_integrity,
              eligible_pass: record.eligible_pass,
              started_at: record.started_at,
              finished_at: record.finished_at,
            },
            "task IDが同じ試験記録です。個々の指示/native入力との因果は未記録です。",
          );
      }
      if (!sources.acceptance.verification?.all_declared_full_checks_pass)
        unknown(
          "current_full_test_unknown",
          null,
          "現在のコードに対する全体試験の成功は未確認です。",
        );
    } else
      unknown(
        "test_source_unknown",
        null,
        "対象taskの試験記録を取得できません。",
      );
    unknown(
      "cross_stage_causality_unknown",
      null,
      "実行→試験→質問の因果IDは未記録です。同じtask/runや時刻の近さから矢印を作っていません。",
    );
    if (sources.historyError)
      unknown(
        "native_history_unavailable",
        null,
        "native台帳が欠落・破損・不完全です。実行結果の証拠として使っていません。",
      );
  }
  const stages = timelineStages.map((stage) => ({
    stage,
    count: nodes.filter((node) => node.stage === stage).length,
    unknown: nodes.filter(
      (node) =>
        node.stage === stage &&
        ["unknown", "unverified", "uncorrelated"].includes(node.status),
    ).length,
  }));
  for (const stage of stages)
    if (!stage.count)
      unknown(
        "stage_unknown",
        null,
        `${stageLabels[stage.stage]}: この区間の相関記録がありません。`,
      );
  return {
    trace_id: traceId,
    context: consumer
      ? {
          consumer_id: consumer.consumer_id,
          run_id: consumer.run_id,
          session_id: consumer.session_id,
          task_id: consumer.task_id,
        }
      : null,
    title: consumer
      ? summary(consumer.task_id || consumer.run_id)
      : "相関のない報告・質問",
    stages,
    nodes,
    links,
    issues,
    replayed_commands: 0,
    execution_authorized: false,
  };
}

export async function readCausalTimeline(
  project,
  state,
  { after = 0, limit = 10, trace_id = null } = {},
) {
  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 20 ||
    (trace_id !== null && !/^tl_[0-9a-f]{32}$/.test(trace_id))
  )
    throw Object.assign(new Error("Invalid timeline page or ID"), {
      status: 400,
    });
  const consumers = values(state.answer_applications?.consumers).sort((a, b) =>
    a.consumer_id.localeCompare(b.consumer_id),
  );
  const hasUnlinked =
    (state.events || []).length ||
    (state.questions || []).some(
      (question) => !questionRecipient(state, question),
    );
  const all = [...consumers, ...(hasUnlinked ? [null] : [])];
  const selected =
    trace_id === null
      ? all.slice(after, after + limit)
      : all.filter(
          (consumer) =>
            stable(state.project.id, consumer?.consumer_id || "unlinked") ===
            trace_id,
        );
  if (trace_id && selected.length !== 1)
    throw Object.assign(new Error("Timeline not found"), { status: 404 });
  const authority = new AnswerApplicationServer(
    project,
    () => state,
    () => {
      throw new Error("Read-only timeline");
    },
  );
  let history = null,
    historyError = null;
  try {
    history = await new RunHistory(project).read();
  } catch (error) {
    historyError = error.code || "history_unavailable";
  }
  if (history?.tail_bytes) historyError = "incomplete_history_tail";
  const acceptance = new Map();
  const traces = [];
  for (const consumer of selected) {
    let checks = null;
    if (consumer?.task_id) {
      if (!acceptance.has(consumer.task_id)) {
        try {
          acceptance.set(
            consumer.task_id,
            await (
              await AcceptanceStore.open(project)
            ).inspect(consumer.task_id),
          );
        } catch {
          acceptance.set(consumer.task_id, null);
        }
      }
      checks = acceptance.get(consumer.task_id);
    }
    const trace = timelineProjection(state, consumer, {
      history,
      historyError,
      acceptance: checks,
      proofFor: (command) =>
        history && !historyError ? authority.proof(command, history) : null,
    });
    traces.push(
      trace_id ? trace : { ...trace, nodes: undefined, links: undefined },
    );
  }
  return {
    schema: 1,
    project_id: project.id,
    state_revision: state.revision,
    history_revision: history?.events.length ?? null,
    history_complete: Boolean(history && !historyError),
    observed_at: new Date().toISOString(),
    traces,
    total: all.length,
    next:
      trace_id || after + selected.length >= all.length
        ? null
        : after + selected.length,
    notice:
      "各台帳の読取時点は独立しています。受信・intent・ACP結果・試験を分け、未知の区間は補完していません。",
    replayed_commands: 0,
  };
}
