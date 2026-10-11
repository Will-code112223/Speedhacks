// READ ONLY: node --env-file=/secure/path/dial.env src/integrations/dial/check-account.mts
// Never print the raw account: it contains identity and key-preview fields.
const key = process.env.DIAL_API_KEY;
if (!key || key.length > 4096 || !/^[\x21-\x7e]+$/.test(key)) {
  throw new Error("Configure a valid DIAL_API_KEY before checking the account.");
}
const requestedCap = process.env.DIAL_MAX_CALL_DURATION_SECONDS === undefined
  ? 300 : Number(process.env.DIAL_MAX_CALL_DURATION_SECONDS);
if (!Number.isInteger(requestedCap) || requestedCap < 60 || requestedCap > 3600) {
  throw new Error("DIAL_MAX_CALL_DURATION_SECONDS must be an integer from 60 to 3600.");
}
let response: Response;
try {
  response = await fetch("https://api.getdial.ai/api/v1/account", {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000), redirect: "error",
  });
} catch {
  throw new Error("Dial account lookup failed before limits could be verified.");
}
if (!response.ok) throw new Error(`Dial account lookup failed (HTTP ${response.status}).`);
let value: unknown;
try { value = await response.json(); }
catch { throw new Error("Dial account limits response is not valid JSON; no limits verified."); }
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const cap = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
if (!isRecord(value) || !(value.maxCallDurationSeconds === null || cap(value.maxCallDurationSeconds))
  || !(value.limits === null || (isRecord(value.limits) && cap(value.limits.maxCallDurationSeconds) && cap(value.limits.maxConcurrentCalls)))) {
  throw new Error("Dial account limits response is malformed; no limits verified.");
}
const limits = value.limits as { maxCallDurationSeconds: number; maxConcurrentCalls: number } | null;
const configuredCap = value.maxCallDurationSeconds as number | null;
console.log(JSON.stringify({
  verifiedAt: new Date().toISOString(),
  configuredMaxCallDurationSeconds: configuredCap,
  freeGuardrails: limits,
  adapterDefaultMaxCallDurationSeconds: 300,
  adapterDefaultWithinFreeGuardrails: limits === null || 300 <= limits.maxCallDurationSeconds,
  requestedMaxCallDurationSeconds: requestedCap,
  requestedDurationWithinFreeGuardrails: limits === null || requestedCap <= limits.maxCallDurationSeconds,
  smokeDurationWithinFreeGuardrails: limits === null || 60 <= limits.maxCallDurationSeconds,
}, null, 2));
if (limits !== null && requestedCap > limits.maxCallDurationSeconds) process.exitCode = 1;
// The per-call cap takes precedence over the configured number/account cap;
// free guardrails still apply. This endpoint does not prove number readiness.
