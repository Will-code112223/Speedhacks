import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowResponse } from "../../../../contracts/workflow";
import type { BrowserRun } from "../../../../contracts/browser";
import { parseSavedPreparation, startPreparation } from "../../browser/PreparationPreview";
import { createFixtureCaseApi } from "../../api/fixture";
import { ApiRequestError, ApiUnreachableError } from "../../api/types";
import { createWorkflowApi, type WorkflowApi } from "../client";
import WorkflowPanel, { EvidencePicker, publicContactUrl } from "../WorkflowPanel";
import { createWorkflowSession, EMPTY_WORKFLOW } from "../session";
import ChatColumn from "../../chat/ChatColumn";
import type { CaseSessionController } from "../../state/controller";
import { initialSessionsState, sessionsReducer } from "../../state/session";

async function response(revision = 1): Promise<WorkflowResponse> {
  const caseData = await createFixtureCaseApi({ scenario: "insurance_claim", latencyMs: 0 }).createCase({ summary: "Help prepare my car claim" });
  caseData.id = "case-owned";
  caseData.revision = revision;
  return { case: caseData, workflow: {
    caseId: caseData.id, caseRevision: revision, kind: "auto_insurance", stage: "collecting", analysisStatus: "complete",
    facts: {}, messages: [{ id: "m1", role: "user", content: "Help prepare my car claim", createdAt: caseData.createdAt }],
    questions: [{ id: "loss", field: "lossDate", question: "When did the damage happen?", required: true }], conflicts: [], contacts: [],
    brief: { title: "Auto claim preparation", body: "Loss date: unknown. No claim has been filed.", updatedAt: caseData.updatedAt },
    actions: [{ id: "call-other", type: "call", title: "Ask the other party for missing information", description: "Review this planned contact.", status: "ready", blockedBy: [], browser: null, call: { role: "other_party", to: null, purpose: "Confirm incident details", brief: "Ask about the incident. Do not assert liability." } }],
    updatedAt: caseData.updatedAt,
  } };
}
function apiWith(value: WorkflowResponse): WorkflowApi {
  return { get: vi.fn().mockResolvedValue(value), message: vi.fn().mockResolvedValue(value), evidence: vi.fn().mockResolvedValue(value), analyze: vi.fn().mockResolvedValue(value) };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe("real workflow transport", () => {
  it("sends follow-ups to their owner-scoped endpoint, never as local notes", async () => {
    const value = await response(2);
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(value)));
    const input = { requestId: "stable-id", expectedRevision: 1, message: "The incident was on Friday" };
    await createWorkflowApi(fetcher).message(value.case.id, input);
    expect(fetcher).toHaveBeenCalledWith("/api/cases/case-owned/messages", expect.objectContaining({ method: "POST", body: JSON.stringify(input), credentials: "same-origin", cache: "no-store", signal: expect.any(AbortSignal) }));
  });
  it("uploads real files with revision and request ID and lets fetch supply the multipart boundary", async () => {
    const value = await response(2);
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(value)));
    const file = new File(["user evidence"], "receipt.txt", { type: "text/plain" });
    await createWorkflowApi(fetcher).evidence(value.case.id, { requestId: "upload-id", expectedRevision: 1, files: [file] });
    const options = fetcher.mock.calls[0]![1] as RequestInit;
    expect(new Headers(options.headers).has("content-type")).toBe(false);
    const form = options.body as FormData;
    expect(form.get("requestId")).toBe("upload-id"); expect(form.get("expectedRevision")).toBe("1");
    expect(await (form.get("files") as File).text()).toBe("user evidence");
  });
  it.each(["wrong owner", "mixed revision", "malformed plan"])("rejects a %s response", async kind => {
    const value = await response();
    if (kind === "wrong owner") value.workflow.caseId = "other-case";
    if (kind === "mixed revision") value.workflow.caseRevision = 99;
    if (kind === "malformed plan") (value.workflow as unknown as { questions: unknown }).questions = [{}];
    const api = createWorkflowApi(vi.fn().mockResolvedValue(new Response(JSON.stringify(value))));
    await expect(api.get("case-owned")).rejects.toMatchObject({ code: "CONTRACT_VIOLATION" });
  });
  it("surfaces provider failure instead of substituting a fake workflow", async () => {
    const api = createWorkflowApi(vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "WORKFLOW_MODEL_FAILED", message: "Analysis did not finish." } }), { status: 503 })));
    await expect(api.get("case-owned")).rejects.toMatchObject({ status: 503, code: "WORKFLOW_MODEL_FAILED" });
  });
});

