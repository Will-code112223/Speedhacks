import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { CALL_PLAN_ACTIONS, type CallPlanV1, type VoiceAdapter, type VoiceSnapshot } from "@/contracts/voice";
import { proposeUpdates } from "@/server/cases/answers";
import { ApiHttpError } from "@/server/http/errors";
import { COMPLETE_FIELDS, SESSION_A, authorizeAndCall, createReadyCase, makeHarness, type Harness } from "./helpers";

let h: Harness | undefined;
afterEach(() => { h?.cleanup(); h = undefined; });

const PLAN: CallPlanV1 = {
  version: 1,
  purpose: "gather_information",
  facts: { customerName: "Sam", customerEmail: null, merchantName: "Acme", amountMinor: null, currency: null, reason: "Unknown charge.", evidenceNames: [], history: null },
  permittedDisclosures: ["customerName", "merchantName"],
  questions: [
    { id: "amount", text: "What amount was charged?" },
    { id: "requirements", text: "What do you need?" },
    { id: "reference", text: "Reference?" },
  ],
  permittedActions: [...CALL_PLAN_ACTIONS.gather_information.permitted],
  forbiddenActions: [...CALL_PLAN_ACTIONS.gather_information.forbidden],
  caseRef: { caseId: "22222222-2222-4222-8222-222222222222", revision: 1 },
};
const BIND = { callId: "c1", authorizationId: "a1", revision: 1, now: "2026-10-11T20:00:00.000Z" };

describe("proposeUpdates (transcript → proposals)", () => {
  it("reads only labeled support lines and quotes them verbatim", () => {
    const transcript = [
      "agent: Our reference number is AGENT-9999 and the charge was $10.00.",
      "user: The charge on file is $49.99 from October 3.",
      "user: We need the order number before we can look further.",
      "user: Your case number is CS-20481.",
    ].join("\n");
    const out = proposeUpdates({ transcript, plan: PLAN, ...BIND });
    expect(out.map((u) => [u.target, u.value])).toEqual([
      [{ kind: "fact", field: "amountMinor" }, "4999"],
      [{ kind: "question", questionId: "requirements" }, "We need the order number before we can look further."],
      [{ kind: "question", questionId: "reference" }, "CS-20481"],
    ]);
    expect(out[0]?.quote).toBe("The charge on file is $49.99 from October 3.");
    expect(out.every((u) => u.status === "pending" && u.callId === "c1" && u.authorizationId === "a1" && u.revision === 1)).toBe(true);
  });

  it("never proposes a fact the plan already knows, and ignores unlabeled text", () => {
    const known = { ...PLAN, facts: { ...PLAN.facts, amountMinor: 1000, currency: "USD" } };
    expect(proposeUpdates({ transcript: "user: It was $49.99.", plan: known, ...BIND })).toEqual([]);
    expect(proposeUpdates({ transcript: "The charge was $49.99. Reference number is REF-12345.", plan: PLAN, ...BIND })).toEqual([]);
  });
});

/** Fake provider: completes immediately with the given transcript. */
function completingVoice(transcript: () => string | null): VoiceAdapter {
  return {
    async startCall() { return { state: "accepted", mode: "simulated", providerCallId: `prov_${randomUUID()}` }; },
    async getCall(id): Promise<VoiceSnapshot> { return { providerCallId: id, mode: "simulated", state: "completed", transcript: transcript(), durationSeconds: 30 }; },
    async verifyWebhook() { return null; },
  };
}

async function amountlessCase(harness: Harness) {
  const { amountMinor: _omit, ...fields } = COMPLETE_FIELDS;
  return harness.service.createCase(SESSION_A, { summary: "There is a charge I do not recognize.", files: [], fields: fields as typeof COMPLETE_FIELDS });
}

async function expectApi(p: () => unknown, status: number, code: string) {
  try { await p(); throw new Error("expected error"); } catch (err) {
    expect(err).toBeInstanceOf(ApiHttpError);
    expect([(err as ApiHttpError).status, (err as ApiHttpError).code]).toEqual([status, code]);
  }
}

