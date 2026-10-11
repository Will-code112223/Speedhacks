import type { WorkflowCallAuthorization, WorkflowCallAuthorizeRequest, WorkflowCallListResponse, WorkflowCallStartRequest } from "../../../contracts/workflow-call";
import { ApiRequestError } from "../api/types";
import { matchesAuthorization, validCallNumber, type WorkflowCallApi } from "./call-client";

export type PendingCallRequest = { kind: "authorize"; request: WorkflowCallAuthorizeRequest; uncertain: boolean } | { kind: "start"; request: WorkflowCallStartRequest; uncertain: boolean };
export interface WorkflowCallState {
  data: WorkflowCallListResponse | null; selectedAuthorizationId: string | null; pending: PendingCallRequest | null;
  loading: boolean; busy: boolean; readFailed: boolean; recoveryBlocked: boolean; error: string | null;
}
export interface CallStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export const workflowCallStorageKey = (id: string) => `recourse:workflow-calls:v1:${id}`;
const activeStates = new Set(["dispatch_pending", "dispatch_unknown", "queued", "in_progress"]);
export const hasUnresolvedCall = (data: WorkflowCallListResponse | null) => !!data?.calls.some(call => activeStates.has(call.state));
/** Pure manager: GET recovery never authorizes or dispatches; an explicit retry retains the exact request. */
export function createWorkflowCallSession(caseId: string, api: WorkflowCallApi, storage: CallStorage) {
  const initial: WorkflowCallState = { data: null, selectedAuthorizationId: null, pending: null, loading: true, busy: false, readFailed: false, recoveryBlocked: false, error: null };
  let state = initial; let generation = 0; let readSequence = 0;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<WorkflowCallState>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
  function persist(pending: PendingCallRequest | null, selectedAuthorizationId: string | null) {
    storage.setItem(workflowCallStorageKey(caseId), JSON.stringify({ caseId, pending: pending ? { ...pending, uncertain: true } : null, selectedAuthorizationId }));
  }
  function persistAccepted(pending: PendingCallRequest | null, selectedAuthorizationId: string | null) {
    try { persist(pending, selectedAuthorizationId); }
    catch { publish({ recoveryBlocked: true, error: "The call was saved on the server, but local recovery storage is unavailable. Refresh to view its status." }); }
  }
  async function refresh(signal?: AbortSignal, manual = false) {
    if (state.busy) return;
    const read = ++readSequence; const before = generation;
    try {
      const data = await api.list(caseId, signal, manual);
      if (signal?.aborted || before !== generation || read !== readSequence) return;
      let pending = state.pending;
      if (pending?.kind === "start") { const request = pending.request; if (data.calls.some(call => call.requestId === request.requestId && call.authorizationId === request.authorizationId)) pending = null; }
      const selected = state.selectedAuthorizationId && data.authorizations.some(auth => auth.id === state.selectedAuthorizationId) ? state.selectedAuthorizationId : null;
      publish({ data, pending, selectedAuthorizationId: selected, readFailed: false, error: state.recoveryBlocked ? state.error : pending ? "The previous request is saved. Retry that exact request to confirm its result." : null });
      persistAccepted(pending, selected);
    } catch (error) { if (!signal?.aborted && before === generation && read === readSequence) publish({ error: message(error), readFailed: true }); }
    finally { if (!signal?.aborted && before === generation && read === readSequence) publish({ loading: false }); }
  }
  async function execute(pending: PendingCallRequest) {
    if (state.busy || state.loading || state.recoveryBlocked || state.readFailed) return;
    try { persist(pending, state.selectedAuthorizationId); }
    catch { publish({ error: "Enable session storage before authorizing a recoverable call.", recoveryBlocked: true }); return; }
    generation++; readSequence++;
    publish({ pending, busy: true, error: null });
    try {
      if (pending.kind === "authorize") {
        const authorization = await api.authorize(caseId, pending.request);
        const data = state.data ?? { caseId, authorizations: [], calls: [] };
        publish({ data: { ...data, authorizations: [...data.authorizations.filter(item => item.id !== authorization.id), authorization] }, selectedAuthorizationId: authorization.id, pending: null });
        persistAccepted(null, authorization.id);
      } else {
        const call = await api.start(caseId, pending.request);
        const authorization = state.data?.authorizations.find(item => item.id === pending.request.authorizationId);
        if (!authorization || !matchesAuthorization(call, authorization)) throw new ApiRequestError(502, "CONTRACT_VIOLATION", "The returned call does not match the approved recipient and brief. Refresh its saved status.");
        const data = state.data!;
        publish({ data: { ...data, calls: [...data.calls.filter(item => item.id !== call.id), call] }, pending: null });
        persistAccepted(null, state.selectedAuthorizationId);
      }
    } catch (error) {
      if (!pending.uncertain && definiteRejection(error)) {
        publish({ pending: null, error: message(error) }); persistAccepted(null, state.selectedAuthorizationId);
      } else {
        const uncertain = { ...pending, uncertain: true };
        publish({ pending: uncertain, error: message(error) }); persistAccepted(uncertain, state.selectedAuthorizationId);
      }
    } finally { publish({ busy: false }); }
  }
  return {
    getSnapshot: () => state, getServerSnapshot: () => initial,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async recover(signal?: AbortSignal) {
      try {
        const raw = storage.getItem(workflowCallStorageKey(caseId));
        if (raw) {
          const saved: unknown = JSON.parse(raw);
          if (!isSaved(saved, caseId)) throw new Error("Saved call recovery data is invalid. No call was replayed.");
          publish({ pending: saved.pending ? { ...saved.pending, uncertain: true } : null, selectedAuthorizationId: saved.selectedAuthorizationId });
        }
      } catch (error) { publish({ recoveryBlocked: true, error: message(error) }); }
      await refresh(signal);
    },
    refresh,
    async authorize(input: Omit<WorkflowCallAuthorizeRequest, "requestId">) {
      if (state.pending || hasUnresolvedCall(state.data)) return;
      await execute({ kind: "authorize", request: { ...input, requestId: crypto.randomUUID() }, uncertain: false });
    },
    selectAuthorization(id: string | null) {
      if (state.busy || state.pending || state.loading || state.recoveryBlocked || (id !== null && !state.data?.authorizations.some(item => item.id === id))) return;
      publish({ selectedAuthorizationId: id }); persistAccepted(null, id);
    },
    async start(authorization: WorkflowCallAuthorization) {
      if (state.pending || hasUnresolvedCall(state.data) || state.data?.calls.some(call => call.authorizationId === authorization.id) || !state.data?.authorizations.some(item => item.id === authorization.id)) return;
      await execute({ kind: "start", request: { requestId: crypto.randomUUID(), authorizationId: authorization.id }, uncertain: false });
    },
    async retry() { if (state.pending) await execute(state.pending); },
  };
}
function message(error: unknown) { return error instanceof Error ? error.message : "Call information is unavailable."; }
/** Only documented preflight failures prove that this first request never dispatched. */
function definiteRejection(error: unknown) {
  if (!(error instanceof ApiRequestError)) return false;
  const codes: Record<string, number> = { BAD_REQUEST: 400, ORIGIN_REQUIRED: 403, NOT_FOUND: 404, REVISION_CONFLICT: 409, MODE_MISMATCH: 409, WORKFLOW_REVIEW_REQUIRED: 409, WORKFLOW_NOT_READY: 409, AUTHORIZATION_CONFLICT: 409 };
  return codes[error.code] === error.status;
}
function isSaved(value: unknown, caseId: string): value is { caseId: string; pending: PendingCallRequest | null; selectedAuthorizationId: string | null } {
  if (!value || typeof value !== "object") return false;
  const saved = value as { caseId?: unknown; pending?: Partial<PendingCallRequest> | null; selectedAuthorizationId?: unknown };
  if (saved.caseId !== caseId || !(saved.selectedAuthorizationId === null || typeof saved.selectedAuthorizationId === "string")) return false;
  if (saved.pending === null) return true;
  const pending = saved.pending; const request = pending?.request;
  if (!pending || !request || typeof request.requestId !== "string") return false;
  if (pending.kind === "start") return "authorizationId" in request && typeof request.authorizationId === "string";
  if (pending.kind !== "authorize" || !("actionId" in request)) return false;
  return typeof request.actionId === "string" && typeof request.to === "string" && validCallNumber(request.to) && Number.isInteger(request.expectedRevision)
    && request.recipientConfirmed === true && Number.isInteger(request.maxDurationSeconds) && request.maxDurationSeconds >= 60 && request.maxDurationSeconds <= 3600;
}
