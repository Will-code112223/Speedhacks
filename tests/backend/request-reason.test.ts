import { describe, expect, it } from "vitest";
import { buildBrief, buildDraft, type Facts } from "@/server/cases/facts";

describe("customer request reason", () => {
  const facts: Facts = {
    customer: { name: "Test customer", email: null },
    merchant: { name: "Amazon", supportPhone: "+12025550101" },
    amountMinor: 6500,
    currency: "USD",
    reason: "The shoes arrived damaged. I want to return them for a refund.",
  };

  it("does not turn a damaged-shoes request into a duplicate charge in generated documents", () => {
    const draft = buildDraft(facts, []);
    expect(draft?.body).toContain(facts.reason);
    expect(draft?.body).not.toMatch(/for a duplicate charge/i);
    expect(draft?.subject).not.toMatch(/duplicate/i);
    expect(draft?.body).not.toMatch(/eligible|approved|guaranteed/i);
  });

  it("freezes the stated reason in the call brief without adding a duplicate-charge assertion", () => {
    const brief = buildBrief({ ...facts, caseId: "test-case", revision: 1, merchant: { name: "Amazon", supportPhone: "+12025550101" }, amountMinor: 6500, evidence: [] });
    expect(brief).toContain(facts.reason);
    expect(brief).not.toMatch(/for a duplicate charge|refund of the duplicate/i);
    expect(brief).toContain("Do not assume");
  });
});
