/**
 * Pure simulation of one scripted call. Given the script, the user's recorded
 * interventions and a point in script time, it replays everything up to that
 * point. No timers: the engine calls it on every read, so state is a function
 * of the clock and the result is deterministic.
 *
 * Two kinds of pause stop the script clock while real time runs on:
 * - a decision gate, until the user answers or the prompt times out and the
 *   default option applies;
 * - the user stepping in, until they answer a pending decision or the join
 *   window passes, after which the agent takes over again.
 */

import { assertNever } from "../assert-never";
import type { Counterpart, DecisionOption, LiveCallPhase } from "../types";

/** Phases the script sets; `waiting_for_user` and `user_joined` come from pauses. */
export type ScriptPhase = Exclude<LiveCallPhase, "waiting_for_user" | "user_joined">;

export interface ScriptStep {
  /** Script time in ms (real ms at speed 1). The script clock stops during pauses. */
  at: number;
  phase?: ScriptPhase;
  note?: string;
  counterpart?: { who: Counterpart; confidence: number };
  /** The agent enters the plan step with this id here. */
  step?: string;
}

export interface DecisionGate {
  /** Script time at which the prompt is raised; every pre-gate step is at or before it. */
  at: number;
  question: string;
  options: DecisionOption[];
  defaultOptionId: string;
  /** Time the prompt waits for an answer before the default applies. */
  timeoutMs: number;
  /** Steps after the decision, per option. Script time resumes from `at`. */
  after: Record<string, ScriptStep[]>;
}

export interface CallScript {
  steps: ScriptStep[];
  gate: DecisionGate | null;
}

/** Recorded user actions; `at` is script time measured on the real clock (pauses included). */
export type Intervention = { kind: "join"; at: number } | { kind: "answer"; at: number; optionId: string };

export type CallRunEvent =
  | { kind: "phase"; at: number; phase: ScriptPhase }
  | { kind: "note"; at: number; text: string }
  | { kind: "counterpart"; at: number; who: Counterpart; confidence: number }
  | { kind: "decision_raised"; at: number; expiresAt: number }
  | { kind: "decision_resolved"; at: number; optionId: string; by: "user" | "default" }
  | { kind: "joined"; at: number }
  | { kind: "left"; at: number };

export interface CallRun {
  /** Everything up to the requested time, in order. */
  events: CallRunEvent[];
  phase: LiveCallPhase;
  counterpart: Counterpart;
  counterpartConfidence: number;
  /** Script time spent navigating menus or on hold. */
  holdMs: number;
  pendingDecision: { raisedAt: number; expiresAt: number } | null;
  resolution: { optionId: string; by: "user" | "default"; at: number } | null;
  joined: boolean;
  endedAt: number | null;
  /** The plan step the agent entered last; null before the first tagged step. */
  stepId: string | null;
}

/** How long stepping in pauses the agent when no decision answer ends it sooner. */
export const JOIN_WINDOW_MS = 20_000;

export const JOIN_NOTE = "You stepped in. The agent is paused and takes over again when you hand back.";
export const LEAVE_NOTE = "You handed back. The agent took over the call again.";

interface Occurrence {
  at: number;
  /** Tie-break at equal times: the script first, then timeouts, then user actions. */
  rank: number;
  apply: () => void;
}

