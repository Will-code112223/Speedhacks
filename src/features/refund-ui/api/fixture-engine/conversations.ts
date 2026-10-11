/**
 * Scripted calls the fixture plays: the live timeline, the transcript the call
 * ends with, and the outcome it supports. All text is synthetic. Facts that the
 * user can edit (names, amount) come from the authorization snapshot, so an
 * edited case is never contradicted by its own transcript.
 */

import type { CaseOutcome } from "../../../../contracts/case";
import type { DecisionOption } from "../types";
import type { CallScript, ScriptSpeaker, ScriptStep } from "./call-run";

export interface CallContext {
  customerName: string;
  merchantName: string;
  phone: string;
  /** The authorized amount, formatted. */
  amount: string;
}

export interface Resolution {
  optionId: string;
  by: "user" | "default";
}

/** One step of the agent's plan for the call, in order. Script steps enter it by id. */
export interface PlanStepDefinition {
  id: string;
  title: string;
  detail?: string;
}

/** One spoken line at a point in script time. */
export interface ScriptTurn {
  at: number;
  speaker: ScriptSpeaker;
  text: string;
}

export interface Conversation {
  script(ctx: CallContext): CallScript;
  /**
   * Every spoken line, in order, at the script time it is said. The single
   * source of the words: the script plays these live and the transcript the
   * call ends with is built from the same list, so the two never disagree.
   * Without a resolution a gated call uses its default branch.
   */
  turns(ctx: CallContext, resolution: Resolution | null): ScriptTurn[];
  /** What the agent intends to do on the call. Intent only: progress comes from the script's tagged steps. */
  plan(ctx: CallContext): PlanStepDefinition[];
  /** Speaker-labelled lines after a first line that marks the transcript as simulated. */
  transcript(ctx: CallContext, resolution: Resolution | null): string;
  outcome(ctx: CallContext, resolution: Resolution | null): CaseOutcome;
}

export const SIMULATED_MARKER = "[SIMULATED] Fixture conversation. No phone call was placed.";

const SPEAKER_LABEL: Record<ScriptSpeaker, string> = { support: "Support", agent: "Agent" };

/** The transcript a call ends with: the simulated marker, then one speaker-labelled line per turn. */
export function transcriptFromTurns(turns: readonly ScriptTurn[]): string {
  return [SIMULATED_MARKER, ...turns.map((t) => `${SPEAKER_LABEL[t.speaker]}: ${t.text}`)].join("\n");
}

/** Script steps that say each turn, merged into `steps` by time; at equal times the existing step goes first. */
export function withTurns(steps: readonly ScriptStep[], turns: readonly ScriptTurn[]): ScriptStep[] {
  const said: ScriptStep[] = turns.map((t) => ({ at: t.at, say: { speaker: t.speaker, text: t.text } }));
  return [...steps, ...said].sort((a, b) => a.at - b.at);
}

function lerp(from: number, to: number, fraction: number): number {
  return Math.round(from + (to - from) * fraction);
}

// ---------------------------------------------------------------------------
// Refund call: a person at the merchant's billing line issues the refund.
// ---------------------------------------------------------------------------

export const REFUND_REFERENCE = "RO-77102";

interface RefundPace {
  ringAt: number;
  holdAt: number;
  answerAt: number;
  explainAt: number;
  issuedAt: number;
  readBackAt: number;
  endAt: number;
}

const STANDARD_PACE: RefundPace = {
  ringAt: 2_000,
  holdAt: 4_000,
  answerAt: 10_000,
  explainAt: 14_000,
  issuedAt: 21_000,
  readBackAt: 26_000,
  endAt: 30_000,
};

const QUICK_PACE: RefundPace = {
  ringAt: 1_000,
  holdAt: 2_000,
  answerAt: 4_000,
  explainAt: 6_000,
  issuedAt: 8_000,
  readBackAt: 10_000,
  endAt: 12_000,
};

