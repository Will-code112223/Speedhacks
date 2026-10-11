import type { CallState } from "./case";
import type { WorkflowContact } from "./workflow";

/** Additive information-call API. Does not change V1 refund approval semantics. */
export interface WorkflowCallAuthorizeRequest {
  requestId: string;
  expectedRevision: number;
  actionId: string;
  to: string;
  maxDurationSeconds: number;
  recipientConfirmed: true;
}
export interface WorkflowCallStartRequest { requestId: string; authorizationId: string }
export interface WorkflowCallAuthorization {
  id: string;
  caseId: string;
  caseRevision: number;
  actionId: string;
  role: WorkflowContact["role"];
  purpose: "gather_information";
  to: string;
  maxDurationSeconds: number;
  /** Server-built facts and boundaries frozen when the user approves. */
  brief: string;
  approvedAt: string;
}
export interface WorkflowCallResult {
  status: "pending" | "uncertain" | "transcript_pending" | "transcript_available" | "not_connected";
  summary: string;
  /** Exact attributed excerpts, never a coverage/payment/filing determination. */
  highlights: Array<{ kind: "documents" | "reference" | "next_step"; quote: string }>;
  nextSteps: string[];
}
export interface WorkflowCallAttempt extends Omit<WorkflowCallAuthorization, "id" | "approvedAt" | "brief"> {
  id: string;
  requestId: string;
  authorizationId: string;
  mode: "live";
  state: CallState;
  providerCallId: string | null;
  transcript: string | null;
  durationSeconds: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  result: WorkflowCallResult;
}
export interface WorkflowCallListResponse {
  caseId: string;
  authorizations: WorkflowCallAuthorization[];
  calls: WorkflowCallAttempt[];
}
export interface WorkflowCallAuthorizeResponse { authorization: WorkflowCallAuthorization }
export interface WorkflowCallStartResponse { call: WorkflowCallAttempt }
/**
 * POST /api/cases/:id/workflow/calls/authorize -> WorkflowCallAuthorizeResponse
 * POST /api/cases/:id/workflow/calls -> WorkflowCallStartResponse
 * GET /api/cases/:id/workflow/calls -> WorkflowCallListResponse (owner-scoped provider polling)
 * GET /api/cases/:id/workflow/calls/:callId/transcript -> private text download
 * GET /api/cases/:id/workflow/calls/:callId/recording -> private audio, or unavailable
 * Retry a mutation with exactly the same request ID/body. An unknown dispatch
 * blocks new calls until reconciled; refresh never dispatches a call.
 */
