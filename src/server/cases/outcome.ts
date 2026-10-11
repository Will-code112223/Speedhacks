import type { CaseOutcome } from "@/contracts/case";
import type { CallPurpose } from "@/contracts/voice";
import { formatAmount } from "@/server/cases/facts";

/**
 * Deterministic transcript analysis. Rules:
 *  - only the support side can approve, deny or ask for information; lines
 *    spoken by our agent or the customer are ignored when speakers are labeled;
 *  - questions, conditionals, quoted claims and negated statements never count
 *    as approval; a later decisive statement overrides an earlier one;
 *  - approval needs an explicit refund statement; paymentStatus stays
 *    "unverified" because a transcript is not payment evidence;
 *  - the call purpose picks the rules: a file_claim call is read for a claim
 *    being opened (never a refund), a gather_information call is summarized and
 *    never approved or denied;
 *  - recordings (voicemail, closed line, IVR errors, hold messages) are never a
 *    decision, and a call cut off at the time limit says plainly nothing was filed.
 */
const NON_SUPPORT_SPEAKERS = new Set(["agent", "ai", "ai assistant", "assistant", "bot", "caller", "customer", "me", "you"]);
const REFUND_CONTEXT = /\b(refund|refunded|credit|credited|reimburse(?:d|ment)?|charge|request|dispute|money back)\b/i;
const NEGATION = /\b(not|no|never|cannot|can't|can not|won't|will not|unable|isn't|wasn't|hasn't|haven't|aren't|don't|doesn't|didn't|n't)\b/i;
const CONDITIONAL = /\b(if|once|assuming|should|unless|provided that|in case)\b/i;
const APPROVAL_VERB = /\b(issued|processed|approved|approve|posted|refunded|credited|reimbursed|on its way|going back|put through|went through|will see .* refund|you'll see .* refund)\b/i;
const UNDECIDED = /\b(review|reviewing|pending|escalat\w*|submitted|forwarded|look into|looking into|investigat\w*)\b/i;
const OFFER = /\b(offer(?:ed|ing)?|propos(?:al|ed)|would be willing|can (?:give|issue|provide|process))\b/i;
const LIMITED_REFUND = /\b(partial(?:ly)?|portion|half|store credit|account credit|voucher|coupon|gift card|deduct(?:ion|ed|ible)?|minus|less|up to|at most|capped)\b|\d\s*%/i;
const AMOUNT_CONTINUATION = /^(?:(?:actually|correction|to clarify)[,:]?\s*)?(?:it(?:'s| is| will be)|that(?:'s| is| will be)|the (?:approved )?(?:amount|total|refund))\b/i;
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
    // "8 a.m. to 6 p.m." stays one sentence so a closed-line recording keeps its hours.
    for (const part of body.split(/(?<=[.?!])(?<!\b[ap]\.m\.)\s+/i)) {
      const text = part.trim();
      if (text) out.push({ speaker, text, support });
    }
  }
  return out;
}

/**
 * Remove quoted material so a repeated claim ("you wrote 'approved'") is not a statement.
 * Single quotes count only when bounded by a non-word character or a line edge on both
 * sides, so the apostrophes in "we're sorry, but we can't" are never read as quotes.
 */
function stripQuotes(text: string): string {
  return text.replace(/"[^"]*"|“[^”]*”|(?<![\p{L}\p{N}_])'(?:[^'\n]|(?<=\p{L})'(?=\p{L})){3,}?'(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])‘[^’\n]*’(?![\p{L}\p{N}_])/gu, " ");
}

function isQuestion(text: string): boolean {
  return /\?\s*$/.test(text) || /^(has|have|is|was|were|did|do|does|can|could|would|will)\b/i.test(text.trim());
}

