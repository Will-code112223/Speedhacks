import { afterEach, describe, expect, it } from "vitest";
import { SESSION_A, authorizeAndCall, createReadyCase, makeHarness, type Harness } from "./helpers";

// Simulated mode runs teammate 3's Dial adapter (live code path) against an in-process fake Dial server.
let h: Harness;
afterEach(() => h?.cleanup());

describe("simulated mode goes through the Dial adapter", () => {
  it("parses Dial transcriptTurns and labels the call simulated", async () => {
    h = makeHarness();
    const c = await createReadyCase(h);
    const { call } = await authorizeAndCall(h, c);
    expect(call.providerCallId).toMatch(/^sim_\d+_approved_[a-f0-9]{8}$/);
    h.clock.advance(10_000);
    const cs = await h.service.getCase(SESSION_A, c.id);
    expect(cs.calls[0]?.state).toBe("completed");
    expect(cs.calls[0]?.mode).toBe("simulated");
    // "agent:" / "user:" labels only come from normalizeCall's transcriptTurns path.
    expect(cs.calls[0]?.transcript).toMatch(/^agent: /m);
    expect(cs.calls[0]?.transcript).toMatch(/^user: .*reference number is REF-/m);
    expect(cs.outcome.decision).toBe("approved");
    expect(cs.timeline.some((t) => /\(provider id sim_.*, simulated\)/.test(t.message ?? ""))).toBe(true);
  });

  it("a Dial HTTP 403 surfaces as the adapter's rejected result", async () => {
    h = makeHarness();
    const result = await h.voice.startCall({
      attemptId: "11111111-1111-4111-8111-111111111111",
      caseId: "22222222-2222-4222-8222-222222222222",
      authorizationId: "33333333-3333-4333-8333-333333333333",
      to: "+15555550001",
      brief: "approved facts",
    });
    expect(result).toMatchObject({ state: "rejected", mode: "simulated", code: "DIAL_HTTP_403" });
  });
});
