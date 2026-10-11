/**
 * Derives the wire shapes from stored records at a given instant. Call
 * progress, its timeline entries and the outcome it publishes are all computed
 * here, so a read at time t always shows exactly what has happened by t.
 */

import {
  ACTIVE_CALL_STATES,
  type CallState,
  type CallV1,
  type CaseOutcome,
  type CaseStatus,
  type CaseV1,
} from "../../../../contracts/case";
import type { CallPlan, CallPlanStepStatus, Counterpart, LiveCallV2 } from "../types";
import { assertNever } from "../assert-never";
import { LEAVE_NOTE, runCall, type CallRun, type DecisionGate } from "./call-run";
import type { CallContext, Conversation, PlanStepDefinition } from "./conversations";
import { buildDraft } from "./documents";
import { missingFields, type FrozenFacts } from "./facts";
import { stableId } from "./ids";
import { formatMoney } from "./money";
import type { CallRecord, CaseRecord, TimelineItem } from "./records";
import type { DispatchBehavior, ScenarioDefinition } from "./scenarios";
import { iso, toReal, toVirtual } from "./time";

export interface ProjectedCall {
  record: CallRecord;
  v1: CallV1;
  /**
   * Null while no live record exists yet: dispatch pending or unknown. A call
   * refused before dispatch has an ended record whose startedAt is null, so a
   * poller never waits forever on an attempt that is already over.
   */
  live: LiveCallV2 | null;
  run: CallRun | null;
  gate: DecisionGate | null;
  /** Entries this call has added to the case timeline by now. */
  timeline: TimelineItem[];
  /** The outcome this call has published by now, if any. */
  outcome: { value: CaseOutcome; atMs: number } | null;
}

export interface ProjectedCase {
  case: CaseV1;
  calls: ProjectedCall[];
}

type CallBase = Pick<CallV1, "id" | "requestId" | "authorizationId" | "providerCallId" | "mode" | "createdAt">;

export function decisionIdFor(callId: string): string {
  return stableId(`${callId}:decision`);
}

export function hasActiveCall(projected: ProjectedCase): boolean {
  return projected.calls.some((c) => ACTIVE_CALL_STATES.includes(c.v1.state));
}

export function callContext(f: FrozenFacts): CallContext {
  return {
    customerName: f.customerName,
    merchantName: f.merchantName,
    phone: f.supportPhone,
    amount: formatMoney(f.amountMinor, f.currency),
  };
}

export function projectCase(record: CaseRecord, nowMs: number, speed: number): ProjectedCase {
  const calls = record.calls.map((call) => projectCall(record.scenario, call, nowMs, speed));
  const outcome = latestOutcome(record.outcome, calls);
  const missing = missingFields(record.facts);
  const timeline = [...record.timeline, ...calls.flatMap((c) => c.timeline)].sort((a, b) => a.atMs - b.atMs);
  const authorization = record.authorizations.find((a) => a.id === record.authorizationId) ?? null;
  return {
    calls,
    case: {
      schemaVersion: 1,
      id: record.id,
      revision: record.revision,
      mode: "simulated",
      status: deriveStatus(record, calls, outcome, missing),
      customer: { ...record.facts.customer },
      merchant: { ...record.facts.merchant },
      amountMinor: record.facts.amountMinor,
      currency: record.facts.currency,
      reason: record.facts.reason,
      evidence: record.evidence.map(({ id, name, mimeType }) => ({ id, name, mimeType })),
      missingFields: missing,
      draft: buildDraft(record.scenario.kind, record.facts, record.evidence),
      authorization:
        authorization === null
          ? null
          : { id: authorization.id, revision: authorization.revision, approvedAt: iso(authorization.approvedAtMs) },
      calls: calls.map((c) => c.v1),
      outcome: { ...outcome },
      timeline: timeline.map((t) => ({ id: t.id, at: iso(t.atMs), type: t.type, message: t.message })),
      createdAt: iso(record.createdAtMs),
      updatedAt: iso(Math.max(record.updatedAtMs, ...timeline.map((t) => t.atMs))),
    },
  };
}

export function projectCall(scenario: ScenarioDefinition, call: CallRecord, nowMs: number, speed: number): ProjectedCall {
  const base: CallBase = {
    id: call.id,
    requestId: call.requestId,
    authorizationId: call.authorizationId,
    providerCallId: call.providerCallId,
    mode: "simulated",
    createdAt: iso(call.startedAtMs),
  };
  if (call.rejectedError !== null) {
    return {
      ...noLiveRecord(call),
      v1: { ...base, state: "failed", transcript: null, error: call.rejectedError, updatedAt: base.createdAt },
      live: refusedLiveCall(call),
    };
  }
  const dispatch = scenario.dispatch;
  switch (dispatch.kind) {
    case "unknown":
      return projectUnknownDispatch(call, base, dispatch, nowMs, speed);
    case "accepted":
      return projectConversation(call, base, dispatch.conversation, nowMs, speed);
    default:
      return assertNever(dispatch);
  }
}