describe("workflow recovery and mutation ordering", () => {
  it("automatically analyzes a new case once and does not dial or start a browser", async () => {
    const initial = await response(); initial.workflow.analysisStatus = "not_started";
    const ready = await response(2);
    const api = apiWith(initial); vi.mocked(api.analyze).mockResolvedValue(ready);
    const session = createWorkflowSession("case-owned", api, vi.fn());
    await session.refresh();
    expect(api.analyze).toHaveBeenCalledOnce();
    expect(api.analyze).toHaveBeenCalledWith("case-owned", { requestId: expect.any(String), expectedRevision: 1 });
    expect(session.getSnapshot().workflow?.analysisStatus).toBe("complete");
    expect(api.message).not.toHaveBeenCalled(); expect(api.evidence).not.toHaveBeenCalled();
  });
  it("retains an ambiguous message ID/body through refresh and rejects a different replacement", async () => {
    const initial = await response(); const saved = await response(2);
    const api = apiWith(initial); vi.mocked(api.message).mockRejectedValueOnce(new ApiUnreachableError()).mockResolvedValue(saved);
    const session = createWorkflowSession("case-owned", api, vi.fn());
    expect(await session.message("The loss was Friday")).toBe(false);
    const original = vi.mocked(api.message).mock.calls[0]![1];
    vi.mocked(api.get).mockResolvedValue(saved); await session.refresh();
    expect(await session.message("A different request")).toBe(false);
    expect(api.message).toHaveBeenCalledTimes(1);
    expect(await session.retry()).toBe(true);
    expect(vi.mocked(api.message).mock.calls[1]![1]).toEqual(original);
    expect(session.getSnapshot().uncertain).toBe(false);
  });
  it("retains uploaded files for an exact retry after a lost response", async () => {
    const value = await response(2); const api = apiWith(value);
    vi.mocked(api.evidence).mockRejectedValueOnce(new ApiUnreachableError()).mockResolvedValue(value);
    const session = createWorkflowSession("case-owned", api, vi.fn());
    const file = new File(["evidence"], "photo.txt");
    expect(await session.upload([file])).toBe(false);
    expect(session.getSnapshot().pendingUpload).toBe(true);
    expect(await session.retry()).toBe(true);
    expect(vi.mocked(api.evidence).mock.calls[1]![1]).toBe(vi.mocked(api.evidence).mock.calls[0]![1]);
  });
  it("an in-progress replay keeps its original request identity until the backend finishes", async () => {
    const value = await response(2); value.workflow.analysisStatus = "processing";
    const finished = await response(3); const api = apiWith(value);
    vi.mocked(api.message).mockRejectedValueOnce(new ApiUnreachableError()).mockRejectedValueOnce(new ApiRequestError(409, "WORKFLOW_BUSY", "Still processing")).mockResolvedValueOnce(finished);
    const session = createWorkflowSession("case-owned", api, vi.fn());
    await session.message("Saved user answer"); await session.retry();
    expect(session.getSnapshot().uncertain).toBe(true);
    await session.retry();
    const attempts = vi.mocked(api.message).mock.calls.map(call => call[1]);
    expect(attempts[0]).toBe(attempts[1]); expect(attempts[1]).toBe(attempts[2]);
    expect(session.getSnapshot().workflow?.caseRevision).toBe(3);
  });
  it("a model failure recovery does not spend a second analysis request until explicitly retried", async () => {
    const value = await response(2); value.workflow.analysisStatus = "failed";
    const api = apiWith(value);
    vi.mocked(api.message).mockRejectedValueOnce(new ApiRequestError(503, "WORKFLOW_MODEL_FAILED", "Saved, analysis failed")).mockResolvedValue(value);
    const session = createWorkflowSession("case-owned", api, vi.fn());
    await session.message("My evidence details"); await session.retry();
    expect(api.analyze).not.toHaveBeenCalled();
    await session.analyze(); expect(api.analyze).toHaveBeenCalledOnce();
  });
  it("does not replace newer plan facts with a late GET", async () => {
    const initial = await response(); const latest = await response(2); const delayed = deferred<WorkflowResponse>();
    const api = apiWith(latest); vi.mocked(api.get).mockReturnValue(delayed.promise);
    const received = vi.fn(); const session = createWorkflowSession("case-owned", api, received);
    const read = session.refresh(); await session.message("Updated facts"); delayed.resolve(initial); await read;
    expect(session.getSnapshot().workflow?.caseRevision).toBe(2);
    expect(received).toHaveBeenCalledTimes(1);
  });
  it("blocks double sends and refreshes after a revision conflict without silently replaying the update", async () => {
    const api = apiWith(await response(3)); const delayed = deferred<WorkflowResponse>();
    vi.mocked(api.message).mockReturnValueOnce(delayed.promise).mockRejectedValueOnce(new ApiRequestError(409, "REVISION_CONFLICT", "Reload first"));
    const session = createWorkflowSession("case-owned", api, vi.fn());
    const first = session.message("First"); expect(await session.message("Second")).toBe(false); delayed.resolve(await response(2)); await first;
    expect(await session.message("Third")).toBe(false); expect(api.get).toHaveBeenCalledOnce();
    expect(session.getSnapshot().error).toBe("Reload first"); expect(session.getSnapshot().workflow?.caseRevision).toBe(3);
    expect(api.message).toHaveBeenCalledTimes(2);
  });
});

