/**
 * Runtime guards for the wire format. The http client uses them to reject
 * responses that do not match contract V1 (or the V2 proposal) instead of
 * handing half-shaped data to the UI; tests use them to hold the fixture to
 * the same shapes.
 */

import type {
  CallState,
  CallV1,
  CaseStatus,
  CaseV1,
  Mode,
  OutcomeDecision,
  PaymentStatus,
} from "../../../contracts/case";
import type {
  CaseApiCapabilities,
  Counterpart,
  DecisionOption,
  LiveCallNote,
  LiveCallPhase,
  LiveCallV2,
  CallPlan,
  CallPlanStep,
  CallPlanStepStatus,
  PendingDecision,
} from "./types";

// Records keyed by every union member, so adding a member to the contract
// without updating these is a type error.
const MODES: Record<Mode, true> = { simulated: true, live: true };
const CASE_STATUSES: Record<CaseStatus, true> = {
  needs_information: true,
  ready_for_approval: true,
  authorized: true,
  calling: true,
  awaiting_response: true,
  approved: true,
  denied: true,
};
const CALL_STATES: Record<CallState, true> = {
  dispatch_pending: true,
  queued: true,
  in_progress: true,
  completed: true,
  failed: true,
  cancelled: true,
  dispatch_unknown: true,
};
const DECISIONS: Record<OutcomeDecision, true> = {
  unknown: true,
  requested: true,
  needs_information: true,
  approved: true,
  denied: true,
};
const PAYMENT_STATUSES: Record<PaymentStatus, true> = { unverified: true, confirmed: true };
const PHASES: Record<LiveCallPhase, true> = {
  dialing: true,
  ringing: true,
  navigating_menu: true,
  on_hold: true,
  talking: true,
  waiting_for_user: true,
  user_joined: true,
  ended: true,
};
const COUNTERPARTS: Record<Counterpart, true> = { human: true, agent: true, unknown: true };
const TONES: Record<NonNullable<DecisionOption["tone"]>, true> = { primary: true, neutral: true, danger: true };

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

function isInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

function oneOf<T extends string>(members: Record<T, true>, v: unknown): v is T {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(members, v);
}

function isArrayOf<T>(v: unknown, guard: (item: unknown) => item is T): v is T[] {
  return Array.isArray(v) && v.every(guard);
}

function isParty(v: unknown, second: "email" | "supportPhone"): boolean {
  return isRecord(v) && isNullableString(v.name) && isNullableString(v[second]);
}

function isEvidence(v: unknown): v is CaseV1["evidence"][number] {
  return isRecord(v) && isString(v.id) && isString(v.name) && isString(v.mimeType);
}

function isDraft(v: unknown): v is CaseV1["draft"] {
  return v === null || (isRecord(v) && isString(v.subject) && isString(v.body));
}

function isAuthorization(v: unknown): v is CaseV1["authorization"] {
  return v === null || (isRecord(v) && isString(v.id) && isInteger(v.revision) && isString(v.approvedAt));
}

function isOutcome(v: unknown): v is CaseV1["outcome"] {
  return (
    isRecord(v) &&
    oneOf(DECISIONS, v.decision) &&
    isNullableString(v.referenceNumber) &&
    isNullableString(v.nextAction) &&
    oneOf(PAYMENT_STATUSES, v.paymentStatus) &&
    isNullableString(v.supportingQuote)
  );
}

function isTimelineEntry(v: unknown): v is CaseV1["timeline"][number] {
  return isRecord(v) && isString(v.id) && isString(v.at) && isString(v.type) && isString(v.message);
}

export function isCallV1(v: unknown): v is CallV1 {
  return (
    isRecord(v) &&
    isString(v.id) &&
    isString(v.requestId) &&
    isString(v.authorizationId) &&
    isNullableString(v.providerCallId) &&
    oneOf(MODES, v.mode) &&
    oneOf(CALL_STATES, v.state) &&
    isNullableString(v.transcript) &&
    isNullableString(v.error) &&
    isString(v.createdAt) &&
    isString(v.updatedAt)
  );
}

