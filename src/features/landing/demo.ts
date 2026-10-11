"use client";

/**
 * The landing hero's demo call: one timeline of beats over about 14 seconds,
 * replayed after a two-second rest. The words come from the fixture's
 * duplicate-charge conversation (api/fixture-engine/conversations.ts).
 */

import { useEffect, useState } from "react";
import { usePrefersReducedMotion } from "@/features/refund-ui/state/browser";

export type DemoPhase = "Dialing" | "Ringing" | "On hold" | "Talking" | "Call ended";

export interface DemoLine {
  speaker: "Agent" | "Support";
  text: string;
}

export const MERCHANT = "Ridgeline Outfitters billing";
export const REFERENCE = "RO-77102";
export const OUTCOME_FIGURE = "$49.99 refund";

export const PLAN_STEPS = [
  "Reach the billing team",
  "Explain the duplicate charge",
  "Ask for the refund",
  "Confirm the reference number",
  "Record the outcome",
] as const;

export const LINES: readonly DemoLine[] = [
  { speaker: "Agent", text: "Hi Sam. I'm an AI assistant calling about a duplicate charge." },
  { speaker: "Support", text: "I can see two charges of $49.99 on the same day." },
  { speaker: "Agent", text: "The second one is the duplicate. Please refund that charge." },
  { speaker: "Support", text: `I've issued the refund to the original card, reference ${REFERENCE}.` },
];

export interface DemoState {
  phase: DemoPhase;
  counterpart: boolean;
  /** Index of the current plan step; PLAN_STEPS.length once every step is done. */
  step: number;
  /** When each transcript line that has begun started, in ms into the loop. */
  lineStarts: readonly number[];
  /** When the call ended, in ms into the loop; null while it is live. */
  endedAtMs: number | null;
}

export interface Beat {
  atMs: number;
  apply: (state: DemoState) => DemoState;
}

export const INITIAL_STATE: DemoState = { phase: "Dialing", counterpart: false, step: 0, lineStarts: [], endedAtMs: null };

const say = (atMs: number): Beat => ({ atMs, apply: (s) => ({ ...s, lineStarts: [...s.lineStarts, atMs] }) });

/** The one timeline. Beats are in time order. */
export const TIMELINE: readonly Beat[] = [
  { atMs: 1200, apply: (s) => ({ ...s, phase: "Ringing" }) },
  { atMs: 2600, apply: (s) => ({ ...s, phase: "On hold" }) },
  { atMs: 4000, apply: (s) => ({ ...s, phase: "Talking", counterpart: true, step: 1 }) },
  say(4300),
  say(6500),
  { atMs: 8000, apply: (s) => ({ ...s, step: 2 }) },
  say(8200),
  { atMs: 9900, apply: (s) => ({ ...s, step: 3 }) },
  say(10000),
  { atMs: 12300, apply: (s) => ({ ...s, step: 4 }) },
  { atMs: 12900, apply: (s) => ({ ...s, phase: "Call ended", step: PLAN_STEPS.length, endedAtMs: 12900 }) },
];

export const LOOP_MS = 14_000;
export const REST_MS = 2_000;
export const TYPE_MS_PER_CHAR = 26;
/** Render granularity: one typed character. */
const QUANTUM_MS = TYPE_MS_PER_CHAR;

export function stateAt(elapsedMs: number): DemoState {
  let state = INITIAL_STATE;
  for (const beat of TIMELINE) {
    if (beat.atMs > elapsedMs) break;
    state = beat.apply(state);
  }
  return state;
}

/** Characters of line `index` typed by `elapsedMs`; 0 when the line has not begun. */
export function typedChars(state: DemoState, index: number, elapsedMs: number): number {
  const start = state.lineStarts[index];
  const line = LINES[index];
  if (start === undefined || !line) return 0;
  return Math.min(line.text.length, Math.floor((elapsedMs - start) / TYPE_MS_PER_CHAR));
}

export interface DemoFrame {
  state: DemoState;
  elapsedMs: number;
  /** True once the loop is finished or motion is reduced: render the end state without animating. */
  settled: boolean;
  /** Bumps on every replay so animations keyed on it restart. */
  run: number;
}

/**
 * Drives the timeline with requestAnimationFrame, re-rendering once per typed
 * character at most. Under prefers-reduced-motion it shows the finished call.
 */
export function useDemoCall(): DemoFrame {
  const reduced = usePrefersReducedMotion();
  const [clock, setClock] = useState({ elapsedMs: 0, run: 0 });

  useEffect(() => {
    if (reduced) {
      setClock({ elapsedMs: LOOP_MS, run: 0 });
      return;
    }
    let frame = 0;
    const startedAt = performance.now();
    const tick = (now: number) => {
      const total = now - startedAt;
      const cycle = LOOP_MS + REST_MS;
      const run = Math.floor(total / cycle);
      const inCycle = total - run * cycle;
      const elapsedMs = Math.min(LOOP_MS, Math.floor(inCycle / QUANTUM_MS) * QUANTUM_MS);
      setClock((prev) => (prev.elapsedMs === elapsedMs && prev.run === run ? prev : { elapsedMs, run }));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [reduced]);

  return { state: stateAt(clock.elapsedMs), elapsedMs: clock.elapsedMs, settled: reduced, run: clock.run };
}
