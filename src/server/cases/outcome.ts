import type { CaseOutcome } from "@/contracts/case";
import { formatAmount } from "@/server/cases/facts";

/**
 * Deterministic transcript analysis. Rules:
 *  - only the support side can approve, deny or ask for information; lines
 *    spoken by our agent or the customer are ignored when speakers are labeled;
 *  - speaker attribution continues across line breaks; questions never establish
 *    a decision, and conditionals, quoted claims and negated statements never
 *    count as approval; a later decisive statement overrides an earlier one;
 *  - approval needs an explicit refund statement; paymentStatus stays
 *    "unverified" because a transcript is not payment evidence.
 */
const NON_SUPPORT_SPEAKERS = new Set(["agent", "ai", "ai assistant", "assistant", "bot", "caller", "customer", "me", "you"]);
// Dial's "user" is the remote party; "agent" is our outbound assistant.
const SUPPORT_SPEAKERS = new Set(["user", "support", "support agent", "representative", "rep", "merchant", "merchant support", "customer service", "customer support", "operator", "transfer_target"]);
const REFUND_CONTEXT = /\b(refund|refunded|credit|credited|reimburse(?:d|ment)?|charge|request|dispute|money back)\b/i;
const NEGATION = /\b(not|no|never|cannot|can't|can not|won't|will not|unable|isn't|wasn't|hasn't|haven't|aren't|don't|doesn't|didn't|n't)\b/i;
const CONDITIONAL = /\b(if|once|assuming|should|unless|provided that|in case)\b/i;
const APPROVAL_VERB = /\b(issued|processed|approved|approve|posted|refunded|credited|reimbursed|on its way|going back|put through|went through|will see .* refund|you'll see .* refund)\b/i;
const UNDECIDED = /\b(review|reviewing|pending|escalat\w*|submitted|forwarded|look into|looking into|investigat\w*)\b/i;
const OFFER = /\b(offer(?:ed|ing)?|propos(?:al|ed)|would be willing|can (?:give|issue|provide|process))\b/i;
const LIMITED_REFUND = /\b(partial(?:ly)?|portion|half|store credit|account credit|voucher|coupon|gift card|deduct(?:ion|ed|ible)?|minus|less|up to|at most|capped)\b|\d\s*%/i;
const AMOUNT_CONTINUATION = /^(?:(?:actually|correction|to clarify)[,:]?\s*)?(?:it(?:'s| is| will be)|that(?:'s| is| will be)|the (?:approved )?(?:amount|total|refund))\b/i;
const DENIAL_WORD = /\b(denied|deny|declined|decline|rejected|reject|not eligible|ineligible|non-?refundable|final sale|no refunds?|not approved|cannot|can't|can not|unable to|won't|will not|not able to)\b/i;
const NEEDS_INFO = /\b(call back|callback|call us back|need (?:you|the customer|the account holder) to|please (?:send|provide|submit|email|upload|fax)|(?:we|I)(?:['’]ll| will) need|order number|last four|verify|verification|proof of|through the (?:customer )?portal)\b/i;
const SENSITIVE_INFO = /\b(full (?:card|credit card|debit card) number|security code|cvv|cvc|password|one[- ]time (?:code|password))\b/i;
const REFERENCE_KEYWORD = /\b(?:reference|confirmation|ticket|case|claim)\b(?:\s*(?:number|no\.?|#|id))?\s*(?:is|:|-)?\s*(?:number\s*)?(?:is\s*)?([A-Za-z0-9][A-Za-z0-9-]{3,}\d[A-Za-z0-9-]*)/i;
const REFERENCE_TOKEN = /\b([A-Z]{2,6}-[A-Z0-9-]*\d[A-Z0-9-]*)\b/;

interface Sentence {
  speaker: string | null;
  text: string;
  support: boolean;
}

function splitSentences(transcript: string): Sentence[] {
  const out: Sentence[] = [];
  let currentSpeaker: string | null = null;
  for (const rawLine of transcript.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // Provider-injected instructions are metadata, not something support said.
    if (/^\[additional context\]:/i.test(line)) continue;
    const labeled = /^([A-Za-z][A-Za-z ()_-]{0,30}):\s*(.*)$/.exec(line);
    const candidateSpeaker = labeled?.[1]?.trim().toLowerCase();
    // A paragraph heading such as "Summary:" must not turn caller speech into
    // support speech. Only known role labels can change an established turn.
    const isSpeaker = candidateSpeaker !== undefined && (NON_SUPPORT_SPEAKERS.has(candidateSpeaker) || SUPPORT_SPEAKERS.has(candidateSpeaker));
    if (isSpeaker) currentSpeaker = candidateSpeaker;
    const speaker = currentSpeaker;
    const body = isSpeaker ? labeled![2]! : line;
    const support = speaker === null ? true : !NON_SUPPORT_SPEAKERS.has(speaker);
    for (const part of body.split(/(?<=[.?!])\s+/)) {
      const text = part.trim();
      if (text) out.push({ speaker, text, support });
    }
  }
  return out;
}

/** Remove quoted material so a repeated claim ("you wrote 'approved'") is not a statement. */
function stripQuotes(text: string): string {
  // Apostrophes inside possessives/contractions are not quote delimiters:
  // "the customer's account, I'll need ..." must keep the request intact.
  return text.replace(/"[^"]*"|“[^”]*”|(?<![\p{L}\p{N}])'[^']{3,}'(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])‘[^’]*’(?![\p{L}\p{N}])/gu, " ");
}

function isQuestion(text: string): boolean {
  const body = text.trim().replace(/^(?:(?:[-*•]|\d+[.)])\s*)+/, "");
  return /\?\s*$/.test(body) || /^(has|have|is|was|were|did|do|does|can|could|would|will|whether|who|what|which|when|where|why|how)\b/i.test(body)
    || /\b(?:ask(?:ed|ing)?|wonder(?:ed|ing)?|tell me|let me know|confirm|clarify|determine)\b[^.!?]*\b(?:whether|if)\b/i.test(body);
}

function findReference(sentences: Sentence[]): string | null {
  for (const s of sentences) {
    if (!s.support) continue;
    const body = stripQuotes(s.text);
    const k = REFERENCE_KEYWORD.exec(body);
    if (k?.[1]) return k[1].replace(/[.,;:]+$/, "").toUpperCase();
    const t = REFERENCE_TOKEN.exec(body);
    if (t?.[1]) return t[1].replace(/[.,;:]+$/, "").toUpperCase();
  }
  return null;
}

type RefundContext = { amountMinor: number; currency: string; merchantName: string };
type Decisive = { kind: "approved" | "denied" | "review"; quote: string };

/** Recognize explicit money conservatively; a charge amount is not proof of the refund amount. */
function amountNeedsReview(text: string, context: RefundContext): boolean {
  const markers = "USD|CAD|AUD|NZD|EUR|GBP|JPY|CHF|US\\$|CA\\$|C\\$|AU\\$|A\\$|NZ\\$|[$€£¥]";
  const money = new RegExp(`(${markers})\\s*(\\d[\\d,.]*)|(\\d[\\d,.]*)\\s*(${markers}|dollars?|cents?|euros?|pounds?)\\b`, "gi");
  const currencies: Record<string, string> = {
    "$": "USD", "US$": "USD", DOLLAR: "USD", DOLLARS: "USD", CENT: "USD", CENTS: "USD",
    "CA$": "CAD", "C$": "CAD", "AU$": "AUD", "A$": "AUD", "NZ$": "NZD",
    "€": "EUR", EURO: "EUR", EUROS: "EUR", "£": "GBP", POUND: "GBP", POUNDS: "GBP", "¥": "JPY",
  };
  let found = false;
  for (const match of text.matchAll(money)) {
    found = true;
    const marker = (match[1] ?? match[4] ?? "").toUpperCase();
    const currency = currencies[marker] ?? marker;
    const number = (match[2] ?? match[3] ?? "").replace(/[.,]$/, "");
    // Unsupported notation, fractions of a minor unit, or a different currency
    // needs review. Do not coerce those into the case's requested amount.
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(number) || currency !== context.currency || currency === "JPY") return true;
    const [whole = "", fraction = ""] = number.replaceAll(",", "").split(".");
    const cents = marker === "CENT" || marker === "CENTS";
    if (cents && fraction) return true;
    const minor = cents ? Number(whole) : Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    if (!Number.isSafeInteger(minor) || minor !== context.amountMinor) return true;
  }
  // Spelled-out amounts and unsupported notation remain unresolved rather than
  // being replaced with the requested amount. A bare approval has no amount proof.
  return !found && /[$€£¥]|\b(?:USD|CAD|AUD|NZD|EUR|GBP|JPY|CHF|dollars?|cents?|euros?|pounds?)\b/i.test(text);
}

function classify(s: Sentence, context: RefundContext): Decisive | "needs_info" | null {
  if (!s.support) return null;
  const body = stripQuotes(s.text);
  const refund = REFUND_CONTEXT.test(body);
  if (isQuestion(body)) return refund && OFFER.test(body) ? { kind: "review", quote: s.text } : null;
  if (refund && DENIAL_WORD.test(body)) {
    // "cannot hear you" has no refund context and never reaches here.
    return { kind: "denied", quote: s.text };
  }
  if (refund && APPROVAL_VERB.test(body) && !NEGATION.test(body) && !CONDITIONAL.test(body) && !UNDECIDED.test(body)) {
    return { kind: OFFER.test(body) || LIMITED_REFUND.test(body) || amountNeedsReview(body, context) ? "review" : "approved", quote: s.text };
  }
  if (refund && (OFFER.test(body) || LIMITED_REFUND.test(body))) return { kind: "review", quote: s.text };
  if (NEEDS_INFO.test(body)) return "needs_info";
  return null;
}

export function analyzeTranscript(
  transcript: string | null,
  context: RefundContext,
): CaseOutcome {
  const amount = formatAmount(context.amountMinor, context.currency);
  const base = { referenceNumber: null as string | null, paymentStatus: "unverified" as const, supportingQuote: null as string | null };
  if (!transcript || transcript.trim().length === 0) {
    return {
      ...base,
      decision: "unknown",
      nextAction: `No transcript was available. Contact ${context.merchantName} support again with the refund packet, or dispute the ${amount} charge with your card issuer.`,
    };
  }

  const sentences = splitSentences(transcript);
  const referenceNumber = findReference(sentences);
  let decisive: Decisive | null = null;
  let needsInfo: string | null = null;
  for (const s of sentences) {
    const c = classify(s, context);
    if (c === null) {
      // A representative can qualify an approval in a following sentence:
      // "The refund is approved. It will be $25." Keep that limitation.
      const body = stripQuotes(s.text);
      if (decisive?.kind === "approved" && s.support && !isQuestion(body) && AMOUNT_CONTINUATION.test(body)
        && (LIMITED_REFUND.test(body) || amountNeedsReview(body, context))) {
        decisive = { kind: "review", quote: s.text };
      }
      continue;
    }
    if (c === "needs_info") needsInfo ??= s.text;
    else decisive = c; // the latest decisive statement wins (handles corrections)
  }

  if (decisive?.kind === "approved") {
    return {
      ...base,
      decision: "approved",
      referenceNumber,
      supportingQuote: decisive.quote,
      nextAction: `${context.merchantName} stated that a refund was approved. Confirm the approved amount and timing, and verify the payment on your statement. Keep ${
        referenceNumber ? `reference ${referenceNumber}` : "the transcript"
      }.`,
    };
  }
  if (decisive?.kind === "review") {
    return {
      ...base,
      decision: "needs_information",
      referenceNumber,
      supportingQuote: decisive.quote,
      nextAction: "Support described an offer, limited refund, or an amount that needs review. Confirm the exact refund amount, currency, and terms before deciding how to proceed. The full requested amount and receipt of payment have not been verified.",
    };
  }
  if (decisive?.kind === "denied") {
    return {
      ...base,
      decision: "denied",
      referenceNumber,
      supportingQuote: decisive.quote,
      nextAction: `${context.merchantName} declined on the call. Dispute the ${amount} charge with your card issuer and attach the refund packet and transcript.`,
    };
  }
  if (needsInfo) {
    return {
      ...base,
      decision: "needs_information",
      referenceNumber,
      supportingQuote: needsInfo,
      nextAction: SENSITIVE_INFO.test(needsInfo)
        ? "Support requested sensitive payment or authentication details; no refund decision was established. Do not share full card numbers, security codes, passwords, or one-time codes in this workflow. Verify the provider and use its official secure process if further verification is needed."
        : "Support asked for more information. Review the request and use the provider's official secure process for any necessary verification, then re-authorize a follow-up call or send the refund packet by email.",
    };
  }
  return {
    ...base,
    decision: "requested",
    referenceNumber,
    nextAction: `The refund was requested but ${context.merchantName} did not state a decision on the call. Follow up in 2 business days${
      referenceNumber ? ` citing reference ${referenceNumber}` : ""
    }, or send the refund packet by email.`,
  };
}

export function unknownOutcome(reason: string): CaseOutcome {
  return {
    decision: "unknown",
    referenceNumber: null,
    nextAction: `${reason} Review the transcript manually and follow up with support or your card issuer.`,
    paymentStatus: "unverified",
    supportingQuote: null,
  };
}
