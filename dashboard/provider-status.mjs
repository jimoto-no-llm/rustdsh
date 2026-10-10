import { defaultMaxAgeSeconds, normalizeObservation, observationView } from "./observations.mjs";

export const providerStatusKinds = [
  "rate_limited",
  "quota_exhausted",
  "authentication_failed",
  "unknown",
];
const identifier = { type: "string", minLength: 1, maxLength: 80 };
const safeCode = { type: "string", minLength: 1, maxLength: 128 };
export const providerStatusSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    provider_id: { ...identifier, pattern: "^[a-z0-9][a-z0-9._-]{0,47}$" },
    scope_id: { ...identifier, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$" },
    status: { enum: providerStatusKinds },
    kind: { enum: ["agent_reported"] },
    reason_code: { ...safeCode, type: ["string", "null"], pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$" },
    event_id: { ...safeCode, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
    sequence: { type: "integer", minimum: 1 },
    quota: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        remaining: { type: ["number", "null"], minimum: 0 },
        limit: { type: ["number", "null"], minimum: 0 },
        unit: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,23}$" },
      },
      required: ["remaining", "limit", "unit"],
    },
    retry_after: { type: ["string", "null"], format: "date-time" },
    observed_at: { type: "string", format: "date-time" },
    source: {
      type: "string",
      minLength: 1,
      maxLength: 80,
      pattern: "^[a-z][a-z0-9._:-]{0,79}$",
    },
    reference: {
      type: ["string", "null"],
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
    },
    max_age_seconds: { type: "integer", minimum: 1, maximum: 604800 },
  },
  required: [
    "provider_id",
    "scope_id",
    "status",
    "event_id",
    "sequence",
    "observed_at",
    "source",
  ],
};

const storedKeys = new Set([...Object.keys(providerStatusSchema.properties), "recorded_at"]);
const inputKeys = new Set(Object.keys(providerStatusSchema.properties));
const providerIdPattern = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const scopeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const codePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const sourcePattern = /^[a-z][a-z0-9._:-]{0,79}$/;
const unitPattern = /^[a-z][a-z0-9_-]{0,23}$/;
const maxRetryDelayMs = 30 * 24 * 60 * 60 * 1000;
const maxProviderStatuses = 64;

function safeString(value, pattern, label, max) {
  if (typeof value !== "string" || value.length > max || !pattern.test(value))
    throw new Error(`Invalid provider status ${label}`);
  return value;
}

function normalizeQuota(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid provider status quota");
  if (Object.keys(value).some((key) => !["remaining", "limit", "unit"].includes(key)))
    throw new Error("Unknown provider status quota field");
  if (!("remaining" in value) || !("limit" in value) || !("unit" in value))
    throw new Error("Provider status quota requires remaining, limit and unit");
  for (const key of ["remaining", "limit"]) {
    const amount = value[key];
    if (amount !== null && (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0))
      throw new Error(`Invalid provider status quota ${key}`);
  }
  if (value.remaining === null && value.limit === null)
    throw new Error("Provider status quota needs a reported amount");
  const unit = safeString(value.unit, unitPattern, "quota unit", 24);
  if (value.remaining !== null && value.limit !== null && value.remaining > value.limit)
    throw new Error("Provider status quota remaining exceeds its limit");
  return { remaining: value.remaining, limit: value.limit, unit };
}

function safeTimestamp(value, label, now) {
  const probe = normalizeObservation({
    kind: "agent_reported",
    observed_at: value,
    source: "provider retry hint",
  }, { now });
  if (!probe.observed_at) throw new Error(`Invalid provider status ${label}`);
  return probe.observed_at;
}

