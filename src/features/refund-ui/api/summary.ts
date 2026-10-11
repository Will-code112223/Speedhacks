/**
 * The transcript and short summary sent after a call (V2 proposal). Pure:
 * both clients compose with these helpers, so the fixture, the http path and
 * the card agree on every line. Contract words are shown as written.
 */

import type { CallV1, CaseV1 } from "../../../contracts/case";
import { formatDuration, formatMoney, secondsBetween, statusWord } from "../ui/format";
import type { SummaryChannel, SummaryDelivery, SummaryDestination } from "./types";

export const TRANSCRIPT_PENDING = "Transcript not available yet.";
export const CALL_NOT_COMPLETE_MESSAGE = "The call has not finished yet.";
export const DESTINATION_MESSAGE = "Enter an email address or a mobile number";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Separators people type inside a phone number. */
const PHONE_SEPARATORS = /[\s\-.()]/g;

const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

/** "jordan@example.com" is email; "+1 (415) 555-0123" is a text message. The number is kept as typed. */
export function inferDestination(text: string): SummaryDestination | null {
  const to = text.trim();
  if (to === "") return null;
  if (EMAIL.test(to)) return { channel: "email", to };
  const digits = to.replace(PHONE_SEPARATORS, "").replace(/^\+/, "");
  if (/^\d{10,15}$/.test(digits)) return { channel: "sms", to };
  return null;
}

/** Whether `to` is a valid address for its channel. */
export function isValidDestination(destination: SummaryDestination): boolean {
  if (typeof destination?.to !== "string") return false;
  return inferDestination(destination.to)?.channel === destination.channel;
}

/** How the card and the timeline name a channel. */
export function channelLabel(channel: SummaryChannel): string {
  return channel === "email" ? "email" : "text message";
}

/** The newest call on the case when it finished with a transcript; anything else is not ready to send. */
export function completedCallFor(caseData: CaseV1): CallV1 | null {
  let newest: CallV1 | null = null;
  for (const call of caseData.calls) if (!newest || call.createdAt > newest.createdAt) newest = call;
  return newest && newest.state === "completed" && newest.transcript !== null ? newest : null;
}

export function composeSummary(caseData: CaseV1, call: CallV1, destination: SummaryDestination): SummaryDelivery {
  const { decision, referenceNumber, nextAction, paymentStatus, supportingQuote } = caseData.outcome;
  const merchant = caseData.merchant.name ?? "the merchant";
  const word = statusWord(decision);
  const amount = decision === "approved" ? formatMoney(caseData.amountMinor, caseData.currency) : null;

  const lines = [`Support decision: ${word}`];
  if (amount !== null) {
    // Only repeat where the money goes when support said so on the call.
    const said = `${supportingQuote ?? ""}\n${call.transcript ?? ""}`.toLowerCase();
    const where = said.includes("original card") ? " to the original card" : "";
    lines.push(`Refund of ${amount}${where}${referenceNumber ? `, reference ${referenceNumber}` : ""}`);
  } else if (referenceNumber) {
    lines.push(`Reference ${referenceNumber}`);
  }
  lines.push(`Payment: ${paymentStatus}`);
  if (nextAction) lines.push(`Next step: ${nextAction}`);
  const seconds = secondsBetween(call.createdAt, call.updatedAt, Date.parse(call.updatedAt));
  const day = Number.isNaN(Date.parse(call.createdAt)) ? "" : ` on ${dateFormat.format(new Date(call.createdAt))}`;
  lines.push(`Call with ${merchant} lasted ${formatDuration(seconds)}${day}`);

  const headline = amount ?? referenceNumber;
  return {
    channel: destination.channel,
    to: destination.to.trim(),
    subject: destination.channel === "email" ? `Recourse: ${merchant} - ${word}${headline ? ` ${headline}` : ""}` : null,
    summary: lines,
    transcript: call.transcript ?? TRANSCRIPT_PENDING,
    sentAt: null,
  };
}

/** The message as plain text: summary lines, a blank line, the transcript. */
export function messageBody(delivery: SummaryDelivery): string {
  return [...delivery.summary, "", delivery.transcript].join("\n");
}

/** Opens the composed message in the person's own Mail or Messages app. */
export function messageUrl(delivery: SummaryDelivery): string {
  const body = messageBody(delivery);
  if (delivery.channel === "email") {
    const to = encodeURIComponent(delivery.to).replace(/%40/g, "@");
    const crlf = (value: string) => encodeURIComponent(value.replace(/\r?\n/g, "\r\n"));
    return `mailto:${to}?subject=${crlf(delivery.subject ?? "")}&body=${crlf(body)}`;
  }
  const plus = delivery.to.trim().startsWith("+") ? "+" : "";
  const number = `${plus}${delivery.to.replace(/\D/g, "")}`;
  return `sms:${encodeURIComponent(number)}?&body=${encodeURIComponent(body)}`;
}
