import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VoiceAdapter, VoiceSnapshot } from "@/contracts/voice";
import { SESSION_A, authorizeAndCall, createReadyCase, makeHarness, type Harness } from "./helpers";

/** Dial's call.ended arrives before call.transcribed: completion must wait (bounded) for the transcript. */
let h: Harness;
let snapshot: VoiceSnapshot;
beforeEach(() => {
  const voice: VoiceAdapter = {
    async startCall() {
      return { state: "accepted", mode: "simulated", providerCallId: "prov_1" };
    },
    async getCall() {
      return snapshot;
    },
    async verifyWebhook() {
      return null;
    },
  };
  h = makeHarness({ voice, env: { TRANSCRIPT_WAIT_MS: "10000" } });
  snapshot = { providerCallId: "prov_1", mode: "simulated", state: "completed", transcript: null, durationSeconds: 30 };
});
afterEach(() => h.cleanup());

describe("late transcript reconciliation", () => {
  it("stays non-terminal until the transcript arrives, then publishes the outcome once", async () => {
    const c = await createReadyCase(h);
    await authorizeAndCall(h, c);
    let cs = await h.service.getCase(SESSION_A, c.id);
    expect(cs.calls[0]?.state).toBe("in_progress");
    expect(cs.status).toBe("calling");
    expect(cs.timeline.some((t) => t.type === "call_ended_awaiting_transcript")).toBe(true);

    h.clock.advance(3000);
    snapshot = { ...snapshot, transcript: "Support: I've processed the refund. Reference number is REF-77777." };
    cs = await h.service.getCase(SESSION_A, c.id);
    expect(cs.calls[0]?.state).toBe("completed");
    expect(cs.outcome.decision).toBe("approved");
    expect(cs.outcome.referenceNumber).toBe("REF-77777");
    expect(cs.timeline.filter((t) => t.type === "outcome_published")).toHaveLength(1);
  });

  it("publishes an explicit unknown outcome with a manual next step when the wait window expires", async () => {
    const c = await createReadyCase(h);
    await authorizeAndCall(h, c);
    await h.service.getCase(SESSION_A, c.id);
    h.clock.advance(5000);
    let cs = await h.service.getCase(SESSION_A, c.id);
    expect(cs.calls[0]?.state).toBe("in_progress");
    h.clock.advance(6000);
    cs = await h.service.getCase(SESSION_A, c.id);
    expect(cs.calls[0]?.state).toBe("completed");
    expect(cs.calls[0]?.transcript).toBeNull();
    expect(cs.outcome.decision).toBe("unknown");
    expect(cs.outcome.nextAction).toMatch(/no transcript/);
    expect(cs.status).toBe("awaiting_response");
  });
});
