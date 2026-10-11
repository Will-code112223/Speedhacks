import { describe, expect, it } from "vitest";
import { inferScenario } from "../fixture";
import { CASE_NOT_FOUND_MESSAGE } from "../messages";
import { randomUuid } from "../uuid";
import { isCallV1, isCaseV1, isLiveCallV2 } from "../validate";
import { authorizationIdOf, failureOf, fixture } from "./support";

describe("fixture: creating a case", () => {
  it("extracts the insurance scenario's facts and labels the case simulated", async () => {
    const { api } = fixture();
    const c = await api.createCase({ summary: "File a claim for the water damage on Oct 3" });
    expect(isCaseV1(c)).toBe(true);
    expect(c).toMatchObject({
      schemaVersion: 1,
      mode: "simulated",
      revision: 1,
      status: "ready_for_approval",
      customer: { name: "Jordan Avery", email: null },
      merchant: { name: "Northwind Mutual claims line", supportPhone: "+14155550162" },
      amountMinor: 120_000,
      currency: "USD",
      reason: "File a claim for the water damage on Oct 3",
      missingFields: [],
      authorization: null,
      calls: [],
      outcome: { decision: "unknown", paymentStatus: "unverified" },
    });
    expect(c.draft?.subject).toBe("Claim request: $1,200.00 with Northwind Mutual claims line");
    expect(c.timeline.map((t) => t.type)).toEqual(["case_created", "facts_extracted", "ready_for_approval"]);
  });

  it("lets explicit fields override extraction and records uploaded evidence", async () => {
    const { api } = fixture("duplicate_charge");
    const receipt = new File(["%PDF-1.7"], "receipt.pdf", { type: "application/pdf" });
    const c = await api.createCase({ summary: "", files: [receipt], amountMinor: 2_500, customerEmail: "jordan@example.com" });
    expect(c.amountMinor).toBe(2_500);
    expect(c.customer.email).toBe("jordan@example.com");
    expect(c.reason).toBe("Charged twice for the same order; refund the duplicate charge.");
    expect(c.evidence).toEqual([{ id: expect.any(String), name: "receipt.pdf", mimeType: "application/pdf" }]);
    expect(c.draft?.body).toContain("1. receipt.pdf (application/pdf)");
    expect(c.timeline.find((t) => t.type === "evidence_added")?.message).toBe(
      "Attached receipt.pdf (application/pdf, 8 bytes).",
    );
  });

  it("rejects input the server would reject", async () => {
    const { api } = fixture("duplicate_charge");
    expect(await failureOf(api.createCase({ summary: "   " }))).toMatchObject({
      status: 400,
      code: "BAD_REQUEST",
      fields: ["summary", "files"],
    });
    expect(await failureOf(api.createCase({ summary: "duplicate", supportPhone: "555-0100", currency: "dollars" })))
      .toMatchObject({ status: 400, code: "BAD_REQUEST", fields: ["supportPhone", "currency"] });
  });

  it("answers 404 with the session message for an unknown case", async () => {
    const { api } = fixture("duplicate_charge");
    const missing = await failureOf(api.getCase(randomUuid()));
    expect(missing).toMatchObject({ status: 404, code: "NOT_FOUND", message: CASE_NOT_FOUND_MESSAGE });
  });
});

describe("fixture: revisions", () => {
  it("rejects a stale expectedRevision and bumps the revision only when facts change", async () => {
    const { api } = fixture("duplicate_charge");
    const c = await api.createCase({ summary: "duplicate charge" });
    const patched = await api.patchCase(c.id, 1, { amountMinor: 5_000 });
    expect(patched.revision).toBe(2);
    expect(patched.timeline.at(-1)).toMatchObject({ type: "facts_updated" });

    const stale = await failureOf(api.patchCase(c.id, 1, { amountMinor: 5_100 }));
    expect(stale).toMatchObject({ status: 409, code: "REVISION_CONFLICT", message: "Case is at revision 2, not 1" });

    const unchanged = await api.patchCase(c.id, 2, { amountMinor: 5_000 });
    expect(unchanged.revision).toBe(2);
    expect(unchanged.timeline).toHaveLength(patched.timeline.length);
  });

  it("validates changes like the server", async () => {
    const { api } = fixture("duplicate_charge");
    const c = await api.createCase({ summary: "duplicate charge" });
    const invalid = await failureOf(
      api.patchCase(c.id, 1, { merchant: { name: "Ridgeline", supportPhone: "555-0100" }, amountMinor: -5 }),
    );
    expect(invalid).toMatchObject({ status: 400, code: "BAD_REQUEST", fields: ["merchant.supportPhone", "amountMinor"] });
    expect(await failureOf(api.patchCase(c.id, 0, {}))).toMatchObject({ status: 400, fields: ["expectedRevision"] });
  });
});

