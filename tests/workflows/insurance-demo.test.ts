import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceAdapter } from "@/contracts/voice";
import type { WorkflowFactKey } from "@/contracts/workflow";
import { CaseService } from "@/server/cases/service";
import { loadConfig } from "@/server/config";
import { EMPTY_FIELDS } from "@/server/documents/extractor";
import { UploadStore } from "@/server/documents/storage";
import { closeDatabase, openDatabase } from "@/server/persistence/db";
import { CaseRepository } from "@/server/persistence/repository";
import { closeInsurerDatabase } from "@/server/insurers";
import { WorkflowService } from "@/server/workflows/service";
import { WorkflowCallService } from "@/server/workflows/call-service";
import type { WorkflowExtractor } from "@/server/workflows/extractor";

const OWNER = "a".repeat(48);
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach(clean => clean()));
const samples = path.resolve("docs/demo/samples");

async function prepare() {
  closeDatabase();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "insurance-demo-"));
  const config = loadConfig({ REFUND_MODE: "live", DATA_DIR: dataDir, OPENAI_API_KEY: "offline", LLM_MODEL: "offline", DIAL_API_KEY: "offline", DIAL_FROM_NUMBER: "+15555550100" });
  const db = openDatabase(dataDir);
  const repo = new CaseRepository(db);
  const uploads = new UploadStore(dataDir);
  const startCall = vi.fn<VoiceAdapter["startCall"]>().mockResolvedValue({ state: "accepted", mode: "live", providerCallId: "insurance-call-1" });
  const getCall = vi.fn<VoiceAdapter["getCall"]>().mockResolvedValue({ mode: "live", providerCallId: "insurance-call-1", state: "completed", durationSeconds: 67, transcript: null });
  const voice = () => ({ startCall, getCall, verifyWebhook: vi.fn() });
  const cases = new CaseService({ config, repo, uploads, voice, extractor: {
    kind: "openai", extract: async () => ({ fields: { ...EMPTY_FIELDS }, provenance: [], notes: [] }),
  } });
  const extract = vi.fn<WorkflowExtractor["extract"]>();
  const workflowDeps = { config, db, repo, cases, extractor: { extract } };
  const workflow = new WorkflowService(workflowDeps);
  const c = await cases.createCase(OWNER, { summary: fs.readFileSync(path.join(samples, "auto-insurance-intake.txt"), "utf8"), fields: {}, files: [] });
  extract.mockImplementationOnce(async ({ message }) => ({ kind: "auto_insurance", facts: Object.entries({
    customerName: "Sam Rivera", insuranceProvider: "AAA", claimantRole: "policyholder",
    vehicle: "silver 2022 Honda Civic", lossDate: "October 10, 2026", lossLocation: "Oakland parking",
    incidentDescription: "right rear bumper dent and scrape", desiredOutcome: "prepare a packet for review",
  }).map(([key, value]) => ({ key: key as WorkflowFactKey, value, sourceId: message.id, quote: value, resolvesConflict: false })) }));
  const initial = await workflow.analyze(OWNER, c.id, { requestId: randomUUID(), expectedRevision: c.revision });
  let time = Date.now();
  const callDeps = { config, db, repo, workflow, voice, now: () => new Date(time) };
  const calls = new WorkflowCallService(callDeps);
  cleanups.push(() => { closeDatabase(); closeInsurerDatabase(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { cases, repo, uploads, workflow, workflowDeps, calls, callDeps, extract, startCall, getCall, initial, advance: () => { time += 31_000; } };
}

// Real service/revision/SQLite/upload/call-result pipeline; external extraction
// and Dial transport are mocks. This test neither calls nor visits an insurer.
describe("insurance rehearsal across preparation, call and follow-up packet", () => {
  it("persists the returned document request and revised evidence packet without another call or claim approval", async () => {
    const h = await prepare();
    const { case: c, workflow } = h.initial;
    expect(workflow.analysisStatus).toBe("complete");
    expect(workflow.conflicts).toEqual([]);
    expect(workflow.stage).toBe("ready");
    expect(c.amountMinor).toBeNull();
    expect(c.merchant.supportPhone).toBeNull();
    expect(h.startCall).not.toHaveBeenCalled();
    const initialBrief = workflow.brief.body;
    const authorization = h.calls.authorize(OWNER, c.id, {
      requestId: randomUUID(), expectedRevision: c.revision, actionId: "call-insurer",
      to: "+15555550101", maxDurationSeconds: 120, recipientConfirmed: true,
    }).authorization;
    expect(authorization.brief).toContain("right rear bumper dent and scrape");
    expect(authorization.brief).toContain("October 10, 2026");
    expect(authorization.brief).toContain("Oakland parking");
    expect(h.startCall).not.toHaveBeenCalled();
    const dispatch = { requestId: randomUUID(), authorizationId: authorization.id };
    const started = await h.calls.start(OWNER, c.id, dispatch);
    expect(h.startCall).toHaveBeenCalledTimes(1);
    expect((await h.calls.list(OWNER, c.id)).calls[0]!.result.status).toBe("transcript_pending");

    h.advance();
    const transcript = "Agent: I am an AI assistant asking about the required documents.\nUser: Please provide damage photos and a repair estimate so we can review the next steps.\nAgent: Thank you.";
    h.getCall.mockResolvedValue({ mode: "live", providerCallId: "insurance-call-1", state: "completed", durationSeconds: 67, transcript });
    const completed = (await h.calls.list(OWNER, c.id)).calls[0]!;
    expect(completed.id).toBe(started.call.id);
    expect(completed.result.highlights).toEqual([{ kind: "documents", quote: "Please provide damage photos and a repair estimate so we can review the next steps." }]);
    expect(completed.transcript).toBe(transcript);

    h.extract.mockImplementationOnce(async ({ documents }) => ({ kind: "auto_insurance", facts: [{
      key: "vehicle", value: "silver 2022 Honda Civic", quote: "Example vehicle: silver 2022 Honda Civic",
      sourceId: documents.find(d => d.name === "auto-repair-estimate.txt")!.evidenceId, resolvesConflict: false,
    }] }));
    const upload = { requestId: randomUUID(), expectedRevision: c.revision, files: [
      { name: "auto-damage-sample.png", mimeType: "image/png", bytes: fs.readFileSync(path.join(samples, "auto-damage-sample.png")) },
      { name: "auto-repair-estimate.txt", mimeType: "text/plain", bytes: fs.readFileSync(path.join(samples, "auto-repair-estimate.txt")) },
    ] };
    const updated = await h.workflow.evidence(OWNER, c.id, upload);
    expect(updated.case.revision).toBeGreaterThan(c.revision);
    expect(updated.workflow.analysisStatus).toBe("complete");
    expect(updated.workflow.conflicts).toEqual([]);
    expect(updated.workflow.brief.body).not.toBe(initialBrief);
    for (const file of upload.files) {
      const evidence = updated.case.evidence.find(e => e.name === file.name)!;
      expect(evidence).toBeDefined();
      expect(updated.workflow.brief.body).toContain(file.name);
      expect(Buffer.from(h.uploads.read(h.repo.listEvidence(c.id).find(e => e.id === evidence.id)!.storedPath)).equals(file.bytes)).toBe(true);
    }
    expect(updated.case.evidence).toHaveLength(2);
    expect(updated.workflow.facts.vehicle?.sourceRefs).toContain(updated.case.evidence.find(e => e.name === "auto-repair-estimate.txt")!.id);
    expect(updated.workflow.facts.policyNumber?.value ?? null).toBeNull();
    expect(updated.case.outcome).toMatchObject({ decision: "unknown", paymentStatus: "unverified", referenceNumber: null });

    const restarted = new WorkflowService(h.workflowDeps);
    const reloaded = restarted.get(OWNER, c.id);
    expect(reloaded.workflow.brief).toEqual(updated.workflow.brief);
    expect(reloaded.case.evidence).toEqual(updated.case.evidence);
    expect((await restarted.evidence(OWNER, c.id, upload)).case.revision).toBe(updated.case.revision);
    expect(h.extract).toHaveBeenCalledTimes(2);
    const reloadedCalls = new WorkflowCallService({ ...h.callDeps, workflow: restarted });
    expect((await reloadedCalls.list(OWNER, c.id)).calls[0]!.transcript).toBe(transcript);
    await reloadedCalls.start(OWNER, c.id, dispatch);
    expect(h.startCall).toHaveBeenCalledTimes(1);
    expect(reloaded.case.calls).toEqual([]);
    expect(reloaded.case.authorization).toBeNull();
  });
});