export function normalizeProviderStatus(input, { now = Date.now() } = {}) {
  if (!Number.isFinite(now)) throw new Error("Invalid provider status clock");
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Expected a provider status object");
  if (Object.keys(input).some((key) => !inputKeys.has(key)))
    throw new Error("Unknown provider status field");

  const providerId = safeString(input.provider_id, providerIdPattern, "provider_id", 48);
  const scopeId = safeString(input.scope_id, scopeIdPattern, "scope_id", 80);
  if (!providerStatusKinds.includes(input.status))
    throw new Error("Invalid provider status status");
  const kind = input.kind ?? "agent_reported";
  if (kind !== "agent_reported")
    throw new Error("Provider status reports must be agent-reported until a trusted adapter exists");
  const eventId = safeString(input.event_id, codePattern, "event_id", 128);
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1)
    throw new Error("Invalid provider status sequence");
  const source = safeString(input.source, sourcePattern, "source", 80);
  const reference = input.reference === undefined || input.reference === null
    ? null
    : safeString(input.reference, codePattern, "reference", 128);
  const observationInput = {
    kind,
    observed_at: input.observed_at,
    source,
    max_age_seconds: input.max_age_seconds ?? defaultMaxAgeSeconds,
  };
  if (reference !== null) observationInput.reference = reference;
  const observation = normalizeObservation(observationInput, { now });
  const quota = normalizeQuota(input.quota);
  if (input.status === "quota_exhausted" && quota?.remaining > 0)
    throw new Error("Exhausted provider quota cannot report remaining quota");

  let retryAfter = null;
  if (input.retry_after !== undefined && input.retry_after !== null) {
    retryAfter = safeTimestamp(input.retry_after, "retry_after", Date.parse(input.retry_after) + 1);
    const observed = Date.parse(observation.observed_at);
    const retry = Date.parse(retryAfter);
    if (retry < observed || retry > observed + maxRetryDelayMs)
      throw new Error("Provider retry_after must follow the observation within 30 days");
    if (!["rate_limited", "quota_exhausted"].includes(input.status))
      throw new Error("Only rate limits or exhausted quota may include retry_after");
  }

  return {
    provider_id: providerId,
    scope_id: scopeId,
    status: input.status,
    kind: observation.kind,
    reason_code: input.reason_code === undefined || input.reason_code === null
      ? null
      : safeString(input.reason_code, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/, "reason_code", 80),
    event_id: eventId,
    sequence: input.sequence,
    quota,
    retry_after: retryAfter,
    observed_at: observation.observed_at,
    recorded_at: new Date(now).toISOString(),
    source,
    reference: observation.reference,
    max_age_seconds: observation.max_age_seconds,
  };
}

export function validateProviderStatuses(value) {
  if (value.provider_statuses === undefined) return;
  const statuses = value.provider_statuses;
  if (!Array.isArray(statuses) || statuses.length > maxProviderStatuses)
    throw new Error("Invalid provider status state");
  const seen = new Set();
  for (const stored of statuses) {
    if (!stored || typeof stored !== "object" || Array.isArray(stored))
      throw new Error("Invalid provider status state record");
    if (Object.keys(stored).some((key) => !storedKeys.has(key)))
      throw new Error("Unknown provider status state field");
    const received = Date.parse(stored.recorded_at);
    if (!Number.isFinite(received) || new Date(received).toISOString() !== stored.recorded_at)
      throw new Error("Invalid provider status recorded_at");
    const { recorded_at, ...input } = stored;
    const normalized = normalizeProviderStatus(input, { now: received });
    if (normalized.recorded_at !== recorded_at)
      throw new Error("Invalid provider status recorded_at");
    const key = JSON.stringify([stored.provider_id, stored.scope_id]);
    if (seen.has(key)) throw new Error("Duplicate provider status scope");
    seen.add(key);
  }
}

export function providerStatusView(record, now = Date.now()) {
  const observation = {
    kind: record.kind,
    observed_at: record.observed_at,
    max_age_seconds: record.max_age_seconds,
  };
  const freshness = observationView(record.status, observation, now).freshness;
  const labels = {
    rate_limited: "利用制限",
    quota_exhausted: "利用枠不足",
    authentication_failed: "認証失敗",
    unknown: "理由不明",
  };
  let nextAction = "新しいprovider観測を待ちます。";
  let retryMessage = "再試行時刻は提供されていません。";
  if (freshness === "stale") {
    nextAction = "前回の状態は期限切れです。現在の状態は未確認です。";
    retryMessage = "期限切れの再試行情報は表示しません。";
  } else if (freshness !== "fresh") {
    nextAction = "現在のprovider状態は確認できません。";
  } else if (record.status === "authentication_failed") {
    nextAction = "認証状態を手動で確認してください。自動再ログインは行いません。";
  } else if (record.status === "quota_exhausted") {
    nextAction = "provider側の利用枠を確認してください。再ログインは必要と判断できません。";
  } else if (record.status === "rate_limited") {
    nextAction = "providerの再試行条件を確認してください。自動再試行は行いません。";
  }
  if (freshness === "fresh" && record.retry_after) {
    const retry = Date.parse(record.retry_after);
    retryMessage = retry > now
      ? `providerが示した再試行時刻: ${new Date(retry).toLocaleString("ja-JP")}`
      : "providerの再試行時刻を過ぎています。利用可能とは確認されていません。";
  }
  const quota = record.quota
    ? `残り ${record.quota.remaining ?? "未取得"} / 上限 ${record.quota.limit ?? "未取得"} ${record.quota.unit}`
    : "利用枠の数値は未提供です。";
  return {
    label: labels[record.status],
    freshness,
    freshnessLabel: freshness === "fresh" ? "有効な観測" : freshness === "stale" ? "期限切れ" : freshness === "unavailable" ? "未取得" : "出所未確認",
    nextAction,
    retryMessage,
    quota,
    observedLabel: new Date(record.observed_at).toLocaleString("ja-JP"),
  };
}

export const maxProviderStatusesPerProject = maxProviderStatuses;
