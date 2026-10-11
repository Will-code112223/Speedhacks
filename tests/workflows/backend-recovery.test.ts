import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaseService } from "@/server/cases/service";
import { loadConfig } from "@/server/config";
import { EMPTY_FIELDS } from "@/server/documents/extractor";
import { UploadStore } from "@/server/documents/storage";
import { closeDatabase, openDatabase } from "@/server/persistence/db";
import { CaseRepository } from "@/server/persistence/repository";
import { WorkflowService } from "@/server/workflows/service";
import type { WorkflowExtraction, WorkflowExtractor } from "@/server/workflows/extractor";
const owner = "a".repeat(48);
const directories: string[] = [];
afterEach(() => { closeDatabase(); for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
async function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-recovery-")); directories.push(dataDir);
  const config = loadConfig({ REFUND_MODE: "live", DATA_DIR: dataDir, OPENAI_API_KEY: "test-key", LLM_MODEL: "test-model" });
  const db = openDatabase(dataDir); const repo = new CaseRepository(db); const clock = { ms: Date.parse("2026-10-11T00:00:00Z") };
  const cases = new CaseService({ config, repo, uploads: new UploadStore(dataDir), now: () => new Date(clock.ms),
    extractor: { kind: "openai", extract: async () => ({ fields: { ...EMPTY_FIELDS }, provenance: [], notes: [] }) },
    voice: () => { throw new Error("No call permitted in workflow tests"); } });
  const extract = vi.fn<WorkflowExtractor["extract"]>();
  const deps = { config, db, repo, cases, extractor: { extract }, contacts: () => [], now: () => new Date(clock.ms) };
  const service = new WorkflowService(deps);
  const c = await cases.createCase(owner, { summary: "Help me request a refund.", files: [], fields: {} });
  return { ...deps, service, c, clock, extract };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

describe("durable interview recovery and contradictory model output", () => {
  it("does not present the legacy USD default as a sourced interview fact", async () => {
    const f = await fixture();
    const initial = f.service.get(owner, f.c.id);
    expect(initial.case.currency).toBe("USD");
    expect(initial.workflow.facts.currency?.value).toBeNull();
    expect(initial.workflow.brief.body).not.toContain("Currency: USD");

    f.cases.patchCase(owner, f.c.id, initial.case.revision, { reason: "The item arrived damaged." });
    const refreshed = new WorkflowService(f).get(owner, f.c.id);
    expect(refreshed.workflow.facts.currency?.value).toBeNull();
    expect(refreshed.workflow.brief.body).not.toContain("Currency: USD");
  });

  it("keeps explicitly supported currency after reload and a separate canonical edit", async () => {
    const f = await fixture();
    f.extract.mockImplementationOnce(async ({ message }) => ({ kind: "refund", facts: [
      { key: "currency", value: "USD", quote: "The receipt says USD", sourceId: message.id, resolvesConflict: false },
    ] }));
    const result = await f.service.message(owner, f.c.id, { requestId: randomUUID(), expectedRevision: f.c.revision, message: "The receipt says USD." });
    expect(result.workflow.facts.currency?.value).toBe("USD");
    expect(f.repo.listProvenance(f.c.id)).toContainEqual(expect.objectContaining({ field: "currency", value: "USD", excerpt: "The receipt says USD" }));
    f.cases.patchCase(owner, f.c.id, result.case.revision, { reason: "The item arrived damaged." });
    const refreshed = new WorkflowService(f).get(owner, f.c.id);
    expect(refreshed.workflow.facts.currency?.value).toBe("USD");
    expect(refreshed.workflow.brief.body).toContain("Currency: USD");
  });

  it("does not let a second service instance steal a still-valid analysis lease", async () => {
    const f = await fixture(); const gate = deferred<WorkflowExtraction>(); const started = deferred<void>();
    f.extract.mockImplementationOnce(async () => { started.resolve(); return gate.promise; });
    const input = { requestId: randomUUID(), expectedRevision: f.c.revision, message: "My merchant is Amazon." };
    const pending = f.service.message(owner, f.c.id, input); await started.promise;
    const second = new WorkflowService(f);
    const current = second.get(owner, f.c.id);
    expect(current.workflow.analysisStatus).toBe("processing"); expect(current.workflow.stage).toBe("in_progress");
    await expect(second.message(owner, f.c.id, input)).rejects.toMatchObject({ code: "WORKFLOW_BUSY" });
    await expect(second.message(owner, f.c.id, { ...input, requestId: randomUUID(), expectedRevision: current.case.revision })).rejects.toMatchObject({ code: "WORKFLOW_BUSY" });
    gate.resolve({ kind: "refund", facts: [] }); await pending;
    expect(second.get(owner, f.c.id).workflow.analysisStatus).toBe("complete"); expect(f.extract).toHaveBeenCalledTimes(1);
  });

  it("expires a lost analysis, preserves its message, and prevents the late result from changing facts", async () => {
    const f = await fixture(); const gate = deferred<WorkflowExtraction>(); const started = deferred<void>();
    let sourceId = "";
    f.extract.mockImplementationOnce(async ({ message }) => { sourceId = message.id; started.resolve(); return gate.promise; });
    const request = { requestId: randomUUID(), expectedRevision: f.c.revision, message: "The amount is 49.99." };
    const pending = f.service.message(owner, f.c.id, request); const rejected = expect(pending).rejects.toMatchObject({ code: "WORKFLOW_REVISION_CONFLICT" });
    await started.promise; f.clock.ms += 120_001;
    const restarted = new WorkflowService(f); const recovered = restarted.get(owner, f.c.id);
    expect(recovered.workflow.analysisStatus).toBe("failed"); expect(recovered.workflow.messages.some(m => m.id === sourceId)).toBe(true);
    const replay = await restarted.message(owner, f.c.id, request);
    expect(replay.workflow.analysisStatus).toBe("failed"); expect(f.extract).toHaveBeenCalledTimes(1);
    gate.resolve({ kind: "refund", facts: [{ key: "amount", value: "49.99", quote: "The amount is 49.99", sourceId, resolvesConflict: false }] });
    await rejected;
    expect(restarted.get(owner, f.c.id).case.amountMinor).toBeNull();
    f.extract.mockResolvedValueOnce({ kind: "refund", facts: [] });
    const refreshed = await restarted.analyze(owner, f.c.id, { requestId: randomUUID(), expectedRevision: replay.case.revision });
    expect(refreshed.workflow.analysisStatus).toBe("complete"); expect(f.extract).toHaveBeenCalledTimes(2);
  });

  it("keeps a previously unknown amount unknown when two sources give different values in one result", async () => {
    const f = await fixture();
    f.extract.mockImplementationOnce(async ({ message }) => ({ kind: "refund", facts: [
      { key: "amount", value: "49.99", quote: "The receipt says 49.99", sourceId: message.id, resolvesConflict: false },
      { key: "amount", value: "59.99", quote: "the statement says 59.99", sourceId: message.id, resolvesConflict: false },
    ] }));
    const result = await f.service.message(owner, f.c.id, { requestId: randomUUID(), expectedRevision: f.c.revision, message: "The receipt says 49.99 but the statement says 59.99." });
    expect(result.case.amountMinor).toBeNull(); expect(result.workflow.facts.amount?.value).toBeNull();
    expect(result.workflow.conflicts).toHaveLength(1); expect(result.workflow.stage).toBe("needs_review");
  });

  it("retains a substantive incident description rather than silently appending its contradiction", async () => {
    const f = await fixture();
    f.extract.mockImplementationOnce(async ({ message }) => ({ kind: "auto_insurance", facts: [
      { key: "incidentDescription", value: "My car was parked", quote: "My car was parked", sourceId: message.id, resolvesConflict: false },
    ] }));
    const first = await f.service.message(owner, f.c.id, { requestId: randomUUID(), expectedRevision: f.c.revision, message: "My car was parked." });
    f.extract.mockImplementationOnce(async ({ message }) => ({ kind: "auto_insurance", facts: [
      { key: "incidentDescription", value: "My car was moving", quote: "My car was moving", sourceId: message.id, resolvesConflict: false },
    ] }));
    const result = await f.service.message(owner, f.c.id, { requestId: randomUUID(), expectedRevision: first.case.revision, message: "My car was moving." });
    expect(result.workflow.facts.incidentDescription?.value).toBe("My car was parked");
    expect(result.workflow.conflicts.some(c => c.startsWith("incidentDescription:"))).toBe(true);
  });
});