describe("fixture: authorization", () => {
  it("refuses authorization with 422 until the missing facts are filled", async () => {
    const { api } = fixture("needs_evidence");
    const c = await api.createCase({ summary: "Charged twice and I lost the receipt" });
    expect(c.status).toBe("needs_information");
    expect([...c.missingFields].sort()).toEqual(["amountMinor", "merchant.supportPhone"]);
    expect(c.draft).toBeNull();
    expect(c.timeline.at(-1)).toMatchObject({ type: "needs_information" });

    const refused = await failureOf(api.authorize(c.id, 1));
    expect(refused).toMatchObject({ status: 422, code: "MISSING_REQUIRED_FACTS" });
    expect([...(refused.fields ?? [])].sort()).toEqual(["amountMinor", "merchant.supportPhone"]);

    const filled = await api.patchCase(c.id, 1, {
      amountMinor: 4_999,
      merchant: { name: "Ridgeline Outfitters billing", supportPhone: "+14155550177" },
    });
    expect(filled).toMatchObject({ status: "ready_for_approval", revision: 2, missingFields: [] });
    expect(filled.draft?.subject).toBe("Refund request: duplicate charge of $49.99 at Ridgeline Outfitters billing");
    expect(filled.timeline.at(-1)).toMatchObject({ type: "ready_for_approval" });

    const authorized = await api.authorize(c.id, 2);
    expect(authorized).toMatchObject({ status: "authorized", authorization: { revision: 2 } });
  });

  it("is idempotent for a revision and cleared by a material edit", async () => {
    const { api } = fixture("duplicate_charge");
    const c = await api.createCase({ summary: "duplicate charge" });
    const first = await api.authorize(c.id, 1);
    const again = await api.authorize(c.id, 1);
    expect(first.status).toBe("authorized");
    expect(authorizationIdOf(again)).toBe(authorizationIdOf(first));
    expect(again.timeline.filter((t) => t.type === "authorized")).toHaveLength(1);

    const edited = await api.patchCase(c.id, 1, { reason: "Charged twice on Oct 2" });
    expect(edited).toMatchObject({ status: "ready_for_approval", authorization: null, revision: 2 });
    expect(edited.draft?.body).toContain("Reason: Charged twice on Oct 2");
    expect(edited.timeline.map((t) => t.type)).toContain("authorization_cleared");

    const reauthorized = await api.authorize(c.id, 2);
    expect(authorizationIdOf(reauthorized)).not.toBe(authorizationIdOf(first));
    const stale = await failureOf(
      api.startCall(c.id, { authorizationId: authorizationIdOf(first), requestId: randomUuid() }),
    );
    expect(stale).toMatchObject({ status: 409, code: "AUTHORIZATION_CONFLICT" });
  });
});

