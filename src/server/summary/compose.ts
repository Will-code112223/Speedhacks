import type { CaseOutcome } from "@/contracts/case";
import { formatAmount } from "@/server/cases/facts";
import type { CaseDoc } from "@/server/persistence/repository";

/**
 * Pure helpers for the post-call summary (POST /api/cases/:id/summary).
 * The lines come from the stored outcome analysis (src/server/cases/outcome.ts),
 * never from a second reading of the transcript, so the summary cannot disagree
 * with the decision shown in the app.
 */

export type SummaryChannel = "email" | "sms";

/** The wire shape the frontend renders (src/features/refund-ui/api/types.ts SummaryDelivery). */
export interface SummaryDelivery {
  channel: SummaryChannel;
  to: string;
  subject: string | null;
  summary: string[];
  transcript: string;
  sentAt: string | null;
}

export type SummaryCaseDoc = Pick<CaseDoc, "merchant" | "amountMinor" | "currency" | "outcome" | "timeline">;

export interface SummaryCall {
  id?: string;
  transcript: string | null;
  createdAt: string;
  updatedAt: string;
  /** Provider-reported length when known; otherwise read from the call_completed timeline entry. */
  durationSeconds?: number | null;
}

export const SMS_BODY_LIMIT = 1500;
export const SMS_CUT_NOTICE = "(The full transcript is in the app.)";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Separators people type inside a phone number. */
const PHONE_SEPARATORS = /[\s\-.()]/g;

export function isEmail(to: string): boolean {
  return EMAIL.test(to.trim());
}

/**
 * E.164 for a typed mobile number, or null when it is not 10 to 15 digits after
 * removing spaces, dashes, dots, parentheses and a leading +.
 * 10 digits is a North American number (+1); 11 digits starting with 1 is the
 * same with the country code; anything else of 11 to 15 digits is taken as an
 * international number with its country code.
 */
export function normalizeSmsNumber(to: string): string | null {
  const stripped = to.trim().replace(PHONE_SEPARATORS, "");
  const plus = stripped.startsWith("+");
  const digits = plus ? stripped.slice(1) : stripped;
  if (!/^\d{10,15}$/.test(digits)) return null;
  if (plus) return digits.startsWith("0") ? null : `+${digits}`;
  if (digits.length === 10) return digits.startsWith("0") || digits.startsWith("1") ? null : `+1${digits}`;
  return digits.startsWith("0") ? null : `+${digits}`;
}

/** "+14155550199" -> "+1 415 555 ••99"; other numbers keep their prefix and last two digits. */
export function maskPhone(e164: string): string {
  const d = e164.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return `+1 ${d.slice(1, 4)} ${d.slice(4, 7)} ••${d.slice(-2)}`;
  return `+${d.slice(0, -4)} ••${d.slice(-2)}`;
}

/** "sam@example.com" -> "s••@example.com". */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.trim().split("@");
  return `${local.slice(0, 1)}••@${domain}`;
}

export function maskDestination(channel: SummaryChannel, to: string): string {
  return channel === "sms" ? maskPhone(to) : maskEmail(to);
}

export function channelLabel(channel: SummaryChannel): string {
  return channel === "sms" ? "text message" : "email";
}

function counterparty(doc: Pick<CaseDoc, "merchant">): string {
  return doc.merchant.name?.trim() || "support";
}

export function caseTitleFor(doc: Pick<CaseDoc, "merchant">): string {
  return `your call with ${counterparty(doc)}`;
}

export function subjectFor(doc: Pick<CaseDoc, "merchant">): string {
  return `Recourse: ${caseTitleFor(doc)}`;
}

/** The newest call_completed entry carries the provider-reported length: "Call completed (65s, via poll)." */
function durationFromTimeline(timeline: CaseDoc["timeline"]): number | null {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const entry = timeline[i];
    if (entry?.type !== "call_completed") continue;
    const m = /\((\d+)s\b/.exec(entry.message);
    return m?.[1] ? Number.parseInt(m[1], 10) : null;
  }
  return null;
}

