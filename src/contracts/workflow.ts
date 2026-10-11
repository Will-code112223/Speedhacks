import type { CaseV1 } from "./case";

/** Additive intake contract. All mutations use the canonical case revision. */
export type WorkflowKind = "refund" | "duplicate_charge" | "auto_insurance" | "other";
export type WorkflowStage = "collecting" | "ready" | "in_progress" | "needs_review";
export type WorkflowFactKey = "customerName" | "customerEmail" | "merchantName" | "supportPhone" | "amount" | "currency"
  | "product" | "orderNumber" | "purchaseDate" | "issue" | "desiredOutcome" | "lossDate" | "lossLocation"
  | "vehicle" | "incidentDescription" | "policyNumber" | "insuranceProvider" | "claimantRole" | "otherPartyName" | "otherPartyPhone";
export interface WorkflowFact {
  label: string;
  value: string | null;
  source: "case" | "user" | "document";
  /** Evidence IDs, or persisted user message IDs supporting the value. */
  sourceRefs: string[];
}
export interface WorkflowMessage { id: string; role: "user" | "assistant"; content: string; createdAt: string }
export interface WorkflowQuestion { id: string; field: WorkflowFactKey | "evidence"; question: string; required: boolean }
export interface WorkflowContact {
  id: string; role: "merchant" | "insurer" | "other_party";
  name: string; phone: string | null; url: string | null;
  source: "knowledge_base" | "user" | "document";
  sourceUrl: string | null;
  /** A sourced general contact still needs applicability/recipient review. */
  requiresConfirmation: boolean;
}
export interface WorkflowAction {
  id: string; type: "browser" | "call" | "document" | "clarify";
  title: string; description: string; status: "blocked" | "ready" | "completed";
  blockedBy: string[];
  browser: { startUrl: string; allowedHosts: string[]; task: string } | null;
  call: { role: WorkflowContact["role"]; to: string | null; purpose: string; brief: string } | null;
}
export interface CaseWorkflow {
  caseId: string;
  /** The CaseV1 revision used for every fact, question, brief and action here. */
  caseRevision: number;
  kind: WorkflowKind; stage: WorkflowStage;
  /** Initial saved inputs are analyzed once; failed analysis can be retried explicitly. */
  analysisStatus?: "not_started" | "processing" | "complete" | "failed";
  facts: Partial<Record<WorkflowFactKey, WorkflowFact>>;
  messages: WorkflowMessage[];
  questions: WorkflowQuestion[];
  conflicts: string[];
  contacts: WorkflowContact[];
  brief: { title: string; body: string; updatedAt: string };
  actions: WorkflowAction[];
  updatedAt: string;
}
export interface WorkflowResponse { case: CaseV1; workflow: CaseWorkflow }
/** POST /api/cases/:id/messages; retry exactly the same requestId/body. */
export interface WorkflowMessageRequest { requestId: string; expectedRevision: number; message: string }
/**
 * GET /api/cases/:id/workflow returns WorkflowResponse, bootstrapping known facts
 * and initial questions without a provider call. POST /workflow accepts
 * requestId and expectedRevision to analyze saved inputs without another user
 * message. POST /messages updates both case and workflow.
 * POST /evidence accepts multipart requestId, expectedRevision, optional message,
 * and repeated files. GET /workflow/brief downloads the current preparation text.
 * Unknown external outcomes are never synthesized by intake/planning.
 */