function refundCall(pace: RefundPace): Conversation {
  const turns = (ctx: CallContext): ScriptTurn[] => refundTurns(pace, ctx);
  return {
    plan: (ctx) => [
      { id: "reach", title: "Reach the billing team", detail: "Dialing, phone menu and hold." },
      { id: "explain", title: "Explain the duplicate charge", detail: `Two charges of ${ctx.amount} on the same day.` },
      { id: "ask", title: "Ask for the refund", detail: "Refund the second charge to the original card." },
      { id: "confirm", title: "Confirm the reference number", detail: "Read back the amount and reference." },
      { id: "record", title: "Record the outcome", detail: "Save the reference and next step to the case." },
    ],
    turns,
    script: (ctx) => ({
      gate: null,
      steps: withTurns(
        [
          { at: 0, phase: "dialing", step: "reach", note: `Dialing ${ctx.merchantName}.` },
          { at: pace.ringAt, phase: "ringing" },
          { at: pace.holdAt, phase: "on_hold", note: "On hold for the billing team." },
          {
            at: pace.answerAt,
            phase: "talking",
            step: "explain",
            counterpart: { who: "human", confidence: 0.8 },
            note: "A person answered.",
          },
          {
            at: pace.explainAt,
            step: "ask",
            note: `Explained the duplicate ${ctx.amount} charge and asked for a refund of the second one.`,
          },
          { at: pace.issuedAt, step: "confirm", note: `The rep issued the refund. Reference ${REFUND_REFERENCE}.` },
          { at: pace.readBackAt, note: "Read back the amount and reference. The rep confirmed." },
          { at: pace.endAt, phase: "ended", step: "record", note: "Call ended." },
        ],
        turns(ctx),
      ),
    }),
    transcript: (ctx) => transcriptFromTurns(turns(ctx)),
    // An explicit support statement supports "approved"; without payment evidence it stays unverified.
    outcome: (ctx) => ({
      decision: "approved",
      referenceNumber: REFUND_REFERENCE,
      nextAction: "Refund expected within 5 to 7 business days. Confirm when it lands.",
      paymentStatus: "unverified",
      supportingQuote: refundQuote(ctx),
    }),
  };
}

/** The refund call's lines, placed between the person answering and the call ending. */
function refundTurns(pace: RefundPace, ctx: CallContext): ScriptTurn[] {
  const talk = (fraction: number): number => lerp(pace.answerAt, pace.explainAt, fraction);
  const confirm = (fraction: number): number => lerp(pace.issuedAt, pace.readBackAt, fraction);
  return [
    { at: talk(0.125), speaker: "support", text: `${ctx.merchantName}, this is Sam. How can I help?` },
    {
      at: talk(0.375),
      speaker: "agent",
      text: `Hi Sam. I'm an AI assistant calling for ${ctx.customerName} about a duplicate charge of ${ctx.amount}.`,
    },
    { at: talk(0.75), speaker: "support", text: `I can see two charges of ${ctx.amount} on the same day.` },
    {
      at: pace.explainAt,
      speaker: "agent",
      text: `The second one is the duplicate. ${ctx.customerName} is asking for a refund of that charge.`,
    },
    { at: pace.issuedAt, speaker: "support", text: `${refundQuote(ctx)}.` },
    {
      at: confirm(0.5),
      speaker: "agent",
      text: `To confirm: a ${ctx.amount} refund to the original card, reference ${REFUND_REFERENCE}.`,
    },
    { at: confirm(0.8), speaker: "support", text: "That's right. It should post in 5 to 7 business days." },
    { at: lerp(pace.readBackAt, pace.endAt, 0.5), speaker: "agent", text: "Thank you. Goodbye." },
  ];
}

function refundQuote(ctx: CallContext): string {
  return `I've issued the refund of ${ctx.amount} to the original card, reference ${REFUND_REFERENCE}`;
}

export const refundCallStandard = refundCall(STANDARD_PACE);
export const refundCallQuick = refundCall(QUICK_PACE);

// ---------------------------------------------------------------------------
// Insurance claim: an automated claims line opens the claim and asks for a
// decision outside the authorization (an adjuster visit time).
// ---------------------------------------------------------------------------

export const CLAIM_REFERENCE = "NWM-2026-48213";
export const ADJUSTER_QUESTION =
  "The claims line can open the claim now but asks to schedule an adjuster visit on Tuesday 10 to 12. Accept?";
