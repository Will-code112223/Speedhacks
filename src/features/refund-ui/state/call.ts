/**
 * Pure helpers for calls: which call is current, how live phases read, and
 * which case states end the flow. Phases are switched exhaustively so a new
 * LiveCallPhase fails the type check instead of rendering a blank.
 */

import type { CallState, CallV1, CaseStatus, CaseV1 } from "../../../contracts/case";
import type { CallPlan, CallPlanStep, Counterpart, LiveCallPhase, LiveCallV2 } from "../api/types";
import { statusWord } from "../ui/format";

/** Case statuses where the call flow is over and the outcome card shows. */
export const OUTCOME_STATUSES: readonly CaseStatus[] = ["awaiting_response", "approved", "denied"];

export function isOutcomeStatus(status: CaseStatus): boolean {
  return OUTCOME_STATUSES.includes(status);
}

/** A request for information is a result only after a completed call. */
export function hasCallOutcome(caseData: CaseV1, call: CallV1 | null): boolean {
  return isOutcomeStatus(caseData.status) || (
    caseData.status === "needs_information" &&
    caseData.outcome.decision === "needs_information" &&
    call?.state === "completed"
  );
}

/** Call states that are still moving or unresolved (mirrors ACTIVE_CALL_STATES in the contract). */
const ACTIVE_STATES: readonly CallState[] = ["dispatch_pending", "queued", "in_progress", "dispatch_unknown"];

export function isCallActive(call: CallV1): boolean {
  return ACTIVE_STATES.includes(call.state) && call.state !== "dispatch_unknown";
}

/** The newest call on the case, or the one just started if the case has not caught up yet. */
export function currentCall(caseData: CaseV1 | null, startedCall: CallV1 | null): CallV1 | null {
  const calls = caseData?.calls ?? [];
  let newest: CallV1 | null = null;
  for (const call of calls) {
    if (!newest || call.createdAt > newest.createdAt) newest = call;
  }
  if (startedCall && !calls.some((call) => call.id === startedCall.id)) {
    if (!newest || startedCall.createdAt >= newest.createdAt) return startedCall;
  }
  return newest;
}

/** Status line on the call screen. */
export function phaseLabel(phase: LiveCallPhase): string {
  switch (phase) {
    case "dialing":
      return "Dialing";
    case "ringing":
      return "Ringing";
    case "navigating_menu":
      return "Navigating the menu";
    case "on_hold":
      return "On hold";
    case "talking":
      return "Talking";
    case "waiting_for_user":
      return "Waiting for you";
    case "user_joined":
      return "You are on the call";
    case "ended":
      return "Ended";
    default: {
      const unreachable: never = phase;
      return unreachable;
    }
  }
}

/** Whether someone has answered, so the counterpart badge means something. */
export function phaseHasCounterpart(phase: LiveCallPhase): boolean {
  switch (phase) {
    case "dialing":
    case "ringing":
      return false;
    case "navigating_menu":
    case "on_hold":
    case "talking":
    case "waiting_for_user":
    case "user_joined":
    case "ended":
      return true;
    default: {
      const unreachable: never = phase;
      return unreachable;
    }
  }
}

/** Phases where the call is still connected and step-in makes sense. */
export function phaseIsLive(phase: LiveCallPhase): boolean {
  switch (phase) {
    case "dialing":
    case "ringing":
    case "navigating_menu":
    case "on_hold":
    case "talking":
    case "waiting_for_user":
    case "user_joined":
      return true;
    case "ended":
      return false;
    default: {
      const unreachable: never = phase;
      return unreachable;
    }
  }
}

/** The compact chat line for entering a phase. */
export function phaseEventText(live: LiveCallV2): string {
  switch (live.phase) {
    case "dialing":
      return `Dialing ${live.calling.name}`;
    case "ringing":
      return "Ringing";
    case "navigating_menu":
      return "Navigating the phone menu";
    case "on_hold":
      return "On hold";
    case "talking":
      return "Talking";
    case "waiting_for_user":
      return "Waiting for your answer";
    case "user_joined":
      return "You stepped in";
    case "ended":
      return "Call ended";
    default: {
      const unreachable: never = live.phase;
      return unreachable;
    }
  }
}