export const REFUSED_NOTE = "The provider refused the call before dialing. Nothing was dialed.";

/** The live record of an attempt that ended without connecting. */
function refusedLiveCall(call: CallRecord): LiveCallV2 {
  const at = iso(call.startedAtMs);
  return {
    callId: call.id,
    caseId: call.caseId,
    calling: { name: call.frozen.merchantName, phone: call.frozen.supportPhone },
    phase: "ended",
    counterpart: "unknown",
    counterpartConfidence: 0,
    startedAt: null,
    endedAt: at,
    holdSeconds: 0,
    notes: [{ at, text: REFUSED_NOTE }],
    pendingDecision: null,
    userJoined: false,
    progress: null,
    updatedAt: at,
  };
}

function noLiveRecord(call: CallRecord): Omit<ProjectedCall, "v1"> {
  return { record: call, live: null, run: null, gate: null, timeline: [], outcome: null };
}

function projectUnknownDispatch(
  call: CallRecord,
  base: CallBase,
  dispatch: Extract<DispatchBehavior, { kind: "unknown" }>,
  nowMs: number,
  speed: number,
): ProjectedCall {
  if (toVirtual(call.startedAtMs, nowMs, speed) < dispatch.afterMs) {
    return {
      ...noLiveRecord(call),
      v1: { ...base, state: "dispatch_pending", transcript: null, error: null, updatedAt: base.createdAt },
    };
  }
  const atMs = toReal(call.startedAtMs, dispatch.afterMs, speed);
  return {
    ...noLiveRecord(call),
    v1: { ...base, state: "dispatch_unknown", transcript: null, error: dispatch.error, updatedAt: iso(atMs) },
    timeline: [
      {
        id: stableId(`${call.id}:timeline:0`),
        atMs,
        type: "call_dispatch_unknown",
        message: `Dispatch result unknown: ${dispatch.error}`,
      },
    ],
    outcome: {
      atMs,
      value: {
        decision: "unknown",
        referenceNumber: null,
        nextAction: `Dispatch result for attempt ${call.id} is unknown. Verify in the provider dashboard whether a call to ${call.frozen.supportPhone} was placed before any new attempt; the assistant will not redial automatically.`,
        paymentStatus: "unverified",
        supportingQuote: null,
      },
    },
  };
}

function projectConversation(
  call: CallRecord,
  base: CallBase,
  conversation: Conversation,
  nowMs: number,
  speed: number,
): ProjectedCall {
  const ctx = callContext(call.frozen);
  const script = conversation.script(ctx);
  const run = runCall(script, call.interventions, toVirtual(call.startedAtMs, nowMs, speed));
  const real = (virtualMs: number): number => toReal(call.startedAtMs, virtualMs, speed);
  const connectedAt = run.events.find((e) => e.kind === "phase" && e.phase !== "dialing")?.at ?? null;
  const endedAtMs = run.endedAt === null ? null : real(run.endedAt);
  // The terminal state, transcript and outcome appear together, so polling never stops before the result.
  const outcome = endedAtMs === null ? null : { value: conversation.outcome(ctx, run.resolution), atMs: endedAtMs };
  let state: CallState = "queued";
  let updatedAtMs = call.startedAtMs;
  if (endedAtMs !== null) {
    state = "completed";
    updatedAtMs = endedAtMs;
  } else if (connectedAt !== null) {
    state = "in_progress";
    updatedAtMs = real(connectedAt);
  }
  return {
    record: call,
    run,
    gate: script.gate,
    v1: {
      ...base,
      state,
      transcript: endedAtMs === null ? null : conversation.transcript(ctx, run.resolution),
      error: null,
      updatedAt: iso(updatedAtMs),
    },
    live: toLiveCall(call, run, script.gate, conversation.plan(ctx), speed),
    timeline: callTimeline(call, run, script.gate, outcome?.value ?? null, speed),
    outcome,
  };
}

/**
 * Where the agent is in its plan. Steps before the one it entered are done,
 * that one is current (paused while the user is on the call) and later ones
 * are upcoming; before the first tagged step the first step is current. Once
 * the call ends every step is done.
 */
export function planFor(definitions: readonly PlanStepDefinition[], run: CallRun): CallPlan | null {
  if (definitions.length === 0) return null;
  const entered = run.stepId === null ? 0 : definitions.findIndex((d) => d.id === run.stepId);
  const currentIndex = entered < 0 ? 0 : entered;
  const ended = run.endedAt !== null;
  return {
    steps: definitions.map((d, index) => {
      let status: CallPlanStepStatus = "upcoming";
      if (ended || index < currentIndex) status = "done";
      else if (index === currentIndex) status = run.joined ? "paused" : "current";
      return { id: d.id, title: d.title, ...(d.detail === undefined ? {} : { detail: d.detail }), status };
    }),
  };
}

