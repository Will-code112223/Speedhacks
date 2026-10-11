import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import type { CaseRow } from "@/server/persistence/repository";
import { BrowserStore } from "@/server/browser/store";
import { BrowserService, type BrowserDependencies } from "@/server/browser/service";
import type { BrowserPort, Observation, PlannedStep } from "@/server/browser/types";
export const OWNER = "a".repeat(48);
export const OTHER = "b".repeat(48);
export function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
export const done: PlannedStep = { kind: "done", elementId: null, value: null, artifactId: null, description: "I claim the insurer paid everything." };
export function fixture(overrides: Partial<BrowserDependencies> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browser-tests-"));
  const store = new BrowserStore(directory);
  const c: CaseRow = { id: randomUUID(), ownerSession: OWNER, revision: 1, mode: "live", createdAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z",
    doc: { customer: { name: null, email: null }, merchant: { name: "Synthetic insurer", supportPhone: null }, amountMinor: null, currency: "USD",
      reason: "Ask what documents this fictional request would need", missingFields: ["lossDate"], draft: { subject: "Unreviewed", body: "Invented refund assertion" }, authorization: null,
      outcome: { decision: "unknown", referenceNumber: null, nextAction: null, paymentStatus: "unverified", supportingQuote: null }, timeline: [] } };
  const elementId = randomUUID();
  const observation: Observation = { id: randomUUID(), url: "https://example.com/claims", title: "Provider page", text: "Continue", fingerprint: "page-1", hasPassword: false, hasFrames: false,
    elements: [{ id: elementId, tag: "button", type: "submit", label: "Continue", href: null, disabled: false, options: [] }] };
  const click: PlannedStep = { kind: "click", elementId, value: null, artifactId: null, description: "Click Continue" };
  const port: BrowserPort = { observe: vi.fn(async () => structuredClone(observation)), screenshot: vi.fn(async () => Buffer.from("MOCK-JPEG")), execute: vi.fn(async () => {}),
    loginHandoff: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const planner = { next: vi.fn().mockResolvedValueOnce(click).mockResolvedValue(done) };
  const loadCase = vi.fn(async (owner: string) => { if (owner !== OWNER) throw new Error("NOT_OWNED"); return structuredClone(c); });
  const launch = vi.fn(async () => port);
  const deps: BrowserDependencies = { store, planner, enabled: true, configured: true, loadCase, evidence: async () => [], launch, ...overrides };
  const service = new BrowserService(deps);
  const input = { caseId: c.id, expectedRevision: 1, requestId: randomUUID(), task: "Review requirements and stop before submission", startUrl: observation.url, allowedHosts: ["example.com"] };
  return { directory, store, c, observation, click, port, planner, loadCase, launch, deps, service, input,
    async cleanup() { await service.dispose(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}
export async function ready(f: ReturnType<typeof fixture>) {
  const run = await f.service.start(OWNER, f.input);
  await vi.waitFor(() => { if (!["needs_approval", "needs_login", "failed", "completed"].includes(f.service.get(OWNER, run.id).status)) throw new Error("pending"); });
  return f.service.get(OWNER, run.id);
}