export const ADJUSTER_OPTIONS: readonly DecisionOption[] = [
  { id: "accept", label: "Accept Tuesday 10 to 12", tone: "primary" },
  { id: "ask_for_other_times", label: "Ask for other times", tone: "neutral" },
  { id: "decline", label: "Decline the visit", tone: "danger" },
];
export const ADJUSTER_DEFAULT = "ask_for_other_times";
export const DECISION_AT = 24_000;
export const DECISION_TIMEOUT_MS = 20_000;

interface ClaimBranch {
  /** Live note once the claims line acts on the choice. */
  note: string;
  /** What the agent says when the user chose this option. */
  agentLine: (ctx: CallContext) => string;
  /** What the agent says when this option applied because nobody answered. */
  agentLineByDefault?: (ctx: CallContext) => string;
  supportLine: string;
  readBack: string;
  closing: string;
  nextAction: string;
}

const CLAIM_BRANCHES: Record<string, ClaimBranch> = {
  accept: {
    note: `Claim ${CLAIM_REFERENCE} opened. Adjuster visit booked for Tuesday 10 to 12.`,
    agentLine: (ctx) => `${ctx.customerName} accepts Tuesday from 10 to 12.`,
    supportLine: `Your claim ${CLAIM_REFERENCE} is open and an adjuster visit is scheduled.`,
    readBack: `To confirm: claim ${CLAIM_REFERENCE}, adjuster visit Tuesday 10 to 12.`,
    closing: "Correct. Please upload photos of the damage before the visit.",
    nextAction: "Adjuster visit Tuesday 10-12; upload photos of the damage before then",
  },
  ask_for_other_times: {
    note: `Claim ${CLAIM_REFERENCE} opened. A scheduler will call you to book the adjuster visit.`,
    agentLine: (ctx) => `${ctx.customerName} would like other times. What else is available?`,
    agentLineByDefault: (ctx) =>
      `I could not confirm Tuesday with ${ctx.customerName} in time. What other times are available?`,
    supportLine: `Your claim ${CLAIM_REFERENCE} is open. A scheduler will call to book the adjuster visit.`,
    readBack: `To confirm: claim ${CLAIM_REFERENCE}, and a scheduler will call about the visit.`,
    closing: "Correct. Please upload photos of the damage before the visit.",
    nextAction: "A scheduler will call to book the adjuster visit; upload photos of the damage before then",
  },
  decline: {
    note: `Claim ${CLAIM_REFERENCE} opened without a visit. An adjuster will review photos instead.`,
    agentLine: (ctx) => `${ctx.customerName} declines the visit for now.`,
    supportLine: `Your claim ${CLAIM_REFERENCE} is open without a visit. An adjuster will review photos instead.`,
    readBack: `To confirm: claim ${CLAIM_REFERENCE}, reviewed from photos.`,
    closing: "Correct. Please upload photos of the damage this week.",
    nextAction: "Upload photos of the damage so an adjuster can review the claim remotely",
  },
};

function claimBranch(resolution: Resolution | null): ClaimBranch {
  const branch = CLAIM_BRANCHES[resolution?.optionId ?? ADJUSTER_DEFAULT] ?? CLAIM_BRANCHES[ADJUSTER_DEFAULT];
  if (branch === undefined) throw new Error("The adjuster decision has no default branch.");
  return branch;
}

function afterDecision(branch: ClaimBranch, ctx: CallContext, resolution: Resolution): ScriptStep[] {
  return withTurns(
    [
      { at: 31_000, step: "confirm", note: branch.note },
      { at: 38_000, note: `Read back claim ${CLAIM_REFERENCE}. The claims line confirmed.` },
      { at: 45_000, phase: "ended", step: "record", note: "Call ended." },
    ],
    claimTurns(ctx, resolution).filter((t) => t.at > DECISION_AT),
  );
}

/** Per option, the steps after the decision when it was chosen by `by`. */
function afterDecisions(ctx: CallContext, by: Resolution["by"]): Record<string, ScriptStep[]> {
  return Object.fromEntries(
    Object.entries(CLAIM_BRANCHES).map(([optionId, branch]) => [optionId, afterDecision(branch, ctx, { optionId, by })]),
  );
}

