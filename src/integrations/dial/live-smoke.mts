// Opt-in only. Never run this script as part of automated tests or the build.
import { randomUUID } from "node:crypto";
import { open, rename } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createDialAdapter } from "./index.ts";

if (!process.argv.includes("--live")) throw new Error("Refusing to call: pass --live only after recipient authorization.");
const to = process.env.DIAL_TEST_TO;
if (!to || !/^\+[1-9]\d{7,14}$/.test(to) || process.env.DIAL_TEST_CONSENT_TO !== to) {
  throw new Error("Set DIAL_TEST_TO to the consenting test recipient and DIAL_TEST_CONSENT_TO to that exact number after explicit authorization.");
}
if (!process.env.DIAL_API_KEY || !process.env.DIAL_FROM_NUMBER) throw new Error("Set server Dial credentials before the test.");
const attemptFile = process.env.DIAL_SMOKE_ATTEMPT_FILE;
if (!attemptFile || !isAbsolute(attemptFile)) throw new Error("Set DIAL_SMOKE_ATTEMPT_FILE to a new absolute file path for this single approved test.");
// Reserve before sending. Reusing a prior path fails closed: inspect the stored
// result / dashboard, never create a fresh attempt simply to retry uncertainty.
const attemptId = randomUUID();
const pending = { attemptId, mode: "live", state: "dispatch_pending", createdAt: new Date().toISOString() };
const reservation = await open(attemptFile, "wx", 0o600);
try { await reservation.writeFile(JSON.stringify(pending, null, 2)); await reservation.sync(); }
finally { await reservation.close(); }
const adapter = createDialAdapter({ mode: "live" }, { config: {
  apiKey: process.env.DIAL_API_KEY, fromNumber: process.env.DIAL_FROM_NUMBER,
  maxCallDurationSeconds: 60,
} });
const result = await adapter.startCall({
  attemptId, caseId: randomUUID(), authorizationId: randomUUID(), to,
  brief: "This is a consensual software smoke test with a test participant. Say this is an AI assistant testing Dial integration. Ask the participant to say the synthetic reference TEST-001. Thank them and end the call. No actual refund or claim exists. Do not discuss any real customer or account information.",
});
// Emit the sanitized provider ID first so it survives an unrelated disk failure.
console.log(JSON.stringify(result, null, 2));
const resultFile = `${attemptFile}.${attemptId}.result`;
const resultHandle = await open(resultFile, "wx", 0o600);
try {
  await resultHandle.writeFile(JSON.stringify({ ...pending, result, updatedAt: new Date().toISOString() }, null, 2));
  await resultHandle.sync();
} finally { await resultHandle.close(); }
await rename(resultFile, attemptFile);
if (result.state !== "accepted") process.exitCode = 1;
// No automatic redial or transcript polling. Use adapter.getCall(result.providerCallId)
// after the call; completed phone status alone does not establish a refund outcome.
