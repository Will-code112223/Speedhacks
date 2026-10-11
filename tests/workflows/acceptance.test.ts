import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowFactKey, WorkflowKind, WorkflowMessageRequest } from "@/contracts/workflow";
import { CaseService } from "@/server/cases/service";
import { loadConfig } from "@/server/config";
import { EMPTY_FIELDS } from "@/server/documents/extractor";
import { UploadStore } from "@/server/documents/storage";
import { closeDatabase, openDatabase } from "@/server/persistence/db";
import { CaseRepository } from "@/server/persistence/repository";
import { closeInsurerDatabase } from "@/server/insurers";
import { WorkflowService } from "@/server/workflows/service";
import type { WorkflowExtractor } from "@/server/workflows/extractor";

const OWNER = "a".repeat(48);
const OTHER = "b".repeat(48);
const cleanups: Array<() => void> = [];
afterEach(() => { for (const clean of cleanups.splice(0)) clean(); });

function harness() {
  closeDatabase();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-acceptance-"));
  const config = loadConfig({ REFUND_MODE: "live", DATA_DIR: dataDir, OPENAI_API_KEY: "offline-test-key", LLM_MODEL: "offline-test-model" });
  const db = openDatabase(dataDir);
  const repo = new CaseRepository(db);
  const uploads = new UploadStore(dataDir);
  const startCall = vi.fn(async () => { throw new Error("Intake must never dispatch a call"); });
  const voice = { startCall, getCall: vi.fn(), verifyWebhook: vi.fn() };
  const cases = new CaseService({ config, repo, uploads, voice: () => voice, extractor: {
    kind: "openai", extract: vi.fn(async () => ({ fields: { ...EMPTY_FIELDS }, provenance: [], notes: [] })),
  } });
  const extract = vi.fn<WorkflowExtractor["extract"]>();
  const extractor = { extract } as WorkflowExtractor;
  const deps = { config, db, repo, cases, extractor };
  const service = new WorkflowService(deps);
  cleanups.push(() => { closeDatabase(); closeInsurerDatabase(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { dataDir, db, repo, uploads, cases, service, deps, extract, startCall };
}

async function start(h: ReturnType<typeof harness>, summary: string) {
  return h.cases.createCase(OWNER, { summary, fields: {}, files: [] });
}
function request(revision: number, message: string): WorkflowMessageRequest {
  return { requestId: randomUUID(), expectedRevision: revision, message };
}
function fromMessage(h: ReturnType<typeof harness>, kind: WorkflowKind, facts: Partial<Record<WorkflowFactKey, string>>) {
  h.extract.mockImplementationOnce(async ({ message }) => ({ kind, facts: Object.entries(facts).map(([key, value]) => ({
    key: key as WorkflowFactKey, value: value!, sourceId: message.id, quote: value!, resolvesConflict: false,
  })) }));
}

// These exercise the real workflow service, SQLite, revision control and private
// evidence storage. Only the external model and voice transport are replaced.
describe("real conversational preparation acceptance", () => {
  it.each([
    ["Help me get a refund for Amazon shoes.", "refund", ["product", "issue", "orderNumber"]],
    ["Help me dispute a duplicate subscription charge.", "duplicate_charge", ["merchantName", "amount", "purchaseDate"]],
    ["Help me prepare a car insurance claim.", "auto_insurance", ["insuranceProvider", "lossDate", "incidentDescription"]],
  ] as const)("asks relevant questions without inventing facts for %s", async (summary, kind, expectedFields) => {
    const h = harness(); const c = await start(h, summary);
    const result = h.service.get(OWNER, c.id);
    expect(result.workflow.kind).toBe(kind);
    expect(result.workflow.caseRevision).toBe(c.revision);
    expect(result.workflow.questions.length).toBeGreaterThan(0);
    if (kind === "refund") expect(result.workflow.questions.some((q) => q.field === "issue")).toBe(true);
    const fields = result.workflow.questions.map((q) => q.field);
    expect(expectedFields.some((field) => fields.includes(field))).toBe(true);
    expect(result.case.mode).toBe("live");
    expect(result.case.amountMinor).toBeNull();
    expect(result.case.merchant.supportPhone).toBeNull();
    expect(result.case.outcome).toMatchObject({ decision: "unknown", paymentStatus: "unverified" });
    expect(h.extract).not.toHaveBeenCalled();
    expect(h.startCall).not.toHaveBeenCalled();
  });

  it("retains Amazon answers across reload and creates actionable preparation without a phone", async () => {
    const h = harness(); const c = await start(h, "Help me get a refund for Amazon shoes.");
    fromMessage(h, "refund", {
      customerName: "Avery Example", merchantName: "Amazon", product: "running shoes", orderNumber: "ORDER-438",
      purchaseDate: "October 3, 2026", amount: "79.99", issue: "The left sole arrived detached", desiredOutcome: "a refund",
    });
    const message = "I am Avery Example. Amazon running shoes, ORDER-438, October 3, 2026, $79.99. The left sole arrived detached; I want a refund.";
    const result = await h.service.message(OWNER, c.id, request(c.revision, message));
    const reloaded = new WorkflowService(h.deps).get(OWNER, c.id);
    expect(reloaded.workflow.messages).toEqual(result.workflow.messages);
    expect(reloaded.case.revision).toBeGreaterThan(c.revision);
    expect(reloaded.workflow.caseRevision).toBe(reloaded.case.revision);
    expect(reloaded.case.customer.name).toBe("Avery Example");
    expect(reloaded.case.amountMinor).toBe(7999);
    expect(reloaded.case.merchant.supportPhone).toBeNull();
    expect(reloaded.workflow.brief.body).toContain("The left sole arrived detached");
    expect(reloaded.workflow.stage).toBe("ready");
    expect(reloaded.workflow.actions.some((a) => a.type === "browser" && a.browser?.startUrl.includes("amazon.com"))).toBe(true);
    expect(reloaded.workflow.actions.some((a) => a.type === "document")).toBe(true);
    expect(reloaded.case.calls).toEqual([]);
    expect(h.startCall).not.toHaveBeenCalled();
  });

  it("keeps an unconfirmed second charge out of a fabricated refund outcome", async () => {
    const h = harness(); const c = await start(h, "Help me dispute a duplicate subscription charge.");
    fromMessage(h, "duplicate_charge", { merchantName: "Acme Streaming", product: "monthly subscription", amount: "49.99", purchaseDate: "October 3", orderNumber: "BILL-938", desiredOutcome: "check the second charge", issue: "two charges but one is still pending" });
    const result = await h.service.message(OWNER, c.id, request(c.revision, "Acme Streaming monthly subscription, BILL-938, 49.99 on October 3: two charges but one is still pending. Please check the second charge."));
    expect(result.workflow.brief.body).toContain("two charges but one is still pending");
    expect(result.workflow.stage).toBe("ready");
    expect(result.case.authorization).toBeNull();
    expect(result.case.outcome).toMatchObject({ decision: "unknown", referenceNumber: null, paymentStatus: "unverified" });
    expect(result.workflow.actions.filter((a) => a.type === "call").every((a) => a.status !== "completed")).toBe(true);
    expect(h.startCall).not.toHaveBeenCalled();
  });

  it("prepares an insurance brief with unknown loss amount and does not infer coverage or an outcome", async () => {
    const h = harness(); const c = await start(h, "Help me prepare a car insurance claim.");
    fromMessage(h, "auto_insurance", {
      insuranceProvider: "GEICO", claimantRole: "policyholder", lossDate: "October 4, 2026", lossLocation: "Oakland",
      vehicle: "2022 Honda Civic", incidentDescription: "My parked car's bumper was damaged", desiredOutcome: "report the damage",
    });
    const result = await h.service.message(OWNER, c.id, request(c.revision,
      "GEICO policyholder: October 4, 2026, Oakland, 2022 Honda Civic. My parked car's bumper was damaged. I want to report the damage. I do not know the repair amount."));
    expect(result.workflow.kind).toBe("auto_insurance");
    expect(result.workflow.brief.body).toContain("2022 Honda Civic");
    expect(result.workflow.stage).toBe("ready");
    expect(result.workflow.brief.body).toContain("My parked car's bumper was damaged");
    expect(result.case.amountMinor).toBeNull();
    expect(result.case.authorization).toBeNull();
    expect(result.case.outcome.decision).toBe("unknown");
    expect(result.case.outcome.paymentStatus).toBe("unverified");
    expect(h.startCall).not.toHaveBeenCalled();
  });

  it("stores later evidence bytes once, updates the actual case, and lets the model see the attachment", async () => {
    const h = harness(); const c = await start(h, "Help me get a refund for Amazon shoes.");
    const bytes = new TextEncoder().encode("Order ORDER-438. Amazon shoes. Total 79.99 USD.");
    h.extract.mockImplementationOnce(async ({ documents }) => ({ kind: "refund", facts: [
      { key: "orderNumber", value: "ORDER-438", sourceId: documents[0]!.evidenceId, quote: "Order ORDER-438", resolvesConflict: false },
      { key: "amount", value: "79.99", sourceId: documents[0]!.evidenceId, quote: "Total 79.99 USD", resolvesConflict: false },
    ] }));
    const input = { requestId: randomUUID(), expectedRevision: c.revision, message: "Here is the order confirmation.", files: [{ name: "order.txt", mimeType: "text/plain", bytes }] };
    const result = await h.service.evidence(OWNER, c.id, input);
    const retry = await h.service.evidence(OWNER, c.id, input);
    const rows = h.repo.listEvidence(c.id);
    expect(rows).toHaveLength(1);
    expect(h.uploads.read(rows[0]!.storedPath)).toEqual(bytes);
    expect(result.case.evidence).toHaveLength(1);
    expect(result.case.evidence[0]!.id).toBe(rows[0]!.id);
    expect(result.case.revision).toBeGreaterThan(c.revision);
    expect(result.workflow.caseRevision).toBe(result.case.revision);
    expect(result.workflow.facts.orderNumber?.sourceRefs).toContain(rows[0]!.id);
    expect(result.case.amountMinor).toBe(7999);
    expect(retry.case.revision).toBe(result.case.revision);
    expect(retry.workflow.messages).toEqual(result.workflow.messages);
    expect(h.extract).toHaveBeenCalledTimes(1);
  });

  it("rejects another owner's read, message, and attachment before model or file writes", async () => {
    const h = harness(); const c = await start(h, "Refund request");
    expect(() => h.service.get(OTHER, c.id)).toThrow();
    await expect(h.service.message(OTHER, c.id, request(c.revision, "Private update"))).rejects.toMatchObject({ status: 404 });
    await expect(h.service.evidence(OTHER, c.id, { requestId: randomUUID(), expectedRevision: c.revision, files: [{ name: "other.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("secret") }] })).rejects.toMatchObject({ status: 404 });
    expect(h.repo.listEvidence(c.id)).toHaveLength(0);
    expect(h.extract).not.toHaveBeenCalled();
  });

  it("does not replay a successful message after reload and rejects reuse with different content", async () => {
    const h = harness(); const c = await start(h, "Refund request");
    fromMessage(h, "refund", { merchantName: "Amazon" });
    const input = request(c.revision, "The merchant is Amazon.");
    const first = await h.service.message(OWNER, c.id, input);
    const restarted = new WorkflowService(h.deps);
    const replay = await restarted.message(OWNER, c.id, input);
    expect(replay.case.revision).toBe(first.case.revision);
    expect(replay.workflow.messages).toEqual(first.workflow.messages);
    await expect(restarted.message(OWNER, c.id, { ...input, message: "The merchant is a different company." })).rejects.toMatchObject({ status: 409 });
    expect(h.extract).toHaveBeenCalledTimes(1);
  });

  it("refuses a stale update before asking the model", async () => {
    const h = harness(); const c = await start(h, "Refund request");
    h.cases.patchCase(OWNER, c.id, c.revision, { reason: "A newer user edit" });
    await expect(h.service.message(OWNER, c.id, request(c.revision, "An older edit"))).rejects.toMatchObject({ status: 409 });
    expect(h.extract).not.toHaveBeenCalled();
    expect(h.repo.getCase(c.id)!.doc.reason).toBe("A newer user edit");
  });

  it("does not apply model output over a concurrent canonical edit", async () => {
    const h = harness(); const c = await start(h, "Refund request");
    let release!: (value: Awaited<ReturnType<WorkflowExtractor["extract"]>>) => void;
    let extractionStarted!: () => void;
    const started = new Promise<void>((resolve) => { extractionStarted = resolve; });
    h.extract.mockImplementationOnce(async ({ message }) => {
      extractionStarted();
      return new Promise((resolve) => { release = resolve; });
    });
    const pending = h.service.message(OWNER, c.id, request(c.revision, "The merchant is Amazon."));
    await started;
    h.cases.patchCase(OWNER, c.id, h.repo.getCase(c.id)!.revision, { reason: "A newer user edit" });
    release({ kind: "refund", facts: [] });
    await expect(pending).rejects.toMatchObject({ status: 409 });
    expect(h.repo.getCase(c.id)!.doc.reason).toBe("A newer user edit");
    expect(h.repo.getCase(c.id)!.doc.merchant.name).toBeNull();
    const reloaded = h.service.get(OWNER, c.id);
    expect(reloaded.workflow.facts.issue?.value).toBe("A newer user edit");
    expect(reloaded.workflow.brief.body).toContain("A newer user edit");
  });

  it("keeps a valid in-flight operation alive across service readers and deduplicates retries", async () => {
    const h = harness(); const c = await start(h, "Refund request");
    let release!: (value: Awaited<ReturnType<WorkflowExtractor["extract"]>>) => void;
    let extractionStarted!: () => void;
    const started = new Promise<void>((resolve) => { extractionStarted = resolve; });
    h.extract.mockImplementationOnce(async () => {
      extractionStarted();
      return new Promise((resolve) => { release = resolve; });
    });
    const input = request(c.revision, "Please review the saved information.");
    const pending = h.service.message(OWNER, c.id, input);
    await started;
    const otherReader = new WorkflowService(h.deps);
    expect(otherReader.get(OWNER, c.id).workflow.analysisStatus).toBe("processing");
    await expect(otherReader.message(OWNER, c.id, input)).rejects.toMatchObject({ status: 409 });
    release({ kind: "refund", facts: [] });
    const result = await pending;
    expect(result.workflow.analysisStatus).toBe("complete");
    expect(result.workflow.messages.filter((message) => message.content === input.message)).toHaveLength(1);
    expect(h.extract).toHaveBeenCalledTimes(1);
  });

  it("does not accept model facts without supporting user or attachment provenance", async () => {
    const h = harness(); const c = await start(h, "Refund request");
    h.extract.mockResolvedValueOnce({ kind: "refund", facts: [
      { key: "amount", value: "800.00", sourceId: "invented-document", quote: "800.00", resolvesConflict: false },
    ] });
    const result = await h.service.message(OWNER, c.id, request(c.revision, "I do not know the amount."));
    expect(result.case.amountMinor).toBeNull();
    expect(result.workflow.facts.amount?.value ?? null).toBeNull();
    expect(result.case.outcome.decision).toBe("unknown");
  });

  it("rejects an unrelated quote even when the source message ID is real", async () => {
    const h = harness(); const c = await start(h, "Refund request");
    h.extract.mockImplementationOnce(async ({ message }) => ({ kind: "refund", facts: [
      { key: "amount", value: "800.00", sourceId: message.id, quote: "I do not know the amount", resolvesConflict: false },
    ] }));
    const result = await h.service.message(OWNER, c.id, request(c.revision, "I do not know the amount."));
    expect(result.case.amountMinor).toBeNull();
    expect(result.workflow.facts.amount?.value ?? null).toBeNull();
  });

  it("preserves an existing fact and asks for clarification when new evidence conflicts", async () => {
    const h = harness(); const c = await start(h, "Refund request");
    fromMessage(h, "refund", { amount: "49.99" });
    const first = await h.service.message(OWNER, c.id, request(c.revision, "The duplicate amount is 49.99."));
    fromMessage(h, "refund", { amount: "59.99" });
    const second = await h.service.message(OWNER, c.id, request(first.case.revision, "The receipt says 59.99."));
    expect(second.case.amountMinor).toBe(4999);
    expect(second.workflow.conflicts.length).toBeGreaterThan(0);
    expect(second.workflow.stage).not.toBe("ready");
    expect(second.case.authorization).toBeNull();
  });

  it("does not let re-analysis replay an older correction over a newer confirmed amount", async () => {
    const h = harness(); const c = await start(h, "Duplicate charge review");
    let oldSource = "";
    h.extract.mockImplementationOnce(async ({ message }) => {
      oldSource = message.id;
      return { kind: "duplicate_charge", facts: [{ key: "amount", value: "69.99", sourceId: message.id, quote: "Actually, the amount is 69.99", resolvesConflict: true }] };
    });
    const first = await h.service.message(OWNER, c.id, request(c.revision, "Actually, the amount is 69.99."));
    h.extract.mockImplementationOnce(async ({ message }) => ({ kind: "duplicate_charge", facts: [
      { key: "amount", value: "49.99", sourceId: message.id, quote: "Correction: the amount is 49.99", resolvesConflict: true },
    ] }));
    const second = await h.service.message(OWNER, c.id, request(first.case.revision, "Correction: the amount is 49.99."));
    expect(second.case.amountMinor).toBe(4999);
    h.extract.mockResolvedValueOnce({ kind: "duplicate_charge", facts: [
      { key: "amount", value: "69.99", sourceId: oldSource, quote: "Actually, the amount is 69.99", resolvesConflict: true },
    ] });
    const replay = await h.service.analyze(OWNER, c.id, { requestId: randomUUID(), expectedRevision: second.case.revision });
    expect(replay.case.amountMinor).toBe(4999);
    expect(replay.case.authorization).toBeNull();
  });

  it.each([false, true])("clears a currency conflict when the latest user confirms the retained value (old source last: %s)", async oldLast => {
    const h = harness(); const c = await start(h, "Amazon return");
    fromMessage(h, "refund", { currency: "USD" });
    const first = await h.service.message(OWNER, c.id, request(c.revision, "Currency: USD."));
    fromMessage(h, "refund", { currency: "CAD" });
    const second = await h.service.message(OWNER, c.id, request(first.case.revision, "The receipt shows CAD."));
    const oldId = second.workflow.messages.filter(m => m.role === "user").at(-1)!.id;
    expect(second.workflow.conflicts).toHaveLength(1);
    h.extract.mockImplementationOnce(async ({ message }) => {
      const correction = { key: "currency" as const, value: "USD", quote: "Correction: currency is USD", sourceId: message.id, resolvesConflict: true };
      const old = { key: "currency" as const, value: "CAD", quote: "The receipt shows CAD", sourceId: oldId, resolvesConflict: false };
      return { kind: "refund", facts: oldLast ? [correction, old] : [old, correction] };
    });
    const fixed = await h.service.message(OWNER, c.id, request(second.case.revision, "Correction: currency is USD."));
    expect(fixed.workflow.conflicts).toEqual([]);
    expect(fixed.workflow.facts.currency?.value).toBe("USD");
    expect(fixed.workflow.brief.body).not.toContain("Which is correct?");
    expect(h.startCall).not.toHaveBeenCalled();
  });

  it("does not clear a conflict merely because an unconfirmed candidate repeats the retained value", async () => {
    const h = harness(); const c = await start(h, "Refund request");
    fromMessage(h, "refund", { currency: "USD" });
    const first = await h.service.message(OWNER, c.id, request(c.revision, "Currency USD."));
    fromMessage(h, "refund", { currency: "CAD" });
    const second = await h.service.message(OWNER, c.id, request(first.case.revision, "Another receipt says CAD."));
    fromMessage(h, "refund", { currency: "USD" });
    const third = await h.service.message(OWNER, c.id, request(second.case.revision, "One document says USD, but I am unsure which is correct."));
    expect(third.workflow.conflicts).toHaveLength(1);
    expect(third.workflow.facts.currency?.value).toBe("USD");
    expect(third.case.authorization).toBeNull();
  });

  it.each([null, "USD", "CAD"])("does not infer or contradict currency %s from a bare dollar sign", async currency => {
    const h = harness(); const c = await start(h, "Amazon return");
    let revision = c.revision;
    if (currency) {
      fromMessage(h, "refund", { currency });
      revision = (await h.service.message(OWNER, c.id, request(revision, `Currency: ${currency}.`))).case.revision;
    }
    fromMessage(h, "refund", { currency: "$" });
    const result = await h.service.message(OWNER, c.id, request(revision, "The order shows $104.68."));
    expect(result.workflow.facts.currency?.value ?? null).toBe(currency);
    expect(result.workflow.conflicts).toEqual([]);
  });

  it("retains uploaded bytes and clears old call approval even when extraction fails", async () => {
    const h = harness();
    const c = await h.cases.createCase(OWNER, { summary: "Duplicate settled subscription charge", files: [], fields: {
      customerName: "Avery Example", customerEmail: "avery@example.com", merchantName: "Acme Streaming",
      supportPhone: "+14155550123", amountMinor: 4999, currency: "USD",
    } });
    h.cases.authorize(OWNER, c.id, c.revision);
    h.extract.mockRejectedValueOnce(new Error("Model transport unavailable"));
    const bytes = new TextEncoder().encode("Billing statement says one of these transactions is pending.");
    await expect(h.service.evidence(OWNER, c.id, { requestId: randomUUID(), expectedRevision: c.revision,
      files: [{ name: "statement.txt", mimeType: "text/plain", bytes }] })).rejects.toThrow();
    const result = h.service.get(OWNER, c.id);
    const rows = h.repo.listEvidence(c.id);
    expect(rows).toHaveLength(1);
    expect(h.uploads.read(rows[0]!.storedPath)).toEqual(bytes);
    expect(result.case.evidence).toHaveLength(1);
    expect(result.case.authorization).toBeNull();
    expect(result.workflow.stage).toBe("needs_review");
    expect(result.case.outcome.paymentStatus).toBe("unverified");
    expect(h.startCall).not.toHaveBeenCalled();
  });

  it("does not fabricate a successful conversation after a model failure", async () => {
    const h = harness(); const c = await start(h, "Refund request");
    h.extract.mockRejectedValueOnce(new Error("Model transport unavailable"));
    await expect(h.service.message(OWNER, c.id, request(c.revision, "My amount is 79.99."))).rejects.toThrow();
    const reloaded = h.service.get(OWNER, c.id);
    expect(reloaded.case.amountMinor).toBeNull();
    expect(reloaded.case.revision).toBeGreaterThan(c.revision);
    expect(reloaded.workflow.messages.some((m) => m.role === "user" && m.content === "My amount is 79.99.")).toBe(true);
    expect(reloaded.workflow.stage).toBe("needs_review");
    expect(reloaded.case.calls).toEqual([]);
    expect(reloaded.workflow.messages.some((m) => m.role === "assistant" && /approved|refunded|submitted/i.test(m.content))).toBe(false);
  });
});
