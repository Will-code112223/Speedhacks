import { describe, expect, it } from "vitest";
import type { CaseWorkflow, WorkflowContact } from "@/contracts/workflow";
import { rebuildWorkflow } from "@/server/workflows/planning";
import { caseData, at } from "@/features/refund-ui/browser/__tests__/support";

function plan(provider: string, contacts: WorkflowContact[] = [], conflicts: string[] = []) {
  const values = { insuranceProvider: provider, incidentDescription: "Rear bumper dent", lossDate: "October 10, 2026", lossLocation: "Oakland", vehicle: "2022 Honda Civic", claimantRole: "policyholder", desiredOutcome: "Prepare a packet for review" };
  const workflow: CaseWorkflow = { caseId: "case-1", caseRevision: 2, kind: "auto_insurance", stage: "ready", analysisStatus: "complete",
    facts: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { label: key, value, source: "user", sourceRefs: ["message-1"] }])),
    messages: [], questions: [], conflicts, contacts: [], brief: { title: "", body: "", updatedAt: at }, actions: [], updatedAt: at };
  const before = structuredClone(contacts);
  const result = rebuildWorkflow(workflow, caseData({ reason: "Prepare an insurance claim", merchant: { name: null, supportPhone: null } }), contacts, at);
  expect(contacts).toEqual(before);
  return result;
}

describe("insurance browser preparation", () => {
  it("provides the official AAA regional entry without inferring a policy carrier from Oakland", () => {
    const workflow = plan("AAA");
    const browser = workflow.actions.find(action => action.type === "browser");
    expect(browser?.browser?.startUrl).toBe("https://www.aaa.com/");
    expect(browser?.browser?.allowedHosts).toEqual(["www.aaa.com"]);
    expect(workflow.contacts[0]).toMatchObject({ phone: null, requiresConfirmation: true, sourceUrl: "https://www.aaa.com/" });
    expect(browser?.browser?.task).toContain("Rear bumper dent");
    expect(browser?.browser?.task).toContain("never infer them from the incident location");
    expect(browser?.browser?.task).toContain("do not type or upload them to a real provider");
    expect(browser?.browser?.task).toContain("Stop before final submission");
    expect(browser?.browser?.task).not.toContain("mypolicy");
  });

  it("offers CSAA MyPolicy only when the recorded carrier is explicitly CSAA", () => {
    const workflow = plan("CSAA Insurance Group, a AAA Insurer");
    const action = workflow.actions.find(action => action.type === "browser");
    expect(action?.browser?.startUrl).toBe("https://www.mypolicy.csaa-insurance.aaa.com/");
    expect(action?.title).toContain("policy ZIP required");
    expect(workflow.facts).not.toHaveProperty("policyNumber");
    expect(workflow.questions).toContainEqual(expect.objectContaining({ field: "policyNumber", required: false }));
  });

  it("preserves sourced portal choices and does not invent a portal for an unknown insurer", () => {
    const contact: WorkflowContact = { id: "verified", role: "insurer", name: "User's carrier", phone: null,
      url: "https://claims.example.com/", source: "document", sourceUrl: "https://claims.example.com/", requiresConfirmation: true };
    expect(plan("AAA", [contact]).contacts).toEqual([contact]);
    expect(plan("An unknown insurer").actions.some(action => action.type === "browser")).toBe(false);
  });

  it("keeps material conflicts blocking the actual provider task", () => {
    const workflow = plan("AAA", [], ["lossDate: two different dates need clarification"]);
    expect(workflow.actions.find(action => action.type === "browser")).toMatchObject({ status: "blocked", blockedBy: ["Resolve conflicting evidence before using it externally"] });
  });
});