describe("proposed updates on a case", () => {
  it("are stored pending after the call, change nothing, and a fact acceptance is an ordinary edit", async () => {
    h = makeHarness({ voice: completingVoice(() => "user: The charge on file is $49.99.\nuser: Your case number is CS-20481.") });
    const c = await amountlessCase(h);
    const a = h.service.authorize(SESSION_A, c.id, c.revision, "gather_information");
    await h.service.startCall(SESSION_A, c.id, { authorizationId: a.authorization!.id, requestId: randomUUID() });
    let cs = await h.service.getCase(SESSION_A, c.id);
    expect(cs.revision).toBe(c.revision);
    expect(cs.amountMinor).toBeNull();
    expect(cs.proposedUpdates?.map((u) => u.status)).toEqual(["pending", "pending"]);
    expect(cs.proposedUpdates?.every((u) => u.authorizationId === a.authorization!.id && u.revision === c.revision)).toBe(true);
    expect(cs.timeline.some((t) => t.type === "updates_proposed")).toBe(true);

    const reference = cs.proposedUpdates!.find((u) => u.target.kind === "question")!;
    cs = h.service.reviewProposedUpdate(SESSION_A, c.id, reference.id, "accept", cs.revision);
    expect(cs.revision).toBe(c.revision); // a question answer never changes facts
    expect(cs.proposedUpdates?.find((u) => u.id === reference.id)?.status).toBe("accepted");

    const amount = cs.proposedUpdates!.find((u) => u.target.kind === "fact")!;
    cs = h.service.reviewProposedUpdate(SESSION_A, c.id, amount.id, "accept", cs.revision);
    expect(cs.amountMinor).toBe(4999);
    expect(cs.revision).toBe(c.revision + 1);
    expect(cs.authorization).toBeNull(); // re-authorization required
    expect(cs.proposedUpdates?.find((u) => u.id === amount.id)?.status).toBe("accepted");
    await expectApi(() => h!.service.reviewProposedUpdate(SESSION_A, c.id, amount.id, "reject", cs.revision), 400, "BAD_REQUEST");
  });

  it("a rejected proposal changes nothing; a stale fact proposal cannot be accepted", async () => {
    h = makeHarness({ voice: completingVoice(() => "user: The charge on file is $49.99.\nuser: We need the order number.") });
    const c = await amountlessCase(h);
    const a = h.service.authorize(SESSION_A, c.id, c.revision, "gather_information");
    await h.service.startCall(SESSION_A, c.id, { authorizationId: a.authorization!.id, requestId: randomUUID() });
    let cs = await h.service.getCase(SESSION_A, c.id);
    const req = cs.proposedUpdates!.find((u) => u.target.kind === "question")!;
    cs = h.service.reviewProposedUpdate(SESSION_A, c.id, req.id, "reject", cs.revision);
    expect(cs.revision).toBe(c.revision);
    expect(cs.proposedUpdates?.find((u) => u.id === req.id)?.status).toBe("rejected");

    cs = h.service.patchCase(SESSION_A, c.id, cs.revision, { reason: "Edited by the user." });
    const amount = cs.proposedUpdates!.find((u) => u.target.kind === "fact")!;
    await expectApi(() => h!.service.reviewProposedUpdate(SESSION_A, c.id, amount.id, "accept", cs.revision), 409, "REVISION_CONFLICT");
  });

  it("a late transcript for an older authorization never creates proposals for the newer revision", async () => {
    let transcript: string | null = null;
    h = makeHarness({ voice: completingVoice(() => transcript), env: { TRANSCRIPT_WAIT_MS: "1000", LATE_TRANSCRIPT_INTERVAL_MS: "30000" } });
    const c = await createReadyCase(h);
    await authorizeAndCall(h, c);
    await h.service.getCase(SESSION_A, c.id);
    h.clock.advance(1001);
    const expired = await h.service.getCase(SESSION_A, c.id);
    expect(expired.calls[0]?.state).toBe("completed");
    h.service.patchCase(SESSION_A, c.id, expired.revision, { amountMinor: 6999 });
    transcript = "user: Your reference number is REF-77777.";
    h.clock.advance(30_001);
    const after = await h.service.getCase(SESSION_A, c.id);
    expect(after.calls[0]?.transcript).toContain("REF-77777");
    expect(after.proposedUpdates).toBeUndefined();
  });

  it("control: a late transcript for the CURRENT authorization does create proposals", async () => {
    let transcript: string | null = null;
    h = makeHarness({ voice: completingVoice(() => transcript), env: { TRANSCRIPT_WAIT_MS: "1000", LATE_TRANSCRIPT_INTERVAL_MS: "30000" } });
    const c = await createReadyCase(h);
    await authorizeAndCall(h, c);
    await h.service.getCase(SESSION_A, c.id);
    h.clock.advance(1001);
    await h.service.getCase(SESSION_A, c.id);
    transcript = "user: Your reference number is REF-77777.";
    h.clock.advance(30_001);
    const after = await h.service.getCase(SESSION_A, c.id);
    expect(after.proposedUpdates?.map((u) => u.value)).toEqual(["REF-77777"]);
  });
});
