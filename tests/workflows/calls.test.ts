import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StartCallResult, VoiceAdapter, VoiceSnapshot } from "@/contracts/voice";
import { loadConfig } from "@/server/config";
import { CaseService } from "@/server/cases/service";
import { EMPTY_FIELDS } from "@/server/documents/extractor";
import { UploadStore } from "@/server/documents/storage";
import { closeDatabase, openDatabase } from "@/server/persistence/db";
import { CaseRepository } from "@/server/persistence/repository";
import { WorkflowService } from "@/server/workflows/service";
import { WorkflowStore } from "@/server/workflows/store";
import { WorkflowCallService } from "@/server/workflows/call-service";
import { closeInsurerDatabase } from "@/server/insurers";

const OWNER = "a".repeat(48); const OTHER = "b".repeat(48);
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); });
async function harness() {
  closeDatabase();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-call-"));
  const config = loadConfig({ REFUND_MODE: "live", DATA_DIR: dataDir, OPENAI_API_KEY: "offline-test-key", LLM_MODEL: "offline-test-model", DIAL_API_KEY: "offline", DIAL_FROM_NUMBER: "+15555550100" });
  const db = openDatabase(dataDir); const repo = new CaseRepository(db);
  let time = Date.now();
  const startCall = vi.fn<VoiceAdapter["startCall"]>().mockResolvedValue({ state: "accepted", mode: "live", providerCallId: "provider-1" });
  const getCall = vi.fn<VoiceAdapter["getCall"]>().mockResolvedValue({ providerCallId: "provider-1", mode: "live", state: "completed", transcript: null, durationSeconds: 67 });
  const adapter: VoiceAdapter = { startCall, getCall, verifyWebhook: vi.fn() };
  const voice = vi.fn(() => adapter);
  const cases = new CaseService({ config, repo, uploads: new UploadStore(dataDir), voice, extractor: {
    kind: "openai", extract: async () => ({ fields: { ...EMPTY_FIELDS }, provenance: [], notes: [] }),
  } });
  const workflow = new WorkflowService({ config, db, repo, cases, extractor: { extract: vi.fn() } });
  const c = await cases.createCase(OWNER, { summary: "Help prepare a car insurance claim", fields: {}, files: [] });
  const prepared = workflow.get(OWNER, c.id).workflow;
  prepared.analysisStatus = "complete";
  prepared.facts.vehicle = { label: "Vehicle", value: "2022 Honda Civic", source: "user", sourceRefs: [] };
  prepared.facts.incidentDescription = { label: "Incident", value: "Parked car rear bumper damage", source: "user", sourceRefs: [] };
  prepared.facts.policyNumber = { label: "Policy", value: "PRIVATE-POLICY", source: "user", sourceRefs: [] };
  new WorkflowStore(db).save(OWNER, prepared);
  const deps = { config, db, repo, workflow, voice, now: () => new Date(time) };
  const service = new WorkflowCallService(deps);
  const input = () => ({ requestId: randomUUID(), expectedRevision: c.revision, actionId: "call-insurer", to: "+15555550101", maxDurationSeconds: 120, recipientConfirmed: true as const });
  const approve = () => service.authorize(OWNER, c.id, input()).authorization;
  cleanup.push(() => { closeDatabase(); closeInsurerDatabase(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { service, deps, config, db, repo, cases, workflow, c, input, approve, startCall, getCall, voice, advance: (ms = 31_000) => { time += ms; } };
}
describe("durable live information call boundary (mock provider)", () => {
  it("freezes approved recipient, duration and relevant facts without refund amount or private policy", async () => {
    const h = await harness(); const auth = h.approve();
    expect(auth.brief).toContain("2022 Honda Civic"); expect(auth.brief).toContain("Parked car rear bumper damage");
    expect(auth.brief).not.toContain("PRIVATE-POLICY"); expect(h.startCall).not.toHaveBeenCalled();
    const { call } = await h.service.start(OWNER, h.c.id, { requestId: randomUUID(), authorizationId: auth.id });
    expect(call.state).toBe("queued"); expect(h.voice).toHaveBeenCalledWith(120);
    expect(h.startCall).toHaveBeenCalledWith(expect.objectContaining({ to: auth.to, brief: auth.brief, authorizationId: auth.id }));
    expect((await h.cases.getCase(OWNER, h.c.id)).outcome.decision).toBe("unknown");
  });
  it("rejects stale or superseded authorizations before any dispatch", async () => {
    const h = await harness(); const first = h.approve(); h.approve();
    await expect(h.service.start(OWNER, h.c.id, { requestId: randomUUID(), authorizationId: first.id })).rejects.toMatchObject({ code: "AUTHORIZATION_CONFLICT" });
    const current = h.approve(); h.cases.patchCase(OWNER, h.c.id, h.c.revision, { reason: "Changed incident" });
    await expect(h.service.start(OWNER, h.c.id, { requestId: randomUUID(), authorizationId: current.id })).rejects.toMatchObject({ code: "AUTHORIZATION_CONFLICT" });
    expect(h.startCall).not.toHaveBeenCalled();
  });
  it.each(["not_started", "processing", "failed"] as const)("blocks %s analysis", async status => {
    const h = await harness(); const w = h.workflow.get(OWNER, h.c.id).workflow; w.analysisStatus = status; new WorkflowStore(h.db).save(OWNER, w);
    expect(() => h.approve()).toThrowError(expect.objectContaining({ code: "WORKFLOW_NOT_READY" }));
  });
  it("blocks conflicting facts and recipient confirmation omission", async () => {
    const h = await harness(); const w = h.workflow.get(OWNER, h.c.id).workflow; w.conflicts = ["vehicle: two conflicting vehicles"]; new WorkflowStore(h.db).save(OWNER, w);
    expect(() => h.approve()).toThrowError(expect.objectContaining({ code: "WORKFLOW_NOT_READY" }));
    expect(() => h.service.authorize(OWNER, h.c.id, { ...h.input(), recipientConfirmed: false as true })).toThrow();
  });
  it("deduplicates concurrent deliveries and restart reads without another provider POST", async () => {
    const h = await harness(); const auth = h.approve(); const request = { requestId: randomUUID(), authorizationId: auth.id };
    const calls = await Promise.all([h.service.start(OWNER, h.c.id, request), h.service.start(OWNER, h.c.id, request)]);
    expect(calls[0]!.call.id).toBe(calls[1]!.call.id); expect(h.startCall).toHaveBeenCalledTimes(1);
    await new WorkflowCallService(h.deps).start(OWNER, h.c.id, request);
    await h.service.start(OWNER, h.c.id, { ...request, requestId: randomUUID() });
    expect(h.startCall).toHaveBeenCalledTimes(1);
  });
  it("preserves unknown dispatch across restart, prevents new approvals and legacy edits", async () => {
    const h = await harness(); const auth = h.approve(); h.startCall.mockRejectedValueOnce(new Error("timeout after accepted POST"));
    const request = { requestId: randomUUID(), authorizationId: auth.id };
    expect((await h.service.start(OWNER, h.c.id, request)).call.state).toBe("dispatch_unknown");
    const restarted = new WorkflowCallService(h.deps);
    await restarted.start(OWNER, h.c.id, request);
    expect(() => h.approve()).toThrowError(expect.objectContaining({ code: "CALL_IN_PROGRESS" }));
    expect(() => h.cases.patchCase(OWNER, h.c.id, h.c.revision, { reason: "retry" })).toThrowError(expect.objectContaining({ code: "CALL_IN_PROGRESS" }));
    expect(h.startCall).toHaveBeenCalledTimes(1);
  });
  it("reserves uncertain state before an interrupted provider call can finish", async () => {
    const h = await harness(); const auth = h.approve(); let finish!: (value: StartCallResult) => void;
    h.startCall.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const request = { requestId: randomUUID(), authorizationId: auth.id }; const pending = h.service.start(OWNER, h.c.id, request);
    expect((await new WorkflowCallService(h.deps).start(OWNER, h.c.id, request)).call.state).toBe("dispatch_unknown");
    finish({ state: "accepted", mode: "live", providerCallId: "provider-1" }); await pending;
    expect(h.startCall).toHaveBeenCalledTimes(1);
  });
  it("refuses other owners and mismatched idempotency bodies", async () => {
    const h = await harness(); const input = h.input(); const auth = h.service.authorize(OWNER, h.c.id, input).authorization;
    expect(() => h.service.authorize(OWNER, h.c.id, { ...input, to: "+15555550102" })).toThrowError(expect.objectContaining({ code: "REQUEST_CONFLICT" }));
    await expect(h.service.list(OTHER, h.c.id)).rejects.toMatchObject({ status: 404 });
    await expect(h.service.start(OTHER, h.c.id, { requestId: randomUUID(), authorizationId: auth.id })).rejects.toMatchObject({ status: 404 });
    expect(h.startCall).not.toHaveBeenCalled(); expect(h.getCall).not.toHaveBeenCalled();
  });
  it("keeps simulated or malformed acceptance uncertain", async () => {
    const h = await harness(); const auth = h.approve();
    h.startCall.mockResolvedValueOnce({ state: "accepted", mode: "simulated", providerCallId: "sim_dial_123" });
    expect((await h.service.start(OWNER, h.c.id, { requestId: randomUUID(), authorizationId: auth.id })).call.state).toBe("dispatch_unknown");
  });
  it("recovers late transcripts without fabricating refund or coverage outcomes", async () => {
    const h = await harness(); const auth = h.approve(); await h.service.start(OWNER, h.c.id, { requestId: randomUUID(), authorizationId: auth.id });
    expect((await h.service.list(OWNER, h.c.id)).calls[0]!.result.status).toBe("transcript_pending");
    h.advance(); h.getCall.mockResolvedValueOnce({ providerCallId: "provider-1", mode: "live", state: "completed", transcript: "User: We need photos and a repair estimate.", durationSeconds: 67 });
    const result = (await h.service.list(OWNER, h.c.id)).calls[0]!;
    expect(result.result.highlights[0]!.quote).toContain("photos");
    expect((await h.cases.getCase(OWNER, h.c.id)).outcome).toMatchObject({ decision: "unknown", paymentStatus: "unverified" });
    h.advance(); h.getCall.mockResolvedValueOnce({ providerCallId: "provider-1", mode: "live", state: "queued", transcript: null, durationSeconds: null });
    const regressed = (await h.service.list(OWNER, h.c.id, { refresh: true })).calls[0]!;
    expect(regressed.state).toBe("completed"); expect(regressed.transcript).toBe(result.transcript);
  });
  it("rejects mismatched provider snapshots without replacing saved state", async () => {
    const h = await harness(); const auth = h.approve(); await h.service.start(OWNER, h.c.id, { requestId: randomUUID(), authorizationId: auth.id });
    h.getCall.mockResolvedValueOnce({ providerCallId: "someone-else", mode: "live", state: "completed", transcript: "User: Private", durationSeconds: 5 } as VoiceSnapshot);
    const call = (await h.service.list(OWNER, h.c.id)).calls[0]!;
    expect(call.state).toBe("queued"); expect(call.transcript).toBeNull(); expect(call.error).not.toBeNull();
  });
  it.each(["completed", "failed", "cancelled"] as const)("keeps checking a %s call for a later complete transcript", async state => {
    const h = await harness(); const auth = h.approve(); await h.service.start(OWNER, h.c.id, { requestId: randomUUID(), authorizationId: auth.id });
    h.getCall.mockResolvedValueOnce({ providerCallId: "provider-1", mode: "live", state, transcript: "Agent: Hello.", durationSeconds: 10 });
    await h.service.list(OWNER, h.c.id); h.advance();
    const full = "Agent: Hello.\nUser: Please upload a repair estimate.";
    h.getCall.mockResolvedValueOnce({ providerCallId: "provider-1", mode: "live", state, transcript: full, durationSeconds: 20 });
    const updated = (await h.service.list(OWNER, h.c.id)).calls[0]!;
    expect(updated.transcript).toBe(full); expect(updated.result.highlights).toHaveLength(1);
  });
});
