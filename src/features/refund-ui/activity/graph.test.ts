import { describe, expect, it } from "vitest";
import type { CallV1, CaseV1 } from "../../../contracts/case";
import { activityGraph } from "./graph";

const at = "2026-10-11T19:00:00.000Z";
function makeCase(overrides: Partial<CaseV1> = {}): CaseV1 {
  return {
    schemaVersion: 1, id: "case-1", revision: 2, mode: "simulated", status: "ready_for_approval",
    customer: { name: "Fictional Customer", email: null }, merchant: { name: "Fictional Insurer", supportPhone: null },
    amountMinor: 12000, currency: "USD", reason: "Fictional duplicate charge", evidence: [], missingFields: [],
    draft: { subject: "Fictional refund", body: "Request a refund." }, authorization: null, calls: [],
    outcome: { decision: "unknown", referenceNumber: null, nextAction: null, paymentStatus: "unverified", supportingQuote: null },
    timeline: [], createdAt: at, updatedAt: at, ...overrides,
  };
}
function makeCall(overrides: Partial<CallV1> = {}): CallV1 {
  return { id: "call-1", requestId: "request-1", authorizationId: "approval-2", providerCallId: null, mode: "simulated", state: "dispatch_pending", transcript: null, error: null, createdAt: at, updatedAt: at, ...overrides };
}
const authorization = { id: "approval-2", revision: 2, approvedAt: at };

