// Opt-in only. Never run this script as part of automated tests or the build.
import { randomUUID } from "node:crypto";
import { open, realpath, rename } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createDialAdapter } from "./index.ts";

if (!process.argv.includes("--live")) throw new Error("Refusing to call: pass --live only after recipient authorization.");
const to = process.env.DIAL_TEST_TO;
if (!to || !/^\+[1-9]\d{7,14}$/.test(to) || process.env.DIAL_TEST_CONSENT_TO !== to) {
  throw new Error("Set DIAL_TEST_TO to the consenting test recipient and DIAL_TEST_CONSENT_TO to that exact number after explicit authorization.");
}
const validConfigText = (value: string | undefined, maximum: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
if (!process.env.DIAL_API_KEY || process.env.DIAL_API_KEY.length > 4096
  || !/^[\x21-\x7e]+$/.test(process.env.DIAL_API_KEY)
  || !validConfigText(process.env.DIAL_FROM_NUMBER, 256)) {
  throw new Error("Set valid server Dial credentials before the test.");
}
const attemptFile = process.env.DIAL_SMOKE_ATTEMPT_FILE;
if (!attemptFile || !isAbsolute(attemptFile)) throw new Error("Set DIAL_SMOKE_ATTEMPT_FILE to a new absolute file path for this single approved test.");
const parentDirectory = await realpath(dirname(resolve(attemptFile)));
const canonicalAttemptFile = join(parentDirectory, basename(resolve(attemptFile)));
const repositoryRoot = await realpath(fileURLToPath(new URL("../../../", import.meta.url)));
const relativeAttemptFile = relative(repositoryRoot, canonicalAttemptFile);
if (relativeAttemptFile === "" || (!relativeAttemptFile.startsWith(`..${sep}`) && !isAbsolute(relativeAttemptFile))) {
  throw new Error("DIAL_SMOKE_ATTEMPT_FILE must be outside the repository, including through symlinked directories.");
}
async function syncParentDirectory(): Promise<void> {
  const directory = await open(parentDirectory, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
// Reserve before sending. Reusing a prior path fails closed: inspect the stored
// result / dashboard, never create a fresh attempt simply to retry uncertainty.
const attemptId = randomUUID();
const pending = { attemptId, mode: "live", state: "dispatch_pending", createdAt: new Date().toISOString() };
const reservation = await open(canonicalAttemptFile, "wx", 0o600);
try { await reservation.writeFile(JSON.stringify(pending, null, 2)); await reservation.sync(); }
finally { await reservation.close(); }
// Persist the directory entry too before the network side effect. If persistence
// fails, the script stops with the reserved file intact and does not send a call.
await syncParentDirectory();
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
const resultFile = `${canonicalAttemptFile}.${attemptId}.result`;
const resultHandle = await open(resultFile, "wx", 0o600);
try {
  await resultHandle.writeFile(JSON.stringify({ ...pending, state: result.state, result, updatedAt: new Date().toISOString() }, null, 2));
  await resultHandle.sync();
} finally { await resultHandle.close(); }
await rename(resultFile, canonicalAttemptFile);
await syncParentDirectory();
if (result.state !== "accepted") process.exitCode = 1;
// No automatic redial or transcript polling. Use adapter.getCall(result.providerCallId)
// after the call; completed phone status alone does not establish a refund outcome.
