/**
 * Scripted calls the fixture plays: the live timeline, the transcript the call
 * ends with, and the outcome it supports. All text is synthetic. Facts that the
 * user can edit (names, amount) come from the authorization snapshot, so an
 * edited case is never contradicted by its own transcript.
 */

import type { CaseOutcome } from "../../../../contracts/case";
import type { DecisionOption } from "../types";
import type { CallScript, ScriptStep } from "./call-run";

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

export interface Conversation {
  script(ctx: CallContext): CallScript;
  /** What the agent intends to do on the call. Intent only: progress comes from the script's tagged steps. */
  plan(ctx: CallContext): PlanStepDefinition[];
  /** Speaker-labelled lines after a first line that marks the transcript as simulated. */
  transcript(ctx: CallContext, resolution: Resolution | null): string;
  outcome(ctx: CallContext, resolution: Resolution | null): CaseOutcome;
}

export const SIMULATED_MARKER = "[SIMULATED] Fixture conversation. No phone call was placed.";

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
  return {
    plan: (ctx) => [
      { id: "reach", title: "Reach the billing team", detail: "Dialing, phone menu and hold." },
      { id: "explain", title: "Explain the duplicate charge", detail: `Two charges of ${ctx.amount} on the same day.` },
      { id: "ask", title: "Ask for the refund", detail: "Refund the second charge to the original card." },
      { id: "confirm", title: "Confirm the reference number", detail: "Read back the amount and reference." },
      { id: "record", title: "Record the outcome", detail: "Save the reference and next step to the case." },
    ],
    script: (ctx) => ({
      gate: null,
      steps: [
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
        { at: pace.explainAt, step: "ask", note: `Explained the duplicate ${ctx.amount} charge and asked for a refund of the second one.` },
        { at: pace.issuedAt, step: "confirm", note: `The rep issued the refund. Reference ${REFUND_REFERENCE}.` },
        { at: pace.readBackAt, note: "Read back the amount and reference. The rep confirmed." },
        { at: pace.endAt, phase: "ended", step: "record", note: "Call ended." },
      ],
    }),
    transcript: (ctx) =>
      [
        SIMULATED_MARKER,
        `Support: ${ctx.merchantName}, this is Sam. How can I help?`,
        `Agent: Hi Sam. I'm an AI assistant calling for ${ctx.customerName} about a duplicate charge of ${ctx.amount}.`,
        `Support: I can see two charges of ${ctx.amount} on the same day.`,
        `Agent: The second one is the duplicate. ${ctx.customerName} is asking for a refund of that charge.`,
        `Support: ${refundQuote(ctx)}.`,
        `Agent: To confirm: a ${ctx.amount} refund to the original card, reference ${REFUND_REFERENCE}.`,
        "Support: That's right. It should post in 5 to 7 business days.",
        "Agent: Thank you. Goodbye.",
      ].join("\n"),
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

function afterDecision(branch: ClaimBranch): ScriptStep[] {
  return [
    { at: 31_000, step: "confirm", note: branch.note },
    { at: 38_000, note: `Read back claim ${CLAIM_REFERENCE}. The claims line confirmed.` },
    { at: 45_000, phase: "ended", step: "record", note: "Call ended." },
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
  script: (ctx) => ({
    steps: [
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
    gate: {
      at: DECISION_AT,
      question: ADJUSTER_QUESTION,
      options: ADJUSTER_OPTIONS.map((o) => ({ ...o })),
      defaultOptionId: ADJUSTER_DEFAULT,
      timeoutMs: DECISION_TIMEOUT_MS,
      after: Object.fromEntries(
        Object.entries(CLAIM_BRANCHES).map(([optionId, branch]) => [optionId, afterDecision(branch)]),
      ),
    },
  }),
  transcript: (ctx, resolution) => {
    const branch = claimBranch(resolution);
    const agentLine =
      resolution?.by === "default" && branch.agentLineByDefault ? branch.agentLineByDefault(ctx) : branch.agentLine(ctx);
    return [
      SIMULATED_MARKER,
      `Support: Thank you for calling ${ctx.merchantName}. For existing claims, press 2.`,
      "Support: Please hold for the next available claims agent.",
      "Support: This is the automated claims assistant. How can I help?",
      `Agent: I'm an AI assistant calling for ${ctx.customerName} about a claim for ${ctx.amount}. The details and photos are on file.`,
      "Support: I can open the claim now. An adjuster needs to visit, and the first opening is Tuesday from 10 to 12. Does that work?",
      `Agent: One moment while I check with ${ctx.customerName}.`,
      `Agent: ${agentLine}`,
      `Support: ${branch.supportLine}`,
      `Agent: ${branch.readBack}`,
      `Support: ${branch.closing}`,
      "Agent: Thank you. Goodbye.",
    ].join("\n");
  },
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
