import type { WorkflowCallAttempt, WorkflowCallAuthorization, WorkflowCallAuthorizeRequest, WorkflowCallListResponse, WorkflowCallStartRequest } from "../../../contracts/workflow-call";
import { ApiRequestError, ApiUnreachableError } from "../api/types";
import { isRecord, readApiError } from "../api/validate";

export interface WorkflowCallApi {
  list(caseId: string, signal?: AbortSignal, refresh?: boolean): Promise<WorkflowCallListResponse>;
  authorize(caseId: string, request: WorkflowCallAuthorizeRequest): Promise<WorkflowCallAuthorization>;
  start(caseId: string, request: WorkflowCallStartRequest): Promise<WorkflowCallAttempt>;
}
const oneOf = (value: unknown, choices: string[]) => typeof value === "string" && choices.includes(value);
const text = (value: unknown) => typeof value === "string";
const nullableText = (value: unknown) => value === null || text(value);
const texts = (value: unknown) => Array.isArray(value) && value.every(text);
const natural = (value: unknown) => Number.isInteger(value) && Number(value) >= 0;
export const validCallNumber = (value: string) => /^\+[1-9]\d{7,14}$/.test(value);
function base(value: Record<string, unknown>) {
  return ["id", "caseId", "actionId"].every(key => text(value[key])) && natural(value.caseRevision) && Number(value.caseRevision) >= 1
    && oneOf(value.role, ["merchant", "insurer", "other_party"]) && value.purpose === "gather_information" && typeof value.to === "string" && validCallNumber(value.to)
    && natural(value.maxDurationSeconds) && Number(value.maxDurationSeconds) >= 60 && Number(value.maxDurationSeconds) <= 3600;
}
export function isWorkflowCallAuthorization(value: unknown): value is WorkflowCallAuthorization {
  return isRecord(value) && base(value) && text(value.brief) && text(value.approvedAt);
}
export function isWorkflowCall(value: unknown): value is WorkflowCallAttempt {
  if (!isRecord(value) || !base(value) || value.mode !== "live" || !["requestId", "authorizationId", "createdAt", "updatedAt"].every(key => text(value[key]))
    || !oneOf(value.state, ["dispatch_pending", "queued", "in_progress", "completed", "failed", "cancelled", "dispatch_unknown"])
    || !nullableText(value.providerCallId) || !nullableText(value.transcript) || !nullableText(value.error)
    || !(value.durationSeconds === null || (typeof value.durationSeconds === "number" && Number.isFinite(value.durationSeconds) && value.durationSeconds >= 0))) return false;
  const result = value.result;
  return isRecord(result) && oneOf(result.status, ["pending", "uncertain", "transcript_pending", "transcript_available", "not_connected"])
    && text(result.summary) && texts(result.nextSteps) && Array.isArray(result.highlights)
    && result.highlights.every(item => isRecord(item) && oneOf(item.kind, ["documents", "reference", "next_step"]) && text(item.quote));
}
export function workflowCallDownload(caseId: string, callId: string, kind: "transcript" | "recording") {
  return `/api/cases/${encodeURIComponent(caseId)}/workflow/calls/${encodeURIComponent(callId)}/${kind}`;
}
export function createWorkflowCallApi(fetcher: typeof fetch = (...args) => fetch(...args)): WorkflowCallApi {
  async function send(caseId: string, suffix: string, body?: unknown, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(45_000);
    let response: Response;
    try {
      response = await fetcher(`/api/cases/${encodeURIComponent(caseId)}/workflow/calls${suffix}`, {
        method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
        headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch { throw new ApiUnreachableError("The call request could not be confirmed. Check its saved status before doing anything else."); }
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = readApiError(value);
      throw new ApiRequestError(response.status, error?.code ?? "WORKFLOW_CALL_UNAVAILABLE", error?.message ?? "Call status is unavailable.");
    }
    if (!isRecord(value)) throw contractError();
    return value;
  }
  return {
    async list(caseId, signal, refresh) {
      const value = await send(caseId, refresh ? "?refresh=1" : "", undefined, signal);
      if (value.caseId !== caseId || !Array.isArray(value.authorizations) || !value.authorizations.every(item => isWorkflowCallAuthorization(item) && item.caseId === caseId)
        || !Array.isArray(value.calls) || !value.calls.every(item => isWorkflowCall(item) && item.caseId === caseId)) throw contractError();
      const authorizations = value.authorizations as WorkflowCallAuthorization[]; const calls = value.calls as WorkflowCallAttempt[];
      if (new Set(authorizations.map(item => item.id)).size !== authorizations.length || new Set(calls.map(item => item.id)).size !== calls.length
        || calls.some(call => !authorizations.some(authorization => authorization.id === call.authorizationId && matchesAuthorization(call, authorization)))) throw contractError();
      return { caseId, authorizations, calls };
    },
    async authorize(caseId, request) {
      const value = await send(caseId, "/authorize", request); const auth = value.authorization;
      if (!isWorkflowCallAuthorization(auth) || auth.caseId !== caseId || auth.caseRevision !== request.expectedRevision || auth.actionId !== request.actionId || auth.to !== request.to || auth.maxDurationSeconds !== request.maxDurationSeconds) throw contractError();
      return auth;
    },
    async start(caseId, request) {
      const value = await send(caseId, "", request); const call = value.call;
      if (!isWorkflowCall(call) || call.caseId !== caseId || call.requestId !== request.requestId || call.authorizationId !== request.authorizationId) throw contractError();
      return call;
    },
  };
}
export function matchesAuthorization(call: WorkflowCallAttempt, auth: WorkflowCallAuthorization) {
  return call.caseId === auth.caseId && call.caseRevision === auth.caseRevision && call.actionId === auth.actionId && call.to === auth.to && call.role === auth.role && call.purpose === auth.purpose && call.maxDurationSeconds === auth.maxDurationSeconds;
}
function contractError() { return new ApiRequestError(502, "CONTRACT_VIOLATION", "The server returned inconsistent call information. Refresh the saved call; no new call will be placed automatically."); }