function toLiveCall(
  call: CallRecord,
  run: CallRun,
  gate: DecisionGate | null,
  plan: readonly PlanStepDefinition[],
  speed: number,
): LiveCallV2 {
  const at = (virtualMs: number): string => iso(toReal(call.startedAtMs, virtualMs, speed));
  const lastEvent = run.events[run.events.length - 1];
  return {
    callId: call.id,
    caseId: call.caseId,
    calling: { name: call.frozen.merchantName, phone: call.frozen.supportPhone },
    phase: run.phase,
    counterpart: run.counterpart,
    counterpartConfidence: run.counterpartConfidence,
    startedAt: at(0),
    endedAt: run.endedAt === null ? null : at(run.endedAt),
    holdSeconds: Math.floor(run.holdMs / speed / 1000),
    notes: run.events.flatMap((e) => (e.kind === "note" ? [{ at: at(e.at), text: e.text }] : [])),
    pendingDecision:
      run.pendingDecision !== null && gate !== null
        ? {
            id: decisionIdFor(call.id),
            question: gate.question,
            defaultOptionId: gate.defaultOptionId,
            options: gate.options.map((o) => ({ ...o })),
            expiresAt: at(run.pendingDecision.expiresAt),
          }
        : null,
    userJoined: run.joined,
    progress: planFor(plan, run),
    updatedAt: at(lastEvent?.at ?? 0),
  };
}

function callTimeline(
  call: CallRecord,
  run: CallRun,
  gate: DecisionGate | null,
  outcome: CaseOutcome | null,
  speed: number,
): TimelineItem[] {
  const items: TimelineItem[] = [];
  // Ids come from the position: replaying the same run always yields the same prefix.
  const add = (virtualMs: number, type: string, message: string): void => {
    items.push({
      id: stableId(`${call.id}:timeline:${items.length}`),
      atMs: toReal(call.startedAtMs, virtualMs, speed),
      type,
      message,
    });
  };
  const label = (optionId: string): string => gate?.options.find((o) => o.id === optionId)?.label ?? optionId;
  let connected = false;
  for (const event of run.events) {
    switch (event.kind) {
      case "phase":
        if (!connected && event.phase !== "dialing" && event.phase !== "ended") {
          connected = true;
          add(event.at, "call_in_progress", "Call in progress (simulated).");
        }
        break;
      case "counterpart":
        add(
          event.at,
          "counterpart_detected",
          `Talking to ${describeCounterpart(event.who)} (confidence ${Math.round(event.confidence * 100)}%).`,
        );
        break;
      case "decision_raised":
        add(event.at, "decision_requested", `The agent asked for your decision: ${gate?.question ?? ""}`.trim());
        break;
      case "decision_resolved":
        if (event.by === "user") add(event.at, "decision_answered", `You answered: ${label(event.optionId)}.`);
        else {
          add(
            event.at,
            "decision_defaulted",
            `No answer before the deadline; the agent used the default: ${label(event.optionId)}.`,
          );
        }
        break;
      case "joined":
        add(event.at, "user_joined_call", "You stepped in. The agent paused.");
        break;
      case "left":
        add(event.at, "user_left_call", LEAVE_NOTE);
        break;
      case "note":
        break;
      default:
        assertNever(event);
    }
  }
  if (run.endedAt !== null && outcome !== null) {
    const seconds = Math.round(run.endedAt / speed / 1000);
    add(run.endedAt, "call_completed", `Call completed (${seconds}s, simulated).`);
    add(
      run.endedAt,
      "outcome_published",
      `Decision: ${outcome.decision}; reference: ${outcome.referenceNumber ?? "none"}; payment: ${outcome.paymentStatus}.`,
    );
  }
  return items;
}

function describeCounterpart(who: Counterpart): string {
  switch (who) {
    case "agent":
      return "an automated agent";
    case "human":
      return "a person";
    case "unknown":
      return "an unidentified counterpart";
    default:
      return assertNever(who);
  }
}

function latestOutcome(stored: CaseRecord["outcome"], calls: readonly ProjectedCall[]): CaseOutcome {
  let latest = stored;
  for (const c of calls) if (c.outcome !== null && c.outcome.atMs >= latest.atMs) latest = c.outcome;
  return latest.value;
}

function deriveStatus(
  record: CaseRecord,
  calls: readonly ProjectedCall[],
  outcome: CaseOutcome,
  missing: readonly string[],
): CaseStatus {
  if (calls.some((c) => ACTIVE_CALL_STATES.includes(c.v1.state))) return "calling";
  const authorizationId = record.authorizationId;
  if (authorizationId !== null) {
    // Only a call made under the current authorization decides the status, not an older call's result.
    const completed = calls.some((c) => c.v1.authorizationId === authorizationId && c.v1.state === "completed");
    if (!completed) return "authorized";
    switch (outcome.decision) {
      case "approved":
        return "approved";
      case "denied":
        return "denied";
      case "needs_information":
        return "needs_information";
      case "requested":
      case "unknown":
        return "awaiting_response";
      default:
        return assertNever(outcome.decision);
    }
  }
  return missing.length > 0 ? "needs_information" : "ready_for_approval";
}
