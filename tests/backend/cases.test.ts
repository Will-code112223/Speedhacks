import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiHttpError } from "@/server/http/errors";
import { COMPLETE_FIELDS, SESSION_A, SESSION_B, authorizeAndCall, createReadyCase, makeHarness, type Harness } from "./helpers";

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.cleanup());

const expectApi = async (p: Promise<unknown> | (() => unknown), status: number, code: string) => {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (err) {
    expect(err).toBeInstanceOf(ApiHttpError);
    const e = err as ApiHttpError;
    expect([e.status, e.code]).toEqual([status, code]);
    return e;
  }
  throw new Error(`expected ${status} ${code}`);
};

describe("case creation and facts", () => {
  it("creates a case with extracted facts and provenance; missing fields are listed, never fabricated", async () => {
    const c = await h.service.createCase(SESSION_A, {
      summary: "Charged twice by Acme Streaming for $49.99 on Oct 3. Support is (415) 555-1000. my name is Sam Rivera",
      files: [],
      fields: {},
    });
    expect(c.schemaVersion).toBe(1);
    expect(c.revision).toBe(1);
    expect(c.mode).toBe("simulated");
    expect(c.amountMinor).toBe(4999);
    expect(c.currency).toBe("USD");
    expect(c.merchant.name).toBe("Acme Streaming");
    expect(c.merchant.supportPhone).toBe("+14155551000");
    expect(c.customer.name).toBe("Sam Rivera");
    expect(c.customer.email).toBeNull();
    expect(c.missingFields).toEqual([]);
    expect(c.status).toBe("ready_for_approval");
    expect(c.draft?.subject).toContain("$49.99");
    const prov = h.repo.listProvenance(c.id);
    expect(prov.map((p) => p.field).sort()).toEqual(["amountMinor", "currency", "customerName", "merchantName", "supportPhone"]);
    expect(prov.every((p) => p.sourceKind === "summary")).toBe(true);
  });

  it("requires summary or a file and validates uploads", async () => {
    await expectApi(h.service.createCase(SESSION_A, { summary: "   ", files: [], fields: {} }), 400, "BAD_REQUEST");
    await expectApi(
      h.service.createCase(SESSION_A, {
        summary: "x",
        files: [{ name: "evil.exe", mimeType: "application/octet-stream", bytes: new Uint8Array([1]) }],
        fields: {},
      }),
      400,
      "BAD_REQUEST",
    );
  });

  it("marks needs_information when facts are missing and builds no draft", async () => {
    const c = await h.service.createCase(SESSION_A, { summary: "Something is wrong with a charge.", files: [], fields: {} });
    expect(c.status).toBe("needs_information");
    expect(c.missingFields).toEqual(["customer.name", "merchant.name", "merchant.supportPhone", "amountMinor"]);
    expect(c.draft).toBeNull();
  });
});

describe("revisions, edits and authorization", () => {
  it("rejects a stale revision on PATCH and on authorize", async () => {
    const c = await createReadyCase(h);
    const updated = h.service.patchCase(SESSION_A, c.id, 1, { amountMinor: 5999 });
    expect(updated.revision).toBe(2);
    await expectApi(() => h.service.patchCase(SESSION_A, c.id, 1, { amountMinor: 6999 }), 409, "REVISION_CONFLICT");
    await expectApi(() => h.service.authorize(SESSION_A, c.id, 1), 409, "REVISION_CONFLICT");
  });

  it("does not bump the revision for a no-op edit", async () => {
    const c = await createReadyCase(h);
    const same = h.service.patchCase(SESSION_A, c.id, 1, { amountMinor: 4999 });
    expect(same.revision).toBe(1);
  });

  it("authorization is idempotent per revision and cleared by a material edit", async () => {
    const c = await createReadyCase(h);
    const a1 = h.service.authorize(SESSION_A, c.id, 1);
    const a2 = h.service.authorize(SESSION_A, c.id, 1);
    expect(a1.authorization?.id).toBe(a2.authorization?.id);
    expect(a1.status).toBe("authorized");

    const edited = h.service.patchCase(SESSION_A, c.id, 1, { merchant: { name: "Acme Streaming", supportPhone: "+14155552000" } });
    expect(edited.revision).toBe(2);
    expect(edited.authorization).toBeNull();
    expect(edited.status).toBe("ready_for_approval");
    const a3 = h.service.authorize(SESSION_A, c.id, 2);
    expect(a3.authorization?.id).not.toBe(a1.authorization?.id);
    // The old snapshot is preserved for audit.
    expect(h.repo.getAuthorization(a1.authorization!.id)?.snapshot.merchant.supportPhone).toBe("+14155551000");
  });

  it("refuses to authorize with missing required facts (422 lists them)", async () => {
    const c = await h.service.createCase(SESSION_A, { summary: "Duplicate charge of $12.00", files: [], fields: {} });
    const e = await expectApi(() => h.service.authorize(SESSION_A, c.id, 1), 422, "MISSING_REQUIRED_FACTS");
    expect(e.fields).toEqual(["customer.name", "merchant.name", "merchant.supportPhone"]);
  });

  it("a stale authorization cannot dispatch a call", async () => {
    const c = await createReadyCase(h);
    const a1 = h.service.authorize(SESSION_A, c.id, 1);
    h.service.patchCase(SESSION_A, c.id, 1, { amountMinor: 1 });
    await expectApi(
      h.service.startCall(SESSION_A, c.id, { authorizationId: a1.authorization!.id, requestId: randomUUID() }),
      409,
      "AUTHORIZATION_CONFLICT",
    );
  });
});

