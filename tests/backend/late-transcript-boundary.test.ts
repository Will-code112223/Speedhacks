import { afterEach, describe, expect, it } from "vitest";
import type { VoiceAdapter, VoiceSnapshot } from "@/contracts/voice";
import { SESSION_A, authorizeAndCall, createReadyCase, makeHarness, type Harness } from "./helpers";

const OLD_ID = "synthetic_old_A";
const CURRENT_ID = "synthetic_current_B";
const APPROVED_OLD_TRANSCRIPT = "Support: I've processed the refund for the earlier USD 49.99 request. Reference number is REF-OLD-A12345.";

let h: Harness | undefined;
afterEach(() => { h?.cleanup(); h = undefined; });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** A fake provider with an optional barrier at its read boundary. No network. */
function setup(initialTranscript: string | null = null) {
  let transcript = initialTranscript;
  let dispatches = 0;
  let readsOfOld = 0;
  let gate: { entered: ReturnType<typeof deferred<void>>; result: ReturnType<typeof deferred<VoiceSnapshot>> } | null = null;
  const snapshot = (): VoiceSnapshot => ({
    providerCallId: OLD_ID, mode: "simulated", state: "completed", transcript, durationSeconds: 30,
  });
  const voice: VoiceAdapter = {
    async startCall() {
      dispatches++;
      return { state: "accepted", mode: "simulated", providerCallId: dispatches === 1 ? OLD_ID : CURRENT_ID };
    },
    async getCall(providerCallId) {
      if (providerCallId !== OLD_ID) {
        return { providerCallId, mode: "simulated", state: "in_progress", transcript: null, durationSeconds: null };
      }
      readsOfOld++;
      if (gate) {
        const pending = gate;
        pending.entered.resolve();
        return pending.result.promise;
      }
      return snapshot();
    },
    async verifyWebhook() { return null; },
  };
  const harness = makeHarness({ voice, env: { TRANSCRIPT_WAIT_MS: "1000", LATE_TRANSCRIPT_INTERVAL_MS: "30000" } });
  h = harness;
  return {
    harness,
    setTranscript(value: string) { transcript = value; },
    get readsOfOld() { return readsOfOld; },
    get dispatches() { return dispatches; },
    holdNextOldRead() {
      const pending = { entered: deferred<void>(), result: deferred<VoiceSnapshot>() };
      gate = pending;
      return {
        entered: pending.entered.promise,
        release() { gate = null; pending.result.resolve(snapshot()); },
      };
    },
  };
}

async function expireTranscriptWait(harness: Harness) {
  const original = await createReadyCase(harness);
  const { call } = await authorizeAndCall(harness, original);
  await harness.service.getCase(SESSION_A, original.id);
  harness.clock.advance(1001);
  const expired = await harness.service.getCase(SESSION_A, original.id);
  expect(expired.calls.find((candidate) => candidate.id === call.id)?.state).toBe("completed");
  expect(expired.outcome.decision).toBe("unknown");
  return { expired, call };
}

