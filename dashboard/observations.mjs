// Shared by the store and browser. Reported provenance is data, not verification.
export const observationKinds = [
  "measured",
  "agent_reported",
  "estimated",
  "unavailable",
];
export const defaultMaxAgeSeconds = 15 * 60;
export const observationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { enum: observationKinds },
    observed_at: { type: ["string", "null"], format: "date-time" },
    source: { type: "string", minLength: 1, maxLength: 500 },
    session_id: { type: "string", minLength: 1, maxLength: 160 },
    reference: { type: "string", minLength: 1, maxLength: 2000 },
    max_age_seconds: { type: "integer", minimum: 1, maximum: 604800 },
  },
};
const labels = {
  measured: "実測",
  agent_reported: "agent報告",
  estimated: "推定",
  unavailable: "未取得",
};
function optionalText(value, key, max) {
  if (value === undefined) return null;
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`Invalid observation ${key}`);
  return value;
}
function timestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    throw new Error("Invalid observation observed_at; use an RFC3339 timestamp");
  const time = Date.parse(value);
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const [hour, minute, second] = value.slice(11, 19).split(":").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    !Number.isFinite(time) ||
    month < 1 || month > 12 || day < 1 || day > days[month - 1] ||
    hour > 23 || minute > 59 || second > 59
  )
    throw new Error("Invalid observation observed_at");
  return time;
}
export function normalizeObservation(
  input = {},
  { now = Date.now(), sessionId = null, reference = null } = {},
) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Expected an observation object");
  if (
    Object.keys(input).some(
      (key) => !Object.hasOwn(observationSchema.properties, key),
    )
  )
    throw new Error("Unknown observation field");
  const kind = input.kind === undefined ? "agent_reported" : input.kind;
  if (!observationKinds.includes(kind)) throw new Error("Invalid observation kind");
  const observed = input.observed_at == null ? null : timestamp(input.observed_at);
  if (observed !== null && observed > now)
    throw new Error("Observation observed_at must not be in the future");
  const source = optionalText(input.source, "source", 500);
  if (kind === "measured" && (observed === null || source === null))
    throw new Error("Measured observations require observed_at and source");
  const maxAge = input.max_age_seconds === undefined
    ? defaultMaxAgeSeconds
    : input.max_age_seconds;
  if (!Number.isInteger(maxAge) || maxAge < 1 || maxAge > 604800)
    throw new Error("Invalid observation max_age_seconds");
  const reportedSession = optionalText(input.session_id, "session_id", 160);
  if (sessionId && reportedSession && sessionId !== reportedSession)
    throw new Error("Observation session_id does not match the reported session");
  return {
    kind,
    observed_at: observed === null ? null : new Date(observed).toISOString(),
    recorded_at: new Date(now).toISOString(),
    source,
    session_id: reportedSession ?? sessionId,
    reference: optionalText(input.reference, "reference", 2000) ?? reference,
    max_age_seconds: maxAge,
  };
}
export function observationView(value, observation, now = Date.now()) {
  const available = value !== null && value !== undefined;
  const kind = available ? observation?.kind ?? null : "unavailable";
  let freshness = "unknown";
  const observed = Date.parse(observation?.observed_at);
  const maxAge = observation?.max_age_seconds;
  if (!available || kind === "unavailable") freshness = "unavailable";
  else if (
    observationKinds.includes(kind) &&
    Number.isFinite(observed) && observed <= now &&
    Number.isInteger(maxAge) && maxAge > 0
  )
    freshness = now >= observed + maxAge * 1000 ? "stale" : "fresh";
  return {
    value,
    kind,
    label: labels[kind] ?? "出所未確認",
    freshness,
    current: freshness === "fresh",
    observation: observation ?? null,
  };
}
export function metricView(state, key, now = Date.now()) {
  return observationView(state.metrics[key], state.metric_observations?.[key], now);
}
export function ratioView(state, numerator, denominator, now = Date.now()) {
  const a = metricView(state, numerator, now),
    b = metricView(state, denominator, now);
  if (!a.current || !b.current)
    return { value: null, reason: "unavailable" };
  // Ratios must use one reported snapshot, not unrelated partial updates.
  if (!a.observation.report_id || a.observation.report_id !== b.observation.report_id)
    return { value: null, reason: "incompatible" };
  return {
    value: b.value === 0 ? null : a.value / b.value,
    reason: b.value === 0 ? "zero_denominator" : null,
  };
}
