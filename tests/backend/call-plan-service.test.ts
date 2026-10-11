import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { type AuthorizedCallInput, type VoiceAdapter, validateCallPlan } from "@/contracts/voice";
import { ApiHttpError } from "@/server/http/errors";
import { COMPLETE_FIELDS, SESSION_A, createReadyCase, makeHarness, type Harness } from "./helpers";

// V1.1: the plan is built and frozen at authorization and reaches the adapter beside the brief.
let h: Harness;
afterEach(() => h?.cleanup());

function spyHarness() {
  const seen: AuthorizedCallInput[] = [];
  const base = makeHarness();
  base.cleanup();
  const harness = makeHarness({
    voice: {
      async startCall(input) {
        seen.push(structuredClone(input));
        return { state: "accepted", mode: "simulated", providerCallId: `sim_${Date.now()}_approved_0badf00d` };
      },
      getCall: async (id) => ({ providerCallId: id, mode: "simulated", state: "queued", transcript: null, durationSeconds: null }),
      verifyWebhook: async () => null,
    } satisfies VoiceAdapter,
  });
  return { harness, seen };
}

/** A case whose summary, files and fields carry no amount, so amountMinor stays null. */
async function createCaseWithoutAmount(harness: Harness, supportPhone = COMPLETE_FIELDS.supportPhone) {
  const { amountMinor: _omit, ...fields } = COMPLETE_FIELDS;
  const c = await harness.service.createCase(SESSION_A, {
    summary: "There is a charge from this merchant I do not recognize.",
    files: [],
    fields: { ...fields, supportPhone } as typeof COMPLETE_FIELDS,
  });
  expect(c.amountMinor).toBeNull();
  return c;
}

async function expectApi(p: () => unknown, status: number, code: string) {
  try {
    await p();
    throw new Error(`expected ${status} ${code}`);
  } catch (err) {
    expect(err).toBeInstanceOf(ApiHttpError);
    expect((err as ApiHttpError).status).toBe(status);
    expect((err as ApiHttpError).code).toBe(code);
  }
}

describe("V1.1 call plan at authorization", () => {
  it("default authorization freezes a valid request_refund plan and sends it to the adapter", async () => {
    const spy = spyHarness();
    h = spy.harness;
    const c = await createReadyCase(h);
    const a = h.service.authorize(SESSION_A, c.id, c.revision);
    expect(a.authorization?.purpose).toBe("request_refund");
    await h.service.startCall(SESSION_A, c.id, { authorizationId: a.authorization!.id, requestId: randomUUID() });
    const input = spy.seen[0]!;
    expect(input.brief).toContain("Purpose: request a refund of $49.99");
    expect(input.plan).toBeDefined();
    expect(validateCallPlan(input.plan)).toEqual([]);
    expect(input.plan!.purpose).toBe("request_refund");
    expect(input.plan!.caseRef).toEqual({ caseId: c.id, revision: c.revision });
    expect(input.plan!.facts.amountMinor).toBe(4999);
  });

  it("gather_information authorizes without an amount; request_refund still requires it", async () => {
    const spy = spyHarness();
    h = spy.harness;
    const c = await createCaseWithoutAmount(h);
    await expectApi(() => h.service.authorize(SESSION_A, c.id, c.revision), 422, "MISSING_REQUIRED_FACTS");
    const a = h.service.authorize(SESSION_A, c.id, c.revision, "gather_information");
    expect(a.authorization?.purpose).toBe("gather_information");
    expect(a.timeline.at(-1)?.message).toMatch(/gather information only/);
    await h.service.startCall(SESSION_A, c.id, { authorizationId: a.authorization!.id, requestId: randomUUID() });
    const input = spy.seen[0]!;
    expect(validateCallPlan(input.plan)).toEqual([]);
    expect(input.plan!.facts.amountMinor).toBeNull();
    expect(input.plan!.facts.currency).toBeNull();
    expect(input.plan!.questions.map((q) => q.id)).toContain("amount");
    expect(input.plan!.forbiddenActions.join(" ")).toMatch(/Do not request a refund/);
    expect(input.brief).not.toMatch(/request a refund of/);
    expect(input.brief).not.toContain("[amount missing]");
  });

  it("a case without an amount gets a neutral information-request draft, never a refund request", async () => {
    h = makeHarness();
    const c = await createCaseWithoutAmount(h);
    expect(c.draft?.subject).toMatch(/^Information request about a charge at /);
    expect(c.draft?.body).toContain("am not requesting a refund");
    expect(c.draft?.body).not.toMatch(/requesting a refund of/);
  });

  it("the same revision cannot be re-authorized for a different purpose", async () => {
    h = makeHarness();
    const c = await createReadyCase(h);
    const first = h.service.authorize(SESSION_A, c.id, c.revision);
    await expectApi(() => h.service.authorize(SESSION_A, c.id, c.revision, "gather_information"), 409, "AUTHORIZATION_CONFLICT");
    // Same purpose stays idempotent.
    expect(h.service.authorize(SESSION_A, c.id, c.revision).authorization?.id).toBe(first.authorization?.id);
  });

  it("an information-only call runs end to end through the simulated Dial path with no '[amount missing]' text", async () => {
    h = makeHarness();
    const c = await createCaseWithoutAmount(h, "+14155550004");
    const a = h.service.authorize(SESSION_A, c.id, c.revision, "gather_information");
    await h.service.startCall(SESSION_A, c.id, { authorizationId: a.authorization!.id, requestId: randomUUID() });
    h.clock.advance(10_000);
    const cs = await h.service.getCase(SESSION_A, c.id);
    expect(cs.calls[0]?.state).toBe("completed");
    expect(cs.outcome.decision).toBe("needs_information");
    expect(JSON.stringify(cs)).not.toContain("[amount missing]");
  });
});