describe("late transcript ownership and revision boundaries", () => {
  it("attaches an older transcript without publishing it as the newer active authorization's outcome", async () => {
    const control = setup();
    const { harness } = control;
    const { expired, call: oldCall } = await expireTranscriptWait(harness);
    const revised = harness.service.patchCase(SESSION_A, expired.id, expired.revision, { amountMinor: 6999 });
    const { call: currentCall, authorizationId } = await authorizeAndCall(harness, revised);
    const before = await harness.service.getCase(SESSION_A, revised.id);
    control.setTranscript(APPROVED_OLD_TRANSCRIPT);
    harness.clock.advance(30001);
    const after = await harness.service.getCase(SESSION_A, revised.id);

    expect(after.calls.find((call) => call.id === oldCall.id)?.transcript).toBe(APPROVED_OLD_TRANSCRIPT);
    expect(after.calls.find((call) => call.id === currentCall.id)?.state).toBe("in_progress");
    expect(after.authorization?.id).toBe(authorizationId);
    expect(after.outcome).toEqual(before.outcome);
    expect(after.timeline.filter((entry) => entry.type === "outcome_published")).toHaveLength(
      before.timeline.filter((entry) => entry.type === "outcome_published").length,
    );
    expect(control.dispatches).toBe(2);
  });

  it.each(["", " \n\t "])("refreshes a completed transcript containing only %j", async (emptyTranscript) => {
    const control = setup(emptyTranscript);
    const { harness } = control;
    const { expired, call } = await expireTranscriptWait(harness);
    const readsBefore = control.readsOfOld;
    control.setTranscript(APPROVED_OLD_TRANSCRIPT);
    harness.clock.advance(30001);
    const refreshed = await harness.service.getCase(SESSION_A, expired.id);

    expect(control.readsOfOld).toBe(readsBefore + 1);
    expect(refreshed.calls.find((candidate) => candidate.id === call.id)?.transcript).toBe(APPROVED_OLD_TRANSCRIPT);
    expect(refreshed.calls.find((candidate) => candidate.id === call.id)?.state).toBe("completed");
    expect(refreshed.outcome.decision).toBe("approved");
    expect(refreshed.outcome.referenceNumber).toBe("REF-OLD-A12345");
    expect(control.dispatches).toBe(1);
  });

  it("publishes a current authorization's late transcript once across repeated GETs", async () => {
    const control = setup();
    const { harness } = control;
    const { expired, call } = await expireTranscriptWait(harness);
    const priorOutcomeEntries = expired.timeline.filter((entry) => entry.type === "outcome_published").length;
    control.setTranscript(APPROVED_OLD_TRANSCRIPT);
    harness.clock.advance(30001);
    const refreshed = await harness.service.getCase(SESSION_A, expired.id);
    const readsAfterRefresh = control.readsOfOld;

    expect(refreshed.calls.find((candidate) => candidate.id === call.id)?.transcript).toBe(APPROVED_OLD_TRANSCRIPT);
    expect(refreshed.outcome.decision).toBe("approved");
    expect(refreshed.timeline.filter((entry) => entry.type === "transcript_received_late")).toHaveLength(1);
    expect(refreshed.timeline.filter((entry) => entry.type === "outcome_published")).toHaveLength(priorOutcomeEntries + 1);

    for (let read = 0; read < 3; read++) {
      harness.clock.advance(30001);
      const repeated = await harness.service.getCase(SESSION_A, expired.id);
      expect(repeated.outcome).toEqual(refreshed.outcome);
      expect(repeated.timeline).toEqual(refreshed.timeline);
      expect(repeated.calls).toEqual(refreshed.calls);
    }
    expect(control.readsOfOld).toBe(readsAfterRefresh);
    expect(control.dispatches).toBe(1);
  });

  it("rechecks the current authorization transactionally after awaiting a late provider read", async () => {
    const control = setup();
    const { harness } = control;
    const { expired, call: oldCall } = await expireTranscriptWait(harness);
    control.setTranscript(APPROVED_OLD_TRANSCRIPT);
    harness.clock.advance(30001);
    const heldRead = control.holdNextOldRead();
    const pendingRefresh = harness.service.getCase(SESSION_A, expired.id);
    await heldRead.entered;

    try {
      const revised = harness.service.patchCase(SESSION_A, expired.id, expired.revision, { amountMinor: 6999 });
      const { authorized, call: currentCall, authorizationId } = await authorizeAndCall(harness, revised);
      heldRead.release();
      const after = await pendingRefresh;
      expect(after.revision).toBe(revised.revision);
      expect(after.authorization?.id).toBe(authorizationId);
      expect(after.calls.find((call) => call.id === currentCall.id)?.state).toBe("queued");
      expect(after.calls.find((call) => call.id === oldCall.id)?.transcript).toBe(APPROVED_OLD_TRANSCRIPT);
      expect(after.outcome).toEqual(authorized.outcome);
      expect(control.dispatches).toBe(2);
    } finally {
      heldRead.release();
      await pendingRefresh;
    }
  });

  it("clears the previous outcome on material edits and reports a new authorization as authorized", async () => {
    const control = setup(APPROVED_OLD_TRANSCRIPT);
    const { harness } = control;
    const original = await createReadyCase(harness);
    const { call: oldCall } = await authorizeAndCall(harness, original);
    const approved = await harness.service.getCase(SESSION_A, original.id);
    expect(approved.outcome.decision).toBe("approved");
    const historicalOutcomeEntries = approved.timeline.filter((entry) => entry.type === "outcome_published");

    const revised = harness.service.patchCase(SESSION_A, original.id, approved.revision, { amountMinor: 6999 });
    expect(revised.authorization).toBeNull();
    expect(revised.outcome.decision).toBe("unknown");
    expect(revised.outcome.referenceNumber).toBeNull();
    expect(revised.outcome.supportingQuote).toBeNull();
    expect(revised.calls.find((call) => call.id === oldCall.id)?.transcript).toBe(APPROVED_OLD_TRANSCRIPT);
    expect(revised.timeline.filter((entry) => entry.type === "outcome_published")).toEqual(historicalOutcomeEntries);

    const reauthorized = harness.service.authorize(SESSION_A, revised.id, revised.revision);
    expect(reauthorized.status).toBe("authorized");
    expect(reauthorized.calls).toHaveLength(1);
    expect(control.dispatches).toBe(1);
  });
});