export function isCaseV1(v: unknown): v is CaseV1 {
  return (
    isRecord(v) &&
    v.schemaVersion === 1 &&
    isString(v.id) &&
    isInteger(v.revision) &&
    oneOf(MODES, v.mode) &&
    oneOf(CASE_STATUSES, v.status) &&
    isParty(v.customer, "email") &&
    isParty(v.merchant, "supportPhone") &&
    (v.amountMinor === null || isInteger(v.amountMinor)) &&
    isString(v.currency) &&
    isString(v.reason) &&
    isArrayOf(v.evidence, isEvidence) &&
    isArrayOf(v.missingFields, isString) &&
    isDraft(v.draft) &&
    isAuthorization(v.authorization) &&
    isArrayOf(v.calls, isCallV1) &&
    isOutcome(v.outcome) &&
    isArrayOf(v.timeline, isTimelineEntry) &&
    isString(v.createdAt) &&
    isString(v.updatedAt)
  );
}

function isDecisionOption(v: unknown): v is DecisionOption {
  return isRecord(v) && isString(v.id) && isString(v.label) && (v.tone === undefined || oneOf(TONES, v.tone));
}

function isPendingDecision(v: unknown): v is PendingDecision {
  return (
    isRecord(v) &&
    isString(v.id) &&
    isString(v.question) &&
    isString(v.defaultOptionId) &&
    isArrayOf(v.options, isDecisionOption) &&
    isString(v.expiresAt)
  );
}

function isNote(v: unknown): v is LiveCallNote {
  return isRecord(v) && isString(v.at) && isString(v.text);
}

const PLAN_STEP_STATUSES: Record<CallPlanStepStatus, true> = { done: true, current: true, paused: true, upcoming: true };

function isPlanStep(v: unknown): v is CallPlanStep {
  return (
    isRecord(v) &&
    isString(v.id) &&
    isString(v.title) &&
    (v.detail === undefined || isString(v.detail)) &&
    oneOf(PLAN_STEP_STATUSES, v.status)
  );
}

function isPlan(v: unknown): v is CallPlan {
  return isRecord(v) && isArrayOf(v.steps, isPlanStep);
}

export function isLiveCallV2(v: unknown): v is LiveCallV2 {
  return (
    isRecord(v) &&
    isString(v.callId) &&
    isString(v.caseId) &&
    isRecord(v.calling) &&
    isString(v.calling.name) &&
    isString(v.calling.phone) &&
    oneOf(PHASES, v.phase) &&
    oneOf(COUNTERPARTS, v.counterpart) &&
    typeof v.counterpartConfidence === "number" &&
    isNullableString(v.startedAt) &&
    isNullableString(v.endedAt) &&
    typeof v.holdSeconds === "number" &&
    isArrayOf(v.notes, isNote) &&
    (v.pendingDecision === null || isPendingDecision(v.pendingDecision)) &&
    isBoolean(v.userJoined) &&
    (v.plan === undefined || v.plan === null || isPlan(v.plan)) &&
    isString(v.updatedAt)
  );
}

/** Missing flags read as unsupported; only an explicit `true` turns a feature on. */
export function readCapabilities(v: unknown): CaseApiCapabilities | null {
  if (!isRecord(v)) return null;
  return { liveCall: v.liveCall === true, stepIn: v.stepIn === true, decisions: v.decisions === true };
}

/** The `error` member of an ApiError body, or null when the body is not one. */
export function readApiError(v: unknown): { code: string; message: string; fields: string[] | undefined } | null {
  if (!isRecord(v) || !isRecord(v.error)) return null;
  const { code, message, fields } = v.error;
  if (!isString(code) || !isString(message)) return null;
  if (fields !== undefined && !isArrayOf(fields, isString)) return null;
  return { code, message, fields };
}
