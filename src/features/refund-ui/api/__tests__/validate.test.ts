import { describe, expect, it } from "vitest";
import type { PendingDecision } from "../types";
import { isCallV1, isCaseV1, isLiveCallV2, readApiError, readCapabilities } from "../validate";
import { sampleCall, sampleCase, sampleLiveCall } from "./support";

describe("isCaseV1", () => {
  it("accepts a contract case, with or without extra fields", () => {
    expect(isCaseV1(sampleCase())).toBe(true);
    expect(isCaseV1(sampleCase({ amountMinor: null, draft: null }))).toBe(true);
    expect(isCaseV1({ ...sampleCase(), addedLater: { anything: true } })).toBe(true);
  });

  it.each<[string, unknown]>([
    ["another schema version", { ...sampleCase(), schemaVersion: 2 }],
    ["an unknown status", { ...sampleCase(), status: "pending" }],
    ["a fractional amount", { ...sampleCase(), amountMinor: 49.99 }],
    ["no timeline", { ...sampleCase(), timeline: undefined }],
    ["evidence without a type", { ...sampleCase(), evidence: [{ id: "e1", name: "receipt.pdf" }] }],
    ["an authorization with a string revision", { ...sampleCase(), authorization: { id: "a", revision: "1", approvedAt: "x" } }],
    ["a malformed call", { ...sampleCase(), calls: [{ ...sampleCall(), state: "ringing" }] }],
    ["an unknown payment status", { ...sampleCase(), outcome: { ...sampleCase().outcome, paymentStatus: "paid" } }],
    ["an array", [sampleCase()]],
    ["null", null],
  ])("rejects %s", (_label, value) => {
    expect(isCaseV1(value)).toBe(false);
  });
});

describe("isCallV1", () => {
  it("accepts a contract call and rejects a missing nullable field", () => {
    expect(isCallV1(sampleCall())).toBe(true);
    expect(isCallV1(sampleCall({ providerCallId: null, transcript: "Agent: hello" }))).toBe(true);
    expect(isCallV1({ ...sampleCall(), providerCallId: undefined })).toBe(false);
    expect(isCallV1({ ...sampleCall(), mode: "demo" })).toBe(false);
  });
});

describe("isLiveCallV2", () => {
  it("accepts a proposal record, including a pending decision", () => {
    expect(isLiveCallV2(sampleLiveCall())).toBe(true);
    const pendingDecision: PendingDecision = {
      id: "d1",
      question: "Accept?",
      defaultOptionId: "no",
      options: [{ id: "yes", label: "Yes", tone: "primary" }, { id: "no", label: "No" }],
      expiresAt: "2026-10-11T19:00:20.000Z",
    };
    expect(isLiveCallV2(sampleLiveCall({ phase: "waiting_for_user", pendingDecision }))).toBe(true);
  });

  it("accepts a live call with a plan, without one, or with a null one", () => {
    const plan = {
      steps: [
        { id: "reach", title: "Reach the billing team", detail: "Dialing, phone menu and hold.", status: "done" as const },
        { id: "explain", title: "Explain the duplicate charge", status: "paused" as const },
        { id: "record", title: "Record the outcome", status: "upcoming" as const },
      ],
    };
    expect(isLiveCallV2(sampleLiveCall({ progress: plan }))).toBe(true);
    expect(isLiveCallV2(sampleLiveCall({ progress: null }))).toBe(true);
    expect(isLiveCallV2(sampleLiveCall())).toBe(true);
  });

  it.each<[string, unknown]>([
    ["an unknown phase", { ...sampleLiveCall(), phase: "connecting" }],
    ["a string confidence", { ...sampleLiveCall(), counterpartConfidence: "0.8" }],
    ["an unknown tone", { ...sampleLiveCall(), pendingDecision: { id: "d", question: "q", defaultOptionId: "a", options: [{ id: "a", label: "A", tone: "loud" }], expiresAt: "x" } }],
    ["a note without text", { ...sampleLiveCall(), notes: [{ at: "x" }] }],
    ["no calling party", { ...sampleLiveCall(), calling: null }],
    ["a plan step with an unknown status", { ...sampleLiveCall(), progress: { steps: [{ id: "reach", title: "Reach the billing team", status: "skipped" }] } }],
    ["a plan without steps", { ...sampleLiveCall(), progress: {} }],
  ])("rejects %s", (_label, value) => {
    expect(isLiveCallV2(value)).toBe(false);
  });
});

describe("readCapabilities", () => {
  it("turns on only explicit trues", () => {
    expect(readCapabilities({ liveCall: true })).toEqual({ liveCall: true, stepIn: false, decisions: false });
    expect(readCapabilities({})).toEqual({ liveCall: false, stepIn: false, decisions: false });
    expect(readCapabilities(true)).toBeNull();
    expect(readCapabilities(null)).toBeNull();
  });
});

describe("readApiError", () => {
  it("reads the ApiError envelope", () => {
    expect(readApiError({ error: { code: "NOT_FOUND", message: "Gone" } })).toEqual({
      code: "NOT_FOUND",
      message: "Gone",
      fields: undefined,
    });
    expect(readApiError({ error: { code: "BAD_REQUEST", message: "Bad", fields: ["summary"] } })?.fields).toEqual([
      "summary",
    ]);
  });

  it.each<[string, unknown]>([
    ["non-string fields", { error: { code: "BAD_REQUEST", message: "Bad", fields: [1] } }],
    ["no message", { error: { code: "BAD_REQUEST" } }],
    ["a string error", { error: "Bad" }],
    ["a bare message", { message: "Bad" }],
    ["an array", [{ error: { code: "X", message: "Y" } }]],
  ])("returns null for %s", (_label, value) => {
    expect(readApiError(value)).toBeNull();
  });
});
