import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowCallAttempt, WorkflowCallAuthorization } from "../../../../contracts/workflow-call";
import { ApiRequestError, ApiUnreachableError } from "../../api/types";
import { createWorkflowCallApi, type WorkflowCallApi } from "../call-client";
import { createWorkflowCallSession, workflowCallStorageKey } from "../call-session";
import { CallOutput } from "../WorkflowCallPanel";

const auth: WorkflowCallAuthorization = { id: "auth-one", caseId: "case-one", caseRevision: 2, actionId: "call-insurer", role: "insurer", purpose: "gather_information", to: "+15555550101", maxDurationSeconds: 120, brief: "Ask for required documents; no submission.", approvedAt: "2026-10-11T22:00:00Z" };
const call: WorkflowCallAttempt = { id: "call-one", requestId: "request-one", authorizationId: auth.id, caseId: auth.caseId, caseRevision: auth.caseRevision, actionId: auth.actionId, role: auth.role, purpose: auth.purpose, to: auth.to, maxDurationSeconds: auth.maxDurationSeconds, mode: "live", state: "completed", providerCallId: "provider-one", transcript: "User: We need photos and a repair estimate.", durationSeconds: 67, error: null, createdAt: auth.approvedAt, updatedAt: auth.approvedAt, result: { status: "transcript_available", summary: "The recipient's statements are available.", highlights: [{ kind: "documents", quote: "We need photos and a repair estimate." }], nextSteps: ["Gather the requested documents."] } };
function harness() {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const api = { list: vi.fn<WorkflowCallApi["list"]>().mockResolvedValue({ caseId: auth.caseId, authorizations: [], calls: [] }), authorize: vi.fn<WorkflowCallApi["authorize"]>().mockResolvedValue(auth), start: vi.fn<WorkflowCallApi["start"]>().mockImplementation(async (_id, request) => ({ ...call, requestId: request.requestId })) };
  const session = createWorkflowCallSession(auth.caseId, api, storage);
  const approve = () => session.authorize({ expectedRevision: 2, actionId: auth.actionId, to: auth.to, maxDurationSeconds: 120, recipientConfirmed: true });
  return { session, api, storage, values, approve };
}
describe("live website call recovery", () => {
  it("never places a call during approval or reload; dispatch is a separate action", async () => {
    const h = harness(); await h.session.recover(); await h.approve();
    expect(h.api.start).not.toHaveBeenCalled();
    h.api.list.mockResolvedValue({ caseId: auth.caseId, authorizations: [auth], calls: [] });
    const reloaded = createWorkflowCallSession(auth.caseId, h.api, h.storage); await reloaded.recover();
    expect(reloaded.getSnapshot().selectedAuthorizationId).toBe(auth.id); expect(h.api.start).not.toHaveBeenCalled();
    await reloaded.start(auth); expect(h.api.start).toHaveBeenCalledTimes(1);
    await reloaded.start(auth); expect(h.api.start).toHaveBeenCalledTimes(1);
  });
  it("retains the exact start request across a lost response and reload", async () => {
    const h = harness(); await h.session.recover(); await h.approve(); h.api.start.mockRejectedValueOnce(new ApiUnreachableError("lost response"));
    await h.session.start(auth); const original = h.api.start.mock.calls[0]![1];
    h.api.list.mockResolvedValue({ caseId: auth.caseId, authorizations: [auth], calls: [] });
    const reloaded = createWorkflowCallSession(auth.caseId, h.api, h.storage); await reloaded.recover();
    expect(h.api.start).toHaveBeenCalledTimes(1); await reloaded.retry();
    expect(h.api.start.mock.calls[1]![1]).toEqual(original);
  });
  it("GET recovery resolves a lost start response without dispatching again", async () => {
    const h = harness(); await h.session.recover(); await h.approve(); h.api.start.mockRejectedValueOnce(new ApiUnreachableError("lost"));
    await h.session.start(auth); const requestId = h.api.start.mock.calls[0]![1].requestId;
    h.api.list.mockResolvedValue({ caseId: auth.caseId, authorizations: [auth], calls: [{ ...call, requestId }] });
    await h.session.refresh(); expect(h.session.getSnapshot().pending).toBeNull(); expect(h.api.start).toHaveBeenCalledTimes(1);
  });
  it("keeps an ambiguous request frozen after a later rejection", async () => {
    const h = harness(); await h.session.recover(); await h.approve(); h.api.start.mockRejectedValueOnce(new ApiUnreachableError("lost")); await h.session.start(auth);
    h.api.start.mockRejectedValueOnce(new ApiRequestError(409, "AUTHORIZATION_CONFLICT", "stale")); await h.session.retry();
    expect(h.session.getSnapshot().pending?.kind).toBe("start");
  });
  it("allows correction after a first definitive preflight rejection", async () => {
    const h = harness(); await h.session.recover(); h.api.authorize.mockRejectedValueOnce(new ApiRequestError(409, "REVISION_CONFLICT", "changed")); await h.approve();
    expect(h.session.getSnapshot().pending).toBeNull(); expect(h.api.start).not.toHaveBeenCalled();
  });
  it("does not dispatch with damaged recovery storage or a failed server read", async () => {
    const h = harness(); h.values.set(workflowCallStorageKey(auth.caseId), "invalid-json"); await h.session.recover(); await h.approve();
    expect(h.session.getSnapshot().recoveryBlocked).toBe(true); expect(h.api.authorize).not.toHaveBeenCalled();
    const other = harness(); other.api.list.mockRejectedValueOnce(new Error("offline")); await other.session.recover(); await other.approve(); expect(other.api.authorize).not.toHaveBeenCalled();
  });
  it("rejects recipient changes in accepted call responses", async () => {
    const h = harness(); await h.session.recover(); await h.approve();
    h.api.start.mockImplementationOnce(async (_id, request) => ({ ...call, requestId: request.requestId, to: "+15555550999" }));
    await h.session.start(auth); expect(h.session.getSnapshot().pending?.uncertain).toBe(true); expect(h.session.getSnapshot().data?.calls).toEqual([]);
  });
});
describe("website output and transport", () => {
  it("offers the evidence handoff only for returned document requirements on the latest finished call", () => {
    const onRequestEvidence = vi.fn();
    const output = (value: WorkflowCallAttempt, latest = true) => renderToStaticMarkup(<CallOutput call={value} latest={latest} onRequestEvidence={onRequestEvidence} />);
    expect(output(call)).toContain("Add requested documents");
    expect(output(call, false)).not.toContain("Add requested documents");
    expect(output({ ...call, state: "in_progress" })).not.toContain("Add requested documents");
    expect(output({ ...call, result: { ...call.result, highlights: [] } })).not.toContain("Add requested documents");
    expect(onRequestEvidence).not.toHaveBeenCalled();
  });
  it("renders actual transcript, returned document requirements and private download without autoplay", () => {
    const html = renderToStaticMarkup(<CallOutput call={call} latest />);
    expect(html).toContain("We need photos and a repair estimate."); expect(html).toContain("67 seconds");
    expect(html).toContain("Download transcript"); expect(html).toContain("Load call recording");
    expect(html).not.toContain("<audio"); expect(html).not.toContain("api.getdial.ai");
  });
  it("shows uncertain dispatch without inventing a completed outcome", () => {
    const html = renderToStaticMarkup(<CallOutput call={{ ...call, state: "dispatch_unknown", transcript: null, durationSeconds: null, result: { status: "uncertain", summary: "Check the existing attempt; do not redial.", highlights: [], nextSteps: [] } }} latest />);
    expect(html).toContain("Dispatch unconfirmed"); expect(html).not.toContain("Load call recording"); expect(html).not.toContain("Download transcript");
  });
  it("rejects mismatched case or authorization bindings from GET", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ caseId: auth.caseId, authorizations: [auth], calls: [{ ...call, maxDurationSeconds: 3600 }] }));
    await expect(createWorkflowCallApi(fetcher).list(auth.caseId)).rejects.toMatchObject({ code: "CONTRACT_VIOLATION" });
  });
  it("sends approvals to the real owner-scoped endpoint with same-origin credentials", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ authorization: auth }));
    await createWorkflowCallApi(fetcher).authorize(auth.caseId, { requestId: "request", expectedRevision: 2, actionId: auth.actionId, to: auth.to, maxDurationSeconds: 120, recipientConfirmed: true });
    expect(fetcher).toHaveBeenCalledWith("/api/cases/case-one/workflow/calls/authorize", expect.objectContaining({ method: "POST", credentials: "same-origin", cache: "no-store" }));
  });
});
