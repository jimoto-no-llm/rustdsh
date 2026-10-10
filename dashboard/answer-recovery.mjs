// Browser drafts and request locks outlive card replacement. Reading or
// reconciling this state never sends an answer.
const locked = (entry) => ["sending", "checking"].includes(entry.phase);
const hasContent = (entry) => Boolean(entry.text || entry.choice || entry.submitted);
const questionKey = (question, contract) => JSON.stringify(contract
  ? ["contract", question.id, question.created_at]
  : [question.id, question.created_at, question.question, question.default_action]);
const sameVersion = (left, right) => left?.fingerprint === right?.fingerprint && left?.revision === right?.revision;
export function questionEditable(contract, now = Date.now()) {
  return !contract || (contract.status === "open" &&
    (!contract.snapshot.decision.expires_at || Date.parse(contract.snapshot.decision.expires_at) > now));
}
export function draftReviewState(draft, contract) {
  const changedDraft = Boolean(draft?.fingerprint && !sameVersion(draft, contract));
  return { changedDraft, reviewRequired: changedDraft &&
    (draft.reviewed !== contract?.fingerprint || draft.reviewedRevision !== contract?.revision) };
}

export function createQuestionRecovery(projectId, { read, write, onStorageError = () => {} } = {}) {
  const entries = new Map();
  const storageKey = "rdsh_project_drafts_v1:" + projectId;
  let storageValid = true, reads = 0, latestState = null;
  const validString = (value, max) => typeof value === "string" && value.length <= max;
  const optionalString = (value, max) => value == null || validString(value, max);
  const validRevision = (value) => value == null || (Number.isSafeInteger(value) && value > 0);
  try {
    const saved = read?.(storageKey);
    if (saved) {
      const records = JSON.parse(saved);
      if (!Array.isArray(records)) throw new Error("Invalid drafts");
      for (const record of records) {
        // An 8000-character question and 2000-character default action can
        // expand sixfold when encoded into a JSON identity (e.g. controls).
        if (!record || !validString(record.key, 64 * 1024) || !validString(record.id, 160) ||
            !validString(record.question, 8000) || !validString(record.draft, 8000) ||
            typeof record.uncertain !== "boolean" || !optionalString(record.choice, 160) ||
            !optionalString(record.fingerprint, 1000) || !validRevision(record.revision) ||
            !optionalString(record.reviewed, 1000) || !validRevision(record.reviewedRevision) ||
            !optionalString(record.seenFingerprint, 1000) || !validRevision(record.seenRevision) ||
            (record.submitted && (!validString(record.submitted.answer, 8000) ||
              !optionalString(record.submitted.choice_id, 160) ||
              !optionalString(record.submitted.contract_fingerprint, 1000) ||
              !validRevision(record.submitted.expected_revision)))) throw new Error("Invalid draft");
      }
      for (const record of records) entries.set(record.key, {
        key: record.key, id: record.id, question: record.question, text: record.draft,
        choice: record.choice ?? null, fingerprint: record.fingerprint ?? null,
        revision: record.revision ?? null, reviewed: record.reviewed ?? null,
        reviewedRevision: record.reviewedRevision ?? null,
        seenFingerprint: record.seenFingerprint ?? record.fingerprint ?? null,
        seenRevision: record.seenRevision ?? record.revision ?? null,
        submitted: record.submitted ?? null,
        phase: record.uncertain ? "checking" : "idle", checkAfter: 0, attempt: 0,
      });
    }
  } catch {
    storageValid = false;
    onStorageError();
  }
  function save() {
    if (!storageValid) return;
    try {
      write?.(storageKey, JSON.stringify([...entries.values()].filter(hasContent).map((entry) => ({
        key: entry.key, id: entry.id, question: entry.question, draft: entry.text,
        uncertain: locked(entry), choice: entry.choice, fingerprint: entry.fingerprint,
        revision: entry.revision, reviewed: entry.reviewed, reviewedRevision: entry.reviewedRevision,
        seenFingerprint: entry.seenFingerprint, seenRevision: entry.seenRevision,
        submitted: entry.submitted,
      }))));
    } catch { onStorageError(); }
  }
  function draftFor(question, contract) {
    const key = questionKey(question, contract);
    if (!entries.has(key)) entries.set(key, {
      key, id: question.id, question: question.question, text: "", choice: null,
      fingerprint: contract?.fingerprint ?? null, revision: contract?.revision ?? null,
      reviewed: null, reviewedRevision: null,
      seenFingerprint: contract?.fingerprint ?? null, seenRevision: contract?.revision ?? null,
      phase: "idle", checkAfter: 0, attempt: 0, submitted: null,
    });
    return entries.get(key);
  }
  function reconcile(state, readNumber = 0) {
    if (latestState && state.revision < latestState.revision) return false;
    latestState = state;
    const questions = new Map(state.questions.map((question) => [question.id, question]));
    for (const [key, entry] of entries) {
      const question = questions.get(entry.id);
      const contract = state.question_contracts?.cards[entry.id];
      if (!question || questionKey(question, contract) !== key) {
        entry.phase = "conflict";
        continue;
      }
      const expected = entry.submitted || {
        answer: entry.text.trim() ? entry.text : contract?.snapshot.decision.choices.find((choice) => choice.id === entry.choice)?.label,
        expected_revision: entry.reviewedRevision ?? entry.revision,
        contract_fingerprint: entry.reviewed ?? entry.fingerprint,
        choice_id: entry.choice,
      };
      if (question.answer != null && question.answer === expected.answer &&
          (!contract || (contract.revision === expected.expected_revision &&
            contract.fingerprint === expected.contract_fingerprint &&
            (contract.answer?.choice_id ?? null) === (expected.choice_id ?? null)))) {
        entries.delete(key);
        continue;
      }
      if (contract && (entry.seenFingerprint !== contract.fingerprint || entry.seenRevision !== contract.revision)) {
        entry.choice = null;
        entry.reviewed = null;
        entry.reviewedRevision = null;
        entry.seenFingerprint = contract.fingerprint;
        entry.seenRevision = contract.revision;
      }
      if (question.answer !== null || !questionEditable(contract)) entry.phase = "conflict";
      else if (entry.phase === "conflict") entry.phase = "idle";
      else if (entry.phase === "checking" && readNumber > entry.checkAfter) entry.phase = "retry";
    }
    save();
    return true;
  }
  function change(entry, values) {
    if (entries.get(entry.key) !== entry || locked(entry) || entry.phase === "conflict") return;
    Object.assign(entry, values);
    if ("text" in values || "choice" in values) {
      entry.submitted = null;
      if (entry.phase === "retry") entry.phase = "idle";
    }
    save();
  }
  function beginSend(question, contract) {
    const entry = draftFor(question, contract);
    if (locked(entry) || entry.phase === "conflict" || !questionEditable(contract) ||
        draftReviewState(entry, contract).reviewRequired) return null;
    if (latestState) {
      const current = latestState.questions.find((item) => item.id === question.id);
      const currentContract = latestState.question_contracts?.cards[question.id];
      if (!current || current.answer !== null || questionKey(current, currentContract) !== entry.key ||
          (contract && !sameVersion(contract, currentContract)) || !questionEditable(currentContract)) return null;
    }
    const choice = contract?.snapshot.decision.choices.find((item) => item.id === entry.choice);
    if (entry.choice && !choice) return null;
    const answer = entry.text.trim() ? entry.text : choice?.label;
    if (!answer) return null;
    const payload = { id: question.id, answer,
      ...(contract ? { expected_revision: contract.revision, contract_fingerprint: contract.fingerprint,
        choice_id: entry.choice } : {}) };
    entry.phase = "sending";
    entry.submitted = { ...payload };
    entry.attempt++;
    save();
    return { entry, payload, attempt: entry.attempt };
  }
  function checkResult(operation) {
    const { entry, attempt } = operation;
    if (entries.get(entry.key) !== entry || entry.attempt !== attempt || entry.phase !== "sending") return false;
    entry.phase = "checking";
    entry.checkAfter = reads;
    save();
    return true;
  }
  function discard(entry) {
    if (entries.get(entry.key) !== entry || locked(entry)) return;
    entries.delete(entry.key);
    save();
  }
  return { draftFor, reconcile, change, beginSend, checkResult, discard,
    beginRead: () => ++reads,
    hasDrafts: () => [...entries.values()].some(hasContent),
    retained: () => [...entries.values()].filter((entry) => entry.phase === "conflict" && hasContent(entry)),
  };
}
