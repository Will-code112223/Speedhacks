/**
 * Every claim on the landing page, in one place. Each one must stay true of the product:
 * the demo case is simulated, and the footer says so.
 */

export const HEADLINE_LEAD = "Get your money back from";

/** The cycle shown in the headline's rolling slot; the first one is the resting state. */
export const ROLLING_WORDS = [
  "duplicate charges",
  "denied claims",
  "subscription traps",
  "cancelled bookings",
  "overbilling",
] as const;

/** The headline as a sentence, with the first rolling word. */
export const HEADLINE = `${HEADLINE_LEAD} ${ROLLING_WORDS[0]}.`;

export const EXPLANATION = [
  "Recourse is an AI agent that phones the merchant or insurer and gets your money back.",
  "You approve before anything is dialed, you can step in at any time, and every outcome comes with a transcript.",
] as const;

export interface BandRow {
  /** Graphite part of the sentence, including its trailing space. */
  lead: string;
  /** Cobalt part that ends the sentence. */
  accent: string;
  /** Percent of one copy per second; the sign sets the resting direction. */
  velocity: number;
}

export const BAND_ROWS: readonly BandRow[] = [
  { lead: "You approve. ", accent: "Recourse makes the call.", velocity: 5 },
  { lead: "Step in at any time. Every outcome ", accent: "keeps its transcript.", velocity: -5 },
];

export const bandSentence = (row: BandRow): string => `${row.lead}${row.accent}`;

export const STEPS = [
  { title: "Review the facts", body: "Check the details and evidence." },
  { title: "Approve the call", body: "Nothing is dialed until you approve." },
  { title: "Recourse makes the call", body: "Listen in or step in. The outcome and transcript are kept." },
] as const;

export const PROOF = {
  lead: "Simulated outcome: Approved,",
  amount: "$49.99",
  tail: "refund, reference and transcript kept with the case.",
} as const;

export const FOOTER = "Built at SpeedHacks, San Francisco, October 11, 2026. Demo calls are simulated.";