/**
 * The claim call's lines. Lines up to DECISION_AT play before the prompt; the
 * rest play after it, from script time DECISION_AT, and depend on the answer.
 */
function claimTurns(ctx: CallContext, resolution: Resolution | null): ScriptTurn[] {
  const branch = claimBranch(resolution);
  const agentLine =
    resolution?.by === "default" && branch.agentLineByDefault ? branch.agentLineByDefault(ctx) : branch.agentLine(ctx);
  return [
    { at: 3_500, speaker: "support", text: `Thank you for calling ${ctx.merchantName}. For existing claims, press 2.` },
    { at: 9_500, speaker: "support", text: "Please hold for the next available claims agent." },
    { at: 17_000, speaker: "support", text: "This is the automated claims assistant. How can I help?" },
    {
      at: 20_000,
      speaker: "agent",
      text: `I'm an AI assistant calling for ${ctx.customerName} about a claim for ${ctx.amount}. The details and photos are on file.`,
    },
    {
      at: DECISION_AT - 1_500,
      speaker: "support",
      text: "I can open the claim now. An adjuster needs to visit, and the first opening is Tuesday from 10 to 12. Does that work?",
    },
    { at: DECISION_AT, speaker: "agent", text: `One moment while I check with ${ctx.customerName}.` },
    { at: DECISION_AT + 500, speaker: "agent", text: agentLine },
    { at: 30_000, speaker: "support", text: branch.supportLine },
    { at: 36_000, speaker: "agent", text: branch.readBack },
    { at: 37_500, speaker: "support", text: branch.closing },
    { at: 42_000, speaker: "agent", text: "Thank you. Goodbye." },
  ];
}

export const insuranceClaimCall: Conversation = {
  plan: (ctx) => [
    { id: "reach", title: "Reach the claims line", detail: "Dialing, phone menu and hold." },
    { id: "state", title: "State the claim with the evidence", detail: `A claim for ${ctx.amount}, with the evidence on file.` },
    { id: "decide", title: "Check the adjuster visit with you", detail: "Anything outside your authorization waits for your answer." },
    { id: "confirm", title: "Confirm the claim reference", detail: "Read back the claim reference." },
    { id: "record", title: "Record the outcome", detail: "Save the reference and next step to the case." },
  ],
  turns: claimTurns,
  script: (ctx) => ({
    steps: withTurns(
      [
        { at: 0, phase: "dialing", step: "reach", note: `Dialing ${ctx.merchantName}.` },
        { at: 3_000, phase: "navigating_menu", note: "The phone menu answered." },
        { at: 5_000, note: "Pressed 2 for existing claims" },
        { at: 9_000, phase: "on_hold", note: "On hold for the claims team." },
        {
          at: 17_000,
          phase: "talking",
          step: "state",
          counterpart: { who: "agent", confidence: 0.9 },
          note: "Automated claims assistant answered. Switching to concise mode.",
        },
        { at: 20_000, note: `Stated the claim for ${ctx.customerName}: ${ctx.amount}, with the evidence on file.` },
        { at: DECISION_AT, step: "decide", note: "The claims line asked to book an adjuster visit. Asking you." },
      ],
      claimTurns(ctx, null).filter((t) => t.at <= DECISION_AT),
    ),
    gate: {
      at: DECISION_AT,
      question: ADJUSTER_QUESTION,
      options: ADJUSTER_OPTIONS.map((o) => ({ ...o })),
      defaultOptionId: ADJUSTER_DEFAULT,
      timeoutMs: DECISION_TIMEOUT_MS,
      after: afterDecisions(ctx, "user"),
      afterByDefault: afterDecisions(ctx, "default"),
    },
  }),
  transcript: (ctx, resolution) => transcriptFromTurns(claimTurns(ctx, resolution)),
  // Opening a claim is a request, not a decision on it; nothing is paid yet.
  outcome: (_ctx, resolution) => {
    const branch = claimBranch(resolution);
    return {
      decision: "requested",
      referenceNumber: CLAIM_REFERENCE,
      nextAction: branch.nextAction,
      paymentStatus: "unverified",
      supportingQuote: branch.supportLine,
    };
  },
};
