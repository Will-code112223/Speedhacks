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
  merchant: { name: string | null; supportPhone: string | null; source?: MerchantSourceV1 | MerchantInputSourceV1 | null };
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

/**
 * Additive: provenance of a support number that did not come from the registry.
 * "user" = typed by the person (form field or edit); "document" = extracted from the
 * uploaded documents or summary. Absent on older rows (treat as unknown).
 */
export interface MerchantInputSourceV1 {
  kind: "user" | "document";
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
  | "INVALID_WEBHOOK" // 401 webhook authentication failed
  | "ACCESS_REQUIRED" // 401 APP_ACCESS_CODE is set and the request has no valid access cookie
  | "UNSUPPORTED_DESTINATION" // 422 live mode: supportPhone is not an allowed North American number
  | "SUMMARY_TOO_LONG" // 422 summary exceeds the 2000-character plan limit
  | "RATE_LIMITED"; // 429 live mode: too many call dispatches in the last hour

// ---------------------------------------------------------------------------
// V1.3 (additive): the resolution plan the user reads before approving a call.
// Served by GET /api/cases/:id/plan. Read-only: building it never freezes or
// authorizes anything. Every string is plain words for the policyholder.
// ---------------------------------------------------------------------------

/** One thing to do or expect, in plain words. `status` is set only on "before" items. */
export interface ResolutionStepV1 {
  title: string;
  detail: string;
  /** "done" when the case facts already have it, "missing" when the user still needs to add it. */
  status?: "done" | "missing";
  /** Where the statement comes from, when it is the insurer's own rule. */
  source?: { label: string; url: string };
}

/** One insurer rule from the registry, with how sure we are and where it was read. */
export interface ResolutionTermV1 {
  /** Registry term key, e.g. "claim_decision_timeline". */
  key: string;
  /** Plain-words name, e.g. "Claim decision". */
  label: string;
  value: string;
  /** Registry confidence: verified_official | reported | regulatory_default | unknown. */
  confidence: string;
  /** Plain-words confidence, e.g. "From the insurer's website". */
  confidenceLabel: string;
  sourceUrl: string | null;
}

export interface ResolutionPlanV1 {
  version: 1;
  purpose: CallPurpose;
  /** True when every fact the call needs is present (or the plan is the frozen one). */
  ready: boolean;
  /** True when `call` is the plan frozen with the current authorization: exactly what the agent got. */
  frozen: boolean;
  /** Server field keys still missing for this purpose (same keys as missingFieldsByPurpose). */
  missingFields: string[];
  /** The insurer or company as the registry names it, or the case's name when it is not in the registry. */
  insurerName: string | null;
  before: ResolutionStepV1[];
  call: {
    goal: string;
    steps: string[];
    questions: string[];
    readBack: string;
    /** The plan's forbidden actions in plain words. */
    willNotDo: string[];
  };
  after: ResolutionStepV1[];
  insurerTerms: ResolutionTermV1[];
}

export interface ResolutionPlanResponse {
  plan: ResolutionPlanV1;
}