describe("case isolation", () => {
  it("another session cannot read, edit, authorize or call the case", async () => {
    const c = await createReadyCase(h, SESSION_A);
    await expectApi(h.service.getCase(SESSION_B, c.id), 404, "NOT_FOUND");
    await expectApi(() => h.service.patchCase(SESSION_B, c.id, 1, { amountMinor: 1 }), 404, "NOT_FOUND");
    await expectApi(() => h.service.authorize(SESSION_B, c.id, 1), 404, "NOT_FOUND");
    await expectApi(() => h.service.packet(SESSION_B, c.id), 404, "NOT_FOUND");
    const a = h.service.authorize(SESSION_A, c.id, 1);
    await expectApi(
      h.service.startCall(SESSION_B, c.id, { authorizationId: a.authorization!.id, requestId: randomUUID() }),
      404,
      "NOT_FOUND",
    );
  });
});

describe("dispatch", () => {
  it("duplicate requestId or authorizationId returns the stored attempt; concurrent requests create one call", async () => {
    const c = await createReadyCase(h);
    const a = h.service.authorize(SESSION_A, c.id, 1);
    const authorizationId = a.authorization!.id;
    const requestId = randomUUID();
    const [r1, r2, r3] = await Promise.all([
      h.service.startCall(SESSION_A, c.id, { authorizationId, requestId }),
      h.service.startCall(SESSION_A, c.id, { authorizationId, requestId }),
      h.service.startCall(SESSION_A, c.id, { authorizationId, requestId: randomUUID() }),
    ]);
    expect(r2.id).toBe(r1.id);
    expect(r3.id).toBe(r1.id);
    expect(h.repo.listCalls(c.id)).toHaveLength(1);
    expect(r1.state).toBe("queued");
    expect(r1.providerCallId).toMatch(/^sim_/);
    const after = await h.service.getCase(SESSION_A, c.id);
    expect(after.status).toBe("calling");
  });

  it("rejects edits and new authorizations while a call is active", async () => {
    const c = await createReadyCase(h);
    await authorizeAndCall(h, c);
    await expectApi(() => h.service.patchCase(SESSION_A, c.id, 1, { amountMinor: 1 }), 409, "CALL_IN_PROGRESS");
    await expectApi(() => h.service.authorize(SESSION_A, c.id, 1), 409, "CALL_IN_PROGRESS");
  });

  it("an uncertain provider response stays dispatch_unknown with no redial and no provider id", async () => {
    const c = await createReadyCase(h, SESSION_A, { ...COMPLETE_FIELDS, supportPhone: "+14155550002" });
    const { call } = await authorizeAndCall(h, c);
    expect(call.state).toBe("dispatch_unknown");
    expect(call.providerCallId).toBeNull();
    const again = await h.service.startCall(SESSION_A, c.id, { authorizationId: call.authorizationId, requestId: randomUUID() });
    expect(again.id).toBe(call.id);
    expect(again.state).toBe("dispatch_unknown");
    const cs = await h.service.getCase(SESSION_A, c.id);
    expect(cs.status).toBe("calling");
    expect(cs.outcome.decision).toBe("unknown");
    expect(cs.outcome.nextAction).toMatch(/will not redial/);
    await expectApi(() => h.service.patchCase(SESSION_A, c.id, 1, { amountMinor: 1 }), 409, "CALL_IN_PROGRESS");
  });

  it("a thrown provider error is treated as dispatch_unknown, not retried", async () => {
    const throwing = makeHarness({
      voice: {
        async startCall() {
          throw new Error("socket hang up");
        },
        async getCall() {
          throw new Error("unreachable");
        },
        async verifyWebhook() {
          return null;
        },
      },
    });
    try {
      const c = await createReadyCase(throwing);
      const { call } = await authorizeAndCall(throwing, c);
      expect(call.state).toBe("dispatch_unknown");
      expect(call.error).toContain("socket hang up");
    } finally {
      throwing.cleanup();
    }
  });

  it("a definitive pre-dispatch rejection is a 503; the failed attempt is retained and consumes the authorization", async () => {
    const c = await createReadyCase(h, SESSION_A, { ...COMPLETE_FIELDS, supportPhone: "+14155550001" });
    const a = h.service.authorize(SESSION_A, c.id, 1);
    const authorizationId = a.authorization!.id;
    await expectApi(h.service.startCall(SESSION_A, c.id, { authorizationId, requestId: randomUUID() }), 503, "PROVIDER_UNAVAILABLE");
    const calls = h.repo.listCalls(c.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.state).toBe("failed");
    expect(calls[0]?.providerCallId).toBeNull();
    // A repeat under the same authorization returns the stored attempt instead of dialing again.
    const repeat = await h.service.startCall(SESSION_A, c.id, { authorizationId, requestId: randomUUID() });
    expect(repeat.id).toBe(calls[0]?.id);
    const cs = await h.service.getCase(SESSION_A, c.id);
    expect(cs.status).toBe("authorized");
    expect(cs.outcome.nextAction).toMatch(/re-authorize/);
    expect(cs.timeline.some((t) => t.type === "call_dispatch_rejected")).toBe(true);
  });

  it("live mode without configuration fails with 503 before persisting anything", async () => {
    const live = makeHarness({ mode: "live" });
    try {
      await expectApi(
        live.service.createCase(SESSION_A, { summary: "Duplicate charge", files: [], fields: {} }),
        503,
        "LIVE_CONFIGURATION_MISSING",
      );
    } finally {
      live.cleanup();
    }
  });
});

