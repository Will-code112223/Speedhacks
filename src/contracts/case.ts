/**
 * Canonical case contract — SHARED CONTRACT V1.
 *
 * Owned by teammate 2. Do not change the V1 shapes without a recorded,
 * coordinated contract change. Additive helper aliases are grouped at the
 * bottom and never alter the V1 wire format.
 *
 * Conventions: timestamps are ISO-8601 UTC strings; IDs are UUIDs except
 * opaque provider IDs; monetary amounts are integer minor units; currency is
 * a three-letter code (MVP: USD). Unknown facts are null, never fabricated.
 * Empty collections are [].
 */

import type { CallPurpose } from "./voice";

export type Mode = "simulated" | "live";

export type CaseStatus =
  | "needs_information"
  | "ready_for_approval"
  | "authorized"
  | "calling"
  | "awaiting_response"
  | "approved"
  | "denied";

export type CallState =
  | "dispatch_pending"
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "dispatch_unknown";

export interface CallV1 {
  id: string;
  requestId: string;
  authorizationId: string;
  providerCallId: string | null;
  mode: Mode;
  state: CallState;
  transcript: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CaseV1 {
  schemaVersion: 1;
  id: string;
  revision: number;
  mode: Mode;
  status: CaseStatus;
  customer: { name: string | null; email: string | null };
  /** V1.2 adds optional `source`: where supportPhone came from when the server filled it (null = documents or the user). */
  merchant: { name: string | null; supportPhone: string | null; source?: MerchantSourceV1 | null };
  amountMinor: number | null;
  currency: string;
  reason: string;
  /** V1.2 insurance facts (additive). Absent on older rows = null. Unknown stays null, never guessed. */
  policyNumber?: string | null;
  /** ISO calendar date, YYYY-MM-DD. */
  incidentDate?: string | null;
  lossDescription?: string | null;
  /** Free text such as "water damage" or "auto collision". */
  claimType?: string | null;
  evidence: { id: string; name: string; mimeType: string }[];
  /** Required facts still missing for `suggestedPurpose` (request_refund when absent); drives `status`. */
  missingFields: string[];
  /**
   * V1.2 (additive): the purpose this case is prepared for. "file_claim" when the case
   * describes an insurance loss (lossDescription or claimType known), else "request_refund".
   * Send it as `purpose` to POST /api/cases/:id/authorize.
   */
  suggestedPurpose?: CallPurpose;
  /** V1.2 (additive): missing facts per call purpose, so the UI can offer file_claim or gather_information when no amount is known. */
  missingFieldsByPurpose?: Partial<Record<CallPurpose, string[]>>;
  draft: { subject: string; body: string } | null;
  /** V1.1 adds optional `purpose` (absent = "request_refund", the V1 behavior). */
  authorization: { id: string; revision: number; approvedAt: string; purpose?: CallPurpose } | null;
  calls: CallV1[];
  outcome: {
    decision: "unknown" | "requested" | "needs_information" | "approved" | "denied";
    referenceNumber: string | null;
    nextAction: string | null;
    paymentStatus: "unverified" | "confirmed";
    supportingQuote: string | null;
  };
  timeline: { id: string; at: string; type: string; message: string }[];
  /** V1.1 (additive): transcript answers awaiting user review. Absent = none. */
  proposedUpdates?: ProposedUpdateV1[];
  createdAt: string;
  updatedAt: string;
}

/**
 * V1.1: an answer read from a call transcript, proposed for user review.
 * Never applied automatically: accepting one is a user edit (new revision,
 * re-authorization). Bound to the call, authorization and revision it came
 * from, so a late transcript can never populate a newer plan or brief.
 */
export interface ProposedUpdateV1 {
  id: string;
  callId: string;
  authorizationId: string;
  revision: number;
  target:
    | { kind: "fact"; field: "customer.name" | "customer.email" | "merchant.name" | "merchant.supportPhone" | "amountMinor" | "currency" | "reason" }
    | { kind: "question"; questionId: string };
  value: string;
  /** Verbatim support-side transcript text that supports the value. */
  quote: string;
  status: "pending" | "accepted" | "rejected";
  createdAt: string;
}

export interface CaseChanges {
  customer?: { name: string | null; email: string | null };
  /** A user edit never carries `source`; changing the name or number clears merchant.source. */
  merchant?: { name: string | null; supportPhone: string | null };
  amountMinor?: number | null;
  currency?: string;
  reason?: string;
  /** V1.2 insurance facts (additive). null clears the fact. */
  policyNumber?: string | null;
  incidentDate?: string | null;
  lossDescription?: string | null;
  claimType?: string | null;
}

/**
 * V1.2: provenance of a support number the server filled from the insurer
 * registry. A review candidate only: the user confirms it at approval, and any
 * manual edit of the merchant name or number clears it.
 */
export interface MerchantSourceV1 {
  kind: "insurer_registry";
  insurerId: string;
  insurerName: string;
  /** Which registry line was used: the claims line first, else customer service. */
  purpose: "claims" | "customer_service";
  /** Always "verified_official" today; only verified official national lines are filled. */
  confidence: string;
  sourceUrl: string | null;
  retrievedAt: string | null;
}

export interface ApiError {
  error: { code: string; message: string; fields?: string[] };
}

// ---------------------------------------------------------------------------
// Additive helpers (not part of the V1 wire format; convenience for consumers)
// ---------------------------------------------------------------------------

export type CaseEvidence = CaseV1["evidence"][number];
export type CaseDraft = NonNullable<CaseV1["draft"]>;
export type CaseAuthorization = NonNullable<CaseV1["authorization"]>;
export type CaseOutcome = CaseV1["outcome"];
export type OutcomeDecision = CaseOutcome["decision"];
export type PaymentStatus = CaseOutcome["paymentStatus"];
export type TimelineEntry = CaseV1["timeline"][number];

/** Call states that are still moving; edits/new authorizations are rejected while one exists. */
export const ACTIVE_CALL_STATES: readonly CallState[] = [
  "dispatch_pending",
  "queued",
  "in_progress",
  "dispatch_unknown",
];

/** Call states that never regress once published. */
export const TERMINAL_CALL_STATES: readonly CallState[] = ["completed", "failed", "cancelled"];

/** Request/response envelopes for the shared HTTP API. */
export interface CaseResponse {
  case: CaseV1;
}
export interface CallResponse {
  call: CallV1;
}
export interface PatchCaseRequest {
  expectedRevision: number;
  changes: CaseChanges;
}
export interface AuthorizeCaseRequest {
  expectedRevision: number;
  /** V1.1: absent = "request_refund". "gather_information" does not require an amount. */
  purpose?: CallPurpose;
}
export interface StartCallRequest {
  authorizationId: string;
  /** Client-generated UUID, reused for retries of the same action. */
  requestId: string;
}

/** Error codes used in ApiError.error.code. */
export type ApiErrorCode =
  | "BAD_REQUEST" // 400 malformed input
  | "NOT_FOUND" // 404 unknown case
  | "REVISION_CONFLICT" // 409 expectedRevision mismatch
  | "AUTHORIZATION_CONFLICT" // 409 authorization missing/stale/mismatched
  | "CALL_IN_PROGRESS" // 409 edit/authorize while a call is active or dispatch_unknown
  | "MODE_MISMATCH" // 409 case was created in a different mode than the server runs in
  | "PAYLOAD_TOO_LARGE" // 413 webhook body exceeds the limit
  | "MISSING_REQUIRED_FACTS" // 422 fields lists what is missing
  | "LIVE_CONFIGURATION_MISSING" // 503 live mode requested without configuration
  | "PROVIDER_UNAVAILABLE" // 503 provider rejected before dispatch
  | "INVALID_WEBHOOK"; // 401 webhook authentication failed
