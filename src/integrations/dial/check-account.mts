// READ ONLY: node --env-file=/secure/path/dial.env src/integrations/dial/check-account.mts
// Never print the raw account: it contains identity and key-preview fields.
const key = process.env.DIAL_API_KEY;
if (!key) throw new Error("Configure DIAL_API_KEY before checking the account.");
const response = await fetch("https://api.getdial.ai/api/v1/account", {
  headers: { Authorization: `Bearer ${key}` },
  signal: AbortSignal.timeout(10_000), redirect: "error",
});
if (!response.ok) throw new Error(`Dial account lookup failed (HTTP ${response.status}).`);
const value: unknown = await response.json();
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
}, null, 2));
// The per-call cap takes precedence over the configured number/account cap;
// free guardrails still apply. This endpoint does not prove number readiness.
