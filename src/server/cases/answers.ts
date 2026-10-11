import { randomUUID } from "node:crypto";
import type { ProposedUpdateV1 } from "@/contracts/case";
import type { CallPlanV1 } from "@/contracts/voice";

/**
 * V1.1: answers to the plan's approved questions, read from the support side of a
 * transcript and proposed for user review. Deterministic and conservative:
 *  - only labeled support-side lines count (our agent's and the customer's lines never do);
 *  - each approved question gets at most one proposal, quoting the sentence verbatim;
 *  - a fact is only proposed for a fact the plan left unknown (null);
 *  - nothing here changes the case: the caller stores proposals as "pending".
 */
const NON_SUPPORT_SPEAKERS = new Set(["agent", "ai", "ai assistant", "assistant", "bot", "caller", "customer", "me", "you"]);
const LABELED = /^\s*([^:]{1,40}):\s*(.+)$/;
const REFERENCE = /\b(?:reference|confirmation|ticket|case|claim)\b(?:\s*(?:number|no\.?|#|id))?\s*(?:is|:|-)?\s*(?:number\s*)?(?:is\s*)?([A-Za-z0-9][A-Za-z0-9-]{3,}\d[A-Za-z0-9-]*)/i;
const TIMELINE = /\b(?:\d+\s*(?:to|-)\s*\d+|\d+|a few|several)\s+(?:business\s+)?(?:days?|weeks?)\b|\bwithin\s+(?:a|one|two|\d+)\s+(?:days?|weeks?|billing cycles?)\b/i;
const REQUIREMENT = /\b(?:need|needs|require|required|please (?:send|provide|submit|email|upload|fax)|call (?:us )?back|order number|policy number|claim number|last four|proof of|verify|verification)\b/i;
const MONEY = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?/;
const MAX_QUOTE = 500;

interface SupportSentence {
  text: string;
}

function supportSentences(transcript: string): SupportSentence[] {
  const out: SupportSentence[] = [];
  for (const line of transcript.split(/\r?\n/)) {
    const m = LABELED.exec(line);
    if (!m?.[1] || !m[2]) continue; // unlabeled text cannot be attributed to support
    if (NON_SUPPORT_SPEAKERS.has(m[1].trim().toLowerCase())) continue;
    for (const part of m[2].split(/(?<=[.?!])\s+/)) {
      const text = part.trim();
      if (text) out.push({ text: text.slice(0, MAX_QUOTE) });
    }
  }
  return out;
}

function moneyMinor(text: string): number | null {
  const m = MONEY.exec(text);
  if (!m?.[1]) return null;
  const major = Number.parseInt(m[1].replace(/,/g, ""), 10);
  const minor = major * 100 + (m[2] ? Number.parseInt(m[2], 10) : 0);
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

type Draft = Pick<ProposedUpdateV1, "target" | "value" | "quote">;

function answerFor(questionId: string, sentences: SupportSentence[], plan: CallPlanV1): Draft | null {
  for (const s of sentences) {
    const statement = !s.text.trim().endsWith("?");
    switch (questionId) {
      case "reference": {
        const ref = statement ? REFERENCE.exec(s.text)?.[1] : undefined;
        if (ref) return { target: { kind: "question", questionId }, value: ref, quote: s.text };
        break;
      }
      case "timeline":
        if (statement && TIMELINE.test(s.text)) return { target: { kind: "question", questionId }, value: s.text, quote: s.text };
        break;
      case "requirements":
        // A support question ("Can you send the order number?") is still a stated requirement.
        if (REQUIREMENT.test(s.text)) return { target: { kind: "question", questionId }, value: s.text, quote: s.text };
        break;
      case "amount": {
        if (plan.facts.amountMinor !== null || !statement) break;
        const minor = moneyMinor(s.text);
        if (minor !== null) return { target: { kind: "fact", field: "amountMinor" }, value: String(minor), quote: s.text };
        break;
      }
      default:
        break;
    }
  }
  return null;
}

export function proposeUpdates(input: {
  transcript: string;
  plan: CallPlanV1;
  callId: string;
  authorizationId: string;
  revision: number;
  now: string;
}): ProposedUpdateV1[] {
  const sentences = supportSentences(input.transcript);
  const out: ProposedUpdateV1[] = [];
  for (const q of input.plan.questions) {
    const draft = answerFor(q.id, sentences, input.plan);
    if (!draft) continue;
    out.push({
      id: randomUUID(),
      callId: input.callId,
      authorizationId: input.authorizationId,
      revision: input.revision,
      ...draft,
      status: "pending",
      createdAt: input.now,
    });
  }
  return out;
}