/**
 * The plan to show for a call: the backend's when it reports one, otherwise
 * four steps derived from the live phase so a V2 backend without plans still
 * shows where the agent is. Null without live data, since a V1 call state
 * says nothing about progress.
 */
export function callPlanFor(live: LiveCallV2 | null): CallPlan | null {
  if (live === null) return null;
  if (live.progress) return live.progress;
  return derivedPlan(live);
}

const DERIVED_STEPS: readonly { id: string; title: string; detail: string }[] = [
  { id: "reach", title: "Reach the line", detail: "Dialing and waiting for an answer." },
  { id: "route", title: "Get to the right team", detail: "Phone menu and hold." },
  { id: "case", title: "Make the case", detail: "State the facts and ask for the outcome." },
  { id: "record", title: "Record the outcome", detail: "Reference number, next step and transcript." },
];

function derivedStepIndex(live: LiveCallV2): number {
  switch (live.phase) {
    case "dialing":
    case "ringing":
      return 0;
    case "navigating_menu":
    case "on_hold":
      return 1;
    case "talking":
    case "waiting_for_user":
      return 2;
    case "user_joined":
      // The join hides the underlying phase, so read the evidence the record
      // still carries: nobody identified and no hold time means the line was
      // not reached yet; hold time without a counterpart means still routing.
      if (live.counterpart !== "unknown") return 2;
      return live.holdSeconds > 0 ? 1 : 0;
    case "ended":
      return 3;
    default: {
      const unreachable: never = live.phase;
      return unreachable;
    }
  }
}

function derivedPlan(live: LiveCallV2): CallPlan {
  const ended = live.phase === "ended";
  const current = derivedStepIndex(live);
  const paused = live.userJoined || live.phase === "user_joined";
  return {
    steps: DERIVED_STEPS.map((step, index) => ({
      ...step,
      status: ended ? "done" : index < current ? "done" : index === current ? (paused ? "paused" : "current") : "upcoming",
    })),
  };
}

/** The step the agent is on (current or paused), with its 1-based position. */
export function currentPlanStep(plan: CallPlan): { step: CallPlanStep; position: number } | null {
  const index = plan.steps.findIndex((step) => step.status === "current" || step.status === "paused");
  if (index === -1) return null;
  const step = plan.steps[index];
  return step ? { step, position: index + 1 } : null;
}

/** "Step 2 of 5" style summary for the call bar and the dashboard line. */
export function planProgressText(plan: CallPlan): string {
  const current = currentPlanStep(plan);
  if (current) return `Step ${current.position} of ${plan.steps.length}`;
  return plan.steps.every((step) => step.status === "done") ? "All steps done" : `${plan.steps.length} steps`;
}

/** The chat line when the counterpart becomes known or changes. */
export function counterpartEventText(previous: Counterpart | null, next: Counterpart): string | null {
  if (next === "unknown" || previous === next) return null;
  if (previous === null || previous === "unknown") {
    return next === "human" ? "A person answered" : "An automated agent answered";
  }
  return next === "human" ? "Transferred to a person" : "Now talking to an automated agent";
}

/**
 * The chat line for a V1 call state, used when the backend has no live call
 * data. The contract word is shown as written, only made readable.
 */
export function callStateEventText(state: CallState): string {
  return `Call status: ${statusWord(state).toLowerCase()}`;
}

/** A short case title for the header and rail. */
export function caseTitle(caseData: CaseV1 | null, fallback: string): string {
  const merchant = caseData?.merchant.name?.trim();
  if (merchant) return merchant;
  const trimmed = fallback.trim().replace(/\s+/g, " ");
  if (!trimmed) return "New case";
  return trimmed.length > 40 ? `${trimmed.slice(0, 39).trimEnd()}…` : trimmed;
}