export function callSeconds(doc: Pick<CaseDoc, "timeline">, call: SummaryCall): number | null {
  if (typeof call.durationSeconds === "number" && Number.isFinite(call.durationSeconds)) return Math.max(0, Math.round(call.durationSeconds));
  const fromTimeline = durationFromTimeline(doc.timeline);
  if (fromTimeline !== null) return fromTimeline;
  const ms = Date.parse(call.updatedAt) - Date.parse(call.createdAt);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 1000) : null;
}

/** 65 -> "1 minute 5 seconds"; 6 -> "6 seconds". */
export function formatCallLength(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (m === 0) return unit(s, "second");
  return s === 0 ? unit(m, "minute") : `${unit(m, "minute")} ${unit(s, "second")}`;
}

function outcomeLine(outcome: CaseOutcome, who: string, amount: string): string {
  switch (outcome.decision) {
    case "approved":
      return `${who} approved the ${amount} refund on the call.`;
    case "denied":
      return `${who} declined the ${amount} refund on the call.`;
    case "needs_information":
      return `${who} needs more information before deciding on the ${amount} refund.`;
    case "requested":
      return `The ${amount} refund was requested, but ${who} did not state a decision.`;
    default:
      return `The outcome of the call about the ${amount} refund is unknown.`;
  }
}

/**
 * 3 to 5 short sentence-case lines: the outcome and amount, the reference number
 * when present, payment status, the next action, and the call length.
 * `outcome` defaults to the stored case outcome.
 */
export function composeSummaryLines(doc: SummaryCaseDoc, call: SummaryCall, outcome: CaseOutcome = doc.outcome): string[] {
  const who = counterparty(doc);
  const amount = doc.amountMinor === null ? "requested" : formatAmount(doc.amountMinor, doc.currency);
  const lines = [outcomeLine(outcome, who, amount)];
  if (outcome.referenceNumber) lines.push(`Reference number: ${outcome.referenceNumber}.`);
  if (outcome.nextAction) lines.push(`Next step: ${outcome.nextAction}`);
  // The payment line is stated when confirmed, or to keep at least three lines;
  // otherwise the next step already says to check the statement.
  if (outcome.paymentStatus === "confirmed") lines.push("The refund payment has been confirmed.");
  else if (lines.length < 2) lines.push("The refund payment has not been verified yet; check your statement.");
  const seconds = callSeconds(doc, call);
  lines.push(seconds === null ? `The call with ${who} has ended.` : `The call with ${who} lasted ${formatCallLength(seconds)}.`);
  return lines.slice(0, 5);
}

/**
 * The text that is sent. SMS: header, lines, a blank line, "Transcript:" and the
 * transcript, cut at a line boundary so the whole body (including the notice
 * line) stays within 1500 characters. Email: the full text.
 */
export function messageBody(input: { lines: string[]; transcript: string; channel: SummaryChannel; caseTitle: string }): string {
  const head = [`Recourse summary: ${input.caseTitle}`, ...input.lines, "", "Transcript:"];
  const transcriptLines = input.transcript.split(/\r?\n/);
  const full = [...head, ...transcriptLines].join("\n");
  if (input.channel === "email" || full.length <= SMS_BODY_LIMIT) return full;

  const budget = SMS_BODY_LIMIT - SMS_CUT_NOTICE.length - 1; // newline before the notice
  const kept: string[] = [];
  let length = -1; // first join adds no newline
  for (const line of [...head, ...transcriptLines]) {
    if (length + 1 + line.length > budget) break;
    kept.push(line);
    length += 1 + line.length;
  }
  return [...kept, SMS_CUT_NOTICE].join("\n");
}

/** User-facing strings never carry an em dash. */
export function plainDashes(text: string): string {
  return text.replace(/[\u2014\u2013]/g, "-");
}