describe("fixture: dispatch", () => {
  it("returns the stored call for a repeated requestId or authorization instead of dialing again", async () => {
    const { api } = fixture("duplicate_charge");
    const c = await api.createCase({ summary: "duplicate charge" });
    const authorizationId = authorizationIdOf(await api.authorize(c.id, 1));
    const requestId = randomUuid();

    const first = await api.startCall(c.id, { authorizationId, requestId });
    const retry = await api.startCall(c.id, { authorizationId, requestId });
    const doubleClick = await api.startCall(c.id, { authorizationId, requestId: randomUuid() });
    expect(isCallV1(first)).toBe(true);
    expect(first).toMatchObject({ state: "queued", mode: "simulated", requestId, authorizationId, transcript: null });
    expect(retry.id).toBe(first.id);
    expect(doubleClick.id).toBe(first.id);

    const after = await api.getCase(c.id);
    expect(after.status).toBe("calling");
    expect(after.calls).toHaveLength(1);
    expect(after.timeline.filter((t) => t.type === "call_requested")).toHaveLength(1);
  });

  it("rejects malformed and conflicting call requests", async () => {
    const { api } = fixture("duplicate_charge");
    const one = await api.createCase({ summary: "duplicate charge" });
    const two = await api.createCase({ summary: "duplicate charge" });
    const authOne = authorizationIdOf(await api.authorize(one.id, 1));
    const authTwo = authorizationIdOf(await api.authorize(two.id, 1));
    const requestId = randomUuid();

    expect(await failureOf(api.startCall(one.id, { authorizationId: authOne, requestId: "retry-1" }))).toMatchObject({
      status: 400,
      fields: ["requestId"],
    });
    expect(await failureOf(api.startCall(one.id, { authorizationId: authTwo, requestId }))).toMatchObject({
      status: 409,
      code: "AUTHORIZATION_CONFLICT",
      message: "Unknown authorization for this case",
    });
    await api.startCall(one.id, { authorizationId: authOne, requestId });
    expect(await failureOf(api.startCall(two.id, { authorizationId: authTwo, requestId }))).toMatchObject({
      status: 409,
      code: "AUTHORIZATION_CONFLICT",
      message: "requestId was already used for a different action",
    });
  });

  it("rejects edits and new authorizations while a call is active", async () => {
    const { api } = fixture("duplicate_charge");
    const c = await api.createCase({ summary: "duplicate charge" });
    const authorizationId = authorizationIdOf(await api.authorize(c.id, 1));
    await api.startCall(c.id, { authorizationId, requestId: randomUuid() });

    expect(await failureOf(api.patchCase(c.id, 1, { amountMinor: 100 }))).toMatchObject({
      status: 409,
      code: "CALL_IN_PROGRESS",
    });
    expect(await failureOf(api.authorize(c.id, 1))).toMatchObject({ status: 409, code: "CALL_IN_PROGRESS" });
  });

  it("keeps a refused dispatch as a failed attempt with an ended live record and answers 503", async () => {
    const { api } = fixture("duplicate_charge");
    const c = await api.createCase({ summary: "duplicate charge", supportPhone: "+14155550001" });
    const authorizationId = authorizationIdOf(await api.authorize(c.id, 1));
    const requestId = randomUuid();

    const refused = await failureOf(api.startCall(c.id, { authorizationId, requestId }));
    expect(refused).toMatchObject({ status: 503, code: "PROVIDER_UNAVAILABLE" });
    const retry = await api.startCall(c.id, { authorizationId, requestId });
    expect(retry).toMatchObject({ state: "failed", providerCallId: null });
    expect(retry.error).toContain("FIXTURE_REJECTED");

    const after = await api.getCase(c.id);
    expect(after.status).toBe("authorized");
    expect(after.calls).toHaveLength(1);
    expect(after.outcome.nextAction).toContain("refused the call before dispatch");
    expect(after.timeline.map((t) => t.type)).toContain("call_dispatch_rejected");

    // The attempt is over, so its live record says so and pollers stop.
    const live = await api.getLiveCall(c.id, retry.id);
    expect(isLiveCallV2(live)).toBe(true);
    expect(live).toMatchObject({ phase: "ended", startedAt: null, pendingDecision: null, userJoined: false });
    expect(live?.notes.map((n) => n.text)).toEqual(["The provider refused the call before dialing. Nothing was dialed."]);
    expect(await failureOf(api.stepIn(c.id, retry.id))).toMatchObject({
      status: 409,
      code: "CALL_ENDED",
      message: "This call attempt ended without connecting.",
    });
  });
});

describe("fixture: packet", () => {
  it("downloads a text/plain packet that says it is simulated", async () => {
    const { api } = fixture("duplicate_charge");
    const receipt = new File(["%PDF"], "receipt.pdf", { type: "application/pdf" });
    const c = await api.createCase({ summary: "duplicate charge", files: [receipt] });
    const blob = await api.downloadPacket(c.id);
    expect(blob.type).toBe("text/plain;charset=utf-8");
    const text = await blob.text();
    expect(text).toContain("REFUND REQUEST PACKET");
    expect(text).toContain("SIMULATED");
    expect(text).toContain(`Case: ${c.id}`);
    expect(text).toContain("1. receipt.pdf");
    expect(text).toContain("Subject: Refund request: duplicate charge of $49.99 at Ridgeline Outfitters billing");
  });
});

describe("inferScenario", () => {
  it.each([
    ["File an insurance claim for the water damage", "insurance_claim"],
    ["My claim for the duplicate charge", "insurance_claim"],
    ["Duplicate charge at Ridgeline", "duplicate_charge"],
    ["DUPLICATE in capitals", "duplicate_charge"],
    ["Charged twice and I have no receipt", "needs_evidence"],
    ["I lost the order email", "needs_evidence"],
    ["Run the uncertain dispatch", "uncertain_dispatch"],
    ["Please confirm the refund", "call_complete_unconfirmed"],
    ["Something else entirely", "insurance_claim"],
  ] as const)("reads %j as %s", (summary, scenario) => {
    expect(inferScenario(summary)).toBe(scenario);
  });
});
