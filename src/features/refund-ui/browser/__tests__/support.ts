import { vi } from "vitest";
import type { BrowserRun, RuntimeReadiness, StartBrowserRequest } from "../../../../contracts/browser";
import type { CaseV1 } from "../../../../contracts/case";
import type { BrowserApi } from "../client";
import type { BrowserSessionState, BrowserStorage } from "../session";

export const request: StartBrowserRequest = { caseId: "case-1", expectedRevision: 2, requestId: "request-1", task: "Check the return requirements", startUrl: "https://www.amazon.com/gp/your-account/order-history", allowedHosts: ["www.amazon.com"] };
export const at = "2026-10-11T19:00:00.000Z";
export function run(overrides: Partial<BrowserRun> = {}): BrowserRun {
  return { id: "run-1", caseId: request.caseId, caseRevision: request.expectedRevision, requestId: request.requestId, task: request.task, startUrl: request.startUrl, allowedHosts: request.allowedHosts, status: "running", currentUrl: request.startUrl, pageTitle: "Your orders", message: "Inspecting the page", pendingAction: null, artifacts: [], events: [], frameAvailable: false, createdAt: at, updatedAt: at, ...overrides };
}
export const ready: RuntimeReadiness = { mode: "live", extraction: { ready: true, missing: [] }, calls: { ready: true, missing: [] }, browser: { ready: true, missing: [] } };
export function api() {
  return { readiness: vi.fn<BrowserApi["readiness"]>().mockResolvedValue(ready), start: vi.fn<BrowserApi["start"]>().mockResolvedValue(run()), get: vi.fn<BrowserApi["get"]>().mockResolvedValue(run()), find: vi.fn<BrowserApi["find"]>().mockResolvedValue(run()), command: vi.fn<BrowserApi["command"]>().mockResolvedValue(run()), frame: vi.fn<BrowserApi["frame"]>().mockResolvedValue(new Blob([new Uint8Array([255, 216, 255, 217])], { type: "image/jpeg" })) };
}
export function storage() {
  const values = new Map<string, string>();
  return { getItem: vi.fn<BrowserStorage["getItem"]>((key) => values.get(key) ?? null), setItem: vi.fn<BrowserStorage["setItem"]>((key, value) => { values.set(key, value); }), removeItem: vi.fn<BrowserStorage["removeItem"]>((key) => { values.delete(key); }) };
}
export function state(overrides: Partial<BrowserSessionState> = {}): BrowserSessionState {
  return { run: null, request: null, recovering: false, recoveryBlocked: false, commandNeedsRefresh: false, busy: false, error: null, ...overrides };
}
export function caseData(overrides: Partial<CaseV1> = {}): CaseV1 {
  return { schemaVersion: 1, id: request.caseId, revision: request.expectedRevision, mode: "live", status: "needs_information", customer: { name: null, email: null }, merchant: { name: "Amazon", supportPhone: null }, amountMinor: null, currency: "USD", reason: request.task, evidence: [], missingFields: ["amountMinor", "merchant.supportPhone"], draft: null, authorization: null, calls: [], outcome: { decision: "unknown", referenceNumber: null, nextAction: null, paymentStatus: "unverified", supportingQuote: null }, timeline: [], createdAt: at, updatedAt: at, ...overrides };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