describe("workflow evidence and action UI", () => {
  it.each(["ready", "processing", "failed", "conflict", "missing fact", "no evidence", "busy", "uncertain"])("shows provider upload review only for a prepared local packet: %s", async state => {
    const value = await response(4);
    value.workflow.stage = "ready"; value.workflow.questions = [];
    value.workflow.facts.insuranceProvider = { label: "Insurer", value: "AAA", source: "user", sourceRefs: ["m1"] };
    if (state === "processing" || state === "failed") value.workflow.analysisStatus = state;
    if (state === "conflict") value.workflow.conflicts = ["Incident date differs"];
    if (state === "missing fact") value.workflow.questions = [{ id: "loss", field: "lossDate", question: "When?", required: true }];
    const html = renderToStaticMarkup(<WorkflowPanel controller={{ ...EMPTY_WORKFLOW, workflow: value.workflow, busy: state === "busy", uncertain: state === "uncertain", refresh: async () => {}, upload: async () => false, retry: async () => false, analyze: async () => false }} evidence={state === "no evidence" ? [] : [{ id: "photo", name: "damage-photo.png", mimeType: "image/png" }, { id: "quote", name: "repair-estimate.txt", mimeType: "text/plain" }]} />);
    if (state === "ready") {
      expect(html).toContain("Packet prepared for AAA"); expect(html).toContain("Not uploaded");
      expect(html).toContain("2 saved attachments"); expect(html).toContain("no files have been sent to the insurer");
      expect(html).toContain("Prepare in browser"); expect(html).toContain("Recourse preparation — not an insurer website");
      expect(html).not.toContain("Packet ready for review · Not submitted");
    } else { expect(html).not.toContain('aria-label="Provider upload review"'); expect(html).not.toContain("Prepare in browser"); }
    expect(html).not.toContain("Upload complete"); expect(html).not.toContain("Approved by AAA");
  });
  it("keeps an insurance case out of the legacy refund facts and approval form", async () => {
    const value = await response();
    value.case.mode = "live";
    value.case.evidence = [{ id: "evidence-photo", name: "damage-photo.png", mimeType: "image/png" }];
    const api = createFixtureCaseApi({ latencyMs: 0 });
    let sessions = sessionsReducer(initialSessionsState, { type: "session/started", key: "insurance", api, scenario: null, text: "Prepare my claim", attachments: [], notice: null, at: value.case.createdAt });
    sessions = sessionsReducer(sessions, { type: "create/succeeded", key: "insurance", caseData: value.case, liveCapable: false, at: value.case.updatedAt });
    const noop = () => {};
    const controller: CaseSessionController = {
      apiMode: "http", scenario: null, setScenario: noop, fixtureSettings: { showLoading: false, v1Only: false }, setFixtureSettings: noop,
      sessions: sessions.sessions, active: sessions.sessions[0]!, capabilities: null, call: null, live: null, liveError: null, pendingDecision: null, activeMs: 0,
      selectCase: noop, send: async () => true, retryCreate: noop, saveFacts: async () => null, reloadCase: noop, retryUpdates: noop, approve: noop,
      answerDecision: noop, dismissDecision: noop, stepIn: noop, leaveCall: noop, downloadPacket: noop,
      workflow: { ...EMPTY_WORKFLOW, workflow: value.workflow, refresh: async () => {}, upload: async () => false, retry: async () => false, analyze: async () => false },
    };
    const html = renderToStaticMarkup(<ChatColumn controller={controller} fixture={false} phoneHint={null} planCount={0} callBar={null} metrics={null} />);
    expect(html).toContain("Insurance packet"); expect(html).toContain("damage-photo.png");
    expect(html).toContain("When did the damage happen?"); expect(html).toContain("Review call");
    expect(html).not.toContain('data-testid="facts-card"'); expect(html).not.toContain('data-testid="approve-button"');
    expect(html).not.toContain('data-testid="case-documents"');
  });
  it("shows the updated evidence revision without claiming an insurer submission", async () => {
    const value = await response(4);
    const html = renderToStaticMarkup(<WorkflowPanel controller={{ ...EMPTY_WORKFLOW, workflow: value.workflow, refresh: async () => {}, upload: async () => false, retry: async () => false, analyze: async () => false }} evidence={[{ id: "photo", name: "damage-photo.png", mimeType: "image/png" }, { id: "quote", name: "repair-estimate.txt", mimeType: "text/plain" }]} />);
    expect(html).toContain("Revision 4"); expect(html).toContain("damage-photo.png"); expect(html).toContain("repair-estimate.txt");
    expect(html).toContain("not submitted to an insurer");
  });
  it("shows unknown facts, questions and real brief download without authorizing insurance calls", async () => {
    const value = await response(); const onAction = vi.fn();
    const html = renderToStaticMarkup(<WorkflowPanel controller={{ ...EMPTY_WORKFLOW, workflow: value.workflow, refresh: async () => {}, upload: async () => false, retry: async () => false, analyze: async () => false }} onAction={onAction} />);
    expect(html).toContain("When did the damage happen?"); expect(html).toContain("Loss date: unknown");
    expect(html).toContain('/api/cases/case-owned/workflow/brief'); expect(html).toContain("Action list");
    expect(html).toContain("Review call plan"); expect(html).toContain("approve one information call before placing it");
    expect(html).not.toContain("Approve this call"); expect(onAction).not.toHaveBeenCalled();
  });
  it("has a labelled multiple evidence input and preserves chosen file names", () => {
    const html = renderToStaticMarkup(<EvidencePicker files={[new File(["one"], "receipt.txt")]} onFiles={() => {}} existing={false} busy={false} onUpload={() => {}} />);
    expect(html).toContain('type="file"'); expect(html).toContain('multiple=""'); expect(html).toContain("receipt.txt");
    expect(html).toContain("attached when you send your request"); expect(html).not.toContain("Upload evidence</");
  });
  it("rejects executable and credential-bearing contact URLs", () => {
    expect(publicContactUrl("javascript:alert(1)")).toBeNull(); expect(publicContactUrl("https://user:pass@example.com")).toBeNull();
    expect(publicContactUrl("https://www.geico.com/claims/")).toBe("https://www.geico.com/claims/");
  });
});