/** Labels that name the number the caller must keep, strongest first in intent. */
const STRONG_REFERENCE = /\b(?:claim|reference|confirmation|case|ticket)\s*(?:number\b|no\.|#|id\b)[\s:#-]*(?:is|will be|would be)?[\s:#-]*(?:number\s*)?(.{1,60})/gi;
const POLICY_BEFORE = /\bpolicy(?:\s*(?:number|no\.?|#|id))?\s*(?:is\s*)?[:#-]?\s*$/i;

function normalizeReference(raw: string): string {
  return raw.replace(/[\s,]+/g, "").replace(/[.;:-]+$/, "").toUpperCase();
}

function sameReference(a: string, b: string | null | undefined): boolean {
  if (!b) return false;
  const clean = (v: string) => v.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return clean(a) !== "" && clean(a) === clean(b);
}

/**
 * Read the number right after a label: one token with a digit ("04-1234-5678",
 * "REF-12345"), or digits spoken in groups ("0 4 1 2 3 4 5 6 7 8") joined back up.
 */
function tokenAfterLabel(rest: string): string | null {
  const words = rest.trim().split(/\s+/);
  const first = words[0]?.replace(/[.,;:]+$/, "") ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(first) || !/\d/.test(first)) return null;
  let token = first;
  if (/^\d+$/.test(first)) {
    for (const word of words.slice(1)) {
      const group = word.replace(/[,]+$/, "");
      const digits = group.replace(/[.;:]+$/, "");
      if (!/^\d+(?:-\d+)*$/.test(digits)) break;
      token += digits;
      if (digits !== group) break; // a sentence-ending mark closes the number
    }
  }
  const normalized = normalizeReference(token);
  return normalized.replace(/[^A-Z0-9]/g, "").length >= 4 ? normalized : null;
}

/**
 * The reference the caller should keep. A number next to "claim number",
 * "reference number" or "confirmation number" wins over any other token (the
 * latest one, so a correction holds); the case's own policy number, or a token
 * introduced as a policy number, is never recorded as the reference.
 */
function findReference(sentences: Sentence[], policyNumber?: string | null): string | null {
  let strong: string | null = null;
  let weak: string | null = null;
  for (const s of sentences) {
    if (!s.support) continue;
    const body = stripQuotes(s.text);
    for (const m of body.matchAll(STRONG_REFERENCE)) {
      const token = m[1] ? tokenAfterLabel(m[1]) : null;
      if (token && !sameReference(token, policyNumber)) strong = token;
    }
    if (weak !== null) continue;
    const k = REFERENCE_KEYWORD.exec(body);
    const t = REFERENCE_TOKEN.exec(body);
    for (const [match, index] of [[k?.[1], k ? k.index + k[0].length - k[1]!.length : -1], [t?.[1], t?.index ?? -1]] as const) {
      if (!match) continue;
      const token = match.replace(/[.,;:]+$/, "").toUpperCase();
      if (sameReference(token, policyNumber) || POLICY_BEFORE.test(body.slice(0, index))) continue;
      weak = token;
      break;
    }
  }
  return strong ?? weak;
}

/** amountMinor is null for an information-only authorization; any explicit money mention then needs review. */
type RefundContext = { amountMinor: number | null; currency: string; merchantName: string };
/**
 * What the analysis may know about the call besides its words. All extras are optional:
 * policyNumber is the case's own policy (never recorded as the reference); durationSeconds
 * and maxCallDurationSeconds detect a call cut off at the time limit.
 */
export type TranscriptContext = RefundContext & {
  policyNumber?: string | null;
  durationSeconds?: number | null;
  maxCallDurationSeconds?: number | null;
};
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
    if (context.amountMinor === null || !Number.isSafeInteger(minor) || minor !== context.amountMinor) return true;
  }
  // Spelled-out amounts and unsupported notation remain unresolved rather than
  // being replaced with the requested amount. A bare approval has no amount proof.
  return !found && /[$€£¥]|\b(?:USD|CAD|AUD|NZD|EUR|GBP|JPY|CHF|dollars?|cents?|euros?|pounds?)\b/i.test(text);
}

