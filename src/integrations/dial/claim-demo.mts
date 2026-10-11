// Opt-in, single-attempt fictional claim demo. Never run as a build/test hook.
// Dispatch: DIAL_CLAIM_DEMO_ATTEMPT_FILE=/private/path/new.json node --env-file=/private/path/dial.env src/integrations/dial/claim-demo.mts --live --confirm-credits
// Read the same call: use the same attempt file and credentials, with --read only.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, rename } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createDialAdapter, type StartCallResult, type VoiceSnapshot } from "./index.ts";

const PURPOSE = "fictional_missing_document_demo";
interface Artifact {
  version: 1;
  purpose: typeof PURPOSE;
  attemptId: string;
  mode: "live";
  maxCallDurationSeconds: 60;
  state: "dispatch_pending" | StartCallResult["state"];
  createdAt: string;
  updatedAt?: string;
  result?: StartCallResult;
  snapshot?: VoiceSnapshot;
  readAt?: string;
}
class GuardError extends Error {}
function stop(message: string): never { throw new GuardError(message); }
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function main(): Promise<void> {
  const flags = process.argv.slice(2);
  const readOnly = flags.length === 1 && flags[0] === "--read";
  const dispatch = flags.length === 2 && new Set(flags).size === 2
    && flags.includes("--live") && flags.includes("--confirm-credits");
  if (!readOnly && !dispatch) stop("Use --read alone, or --live --confirm-credits after explicit recipient and credit authorization.");
  const apiKey = process.env.DIAL_API_KEY;
  if (!apiKey || apiKey.length > 4096 || !/^[\x21-\x7e]+$/.test(apiKey)) {
    stop("Configure valid server Dial credentials.");
  }
  const to = process.env.DIAL_TEST_TO;
  const fromNumber = process.env.DIAL_FROM_NUMBER;
  if (dispatch) {
    if (!to || !/^\+[1-9]\d{7,14}$/.test(to) || process.env.DIAL_TEST_CONSENT_TO !== to) {
      stop("Set DIAL_TEST_TO and matching DIAL_TEST_CONSENT_TO only for the explicitly consenting participant.");
    }
    if (!fromNumber || !fromNumber.trim() || fromNumber.length > 256 || /[\x00-\x1f\x7f]/.test(fromNumber)) {
      stop("Configure a valid Dial sending number.");
    }
  }
  const requestedPath = process.env.DIAL_CLAIM_DEMO_ATTEMPT_FILE;
  if (!requestedPath || !isAbsolute(requestedPath)) stop("Set DIAL_CLAIM_DEMO_ATTEMPT_FILE to an absolute private file outside the repository.");
  const parent = await realpath(dirname(resolve(requestedPath)));
  const path = join(parent, basename(resolve(requestedPath)));
  const repository = await realpath(fileURLToPath(new URL("../../../", import.meta.url)));
  const offset = relative(repository, path);
  if (offset === "" || (!offset.startsWith(`..${sep}`) && !isAbsolute(offset))) {
    stop("The attempt artifact must stay outside the repository, including through symlinked directories.");
  }
  async function syncDirectory(): Promise<void> {
    const directory = await open(parent, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async function persist(artifact: Artifact): Promise<void> {
    const temporary = `${path}.${randomUUID()}.result`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(artifact, null, 2)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, path);
    await syncDirectory();
  }
  const adapter = createDialAdapter({ mode: "live" }, {
    config: { apiKey, fromNumber, maxCallDurationSeconds: 60 },
    readRetries: 0,
  });
  if (readOnly) {
    // Refuse symlinks and shared-readable files before reading private transcripts.
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let artifact: Artifact;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600
        || (process.getuid && stat.uid !== process.getuid()) || stat.size > 2_000_000) {
        stop("The attempt artifact must be an owned regular file with permissions 0600.");
      }
      const value: unknown = JSON.parse(await handle.readFile("utf8"));
      if (!isRecord(value) || value.version !== 1 || value.purpose !== PURPOSE || value.mode !== "live"
        || value.maxCallDurationSeconds !== 60 || value.state !== "accepted"
        || typeof value.attemptId !== "string" || !/^[a-f0-9-]{36}$/i.test(value.attemptId)
        || typeof value.createdAt !== "string" || !isRecord(value.result)
        || value.result.state !== "accepted" || value.result.mode !== "live"
        || typeof value.result.providerCallId !== "string" || value.result.providerCallId.startsWith("sim_dial_")) {
        stop("Only an accepted live demo artifact can be read. Reconcile uncertain dispatches; never redial them.");
      }
      artifact = value as unknown as Artifact;
    } finally { await handle.close(); }
    const providerCallId = (artifact.result as Extract<StartCallResult, { state: "accepted" }>).providerCallId;
    const snapshot = await adapter.getCall(providerCallId);
    // A later read without transcript must not discard a transcript already obtained.
    if (snapshot.transcript === null && artifact.snapshot?.providerCallId === providerCallId
      && typeof artifact.snapshot.transcript === "string") snapshot.transcript = artifact.snapshot.transcript;
    const readAt = new Date().toISOString();
    await persist({ ...artifact, snapshot, readAt, updatedAt: readAt });
    console.log(JSON.stringify({ mode: "live", purpose: PURPOSE, providerCallId, state: snapshot.state,
      durationSeconds: snapshot.durationSeconds, transcriptAvailable: snapshot.transcript !== null, readAt }));
    return;
  }

  const artifact: Artifact = { version: 1, purpose: PURPOSE, attemptId: randomUUID(), mode: "live",
    maxCallDurationSeconds: 60, state: "dispatch_pending", createdAt: new Date().toISOString() };
  // Exclusive reservation plus both fsyncs complete BEFORE the only POST. A crash,
  // timeout, unknown response, or rerun leaves this path reserved: no automatic redial.
  const reservation = await open(path, "wx", 0o600);
  try { await reservation.writeFile(JSON.stringify(artifact, null, 2)); await reservation.sync(); }
  finally { await reservation.close(); }
  await syncDirectory();
  const result = await adapter.startCall({ attemptId: artifact.attemptId,
    caseId: randomUUID(), authorizationId: randomUUID(), to: to!,
    brief: "This is a consensual demo with a willing test participant, not an insurer or real claimant. No actual insurance claim, refund, policy, customer, or account exists. At the beginning say: I am an AI assistant calling for a fictional insurance claim demo; this is not a real claim. Ask only: Which missing document would you suggest adding to this fictional claim? Wait for their answer, acknowledge the suggested document without claiming it is a real insurer requirement, thank them, and end the call. If they do not know, decline, or ask to stop, thank them and end. Do not request any personal information, verify identity, file or submit anything, request money, or make any commitment. Keep the entire call within 60 seconds.",
  });
  // Print only normalized routing/status information; never the brief or transcript.
  console.log(JSON.stringify({ mode: "live", purpose: PURPOSE, attemptId: artifact.attemptId,
    state: result.state, ...(result.state === "accepted" ? { providerCallId: result.providerCallId } : {}) }));
  await persist({ ...artifact, state: result.state, result, updatedAt: new Date().toISOString() });
  if (result.state !== "accepted") process.exitCode = 1;
}

try { await main(); }
catch (error) {
  // OS/provider errors can contain file paths or private material. Only our own
  // static guard messages are printable; uncertainty always requires inspection.
  console.error(error instanceof GuardError ? error.message : "Claim demo stopped. Inspect the private attempt artifact; do not retry with a new path after uncertain dispatch.");
  process.exitCode = 1;
}
