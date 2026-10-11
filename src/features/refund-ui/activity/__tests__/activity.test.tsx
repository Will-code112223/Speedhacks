import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CallV1, CaseV1 } from "../../../../contracts/case";
import ActivityGraph from "../ActivityGraph";
import { activityMode, activityNodes } from "../model";

const at = "2026-10-11T19:00:00.000Z";
function makeCase(overrides: Partial<CaseV1> = {}): CaseV1 {
  return {
    schemaVersion: 1, id: "case-1", revision: 1, mode: "simulated", status: "needs_information",
    customer: { name: null, email: null }, merchant: { name: null, supportPhone: null }, amountMinor: null,
    currency: "USD", reason: "A fictional duplicated charge", evidence: [], missingFields: ["customer.name", "amountMinor"], draft: null,
    authorization: null, calls: [], outcome: { decision: "unknown", referenceNumber: null, nextAction: null, paymentStatus: "unverified", supportingQuote: null },
    timeline: [], createdAt: at, updatedAt: at, ...overrides,
  };
}
function makeCall(overrides: Partial<CallV1> = {}): CallV1 {
  return { id: "call-1", requestId: "request-1", authorizationId: "approval-1", providerCallId: null, mode: "live", state: "dispatch_pending", transcript: null, error: null, createdAt: at, updatedAt: at, ...overrides };
}

describe("activity graph snapshot projection", () => {
  it("does not fabricate connected systems or facts before a case exists", () => {
    const nodes = activityNodes(null, null, false);
    expect(nodes.every((node) => node.tone === "idle")).toBe(true);
    expect(nodes.flatMap((node) => node.facts)).toEqual([]);
    expect(activityMode(null, null, false)).toBe("Workflow preview");
  });

  it("shows unavailable facts without pretending evidence was verified", () => {
    const nodes = activityNodes(makeCase(), null, false);
    expect(nodes.find((node) => node.id === "brief")).toMatchObject({ status: "Needs facts", tone: "attention", facts: ["Missing: Your name", "Missing: Amount"] });
    expect(nodes.find((node) => node.id === "evidence")).toMatchObject({ status: "No case files", tone: "idle" });
    expect(nodes.find((node) => node.id === "approval")?.status).toBe("Not approved");
  });

  it("marks ambiguous dispatch as uncertain and never safe to retry", () => {
    const call = makeCall({ state: "dispatch_unknown" });
    const dial = activityNodes(makeCase({ mode: "live" }), call, false).find((node) => node.id === "dial")!;
    expect(dial).toMatchObject({ status: "Prior call · dispatch unknown", tone: "attention" });
    expect(dial.description).toContain("do not start a replacement call");
    expect(dial.facts).toContain("No transcript available yet");
  });

  it("gives fixture provenance precedence even if a supplied call says live", () => {
    const call = makeCall({ state: "in_progress" });
    expect(activityMode(makeCase({ mode: "live" }), call, true)).toBe("Simulated");
    const dial = activityNodes(makeCase(), call, true).find((node) => node.id === "dial")!;
    expect(dial.facts[0]).toBe("Simulated");
    expect(dial.description).toContain("No real phone call was placed");
  });

  it("does not label a simulated call live just because its case says live", () => {
    const caseData = makeCase({ mode: "live" });
    const call = makeCall({ mode: "simulated", state: "completed" });
    expect(activityMode(caseData, call, false)).toBe("Simulated");
    const dial = activityNodes(caseData, call, false).find((node) => node.id === "dial")!;
    expect(dial.facts[0]).toBe("Simulated");
    expect(dial.description).toContain("No real phone call");
  });

  it("distinguishes live configuration from an actual call record", () => {
    const caseData = makeCase({ mode: "live" });
    expect(activityMode(caseData, null, false)).toBe("Live mode · no call yet");
    expect(activityMode(caseData, makeCall(), false)).toBe("Live call record");
  });

  it("does not infer an outcome or transcript from call completion", () => {
    const nodes = activityNodes(makeCase(), makeCall({ state: "completed" }), false);
    expect(nodes.find((node) => node.id === "outcome")).toMatchObject({ status: "Not established", tone: "idle" });
    expect(nodes.find((node) => node.id === "dial")?.facts).toContain("No transcript available yet");
  });

  it("labels a retained call after facts are revised instead of connecting it to the new brief", () => {
    const oldCall = makeCall({ state: "completed", transcript: "Please send a receipt." });
    const revised = makeCase({ revision: 2, authorization: null, calls: [oldCall] });
    const nodes = activityNodes(revised, oldCall, false);
    expect(nodes.find((node) => node.id === "dial")).toMatchObject({ status: "Prior call · completed", tone: "idle" });
    expect(nodes.find((node) => node.id === "dial")?.description).toContain("not the current case brief");
    expect(nodes.find((node) => node.id === "dial")?.facts).toContain("Transcript available");
    expect(nodes.find((node) => node.id === "approval")?.status).toBe("Not approved");
    expect(nodes.find((node) => node.id === "outcome")?.status).toBe("Not established");
  });

  it("keeps an approval separate from payment and shows partial offers verbatim", () => {
    const caseData = makeCase({ outcome: { decision: "approved", referenceNumber: "test-1", nextAction: "Partial offer: review the $25 credit", paymentStatus: "unverified", supportingQuote: "We can offer a $25 credit." } });
    const outcome = activityNodes(caseData, makeCall({ state: "completed" }), true).find((node) => node.id === "outcome")!;
    expect(outcome.status).toBe("approved");
    expect(outcome.facts).toContain("Payment unverified");
    expect(outcome.facts).toContain("Partial offer: review the $25 credit");
  });

  it("exposes keyboard-operable node controls", () => {
    const html = renderToStaticMarkup(<ActivityGraph caseData={null} call={null} fixture={false} />);
    expect(html.match(/aria-pressed=/g)).toHaveLength(7);
    expect(html).toContain("Interactive case relationship graph");
    expect(html).toContain('aria-label="Zoom in"');
    expect(html).toContain('aria-label="Zoom out"');
    expect(html).toContain("Reset view");
    expect(html).toContain("Agent activity map");
    expect(html).toContain('aria-expanded="true"');
  });

  it("keeps the compact graph free of the removed inspector and event list", () => {
    const html = renderToStaticMarkup(<ActivityGraph caseData={makeCase()} call={null} fixture defaultExpanded />);
    expect(html).not.toContain("Graph help");
    expect(html).not.toContain("Data source:");
    expect(html).not.toContain("Inspect node");
    expect(html).not.toContain("Selected node connections");
    expect(html).not.toContain("Recorded case events");
  });

  it("does not show an unrelated supplied live call as started", () => {
    const html = renderToStaticMarkup(<ActivityGraph caseData={makeCase()} call={makeCall()} fixture={false} />);
    expect(html).not.toContain("Live call record");
    expect(html).toContain("Dial call: Not started");
    expect(html).not.toContain("Inspect node");
  });
});