describe("call completion and outcomes", () => {
  it("polling publishes the terminal state and outcome atomically; completion ≠ payment", async () => {
    const c = await createReadyCase(h);
    const { call } = await authorizeAndCall(h, c);
    h.clock.advance(1500);
    let cs = await h.service.getCase(SESSION_A, c.id);
    expect(cs.calls[0]?.state).toBe("in_progress");
    expect(cs.status).toBe("calling");
    h.clock.advance(5000);
    cs = await h.service.getCase(SESSION_A, c.id);
    expect(cs.calls[0]?.id).toBe(call.id);
    expect(cs.calls[0]?.state).toBe("completed");
    expect(cs.calls[0]?.transcript).toContain("reference number");
    expect(cs.outcome.decision).toBe("approved");
    expect(cs.outcome.referenceNumber).toMatch(/^REF-/);
    expect(cs.outcome.supportingQuote).toMatch(/processed the refund/);
    expect(cs.outcome.paymentStatus).toBe("unverified");
    expect(cs.status).toBe("approved");
    expect(cs.revision).toBe(1); // call/timeline updates never bump the revision
  });

  it("a completed call without an explicit approval is not approved", async () => {
    const c = await createReadyCase(h, SESSION_A, { ...COMPLETE_FIELDS, supportPhone: "+14155550004" });
    await authorizeAndCall(h, c);
    h.clock.advance(10_000);
    const cs = await h.service.getCase(SESSION_A, c.id);
    expect(cs.calls[0]?.state).toBe("completed");
    expect(cs.outcome.decision).toBe("needs_information");
    expect(cs.outcome.paymentStatus).toBe("unverified");
    expect(cs.status).toBe("needs_information");
    expect(cs.outcome.nextAction).toBeTruthy();
  });

  it("a denial is reported with the supporting quote", async () => {
    const c = await createReadyCase(h, SESSION_A, { ...COMPLETE_FIELDS, supportPhone: "+14155550003" });
    await authorizeAndCall(h, c);
    h.clock.advance(10_000);
    const cs = await h.service.getCase(SESSION_A, c.id);
    expect(cs.outcome.decision).toBe("denied");
    expect(cs.outcome.supportingQuote).toMatch(/cannot refund/);
    expect(cs.status).toBe("denied");
  });

  it("a failed call publishes an explicit unknown outcome with a next action", async () => {
    const c = await createReadyCase(h, SESSION_A, { ...COMPLETE_FIELDS, supportPhone: "+14155550005" });
    await authorizeAndCall(h, c);
    h.clock.advance(10_000);
    const cs = await h.service.getCase(SESSION_A, c.id);
    expect(cs.calls[0]?.state).toBe("failed");
    expect(cs.outcome.decision).toBe("unknown");
    expect(cs.outcome.nextAction).toMatch(/failed/);
    expect(cs.status).toBe("authorized");
  });

  it("the packet lists facts, evidence and outcome", async () => {
    const c = await createReadyCase(h);
    const text = h.service.packet(SESSION_A, c.id);
    expect(text).toContain("REFUND REQUEST PACKET");
    expect(text).toContain("receipt.txt");
    expect(text).toContain("$49.99");
    expect(text).toContain("SIMULATED");
  });
});
