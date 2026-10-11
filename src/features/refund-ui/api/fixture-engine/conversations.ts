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
  /** The authorized amount, formatted; null for a claim filed before any estimate. */
  amount: string | null;
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

/** A refund always has an authorized amount: the engine never authorizes one without it. */
function refundAmount(ctx: CallContext): string {
  if (ctx.amount === null) throw new Error("A refund call needs an authorized amount.");
  return ctx.amount;
}

function refundCall(pace: RefundPace): Conversation {
  const turns = (ctx: CallContext): ScriptTurn[] => refundTurns(pace, ctx);
  return {
    plan: (ctx) => [
      { id: "reach", title: "Reach the billing team", detail: "Dialing, phone menu and hold." },
      { id: "explain", title: "Explain the duplicate charge", detail: `Two charges of ${refundAmount(ctx)} on the same day.` },
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
            note: `Explained the duplicate ${refundAmount(ctx)} charge and asked for a refund of the second one.`,
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
  const amount = refundAmount(ctx);
  return [
    { at: talk(0.125), speaker: "support", text: `${ctx.merchantName}, this is Sam. How can I help?` },
    {
      at: talk(0.375),
      speaker: "agent",
      text: `Hi Sam. I'm an AI assistant calling for ${ctx.customerName} about a duplicate charge of ${amount}.`,
    },
    { at: talk(0.75), speaker: "support", text: `I can see two charges of ${amount} on the same day.` },
    {
      at: pace.explainAt,
      speaker: "agent",
      text: `The second one is the duplicate. ${ctx.customerName} is asking for a refund of that charge.`,
    },
    { at: pace.issuedAt, speaker: "support", text: `${refundQuote(ctx)}.` },
    {
      at: confirm(0.5),
      speaker: "agent",
      text: `To confirm: a ${amount} refund to the original card, reference ${REFUND_REFERENCE}.`,
    },
    { at: confirm(0.8), speaker: "support", text: "That's right. It should post in 5 to 7 business days." },
    { at: lerp(pace.readBackAt, pace.endAt, 0.5), speaker: "agent", text: "Thank you. Goodbye." },
  ];
}

function refundQuote(ctx: CallContext): string {
  return `I've issued the refund of ${refundAmount(ctx)} to the original card, reference ${REFUND_REFERENCE}`;
}

export const refundCallStandard = refundCall(STANDARD_PACE);
export const refundCallQuick = refundCall(QUICK_PACE);

// ---------------------------------------------------------------------------
// Insurance claim: the policyholder was rear-ended, and the agent calls AAA to
// file a collision claim. A phone menu and an automated assistant route it; a
// claims rep verifies the policy, takes the loss report and opens the claim,
// then offers a direct repair shop. Choosing a shop is outside the
// authorization, so the agent asks the user before answering.
// ---------------------------------------------------------------------------

/** Facts the agent reads from the declarations page and the photos; not editable case facts. */
const POLICY_ENDING = "4471";
const VEHICLE = "red 2021 Toyota Camry";
const OTHER_PLATE = "8UFJ426";

export const CLAIM_REFERENCE = "1002-48-7731";
export const SHOP_DEFAULT = "decide_later";
export const DECISION_AT = 45_000;
export const DECISION_TIMEOUT_MS = 20_000;

/** The insurer as people say it: "AAA claims line" is "AAA". */
function insurerName(ctx: CallContext): string {
  return ctx.merchantName.replace(/\s+claims?\s+line$/i, "").trim() || ctx.merchantName;
}

/** How the rep refers to the policyholder once introduced: "Jordan Avery" is "Jordan". */
function firstName(ctx: CallContext): string {
  return ctx.customerName.trim().split(/\s+/)[0] ?? ctx.customerName;
}

function shopQuestion(ctx: CallContext): string {
  const insurer = insurerName(ctx);
  return `${insurer} can book one of its direct repair shops near you, with the work guaranteed while you own the car. Use ${insurer}'s shop?`;
}

function shopOptions(ctx: CallContext): DecisionOption[] {
  return [
    { id: "accept", label: `Use ${insurerName(ctx)}'s shop`, tone: "primary" },
    { id: "own_shop", label: "Choose my own shop", tone: "neutral" },
    { id: SHOP_DEFAULT, label: "Decide with the adjuster", tone: "neutral" },
  ];
}

/** What the rep says when the claim opens; the outcome quotes it. */
function claimQuote(ctx: CallContext): string {
  return `I've opened the claim. Your claim number is ${CLAIM_REFERENCE}. An adjuster will be assigned and will call ${firstName(ctx)} within one business day.`;
}

interface ClaimBranch {
  /** Live note once the rep acts on the choice. */
  note: string;
  /** What the agent says when the user chose this option. */
  agentLine: (ctx: CallContext) => string;
  /** What the agent says when this option applied because nobody answered. */
  agentLineByDefault?: (ctx: CallContext) => string;
  supportLine: (ctx: CallContext) => string;
  /** The repair shop, as the agent's read-back states it. */
  shopReadBack: (ctx: CallContext) => string;
  nextAction: string;
}

const PHOTOS_BEFORE_ADJUSTER = `Upload the damage and plate photos to claim ${CLAIM_REFERENCE} before the adjuster calls within one business day`;

const CLAIM_BRANCHES: Record<string, ClaimBranch> = {
  accept: {
    note: "The rep booked a direct repair shop near your home. The shop will call to schedule the repair.",
    agentLine: (ctx) => `${firstName(ctx)} would like one of your direct repair shops.`,
    supportLine: (ctx) =>
      `Great. I've assigned a direct repair shop near ${firstName(ctx)}'s home, and they'll call to schedule the repair.`,
    shopReadBack: () => "the repair at your direct repair shop",
    nextAction: `${PHOTOS_BEFORE_ADJUSTER}; the direct repair shop will call to schedule the repair`,
  },
  own_shop: {
    note: "You will choose the repair shop. It sends its estimate to the adjuster.",
    agentLine: (ctx) => `${firstName(ctx)} will choose a repair shop.`,
    supportLine: () => "That's fine. Once a shop is chosen, have them send their estimate to the adjuster.",
    shopReadBack: (ctx) => `${firstName(ctx)}'s own shop sending its estimate to the adjuster`,
    nextAction: `${PHOTOS_BEFORE_ADJUSTER}; have your shop send its estimate to the adjuster`,
  },
  decide_later: {
    note: "The shop choice waits for the adjuster's call.",
    agentLine: (ctx) => `${firstName(ctx)} would like to decide on the shop with the adjuster.`,
    agentLineByDefault: (ctx) =>
      `I couldn't reach ${firstName(ctx)} in time, so ${firstName(ctx)} will decide on the shop with the adjuster.`,
    supportLine: () => "No problem. The adjuster can set up the shop on that call.",
    shopReadBack: () => "the shop chosen on the adjuster's call",
    nextAction: `${PHOTOS_BEFORE_ADJUSTER}; choose the repair shop on that call`,
  },
};

function claimBranch(resolution: Resolution | null): ClaimBranch {
  const branch = CLAIM_BRANCHES[resolution?.optionId ?? SHOP_DEFAULT] ?? CLAIM_BRANCHES[SHOP_DEFAULT];
  if (branch === undefined) throw new Error("The repair shop decision has no default branch.");
  return branch;
}

function afterDecision(branch: ClaimBranch, ctx: CallContext, resolution: Resolution): ScriptStep[] {
  return withTurns(
    [
      { at: 48_000, note: branch.note },
      { at: 52_000, note: "Rental covered at $40 a day for up to 30 days." },
      { at: 56_500, note: "The $500 deductible may be waived once the other driver's insurer accepts liability." },
      { at: 70_500, note: `Read back claim ${CLAIM_REFERENCE} and the next steps. The rep confirmed.` },
      { at: 75_500, phase: "ended", note: "Call ended." },
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
  const insurer = insurerName(ctx);
  const first = firstName(ctx);
  return [
    {
      at: 3_000,
      speaker: "support",
      text: `Thank you for calling ${insurer} claims. To report a new claim, press 1. For an existing claim, press 2.`,
    },
    { at: 7_000, speaker: "support", text: "This is the automated claims assistant. Please enter the policy number, then press pound." },
    { at: 9_500, speaker: "support", text: "Thank you. Please hold for the next available claims representative." },
    { at: 15_500, speaker: "support", text: `${insurer} claims, this is Dana. Who am I speaking with?` },
    {
      at: 17_500,
      speaker: "agent",
      text: `Hi Dana. I'm an AI assistant calling on behalf of ${ctx.customerName} to report an accident.`,
    },
    {
      at: 21_000,
      speaker: "support",
      text: "Okay. I see the policy number you entered. Can you confirm the named insured and the vehicle?",
    },
    { at: 23_500, speaker: "agent", text: `${ctx.customerName}, policy ending ${POLICY_ENDING}, for a ${VEHICLE}.` },
    { at: 26_500, speaker: "support", text: "Thank you, that matches. What happened?" },
    {
      at: 29_000,
      speaker: "agent",
      text: `Yesterday, October 10, in San Francisco, a silver sedan rear-ended the car while it was stopped in traffic. The rear bumper and trunk are damaged. The sedan's California plate is ${OTHER_PLATE}.`,
    },
    {
      at: 33_500,
      speaker: "support",
      text: `I'm sorry to hear that. Plate ${OTHER_PLATE}, got it. Was anyone injured, and are there photos?`,
    },
    {
      at: 35_500,
      speaker: "agent",
      text: `No one was injured. ${first} photographed the damage and the other car's plate, and the photos are on file. ${first} was not at fault.`,
    },
    { at: 39_500, speaker: "support", text: claimQuote(ctx) },
    {
      at: 43_000,
      speaker: "support",
      text: `For the repair, we can book one of our direct repair shops near ${first}'s home, guaranteed for as long as they own the car, or they can choose any shop. Which would they prefer?`,
    },
    { at: DECISION_AT, speaker: "agent", text: `One moment while I check with ${first}.` },
    { at: DECISION_AT + 500, speaker: "agent", text: agentLine },
    { at: 48_000, speaker: "support", text: branch.supportLine(ctx) },
    {
      at: 52_000,
      speaker: "support",
      text: `${first}'s policy has rental reimbursement at $40 a day, for up to 30 days while the car is being repaired.`,
    },
    {
      at: 56_500,
      speaker: "support",
      text: `And since the other driver hit ${first} from behind, we'll pursue their insurer. Once they accept liability, the $500 collision deductible may be waived.`,
    },
    { at: 61_500, speaker: "support", text: `I'm also texting ${first} a link to upload the photos to the claim.` },
    {
      at: 64_000,
      speaker: "agent",
      text: `To confirm: claim ${CLAIM_REFERENCE}, an adjuster call within one business day, ${branch.shopReadBack(ctx)}, and rental at $40 a day. The $500 deductible may be waived once the other insurer accepts liability.`,
    },
    {
      at: 70_500,
      speaker: "support",
      text: `That's all correct. I'm glad no one was hurt. Thank you for calling ${insurer}.`,
    },
    { at: 73_500, speaker: "agent", text: "Thank you, Dana. Goodbye." },
  ];
}

export const insuranceClaimCall: Conversation = {
  plan: (ctx) => [
    { id: "reach", title: `Reach ${insurerName(ctx)} claims`, detail: "Phone menu, then hold for a claims rep." },
    { id: "verify", title: "Verify the policy", detail: `${ctx.customerName}, policy ending ${POLICY_ENDING}, from the declarations page.` },
    { id: "report", title: "Report the loss", detail: `Oct 10 rear-end, plate ${OTHER_PLATE}, photos on file, no injuries.` },
    { id: "claim", title: "Get a claim number and adjuster", detail: "A claim number now, an adjuster within one business day." },
    { id: "next", title: "Confirm next steps", detail: "Repair shop, rental car and the deductible." },
  ],
  turns: claimTurns,
  script: (ctx) => ({
    steps: withTurns(
      [
        { at: 0, phase: "dialing", step: "reach", note: `Dialing ${ctx.merchantName}.` },
        { at: 1_000, phase: "ringing" },
        { at: 2_500, phase: "navigating_menu", note: "The phone menu answered." },
        { at: 5_500, note: "Pressed 1 to report a new claim." },
        {
          at: 6_500,
          phase: "talking",
          counterpart: { who: "agent", confidence: 0.9 },
          note: "Automated claims assistant answered. Switching to concise mode.",
        },
        { at: 9_000, note: "Keyed in the policy number from your declarations page." },
        { at: 10_500, phase: "on_hold", note: "On hold for a claims representative." },
        {
          at: 15_000,
          phase: "talking",
          step: "verify",
          counterpart: { who: "human", confidence: 0.85 },
          note: "A claims representative answered. Back to a conversational tone.",
        },
        { at: 26_500, step: "report", note: `Policy ending ${POLICY_ENDING} verified.` },
        {
          at: 37_500,
          note: `Reported the October 10 rear-end collision: plate ${OTHER_PLATE}, photos on file, no injuries.`,
        },
        { at: 39_500, step: "claim", note: `Claim ${CLAIM_REFERENCE} opened. An adjuster will call within one business day.` },
        { at: 43_000, step: "next" },
        { at: DECISION_AT, note: `${insurerName(ctx)} offered a direct repair shop. Asking you.` },
      ],
      claimTurns(ctx, null).filter((t) => t.at <= DECISION_AT),
    ),
    gate: {
      at: DECISION_AT,
      question: shopQuestion(ctx),
      options: shopOptions(ctx),
      defaultOptionId: SHOP_DEFAULT,
      timeoutMs: DECISION_TIMEOUT_MS,
      after: afterDecisions(ctx, "user"),
      afterByDefault: afterDecisions(ctx, "default"),
    },
  }),
  transcript: (ctx, resolution) => transcriptFromTurns(claimTurns(ctx, resolution)),
  // Opening a claim is a request, not a decision on it; nothing is paid yet.
  outcome: (ctx, resolution) => ({
    decision: "requested",
    referenceNumber: CLAIM_REFERENCE,
    nextAction: claimBranch(resolution).nextAction,
    paymentStatus: "unverified",
    supportingQuote: claimQuote(ctx),
  }),
};
