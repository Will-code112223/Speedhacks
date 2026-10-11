import { describe, expect, it } from "vitest";
import { validateCallPlan } from "@/contracts/voice";
import { buildCallPlan } from "@/server/cases/facts";
import { MAX_OUTBOUND_INSTRUCTION_CHARS, planInstruction } from "@/integrations/dial";

// End to end from case facts to the exact Dial outboundInstruction. Synthetic fixture only.
const CASE_ID = "00000000-0000-4000-8000-000000000002";
const base = {
  caseId: CASE_ID,
  revision: 3,
  customer: { name: "Synthetic Person", email: "synthetic.person@example.com" },
  merchantName: "Northwind Mutual",
  amountMinor: null,
  currency: "USD",
  reason: "Water damage in the kitchen from a burst supply line.",
  evidence: [{ id: "00000000-0000-4000-8000-0000000000e1", name: "kitchen-photo-1.jpg", mimeType: "image/jpeg" }],
};
const insurance = {
  policyNumber: "NM-HO-0000-SYN1",
  incidentDate: "2026-10-03",
  lossDescription: "A supply line under the kitchen sink burst and soaked the kitchen floor and lower cabinets.",
  claimType: "water damage",
};

describe("buildCallPlan -> Dial instruction", () => {
  it("file_claim carries the insurance facts, a goal, steps and a read-back, and no placeholders", () => {
    const plan = buildCallPlan({ ...base, purpose: "file_claim", ...insurance, amountMinor: 485000 });
    expect(validateCallPlan(plan)).toEqual([]);
    expect(plan.goal).toBe("Open a new water damage claim with Northwind Mutual for the loss on October 3, 2026 and get the claim number.");
    expect(plan.questions.map((q) => q.id)).toEqual(["claim_number", "next_steps", "documents"]);
    expect(plan.permittedDisclosures).not.toContain("amountMinor");
    expect(plan.readBack).toMatch(/claim number one character at a time/);
    const text = planInstruction(plan);
    for (const fact of Object.values(insurance)) expect(text).toContain(fact);
    expect(text).toMatch(/say you are an AI assistant calling with the client's authorization/);
    expect(text).not.toMatch(/\[amount missing\]|undefined/);
    expect(text).not.toContain("485000");
    expect(text.length).toBeLessThan(MAX_OUTBOUND_INSTRUCTION_CHARS);
  });

  it("file_claim without a policy number tells the agent not to offer one", () => {
    const plan = buildCallPlan({ ...base, purpose: "file_claim", ...insurance, policyNumber: null });
    expect(validateCallPlan(plan)).toEqual([]);
    expect(plan.facts.policyNumber).toBeNull();
    expect(plan.steps?.join(" ")).toMatch(/the policy number is not known, so do not offer one/);
  });

  it("file_claim without the date or loss description is invalid, so it can never be frozen", () => {
    const plan = buildCallPlan({ ...base, purpose: "file_claim", ...insurance, incidentDate: null });
    expect(validateCallPlan(plan).join(" ")).toMatch(/file_claim requires/);
  });

  it("gather_information for an insurer asks how to file, documents, deadline and hours", () => {
    const plan = buildCallPlan({ ...base, purpose: "gather_information", ...insurance });
    expect(validateCallPlan(plan)).toEqual([]);
    expect(plan.questions.map((q) => q.id)).toEqual(["how_to_file", "documents", "deadline", "hours", "reference"]);
    expect(plan.questions[0]?.text).toContain("a water damage claim");
    expect(plan.goal).toMatch(/Do not file it\./);
    expect(planInstruction(plan)).toMatch(/If a menu or a person starts a claim intake, say you only have questions today/);
  });

  it("refund and charge plans keep their V1.1 facts and questions", () => {
    const refund = buildCallPlan({ ...base, purpose: "request_refund", merchantName: "Synthetic Merchant", amountMinor: 4999 });
    expect(validateCallPlan(refund)).toEqual([]);
    expect(Object.keys(refund.facts)).not.toContain("policyNumber");
    expect(refund.questions.map((q) => q.id)).toEqual(["reference", "timeline"]);
    expect(refund.goal).toBe("Ask Synthetic Merchant to refund the duplicate charge of $49.99 and get a reference number.");
    const info = buildCallPlan({ ...base, purpose: "gather_information", merchantName: "Synthetic Merchant" });
    expect(info.questions.map((q) => q.id)).toEqual(["amount", "requirements", "reference"]);
  });
});