export function runCall(script: CallScript, interventions: readonly Intervention[], until: number): CallRun {
  const events: CallRunEvent[] = [];
  const queue: ScriptStep[] = [...script.steps];
  let scriptPhase: ScriptPhase = "dialing";
  let counterpart: Counterpart = "unknown";
  let confidence = 0;
  let holdMs = 0;
  let scriptClock = 0;
  let clock = 0;
  let gateRaised = false;
  let pending: CallRun["pendingDecision"] = null;
  let resolution: CallRun["resolution"] = null;
  let joinedUntil: number | null = null;
  let endedAt: number | null = null;
  let stepId: string | null = null;
  let nextIntervention = 0;

  const paused = (): boolean => pending !== null || joinedUntil !== null;

  const advanceTo = (t: number): void => {
    const target = Math.max(t, clock);
    if (!paused()) {
      const elapsed = target - clock;
      if (scriptPhase === "navigating_menu" || scriptPhase === "on_hold") holdMs += elapsed;
      scriptClock += elapsed;
    }
    clock = target;
  };

  const note = (text: string): void => {
    events.push({ kind: "note", at: clock, text });
  };

  const applyStep = (step: ScriptStep): void => {
    if (step.step !== undefined) stepId = step.step;
    if (step.phase !== undefined && step.phase !== scriptPhase) {
      scriptPhase = step.phase;
      events.push({ kind: "phase", at: clock, phase: step.phase });
    }
    if (step.counterpart !== undefined) {
      counterpart = step.counterpart.who;
      confidence = step.counterpart.confidence;
      events.push({ kind: "counterpart", at: clock, who: counterpart, confidence });
    }
    if (step.note !== undefined) note(step.note);
    if (step.phase === "ended") endedAt = clock;
  };

  const raise = (gate: DecisionGate): void => {
    gateRaised = true;
    pending = { raisedAt: clock, expiresAt: clock + gate.timeoutMs };
    events.push({ kind: "decision_raised", at: clock, expiresAt: pending.expiresAt });
  };

  const resolve = (gate: DecisionGate, optionId: string, by: "user" | "default"): void => {
    pending = null;
    resolution = { optionId, by, at: clock };
    const label = gate.options.find((o) => o.id === optionId)?.label ?? optionId;
    events.push({ kind: "decision_resolved", at: clock, optionId, by });
    note(by === "user" ? `You chose "${label}".` : `No answer before the deadline. Went with the default: "${label}".`);
    queue.push(...(gate.after[optionId] ?? []));
    queue.sort((a, b) => a.at - b.at);
  };

  const leave = (): void => {
    joinedUntil = null;
    events.push({ kind: "left", at: clock });
    note(LEAVE_NOTE);
  };

  const intervene = (intervention: Intervention): void => {
    switch (intervention.kind) {
      case "join":
        if (joinedUntil === null) {
          joinedUntil = clock + JOIN_WINDOW_MS;
          events.push({ kind: "joined", at: clock });
          note(JOIN_NOTE);
        }
        return;
      case "answer":
        if (pending !== null && script.gate !== null) {
          resolve(script.gate, intervention.optionId, "user");
          if (joinedUntil !== null) leave();
        }
        return;
      default:
        assertNever(intervention);
    }
  };

  const next = (): Occurrence | undefined => {
    const candidates: Occurrence[] = [];
    const gate = script.gate;
    if (!paused()) {
      const step = queue[0];
      const gateAhead = gate !== null && !gateRaised ? gate : null;
      if (step !== undefined && (gateAhead === null || step.at <= gateAhead.at)) {
        candidates.push({
          at: clock + (step.at - scriptClock),
          rank: 0,
          apply: () => {
            queue.shift();
            applyStep(step);
          },
        });
      } else if (gateAhead !== null) {
        candidates.push({ at: clock + (gateAhead.at - scriptClock), rank: 0, apply: () => raise(gateAhead) });
      }
    }
    if (pending !== null && gate !== null) {
      candidates.push({ at: pending.expiresAt, rank: 1, apply: () => resolve(gate, gate.defaultOptionId, "default") });
    }
    if (joinedUntil !== null) candidates.push({ at: joinedUntil, rank: 2, apply: leave });
    const intervention = interventions[nextIntervention];
    if (intervention !== undefined) {
      candidates.push({
        at: intervention.at,
        rank: 3,
        apply: () => {
          nextIntervention += 1;
          intervene(intervention);
        },
      });
    }
    return earliest(candidates);
  };

  while (endedAt === null) {
    const occurrence = next();
    if (occurrence === undefined || occurrence.at > until) break;
    advanceTo(occurrence.at);
    occurrence.apply();
  }
  if (endedAt === null) advanceTo(until);

  let phase: LiveCallPhase = scriptPhase;
  if (endedAt !== null) phase = "ended";
  else if (joinedUntil !== null) phase = "user_joined";
  else if (pending !== null) phase = "waiting_for_user";

  return {
    events,
    phase,
    counterpart,
    counterpartConfidence: confidence,
    holdMs,
    pendingDecision: pending,
    resolution,
    joined: joinedUntil !== null,
    endedAt,
    stepId,
  };
}

function earliest(candidates: readonly Occurrence[]): Occurrence | undefined {
  let best: Occurrence | undefined;
  for (const c of candidates) {
    if (best === undefined || c.at < best.at || (c.at === best.at && c.rank < best.rank)) best = c;
  }
  return best;
}