describe("preparation browser boundary", () => {
  const request = { expectedRevision: 4, requestId: "preparation-request" };
  const run: BrowserRun = {
    id: "browser-one", caseId: "case-owned", requestId: request.requestId, caseRevision: 4,
    task: "Prepare local packet", startUrl: "https://recourse.invalid/preparation", allowedHosts: [],
    currentUrl: null, pageTitle: null, status: "running", pendingAction: null,
    frameAvailable: false, events: [], artifacts: [], message: "Opening preparation form",
    createdAt: "2026-10-11T12:00:00Z", updatedAt: "2026-10-11T12:00:00Z",
  };
  it("sends a scoped preparation request and preserves a lost response identity on explicit retry", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("connection lost")).mockResolvedValueOnce(new Response(JSON.stringify({ run })));
    await expect(startPreparation("case-owned", request, fetcher)).rejects.toMatchObject({ status: null });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await startPreparation("case-owned", request, fetcher)).toEqual(run);
    for (const call of fetcher.mock.calls) {
      expect(call[0]).toBe("/api/cases/case-owned/preparation");
      expect(call[1]).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", body: JSON.stringify(request) });
    }
  });
  it.each([{ caseId: "someone-else" }, { caseRevision: 5 }, { requestId: "other-request" }, { status: "pretend_success" }])("rejects unrelated or invalid preparation run data: %j", async changed => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ run: { ...run, ...changed } })));
    await expect(startPreparation("case-owned", request, fetcher)).rejects.toMatchObject({ status: null });
  });
  it("distinguishes a definite revision rejection from an ambiguous transport failure", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "Refresh the case revision first." } }), { status: 409 }));
    await expect(startPreparation("case-owned", request, fetcher)).rejects.toMatchObject({ status: 409, message: "Refresh the case revision first." });
  });
  it("recovers only preparation identity, dropping unrelated saved properties", () => {
    expect(parseSavedPreparation(JSON.stringify({ request: { ...request, facts: "must not be copied" }, runId: "browser-one", documents: "must not be copied" }))).toEqual({ request, runId: "browser-one" });
    expect(parseSavedPreparation(JSON.stringify({ request, runId: null }))).toEqual({ request, runId: null });
  });
  it.each(["not-json", "{}", JSON.stringify({ request: { ...request, expectedRevision: -1 }, runId: null }), JSON.stringify({ request, runId: {} })])("rejects invalid saved preparation identity: %s", raw => {
    expect(() => parseSavedPreparation(raw)).toThrow();
  });
});
