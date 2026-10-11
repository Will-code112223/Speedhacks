import { describe, expect, it } from "vitest";
import type { CaseV1 } from "../../../../contracts/case";
import type { PlanRecord } from "../../plans/store";
import { attachmentsFor, namesSomeone } from "../attachments";
import { changesFromDraft, draftFromCase, validateFacts } from "../facts";
import { anyPurposeReady, blockingMissingFields, inferPurpose, initialPurpose, previewPlan } from "../purpose";

function caseWith(overrides: Partial<CaseV1>): CaseV1 {
  return {
    schemaVersion: 1,
    id: "case-1",
    revision: 1,
    mode: "simulated",
    status: "ready_for_approval",
    customer: { name: "Alex Rivera", email: null },
    merchant: { name: "State Farm", supportPhone: "+18007325246", source: null },
    amountMinor: null,
    currency: "USD",
    reason: "Water damage to the kitchen",
    evidence: [],
    missingFields: [],
    draft: null,
    authorization: null,
    calls: [],
    outcome: { decision: "unknown", referenceNumber: null, nextAction: null, paymentStatus: "unverified", supportingQuote: null },
    timeline: [],
    createdAt: "2026-10-11T00:00:00.000Z",
    updatedAt: "2026-10-11T00:00:00.000Z",
    ...overrides,
  };
}

describe("inferPurpose", () => {
  it.each([
    ["File a claim with State Farm for water damage to my kitchen on Oct 3, about $1,200.", "file_claim"],
    ["Ask Blue Shield of California what I need to file a claim for an out-of-network visit on Oct 3.", "gather_information"],
    ["Check the status of my Progressive auto claim.", "gather_information"],
    ["Dispute a duplicate $49.99 charge from Ridgeline Outfitters.", "request_refund"],
    ["Open a claim for my car accident", "file_claim"],
    ["How do I appeal a denied claim?", "gather_information"],
    ["Get my money back", "request_refund"],
  ] as const)("%s -> %s", (text, purpose) => {
    expect(inferPurpose(text)).toBe(purpose);
  });
});

describe("blockingMissingFields", () => {
  it("drops the amount for purposes that do not ask for money", () => {
    const caseData = caseWith({ missingFields: ["amountMinor", "customer.name"] });
    expect(blockingMissingFields(caseData, "request_refund")).toEqual(["amountMinor", "customer.name"]);
    expect(blockingMissingFields(caseData, "file_claim")).toEqual(["customer.name"]);
    expect(blockingMissingFields(caseData, "gather_information")).toEqual(["customer.name"]);
  });
});

describe("previewPlan", () => {
  it("names the policy, the loss and the claim ask from the facts", () => {
    const caseData = caseWith({ policyNumber: "SF-1234", claimType: "water damage", incidentDate: "2026-10-03", amountMinor: 120000 });
    const steps = previewPlan(caseData, "file_claim");
    expect(steps.map((step) => step.title)).toEqual([
      "Reach State Farm",
      "Identify the policy",
      "Report the loss",
      "Open the claim",
      "Record the outcome",
    ]);
    expect(steps[1]?.detail).toContain("SF-1234");
    expect(steps[2]?.detail).toContain("Water damage on Oct 3, 2026");
    expect(steps[3]?.detail).toContain("$1,200.00");
  });

  it("says an unknown policy number is unknown", () => {
    expect(previewPlan(caseWith({}), "gather_information")[1]?.detail).toMatch(/No policy number/);
  });
});

describe("insurance facts", () => {
  it("round-trips the nullable insurance facts through the draft", () => {
    const caseData = caseWith({ policyNumber: null, incidentDate: null });
    const draft = { ...draftFromCase(caseData), policyNumber: " SF-99 ", incidentDate: "2026-10-03", claimType: "" };
    expect(validateFacts(draft, caseData)).toEqual({});
    expect(changesFromDraft(caseData, draft)).toEqual({ policyNumber: "SF-99", incidentDate: "2026-10-03" });
  });

  it("rejects an impossible incident date", () => {
    const caseData = caseWith({});
    expect(validateFacts({ ...draftFromCase(caseData), incidentDate: "2026-02-30" }, caseData).incidentDate).toBeDefined();
  });
});

describe("plan insurer as merchantName", () => {
  const plan = (insurer: string): PlanRecord => ({
    id: crypto.randomUUID(),
    name: "",
    insurer,
    policyNumber: "",
    supportPhone: "",
    fileName: "policy.pdf",
    fileType: "application/pdf",
    fileSize: 3,
    fileLastModified: 0,
    addedAt: new Date(0).toISOString(),
    file: new Blob(["pdf"], { type: "application/pdf" }),
  });

  it("uses the plans' one insurer when the message names none", () => {
    expect(attachmentsFor("File a claim for water damage on Oct 3", [plan("Northwind Mutual")], "http").prefill).toEqual({
      merchantName: "Northwind Mutual",
    });
  });

  it("leaves the insurer to the message when it names one", () => {
    expect(attachmentsFor("File a claim with State Farm for water damage", [plan("Northwind Mutual")], "http").prefill).toEqual({});
  });

  it("does not guess between plans from different insurers", () => {
    expect(attachmentsFor("File a claim for water damage", [plan("Northwind Mutual"), plan("Harbor Health")], "http").prefill).toEqual({});
  });

  it("reads capitalized words after the first as names", () => {
    expect(namesSomeone("Check the status of my Progressive auto claim.")).toBe(true);
    expect(namesSomeone("File a claim for water damage on Oct 3. I need help.")).toBe(false);
  });
});

describe("initialPurpose", () => {
  it("starts on the server's suggested purpose", () => {
    expect(initialPurpose(caseWith({ suggestedPurpose: "file_claim" }), "My kitchen flooded")).toBe("file_claim");
  });

  it("keeps a question as a question", () => {
    expect(initialPurpose(caseWith({ suggestedPurpose: "file_claim" }), "What do I need to file a claim?")).toBe("gather_information");
  });

  it("offers a ready purpose when the suggested one lacks facts", () => {
    const caseData = caseWith({
      suggestedPurpose: "request_refund",
      missingFields: ["amountMinor"],
      missingFieldsByPurpose: { request_refund: ["amountMinor"], file_claim: ["policyNumber"], gather_information: [] },
    });
    expect(initialPurpose(caseData, "Dispute a charge")).toBe("gather_information");
    expect(anyPurposeReady(caseData)).toBe(true);
    expect(blockingMissingFields(caseData, "file_claim")).toEqual(["policyNumber"]);
  });

  it("uses the authorized purpose once there is one", () => {
    const caseData = caseWith({ authorization: { id: "a", revision: 1, approvedAt: "2026-10-11T00:00:00.000Z", purpose: "gather_information" } });
    expect(initialPurpose(caseData, "File a claim")).toBe("gather_information");
  });
});