describe("activity graph topology and provenance", () => {
  it("renders a connected branched graph with seven distinct nodes within the world", () => {
    const graph = activityGraph(null, null, false);
    const ids = new Set(graph.nodes.map((node) => node.id));
    expect(ids.size).toBe(7);
    expect(new Set(graph.edges.map((edge) => edge.id)).size).toBe(graph.edges.length);
    expect(graph.nodes.every((node) => node.x > 0 && node.x < 960 && node.y > 0 && node.y < 590)).toBe(true);
    expect(graph.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
    expect(graph.edges.every((edge) => edge.state === "pending")).toBe(true);
    expect(graph.edges.filter((edge) => edge.target === "agent")).toHaveLength(2);
    expect(graph.edges.filter((edge) => edge.source === "agent").length).toBeGreaterThan(1);
    expect(graph.nodes.find((node) => node.id === "agent")?.tone).toBe("idle");
  });

  it("records an approved dispatch even before polling adds the returned call to case.calls", () => {
    const caseData = makeCase({ authorization });
    const graph = activityGraph(caseData, makeCall(), false);
    expect(caseData.calls).toHaveLength(0);
    expect(graph.edges.find((edge) => edge.id === "approval-dial")).toMatchObject({ state: "recorded", label: "Dispatch requested" });
    expect(graph.edges.find((edge) => edge.id === "dial-outcome")?.state).toBe("pending");
    expect(graph.nodes.find((node) => node.id === "dial")?.status).toBe("dispatch pending");
  });

  it("keeps an uncertain dispatch relationship without claiming a connected call or outcome", () => {
    const graph = activityGraph(makeCase({ authorization }), makeCall({ state: "dispatch_unknown" }), false);
    expect(graph.edges.find((edge) => edge.id === "approval-dial")?.label).toBe("Dispatch requested");
    expect(graph.nodes.find((node) => node.id === "dial")?.tone).toBe("attention");
    expect(graph.edges.find((edge) => edge.id === "dial-outcome")?.state).toBe("pending");
  });

  it("routes a historical call through prior authorization, never the current approval", () => {
    const prior = makeCall({ authorizationId: "approval-1", state: "completed" });
    const graph = activityGraph(makeCase({ authorization, calls: [prior] }), prior, false);
    expect(graph.edges.find((edge) => edge.id === "agent-dial")).toMatchObject({ state: "historical", label: "Prior authorization" });
    expect(graph.edges.some((edge) => edge.id === "approval-dial")).toBe(false);
    expect(graph.edges.some((edge) => edge.id === "dial-outcome")).toBe(false);
    expect(graph.nodes.find((node) => node.id === "dial")?.status).toContain("Prior call");
  });

  it("does not reuse a stale revision authorization as current even if its ID matches", () => {
    const call = makeCall({ state: "completed" });
    const graph = activityGraph(makeCase({ revision: 3, authorization, calls: [call] }), call, false);
    expect(graph.edges.find((edge) => edge.id === "brief-approval")?.state).toBe("pending");
    expect(graph.edges.find((edge) => edge.id === "agent-dial")?.state).toBe("historical");
    expect(graph.edges.some((edge) => edge.id === "approval-dial")).toBe(false);
    expect(graph.nodes.find((node) => node.id === "approval")).toMatchObject({ status: "Prior revision", tone: "attention" });
    expect(graph.nodes.find((node) => node.id === "approval")?.description).toContain("revision 2, not the current revision 3");
    expect(graph.nodes.find((node) => node.id === "dial")).toMatchObject({ status: "Prior call · completed", tone: "idle" });
    expect(graph.nodes.find((node) => node.id === "dial")?.description).toContain("prior authorization, not the current case brief");
    expect(graph.call).toBe(call);
  });

  it("does not attach an unrelated supplied call to this case", () => {
    const unrelated = makeCall({ authorizationId: "different-case-approval" });
    const graph = activityGraph(makeCase({ authorization }), unrelated, false);
    expect(graph.nodes.find((node) => node.id === "dial")?.status).toBe("Not started");
    expect(graph.edges.find((edge) => edge.id === "approval-dial")?.state).toBe("pending");
    expect(graph.edges.some((edge) => edge.state === "historical")).toBe(false);
    expect(graph.call).toBeNull();
  });

  it("rejects a conflicting authorization on a known call ID", () => {
    const graph = activityGraph(makeCase({ authorization, calls: [makeCall({ authorizationId: "old-approval" })] }), makeCall(), false);
    expect(graph.nodes.find((node) => node.id === "dial")?.status).toBe("Not started");
  });

  it("does not infer an outcome from a completed call", () => {
    const graph = activityGraph(makeCase({ authorization }), makeCall({ state: "completed" }), false);
    expect(graph.edges.find((edge) => edge.id === "dial-outcome")?.state).toBe("pending");
    expect(graph.edges.find((edge) => edge.id === "agent-outcome")?.state).toBe("pending");
    expect(graph.nodes.find((node) => node.id === "outcome")?.status).toBe("Not established");
  });

  it("records support approval without implying payment or attributing it to a prior call", () => {
    const prior = makeCall({ authorizationId: "old-approval", state: "completed" });
    const caseData = makeCase({ authorization, calls: [prior], outcome: { decision: "approved", referenceNumber: null, nextAction: null, paymentStatus: "unverified", supportingQuote: "Fictional approval" } });
    const graph = activityGraph(caseData, prior, true);
    expect(graph.edges.find((edge) => edge.id === "agent-outcome")?.state).toBe("recorded");
    expect(graph.edges.some((edge) => edge.id === "dial-outcome")).toBe(false);
    expect(graph.nodes.find((node) => node.id === "outcome")?.facts).toContain("Payment unverified");
  });

  it("records a reconciled current call outcome while keeping fixture provenance", () => {
    const caseData = makeCase({ authorization, outcome: { decision: "needs_information", referenceNumber: null, nextAction: "Supply a fictional receipt", paymentStatus: "unverified", supportingQuote: null } });
    const graph = activityGraph(caseData, makeCall({ state: "completed", mode: "live" }), true);
    expect(graph.edges.find((edge) => edge.id === "dial-outcome")?.state).toBe("recorded");
    expect(graph.nodes.find((node) => node.id === "dial")?.facts[0]).toBe("Fixture");
    expect(graph.nodes.find((node) => node.id === "outcome")?.tone).toBe("attention");
  });

  it("ignores a detached call when no case exists and never mutates supplied records", () => {
    const call = makeCall();
    const graph = activityGraph(null, call, false);
    expect(graph.nodes.find((node) => node.id === "dial")?.status).toBe("Not started");
    expect(graph.call).toBeNull();
    const caseData = makeCase({ authorization, calls: [call] });
    const before = JSON.stringify({ caseData, call });
    activityGraph(caseData, call, false);
    expect(JSON.stringify({ caseData, call })).toBe(before);
  });
});
