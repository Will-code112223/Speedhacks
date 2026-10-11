/**
 * Client-side API surface for the Recourse UI.
 *
 * Two implementations live behind one interface: `http` talks to teammate 2's
 * routes from SHARED CONTRACT V1, `fixture` is a deterministic in-browser
 * scenario engine for building and demoing without a backend. The mode is
 * chosen explicitly; a network failure never swaps in fixture data.
 *
 * Section "V2 proposals" covers behavior the contract does not have yet (live
 * call phase, counterpart, step-in, approval prompts). The http client feature
 * detects them and reports what the backend supports; the fixture implements
 * them fully so the UI can be built now. The proposal text for teammate 2 is
 * in docs/handoffs/frontend.txt.
 */

import type { CallV1, CaseChanges, CaseV1, Mode } from "../../../contracts/case";

export type { CallV1, CaseChanges, CaseV1, Mode };

export type ApiMode = "fixture" | "http";

// ---------------------------------------------------------------------------
// Contract V1
// ---------------------------------------------------------------------------

export interface CreateCaseInput {
  /** The user's natural-language request. */
  summary: string;
  /** Evidence and plan documents to attach. */
  files?: File[];
  customerName?: string;
  customerEmail?: string;
  merchantName?: string;
  supportPhone?: string;
  amountMinor?: number;
  currency?: string;
}

export interface StartCallInput {
  authorizationId: string;
  /** Client-generated UUID, reused on retry of the same action. */
  requestId: string;
}

/** Thrown by both clients for any non-2xx or contract violation. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: string[] | undefined;
  constructor(status: number, code: string, message: string, fields?: string[]) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

/** Network-level failure: nothing reached the server or the response was unreadable. */
export class ApiUnreachableError extends Error {
  constructor(message = "The server could not be reached.") {
    super(message);
    this.name = "ApiUnreachableError";
  }
}

// ---------------------------------------------------------------------------
// V2 proposals (additive, feature detected)
// ---------------------------------------------------------------------------

export type Counterpart = "human" | "agent" | "unknown";

export type LiveCallPhase =
  | "dialing"
  | "ringing"
  | "navigating_menu"
  | "on_hold"
  | "talking"
  | "waiting_for_user"
  | "user_joined"
  | "ended";

export interface LiveCallNote {
  at: string;
  text: string;
}

export interface DecisionOption {
  id: string;
  label: string;
  /** Visual weight. "primary" is the agent's recommendation. */
  tone?: "primary" | "neutral" | "danger";
}

export interface PendingDecision {
  id: string;
  question: string;
  /** What the agent will do if the user does not answer in time. */
  defaultOptionId: string;
  options: DecisionOption[];
  expiresAt: string;
}

export type CallPlanStepStatus = "done" | "current" | "paused" | "upcoming";

/** One thing the agent plans to do on the call, in order. */
export interface CallPlanStep {
  id: string;
  /** Sentence case, names the action: "Explain the duplicate charge". */
  title: string;
  /** Optional one-line detail shown under the current step. */
  detail?: string;
  status: CallPlanStepStatus;
}

/**
 * The agent's plan for the call and where it is in it. "paused" marks the
 * step the user interrupted by stepping in; it becomes "current" again when
 * the agent takes over. Exactly one step is current or paused while the call
 * is live; every step is done once the call ends normally.
 */
export interface CallPlan {
  steps: CallPlanStep[];
}

export interface LiveCallV2 {
  callId: string;
  caseId: string;
  /** Who is being called, as the UI should display it. */
  calling: { name: string; phone: string };
  phase: LiveCallPhase;
  counterpart: Counterpart;
  /** 0 to 1, how sure the agent is about the counterpart. */
  counterpartConfidence: number;
  /** Null when the attempt never connected, for example a call refused before dialing (phase "ended"). */
  startedAt: string | null;
  endedAt: string | null;
  /** Seconds spent on hold or in menus so far. */
  holdSeconds: number;
  notes: LiveCallNote[];
  pendingDecision: PendingDecision | null;
  userJoined: boolean;
  /**
   * The agent's plan and progress (V2 proposal, additive). Absent or null
   * when the backend does not report one; the UI then derives a plan from
   * the phase with `callPlanFor` in state/call.ts.
   */
  plan?: CallPlan | null;
  updatedAt: string;
}

