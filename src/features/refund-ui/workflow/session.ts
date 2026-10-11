import type { CaseWorkflow, WorkflowMessageRequest, WorkflowResponse } from "../../../contracts/workflow";
import { ApiRequestError, ApiUnreachableError } from "../api/types";
import type { WorkflowApi } from "./client";

export interface WorkflowState { workflow: CaseWorkflow | null; loading: boolean; busy: boolean; error: string | null; uncertain: boolean; pendingMessage: string | null; pendingUpload: boolean }
export const EMPTY_WORKFLOW: WorkflowState = { workflow: null, loading: false, busy: false, error: null, uncertain: false, pendingMessage: null, pendingUpload: false };
export interface WorkflowController extends WorkflowState {
  refresh(): Promise<void>;
  upload(files: File[]): Promise<boolean>;
  retry(): Promise<boolean>;
  analyze(): Promise<boolean>;
}

/** Retains the exact attempted mutation until its result is known; reads never replay it. */
export function createWorkflowSession(caseId: string, api: WorkflowApi, onResponse: (response: WorkflowResponse) => void) {
  let state: WorkflowState = EMPTY_WORKFLOW;
  let revision = 1;
  let reading = 0;
  let pending: { type: "message"; input: WorkflowMessageRequest } | { type: "evidence"; input: { requestId: string; expectedRevision: number; files: File[]; message?: string } } | { type: "analyze"; input: { requestId: string; expectedRevision: number } } | null = null;
  const listeners = new Set<() => void>();
  const set = (change: Partial<WorkflowState>) => { state = { ...state, ...change }; listeners.forEach(listener => listener()); };
  const accept = (response: WorkflowResponse): boolean => {
    if (response.case.id !== caseId || response.workflow.caseId !== caseId || response.case.revision !== response.workflow.caseRevision) throw new Error("The workflow does not belong to this case.");
    if (response.case.revision < revision || (state.workflow && response.case.revision < state.workflow.caseRevision)) return false;
    revision = response.case.revision;
    set({ workflow: response.workflow });
    onResponse(response);
    return true;
  };
  async function refresh(signal?: AbortSignal, clearError = true) {
    const ticket = ++reading;
    set({ loading: true });
    try {
      const response = await api.get(caseId, signal);
      if (signal?.aborted || ticket !== reading) return;
      const accepted = accept(response);
      if (!pending && clearError) set({ error: null });
      if (accepted && !pending && response.workflow.analysisStatus === "not_started") await analyze();
    } catch (error) {
      if (!signal?.aborted && ticket === reading) set({ error: error instanceof Error ? error.message : "The case plan could not be loaded." });
    } finally { if (ticket === reading) set({ loading: false }); }
  }
  async function execute() {
    if (!pending || state.busy) return false;
    const attempt = pending;
    set({ busy: true, error: null, pendingMessage: "message" in attempt.input ? attempt.input.message ?? null : null, pendingUpload: attempt.type === "evidence" });
    try {
      const result = attempt.type === "message" ? await api.message(caseId, attempt.input) : attempt.type === "evidence" ? await api.evidence(caseId, attempt.input) : await api.analyze(caseId, attempt.input);
      accept(result);
      pending = null;
      set({ uncertain: false, pendingMessage: null, pendingUpload: false });
      return true;
    } catch (error) {
      // Network errors and unreadable success responses may have committed. A
      // retry retains the same body and request ID even after a status refresh.
      const uncertain = error instanceof ApiUnreachableError || !(error instanceof ApiRequestError) || error.status >= 500 || error.code === "WORKFLOW_BUSY" || error.code === "WORKFLOW_REVISION_CONFLICT";
      if (!uncertain) { pending = null; set({ pendingMessage: null, pendingUpload: false }); }
      set({ error: error instanceof Error ? error.message : "The update could not be confirmed.", uncertain });
      if (error instanceof ApiRequestError && error.status === 409) await refresh(undefined, false);
      return false;
    } finally { set({ busy: false }); }
  }
  async function analyze(): Promise<boolean> {
    if (state.busy || pending) return false;
    pending = { type: "analyze", input: { requestId: crypto.randomUUID(), expectedRevision: revision } };
    return execute();
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => state,
    getServerSnapshot: () => EMPTY_WORKFLOW,
    setRevision(value: number) { revision = Math.max(revision, value); },
    refresh,
    retry: execute,
    analyze,
    async message(message: string): Promise<boolean> {
      if (state.busy || !message.trim()) return false;
      if (pending && (pending.type !== "message" || pending.input.message !== message.trim())) { set({ error: "Retry the previous unchanged message or upload first. Its result is still unknown." }); return false; }
      pending ??= { type: "message", input: { requestId: crypto.randomUUID(), expectedRevision: revision, message: message.trim() } };
      return execute();
    },
    async upload(files: File[], message?: string): Promise<boolean> {
      if (state.busy || files.length === 0) return false;
      if (pending && (pending.type !== "evidence" || pending.input.files.length !== files.length || pending.input.files.some((file, index) => file !== files[index]) || pending.input.message !== message)) { set({ error: "Retry the previous unchanged upload or message first. Its result is still unknown." }); return false; }
      pending ??= { type: "evidence", input: { requestId: crypto.randomUUID(), expectedRevision: revision, files, ...(message ? { message } : {}) } };
      return execute();
    },
  };
}
