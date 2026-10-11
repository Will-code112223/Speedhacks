import type { CaseOutcome } from "@/contracts/case";
import { formatAmount } from "@/server/cases/facts";

/**
 * Deterministic transcript analysis. Rules:
 *  - only the support side can approve, deny or ask for information; lines
 *    spoken by our agent or the customer are ignored when speakers are labeled;
 *  - questions, conditionals, quoted claims and negated statements never count
 *    as approval; a later decisive statement overrides an earlier one;
 *  - approval needs an explicit refund statement; paymentStatus stays
 *    "unverified" because a transcript is not payment evidence.
 */
const NON_SUPPORT_SPEAKERS = new Set(["agent", "ai", "ai assistant", "assistant", "bot", "caller", "customer", "me", "you"]);
const REFUND_CONTEXT = /\b(refund|refunded|credit|credited|reimburse(?:d|ment)?|charge|request|dispute|money back)\b/i;
const NEGATION = /\b(not|no|never|cannot|can't|can not|won't|will not|unable|isn't|wasn't|hasn't|haven't|aren't|don't|doesn't|didn't|n't)\b/i;
const CONDITIONAL = /\b(if|once|assuming|should|unless|provided that|in case)\b/i;
const APPROVAL_VERB = /\b(issued|processed|approved|approve|posted|refunded|credited|reimbursed|on its way|going back|put through|went through|will see .* refund|you'll see .* refund)\b/i;
const UNDECIDED = /\b(review|reviewing|pending|escalat\w*|submitted|forwarded|look into|looking into|investigat\w*)\b/i;
const DENIAL_WORD = /\b(denied|deny|declined|decline|rejected|reject|not eligible|ineligible|non-?refundable|final sale|no refunds?|not approved|cannot|can't|can not|unable to|won't|will not|not able to)\b/i;
const NEEDS_INFO = /\b(call back|callback|call us back|need (?:you|the customer|the account holder) to|please (?:send|provide|submit|email|upload|fax)|we(?:'ll| will) need|order number|last four|verify|verification|proof of|through the (?:customer )?portal)\b/i;
const REFERENCE_KEYWORD = /\b(?:reference|confirmation|ticket|case|claim)\b(?:\s*(?:number|no\.?|#|id))?\s*(?:is|:|-)?\s*(?:number\s*)?(?:is\s*)?([A-Za-z0-9][A-Za-z0-9-]{3,}\d[A-Za-z0-9-]*)/i;
const REFERENCE_TOKEN = /\b([A-Z]{2,6}-[A-Z0-9-]*\d[A-Z0-9-]*)\b/;

interface Sentence {
  speaker: string | null;
  text: string;
  support: boolean;
}

function splitSentences(transcript: string): Sentence[] {
  const out: Sentence[] = [];
  for (const rawLine of transcript.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const labeled = /^([A-Za-z][A-Za-z ()_-]{0,30}):\s*(.*)$/.exec(line);
    const speaker = labeled?.[1]?.trim().toLowerCase() ?? null;
    const body = labeled?.[2] ?? line;
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
  return text.replace(/"[^"]*"|“[^”]*”|'[^']{3,}'|‘[^’]*’/g, " ");
}

function isQuestion(text: string): boolean {
  return /\?\s*$/.test(text) || /^(has|have|is|was|were|did|do|does|can|could|would|will)\b/i.test(text.trim());
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

type Decisive = { kind: "approved" | "denied"; quote: string };

function classify(s: Sentence): Decisive | "needs_info" | null {
  if (!s.support) return null;
  const body = stripQuotes(s.text);
  if (isQuestion(body)) return null;
  const refund = REFUND_CONTEXT.test(body);
  if (refund && DENIAL_WORD.test(body)) {
    // "cannot hear you" has no refund context and never reaches here.
    return { kind: "denied", quote: s.text };
  }
  if (refund && APPROVAL_VERB.test(body) && !NEGATION.test(body) && !CONDITIONAL.test(body) && !UNDECIDED.test(body)) {
    return { kind: "approved", quote: s.text };
  }
  if (NEEDS_INFO.test(body)) return "needs_info";
  return null;
}

export function analyzeTranscript(
  transcript: string | null,
  context: { amountMinor: number | null; currency: string; merchantName: string },
): CaseOutcome {
  // An information-only authorization may have no amount: say "the charge", never "[amount missing]".
  const charge = context.amountMinor === null ? "charge" : `${formatAmount(context.amountMinor, context.currency)} charge`;
  const refund = context.amountMinor === null ? "refund" : `${formatAmount(context.amountMinor, context.currency)} refund`;
  const base = { referenceNumber: null as string | null, paymentStatus: "unverified" as const, supportingQuote: null as string | null };
  if (!transcript || transcript.trim().length === 0) {
    return {
      ...base,
      decision: "unknown",
      nextAction: `No transcript was available. Contact ${context.merchantName} support again with the refund packet, or dispute the ${charge} with your card issuer.`,
    };
  }

  const sentences = splitSentences(transcript);
  const referenceNumber = findReference(sentences);
  let decisive: Decisive | null = null;
  let needsInfo: string | null = null;
  for (const s of sentences) {
    const c = classify(s);
    if (c === null) continue;
    if (c === "needs_info") needsInfo ??= s.text;
    else decisive = c; // the latest decisive statement wins (handles corrections)
  }

  if (decisive?.kind === "approved") {
    return {
      ...base,
      decision: "approved",
      referenceNumber,
      supportingQuote: decisive.quote,
      nextAction: `Watch your statement for a ${refund} from ${context.merchantName}. Keep ${
        referenceNumber ? `reference ${referenceNumber}` : "the transcript"
      }; if it has not posted in 10 business days, follow up or dispute with your card issuer.`,
    };
  }
  if (decisive?.kind === "denied") {
    return {
      ...base,
      decision: "denied",
      referenceNumber,
      supportingQuote: decisive.quote,
      nextAction: `${context.merchantName} declined on the call. Dispute the ${charge} with your card issuer and attach the refund packet and transcript.`,
    };
  }
  if (needsInfo) {
    return {
      ...base,
      decision: "needs_information",
      referenceNumber,
      supportingQuote: needsInfo,
      nextAction: "Support asked for more information. Provide what was requested, then re-authorize a follow-up call or send the refund packet by email.",
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