export interface CaseApiCapabilities {
  /** GET /api/cases/:id/calls/:callId/live */
  liveCall: boolean;
  /** POST /api/cases/:id/calls/:callId/join */
  stepIn: boolean;
  /** POST /api/cases/:id/calls/:callId/decisions/:decisionId */
  decisions: boolean;
}

// ---------------------------------------------------------------------------
// The interface both clients implement
// ---------------------------------------------------------------------------

export interface CaseApi {
  readonly mode: ApiMode;

  createCase(input: CreateCaseInput): Promise<CaseV1>;
  getCase(caseId: string): Promise<CaseV1>;
  patchCase(caseId: string, expectedRevision: number, changes: CaseChanges): Promise<CaseV1>;
  authorize(caseId: string, expectedRevision: number): Promise<CaseV1>;
  startCall(caseId: string, input: StartCallInput): Promise<CallV1>;
  /** text/plain refund request with evidence index. */
  downloadPacket(caseId: string): Promise<Blob>;

  /** Resolved once per session; the http client probes with a cheap request. */
  capabilities(): Promise<CaseApiCapabilities>;
  /**
   * Returns null when the backend lacks the capability or the call has no live
   * record yet (dispatch pending or unknown). An attempt that is over always
   * has a record with phase "ended", so null never means "finished".
   */
  getLiveCall(caseId: string, callId: string): Promise<LiveCallV2 | null>;
  stepIn(caseId: string, callId: string): Promise<LiveCallV2>;
  answerDecision(caseId: string, callId: string, decisionId: string, optionId: string): Promise<LiveCallV2>;
}

// ---------------------------------------------------------------------------
// Fixture scenarios
// ---------------------------------------------------------------------------

/**
 * Deterministic scenarios the fixture client can play. The chat picks one from
 * the user's message; the fixture picker in the header overrides it.
 */
export type FixtureScenario =
  | "insurance_claim" // headline demo: file a claim, insurer bot answers, approval prompt, outcome requested
  | "duplicate_charge" // $49.99 duplicate charge, human rep, refund requested, payment unconfirmed
  | "needs_evidence" // extraction leaves missing fields; no call until provided
  | "uncertain_dispatch" // call attempt ends in dispatch_unknown
  | "call_complete_unconfirmed"; // completed call, decision approved, paymentStatus unverified

export const FIXTURE_SCENARIOS: readonly FixtureScenario[] = [
  "insurance_claim",
  "duplicate_charge",
  "needs_evidence",
  "uncertain_dispatch",
  "call_complete_unconfirmed",
];

export interface FixtureOptions {
  /** Speeds the scripted timeline; 1 is real time, 4 is four times faster. */
  speed?: number;
  scenario?: FixtureScenario;
  /** Injected clock for tests. */
  now?: () => number;
  /** Artificial response delay in ms so loading states are visible. Default 0. Not scaled by speed. */
  latencyMs?: number;
  /**
   * Emulates the V2 live call proposal (default true). Set false to behave like
   * a V1-only backend: capabilities() reports nothing, getLiveCall returns null,
   * stepIn and answerDecision reject with 501 NOT_SUPPORTED.
   */
  v2?: boolean;
}

// ---------------------------------------------------------------------------
// Factory contract implemented in ./client.ts
// ---------------------------------------------------------------------------

export interface CreateCaseApiOptions {
  mode: ApiMode;
  /** http only; defaults to same origin. */
  baseUrl?: string;
  /** fixture only. */
  fixture?: FixtureOptions;
}

/**
 * `createCaseApi(options): CaseApi` lives in ./client.ts.
 * `detectApiMode(search: string, fallback: ApiMode): ApiMode` reads `?api=fixture|http`.
 */