function classify(s: Sentence, context: RefundContext): Decisive | "needs_info" | null {
  if (!s.support) return null;
  const body = stripQuotes(s.text);
  // A recording ("we cannot complete your request as dialed") is never a decision.
  if (recordingKind(body)) return null;
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

function analyzeRefund(transcript: string | null, context: TranscriptContext): CaseOutcome {
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
  const referenceNumber = findReference(sentences, context.policyNumber);
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
  const line = lineStatus(sentences, context);
  if (line) {
    return {
      ...base,
      decision: "unknown",
      referenceNumber,
      supportingQuote: line.quote,
      nextAction: `${line.kind === "cap" ? CUT_OFF : `${lineReason(line, context.merchantName)}; nothing was filed.`} ${
        context.merchantName
      } did not state a decision on the refund. Call again, or send the refund packet by email.`,
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

const VOICEMAIL = /\b(?:voice ?mail|leave (?:a|your) (?:message|name)|after the (?:tone|beep)|mailbox (?:is full|belonging)|record your message)\b/i;
const CLOSED = /\b(?:(?:office|offices|we|our (?:claims? )?(?:center|department|office|line)s?) (?:are|is) (?:currently |now )?closed|outside (?:of )?(?:our )?(?:normal |regular )?(?:business |office )?hours)\b/i;
const IVR_FAILURE = /\b(?:cannot|can't|could not|couldn't|unable to) (?:complete|connect) your (?:call|request)\b|\bcall (?:cannot|could not) be completed\b|\b(?:is )?(?:not|no longer) in service\b|\binvalid (?:selection|entry|option)\b|\bplease hang up and (?:try|dial) again\b/i;
const HOLD = /\b(?:please (?:hold|continue to hold|stay on the line)|on hold|next available (?:agent|representative|associate|specialist)|all (?:of )?our (?:agents|representatives|associates|specialists)|your call is (?:very )?important|estimated wait time|(?:answered|handled) in the order)\b/i;
const HOURS = /\b(?:(?:business |office )?hours are|(?:we are|we're) open|open (?:from|monday|weekdays|\d)|available (?:from|monday|weekdays)|(?:monday|mon) (?:through|to|-) (?:friday|fri|saturday|sat))\b/i;
const DOCUMENTS = /\b(?:need|needs|require[sd]?|send|provide|submit|upload|bring|include|fax|email)\b.*\b(?:documents?|photos?|pictures?|receipts?|estimates?|police report|proof of (?:loss|purchase|ownership)|forms?|invoices?|statements?|records?|cop(?:y|ies))\b/i;
const DEADLINE = /\b(?:within \d+ (?:business |calendar )?(?:days?|hours?|weeks?|months?)|deadline|no later than|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|the end of)|\d+ (?:business |calendar )?days? (?:from|of|after))\b/i;
const CLAIM_WORD = /\bclaims?\b/i;
const CLAIM_OPENED = /\b(?:opened|filed|created|started|set up|registered|logged|lodged|processed|entered|submitted)\b|\bclaim (?:is|has been) (?:open|active|on file)\b/i;
const CLAIM_REFUSED = /\b(?:won't|will not|cannot|can't|can not|unable to|not able to|not going to|aren't able to|do not|don't)\s+(?:be able to\s+)?(?:open|file|create|start|accept|take|process|register|log|lodge)\b.*\bclaims?\b|\bclaim (?:has been |was |is )?(?:denied|declined|rejected)\b/i;
const CUT_OFF = "The call was cut off at the time limit; nothing was filed.";
/** A provider can stop a few seconds either side of the configured cap. */
const CAP_TOLERANCE_SECONDS = 2;

type RecordingKind = "ivr" | "closed" | "voicemail" | "hold";
type LineStatus = { kind: RecordingKind | "cap"; quote: string | null; hours: string | null };

function recordingKind(body: string): RecordingKind | null {
  if (IVR_FAILURE.test(body)) return "ivr";
  if (CLOSED.test(body)) return "closed";
  if (VOICEMAIL.test(body)) return "voicemail";
  if (HOLD.test(body)) return "hold";
  return null;
}

function reachedCap(context: TranscriptContext): boolean {
  const { durationSeconds, maxCallDurationSeconds } = context;
  return typeof durationSeconds === "number" && typeof maxCallDurationSeconds === "number" && maxCallDurationSeconds > 0
    && durationSeconds >= maxCallDurationSeconds - CAP_TOLERANCE_SECONDS;
}

/**
 * Why the call produced nothing, when it did not reach anyone who could act:
 * cut off at the cap first, then an IVR error, a closed line, voicemail, or a
 * hold queue nobody answered (hold counts only when no one spoke after it).
 */
function lineStatus(sentences: Sentence[], context: TranscriptContext): LineStatus | null {
  const hours = sentences.find((s) => s.support && HOURS.test(stripQuotes(s.text)))?.text ?? null;
  const found: Partial<Record<RecordingKind, string>> = {};
  let afterHold = false;
  for (const s of sentences) {
    if (!s.support) continue;
    const kind = recordingKind(stripQuotes(s.text));
    if (kind) {
      found[kind] ??= s.text;
      if (kind === "hold") afterHold = false;
    } else if (found.hold && !(hours && s.text === hours)) {
      afterHold = true;
    }
  }
  if (reachedCap(context)) return { kind: "cap", quote: found.hold ?? null, hours };
  for (const kind of ["ivr", "closed", "voicemail"] as const) {
    if (found[kind]) return { kind, quote: found[kind]!, hours };
  }
  if (found.hold && !afterHold) return { kind: "hold", quote: found.hold, hours };
  return null;
}

function lineReason(line: LineStatus, org: string): string {
  switch (line.kind) {
    case "cap":
      return "The call was cut off at the time limit";
    case "ivr":
      return `${org}'s phone system could not complete the call`;
    case "closed":
      return `${org}'s line was closed`;
    case "voicemail":
      return "The call reached voicemail";
    case "hold":
      return "The call stayed on hold and never reached a representative";
  }
}

function strongReferenceIn(body: string, policyNumber?: string | null): string | null {
  let found: string | null = null;
  for (const m of body.matchAll(STRONG_REFERENCE)) {
    const token = m[1] ? tokenAfterLabel(m[1]) : null;
    if (token && !sameReference(token, policyNumber)) found = token;
  }
  return found;
}

function analyzeClaim(transcript: string | null, context: TranscriptContext): CaseOutcome {
  const insurer = context.merchantName;
  const base = { referenceNumber: null as string | null, paymentStatus: "unverified" as const, supportingQuote: null as string | null };
  if (!transcript || transcript.trim().length === 0) {
    return {
      ...base,
      decision: "unknown",
      nextAction: `No transcript was available, so no claim is on record. Call ${insurer} again to file the claim and ask for a claim number.`,
    };
  }
  const sentences = splitSentences(transcript);
  const referenceNumber = findReference(sentences, context.policyNumber);
  let decisive: { kind: "opened" | "refused"; quote: string } | null = null;
  let needsInfo: string | null = null;
  for (const s of sentences) {
    if (!s.support) continue;
    const body = stripQuotes(s.text);
    if (isQuestion(body) || recordingKind(body)) continue;
    if (CLAIM_WORD.test(body) && CLAIM_REFUSED.test(body)) {
      decisive = { kind: "refused", quote: s.text };
    } else if (strongReferenceIn(body, context.policyNumber)
      || (CLAIM_WORD.test(body) && CLAIM_OPENED.test(body) && !NEGATION.test(body) && !CONDITIONAL.test(body))) {
      decisive = { kind: "opened", quote: s.text };
    } else if (NEEDS_INFO.test(body) || DOCUMENTS.test(body)) {
      needsInfo ??= s.text;
    }
  }
  if (decisive?.kind === "opened") {
    return {
      ...base,
      decision: "approved",
      referenceNumber,
      supportingQuote: decisive.quote,
      nextAction: referenceNumber
        ? `Claim ${referenceNumber} opened with ${insurer}. Next: keep this claim number, send photos, estimates and receipts to the adjuster when they contact you, and note the date of this call.`
        : `${insurer} said a claim was opened, but no claim number was given on the call. Next: ask ${insurer} for the claim number and keep it with this transcript.`,
    };
  }
  if (decisive?.kind === "refused") {
    return {
      ...base,
      decision: "denied",
      referenceNumber,
      supportingQuote: decisive.quote,
      nextAction: `${insurer} said it will not open a claim; no claim was filed. Next: ask for the reason in writing, check your policy terms, and contact your state insurance department if you disagree.`,
    };
  }
  const cap = reachedCap(context) ? `${CUT_OFF} ` : "";
  if (needsInfo) {
    return {
      ...base,
      decision: "needs_information",
      referenceNumber,
      supportingQuote: needsInfo,
      nextAction: `${cap}No claim was filed yet: ${insurer} asked for more information first. Next: gather what was requested, then approve another call to file the claim.`,
    };
  }
  const line = lineStatus(sentences, context);
  if (line) {
    const hours = line.kind === "closed" && line.hours ? ` The recording said: "${line.hours}"` : "";
    const next = line.kind === "closed" ? "call again during business hours" : line.kind === "ivr" ? "check the claims phone number and call again" : "call again, or file the claim online";
    return {
      ...base,
      decision: "unknown",
      referenceNumber,
      supportingQuote: line.quote,
      nextAction: `${line.kind === "cap" ? `${CUT_OFF} No claim was opened with ${insurer}.` : `${lineReason(line, insurer)}; no claim was filed.`}${hours} Next: ${next}.`,
    };
  }
  return {
    ...base,
    decision: "unknown",
    referenceNumber,
    nextAction: `No claim was filed: ${insurer} did not open a claim or give a claim number on the call. Next: call again and ask for a claim number before hanging up.`,
  };
}

function analyzeInformation(transcript: string | null, context: TranscriptContext): CaseOutcome {
  const org = context.merchantName;
  const base = { referenceNumber: null as string | null, paymentStatus: "unverified" as const, supportingQuote: null as string | null };
  if (!transcript || transcript.trim().length === 0) {
    return { ...base, decision: "unknown", nextAction: `No transcript was available, so nothing was learned. Call ${org} again with your questions.` };
  }
  const sentences = splitSentences(transcript);
  const referenceNumber = findReference(sentences, context.policyNumber);
  const learned: { label: string; quote: string }[] = [];
  for (const [label, pattern] of [["Documents", DOCUMENTS], ["Deadline", DEADLINE], ["Hours", HOURS]] as const) {
    const s = sentences.find((x) => x.support && !isQuestion(stripQuotes(x.text)) && pattern.test(stripQuotes(x.text)));
    if (s) learned.push({ label, quote: s.text });
  }
  const cap = reachedCap(context) ? `${CUT_OFF} ` : "";
  if (learned.length > 0) {
    return {
      ...base,
      decision: "needs_information",
      referenceNumber,
      supportingQuote: learned[0]!.quote,
      nextAction: `${cap}What ${org} said: ${learned.map((l) => `${l.label}: "${l.quote}"`).join(" ")} Next: use this to prepare the claim or request.`,
    };
  }
  const line = lineStatus(sentences, context);
  if (line) {
    return {
      ...base,
      decision: "unknown",
      referenceNumber,
      supportingQuote: line.quote,
      nextAction: `${line.kind === "cap" ? CUT_OFF : `${lineReason(line, org)}; nothing was learned.`} Next: call again with the same questions.`,
    };
  }
  return {
    ...base,
    decision: "needs_information",
    referenceNumber,
    nextAction: `${org} did not state documents, deadlines or hours on the call. Next: call again with the same questions, or check ${org}'s website.`,
  };
}

/**
 * Read a finished call. `purpose` is the authorization's call purpose (absent on
 * older rows = request_refund) and picks refund, claim or information rules.
 */
export function analyzeTranscript(
  transcript: string | null,
  context: TranscriptContext,
  purpose: CallPurpose = "request_refund",
): CaseOutcome {
  if (purpose === "file_claim") return analyzeClaim(transcript, context);
  if (purpose === "gather_information") return analyzeInformation(transcript, context);
  return analyzeRefund(transcript, context);
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
