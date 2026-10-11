import type { CaseWorkflow, WorkflowMessageRequest, WorkflowResponse } from "../../../contracts/workflow";
import { ApiRequestError, ApiUnreachableError } from "../api/types";
import { isCaseV1, isRecord, readApiError } from "../api/validate";

export interface WorkflowApi {
  get(caseId: string, signal?: AbortSignal): Promise<WorkflowResponse>;
  message(caseId: string, input: WorkflowMessageRequest): Promise<WorkflowResponse>;
  analyze(caseId: string, input: { requestId: string; expectedRevision: number }): Promise<WorkflowResponse>;
  evidence(caseId: string, input: { requestId: string; expectedRevision: number; files: File[]; message?: string }): Promise<WorkflowResponse>;
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
const nullableString = (value: unknown) => value === null || typeof value === "string";
const oneOf = (value: unknown, values: string[]) => typeof value === "string" && values.includes(value);

export function isWorkflow(value: unknown): value is CaseWorkflow {
  if (!isRecord(value) || typeof value.caseId !== "string" || !Number.isInteger(value.caseRevision) || Number(value.caseRevision) < 1
    || !oneOf(value.kind, ["refund", "duplicate_charge", "auto_insurance", "other"]) || !oneOf(value.stage, ["collecting", "ready", "in_progress", "needs_review"])
    || (value.analysisStatus !== undefined && !oneOf(value.analysisStatus, ["not_started", "processing", "complete", "failed"]))
    || typeof value.updatedAt !== "string" || !isRecord(value.facts) || !strings(value.conflicts)) return false;
  if (!Object.values(value.facts).every(fact => isRecord(fact) && typeof fact.label === "string" && nullableString(fact.value) && oneOf(fact.source, ["case", "user", "document"]) && strings(fact.sourceRefs))) return false;
  if (!Array.isArray(value.messages) || !value.messages.every(item => isRecord(item) && typeof item.id === "string" && oneOf(item.role, ["user", "assistant"]) && typeof item.content === "string" && typeof item.createdAt === "string")) return false;
  if (!Array.isArray(value.questions) || !value.questions.every(item => isRecord(item) && typeof item.id === "string" && typeof item.field === "string" && typeof item.question === "string" && typeof item.required === "boolean")) return false;
  if (!Array.isArray(value.contacts) || !value.contacts.every(item => isRecord(item) && typeof item.id === "string" && typeof item.name === "string" && oneOf(item.role, ["merchant", "insurer", "other_party"]) && nullableString(item.phone) && nullableString(item.url) && nullableString(item.sourceUrl) && typeof item.requiresConfirmation === "boolean" && oneOf(item.source, ["knowledge_base", "user", "document"]))) return false;
  if (!isRecord(value.brief) || typeof value.brief.title !== "string" || typeof value.brief.body !== "string" || typeof value.brief.updatedAt !== "string") return false;
  return Array.isArray(value.actions) && value.actions.every(item => isRecord(item) && typeof item.id === "string" && typeof item.title === "string" && typeof item.description === "string" && oneOf(item.type, ["browser", "call", "document", "clarify"]) && oneOf(item.status, ["blocked", "ready", "completed"]) && strings(item.blockedBy)
    && (item.browser === null || (isRecord(item.browser) && typeof item.browser.startUrl === "string" && strings(item.browser.allowedHosts) && typeof item.browser.task === "string"))
    && (item.call === null || (isRecord(item.call) && oneOf(item.call.role, ["merchant", "insurer", "other_party"]) && nullableString(item.call.to) && typeof item.call.purpose === "string" && typeof item.call.brief === "string")));
}

export function workflowBriefUrl(caseId: string): string { return `/api/cases/${encodeURIComponent(caseId)}/workflow/brief`; }

export function createWorkflowApi(fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args)): WorkflowApi {
  async function send(caseId: string, suffix: string, body?: BodyInit, signal?: AbortSignal): Promise<WorkflowResponse> {
    const timeout = AbortSignal.timeout(90_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetchImpl(`/api/cases/${encodeURIComponent(caseId)}/${suffix}`, {
        method: body === undefined ? "GET" : "POST", body, credentials: "same-origin", cache: "no-store", signal: combined,
        headers: body instanceof FormData ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      });
    } catch { throw new ApiUnreachableError("The request could not be confirmed. Retry the same message or upload to check its saved result."); }
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = readApiError(value);
      throw new ApiRequestError(response.status, error?.code ?? "WORKFLOW_UNAVAILABLE", error?.message ?? "The case could not be updated.");
    }
    if (!isRecord(value) || !isCaseV1(value.case) || !isWorkflow(value.workflow) || value.case.id !== caseId || value.workflow.caseId !== caseId || value.case.revision !== value.workflow.caseRevision) {
      throw new ApiRequestError(502, "CONTRACT_VIOLATION", "The server returned an inconsistent case workflow. Refresh before continuing.");
    }
    return value as unknown as WorkflowResponse;
  }
  return {
    get: (id, signal) => send(id, "workflow", undefined, signal),
    message: (id, input) => send(id, "messages", JSON.stringify(input)),
    analyze: (id, input) => send(id, "workflow", JSON.stringify(input)),
    evidence: (id, input) => {
      const form = new FormData(); form.set("requestId", input.requestId); form.set("expectedRevision", String(input.expectedRevision));
      if (input.message) form.set("message", input.message);
      input.files.forEach(file => form.append("files", file));
      return send(id, "evidence", form);
    },
  };
}
