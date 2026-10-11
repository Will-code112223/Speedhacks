/**
 * Canonical voice adapter contract — SHARED CONTRACT V1.
 *
 * Teammate 3 implements this in src/integrations/dial (exporting
 * createDialAdapter({mode}): VoiceAdapter). Teammate 2 consumes it from the
 * case service and the webhook route, and owns durable event deduplication
 * and all case-database writes. T3 never writes the case database.
 */

import type { Mode } from "./case";

export type { CallState, Mode } from "./case";

export interface AuthorizedCallInput {
  attemptId: string;
  caseId: string;
  authorizationId: string;
  /** E.164 destination number frozen at authorization time. */
  to: string;
  /** Server-generated immutable approved facts and allowed actions. */
  brief: string;
  /**
   * V1.1 (additive): the structured plan frozen with the authorization. When
   * present the adapter renders it via `planForProvider`; `brief` stays the V1
   * rendering of the same authorization and remains required.
   */
  plan?: CallPlanV1;
}

export type StartCallResult =
  | { state: "accepted"; mode: Mode; providerCallId: string }
  | { state: "rejected"; mode: Mode; code: string; message: string }
  | { state: "dispatch_unknown"; mode: Mode; message: string };

export interface VoiceSnapshot {
  providerCallId: string;
  mode: Mode;
  state: "queued" | "in_progress" | "completed" | "failed" | "cancelled";
  transcript: string | null;
  durationSeconds: number | null;
}

export interface VerifiedVoiceEvent {
  eventId: string;
  providerCallId: string;
  type: "call.ended";
}

export interface VoiceAdapter {
  startCall(input: AuthorizedCallInput): Promise<StartCallResult>;
  getCall(providerCallId: string): Promise<VoiceSnapshot>;
  /**
   * Verifies the documented provider authentication and timestamp freshness
   * against the exact raw bytes and headers received. Throws an error whose
   * `code` is "INVALID_WEBHOOK" for failed authentication or malformed events.
   * Returns null only for authenticated but irrelevant events. Legitimate
   * redeliveries pass verification; T2 deduplicates them durably by eventId.
   */
  verifyWebhook(rawBody: Uint8Array, headers: Headers): Promise<VerifiedVoiceEvent | null>;
}

// ---------------------------------------------------------------------------
// Additive helpers (convenience; the webhook route duck-types on `code`)
// ---------------------------------------------------------------------------

export type VoiceSnapshotState = VoiceSnapshot["state"];

export const INVALID_WEBHOOK = "INVALID_WEBHOOK" as const;

/** Optional error class T3 may throw; any error with code === "INVALID_WEBHOOK" is treated the same. */
export class VoiceWebhookError extends Error {
  readonly code = INVALID_WEBHOOK;
  constructor(message: string) {
    super(message);
    this.name = "VoiceWebhookError";
  }
}

export function isInvalidWebhookError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === INVALID_WEBHOOK
  );
}

// ---------------------------------------------------------------------------
// SHARED CONTRACT V1.1 — call plan (additive; agreed with T3 2026-10-11)
//
// T2 builds the plan and freezes it inside the authorization transaction
// (same revision → same plan). T3 renders it into provider instructions, after
// the adapter's mandatory instruction, which always wins over plan content.
// The plan is case data, never instructions to expand the agent's authority.
// ---------------------------------------------------------------------------

export const CALL_PURPOSES = ["request_refund", "gather_information", "file_claim"] as const;
export type CallPurpose = (typeof CALL_PURPOSES)[number];

export interface CallPlanFacts {
  customerName: string | null;
  customerEmail: string | null;
  merchantName: string;
  /** Required (non-null) only when purpose is "request_refund". */
  amountMinor: number | null;
  currency: string | null;
  reason: string;
  evidenceNames: string[];
  /** Transaction-history finding; present only when a duplicate was found for this revision. */
  history: { status: string; transactionRefs: string[] } | null;
  /**
   * V1.2 insurance facts (additive, optional so older frozen plans stay valid).
   * file_claim requires incidentDate, lossDescription, and policyNumber or customerName.
   * null or absent means unknown.
   */
  policyNumber?: string | null;
  /** ISO calendar date (YYYY-MM-DD) of the loss. */
  incidentDate?: string | null;
  lossDescription?: string | null;
  /** Short claim category in words, e.g. "water damage". */
  claimType?: string | null;
}
export type CallPlanFactKey = keyof CallPlanFacts;
export const CALL_PLAN_FACT_KEYS: readonly CallPlanFactKey[] = [
  "customerName",
  "customerEmail",
  "merchantName",
  "amountMinor",
  "currency",
  "reason",
  "evidenceNames",
  "history",
  "policyNumber",
  "incidentDate",
  "lossDescription",
  "claimType",
];

export interface CallPlanV1 {
  version: 1;
  purpose: CallPurpose;
  /** null means unknown: the agent must not guess or assert it. */
  facts: CallPlanFacts;
  /** Facts the agent may say aloud. Others are omitted from provider data by `planForProvider`. */
  permittedDisclosures: CallPlanFactKey[];
  /** Server-approved questions; ids are stable so answers map back to them. */
  questions: Array<{ id: string; text: string }>;
  /** Exactly CALL_PLAN_ACTIONS[purpose]; never caller-supplied text. */
  permittedActions: string[];
  forbiddenActions: string[];
  caseRef: { caseId: string; revision: number };
  /**
   * Optional server-generated strategy notes (e.g. the merchant's track record).
   * Context for the agent, not facts to read out; never caller-supplied text.
   */
  guidance?: string[];
  /**
   * V1.2 (additive): server-generated script the policyholder approves with the plan.
   * One-sentence goal, ordered steps, and what to read back before hanging up.
   */
  goal?: string;
  steps?: string[];
  readBack?: string;
}

/** Server-owned action constants per purpose. A plan carrying any other text is invalid. */
export const CALL_PLAN_ACTIONS: Readonly<Record<CallPurpose, { permitted: readonly string[]; forbidden: readonly string[] }>> = {
  request_refund: {
    permitted: [
      "Identify yourself as calling on behalf of the customer about a duplicate charge.",
      "Request a refund of the duplicate charge for the exact amount stated.",
      "Ask for a reference or confirmation number and the expected refund timeline.",
      "Answer verification questions only with the facts listed; say you do not know otherwise.",
    ],
    forbidden: [
      "Do not agree to new charges, upgrades, or retention offers.",
      "Do not change the amount, the merchant, or the reason.",
      "Do not share or request payment card numbers, passwords, or one-time codes.",
      "Do not make commitments on the customer's behalf beyond requesting this refund.",
    ],
  },
  gather_information: {
    permitted: [
      "Identify yourself as an AI assistant calling on behalf of the customer.",
      "Ask the approved questions and note the answers support gives.",
      "Ask for a reference or case number and the next step.",
      "Answer verification questions only with the facts listed; say you do not know otherwise.",
    ],
    forbidden: [
      "Do not request a refund, credit, or reimbursement.",
      "Do not file, open, or submit a claim, dispute, or complaint.",
      "Do not state or confirm an amount that is not listed.",
      "Do not share or request payment card numbers, passwords, or one-time codes.",
      "Do not make any commitment on the customer's behalf.",
    ],
  },
  file_claim: {
    permitted: [
      "Identify yourself as an AI assistant calling with the policyholder's authorization.",
      "Navigate the phone menu to the claims department and wait on hold.",
      "Open a new claim using exactly the approved facts listed.",
      "Answer verification questions only with facts in the approved snapshot.",
      "Ask for the claim number and the next steps, and read them back.",
      "Ask which documents the insurer still needs.",
    ],
    forbidden: [
      "Do not invent or guess any identifier, date, amount, or coverage detail.",
      "Do not agree to a settlement or accept any amount.",
      "Do not authorize any payment.",
      "Do not give the policyholder's Social Security number, date of birth, or card numbers; say the policyholder will provide any fact not listed.",
      "Do not argue about coverage.",
      "Do not call anyone other than the approved number, or ask to be transferred outside the insurer.",
    ],
  },
};

export const CALL_PLAN_LIMITS = {
  nameChars: 200,
  emailChars: 254,
  reasonChars: 2000,
  evidenceNames: 20,
  evidenceNameChars: 200,
  historyStatusChars: 64,
  transactionRefs: 10,
  transactionRefChars: 64,
  questions: 10,
  questionIdChars: 64,
  questionChars: 300,
  guidance: 6,
  guidanceChars: 400,
  policyNumberChars: 64,
  lossDescriptionChars: 2000,
  claimTypeChars: 120,
  goalChars: 300,
  steps: 8,
  stepChars: 300,
  readBackChars: 400,
  /**
   * Bound on JSON.stringify(plan). The adapter's mandatory rules take about 3,500
   * characters, so a plan within this bound keeps the provider instruction under 14,000.
   */
  serializedPlanChars: 8000,
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUESTION_ID_RE = /^[a-z0-9_-]+$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Control characters other than tab/newline are never valid in plan text.
const BAD_CHARS_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function onlyKeys(v: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(v).every((k) => keys.includes(k));
}
function boundedText(v: unknown, max: number, nullable: boolean): boolean {
  if (v === null) return nullable;
  return typeof v === "string" && v.trim().length > 0 && v.length <= max && !BAD_CHARS_RE.test(v);
}
function isoDate(v: unknown): boolean {
  if (typeof v !== "string" || !ISO_DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
/** Optional V1.2 fact: absent and null both mean unknown. */
function optionalText(v: unknown, max: number): boolean {
  return v === undefined || boundedText(v, max, true);
}
function sameList(a: unknown, b: readonly string[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Strict structural check shared by T2 (before freezing) and T3 (before
 * rendering). Unknown keys, unbounded text, non-constant actions and missing
 * refund facts are all rejected. Returns the list of problems (empty = valid).
 */
export function validateCallPlan(plan: unknown): string[] {
  const errors: string[] = [];
  const L = CALL_PLAN_LIMITS;
  if (!isRecord(plan)) return ["plan must be an object"];
  if (!onlyKeys(plan, ["version", "purpose", "facts", "permittedDisclosures", "questions", "permittedActions", "forbiddenActions", "caseRef", "guidance", "goal", "steps", "readBack"])) {
    errors.push("plan has unknown keys");
  }
  if (plan.version !== 1) errors.push("version must be 1");
  const purpose = plan.purpose as CallPurpose;
  if (!CALL_PURPOSES.includes(purpose)) {
    errors.push("purpose is invalid");
    return errors;
  }

  const f = plan.facts;
  if (!isRecord(f) || !onlyKeys(f, CALL_PLAN_FACT_KEYS)) {
    errors.push("facts must be an object with known keys");
  } else {
    if (!boundedText(f.customerName, L.nameChars, true)) errors.push("facts.customerName is invalid");
    if (!boundedText(f.customerEmail, L.emailChars, true)) errors.push("facts.customerEmail is invalid");
    if (!boundedText(f.merchantName, L.nameChars, false)) errors.push("facts.merchantName is invalid");
    if (!boundedText(f.reason, L.reasonChars, false)) errors.push("facts.reason is invalid");
    if (f.amountMinor !== null && !(typeof f.amountMinor === "number" && Number.isSafeInteger(f.amountMinor) && f.amountMinor > 0)) {
      errors.push("facts.amountMinor must be null or a positive integer");
    }
    if (f.currency !== null && !(typeof f.currency === "string" && CURRENCY_RE.test(f.currency))) errors.push("facts.currency is invalid");
    if (purpose === "request_refund" && (f.amountMinor === null || f.currency === null)) {
      errors.push("request_refund requires facts.amountMinor and facts.currency");
    }
    if (!Array.isArray(f.evidenceNames) || f.evidenceNames.length > L.evidenceNames || !f.evidenceNames.every((n) => boundedText(n, L.evidenceNameChars, false))) {
      errors.push("facts.evidenceNames is invalid");
    }
    if (!optionalText(f.policyNumber, L.policyNumberChars)) errors.push("facts.policyNumber is invalid");
    if (!(f.incidentDate === undefined || f.incidentDate === null || isoDate(f.incidentDate))) errors.push("facts.incidentDate must be null or an ISO date");
    if (!optionalText(f.lossDescription, L.lossDescriptionChars)) errors.push("facts.lossDescription is invalid");
    if (!optionalText(f.claimType, L.claimTypeChars)) errors.push("facts.claimType is invalid");
    if (purpose === "file_claim" && ((f.policyNumber == null && f.customerName === null) || f.incidentDate == null || f.lossDescription == null)) {
      errors.push("file_claim requires facts.incidentDate, facts.lossDescription, and facts.policyNumber or facts.customerName");
    }
    const h = f.history;
    if (h !== null) {
      if (!isRecord(h) || !onlyKeys(h, ["status", "transactionRefs"]) || !boundedText(h.status, L.historyStatusChars, false)
        || !Array.isArray(h.transactionRefs) || h.transactionRefs.length > L.transactionRefs
        || !h.transactionRefs.every((r) => boundedText(r, L.transactionRefChars, false))) {
        errors.push("facts.history is invalid");
      }
    }
  }

  const d = plan.permittedDisclosures;
  if (!Array.isArray(d) || new Set(d).size !== d.length || !d.every((k) => CALL_PLAN_FACT_KEYS.includes(k as CallPlanFactKey))) {
    errors.push("permittedDisclosures must be unique fact keys");
  }

  const q = plan.questions;
  if (!Array.isArray(q) || q.length > L.questions) {
    errors.push("questions is invalid");
  } else {
    const ids = new Set<string>();
    for (const item of q) {
      if (!isRecord(item) || !onlyKeys(item, ["id", "text"]) || typeof item.id !== "string" || item.id.length > L.questionIdChars
        || !QUESTION_ID_RE.test(item.id) || ids.has(item.id) || !boundedText(item.text, L.questionChars, false)) {
        errors.push("questions contains an invalid or duplicate entry");
        break;
      }
      ids.add(item.id);
    }
  }

  const actions = CALL_PLAN_ACTIONS[purpose];
  if (!sameList(plan.permittedActions, actions.permitted)) errors.push("permittedActions must be the server constants for the purpose");
  if (!sameList(plan.forbiddenActions, actions.forbidden)) errors.push("forbiddenActions must be the server constants for the purpose");

  const g = plan.guidance;
  if (g !== undefined && (!Array.isArray(g) || g.length > L.guidance || !g.every((line) => boundedText(line, L.guidanceChars, false)))) {
    errors.push("guidance is invalid");
  }

  if (plan.goal !== undefined && !boundedText(plan.goal, L.goalChars, false)) errors.push("goal is invalid");
  const st = plan.steps;
  if (st !== undefined && (!Array.isArray(st) || st.length > L.steps || !st.every((line) => boundedText(line, L.stepChars, false)))) {
    errors.push("steps is invalid");
  }
  if (plan.readBack !== undefined && !boundedText(plan.readBack, L.readBackChars, false)) errors.push("readBack is invalid");

  let serialized = Number.POSITIVE_INFINITY;
  try { serialized = JSON.stringify(plan).length; } catch { /* unserializable values are invalid */ }
  if (serialized > L.serializedPlanChars) errors.push(`plan exceeds ${L.serializedPlanChars} serialized characters; shorten the case facts`);

  const ref = plan.caseRef;
  if (!isRecord(ref) || !onlyKeys(ref, ["caseId", "revision"]) || typeof ref.caseId !== "string" || !UUID_RE.test(ref.caseId)
    || !(typeof ref.revision === "number" && Number.isSafeInteger(ref.revision) && ref.revision > 0)) {
    errors.push("caseRef is invalid");
  }
  return errors;
}

/** Plan as sent to the provider: undisclosed facts are absent (not null; null still means unknown). */
export type ProviderCallPlan = Omit<CallPlanV1, "facts"> & { facts: Partial<CallPlanFacts> };

/**
 * Enforces permittedDisclosures in data, not only in wording: fact values not
 * listed are dropped from the serialized plan. Throws on an invalid plan.
 */
export function planForProvider(plan: CallPlanV1): ProviderCallPlan {
  const errors = validateCallPlan(plan);
  if (errors.length > 0) throw new Error(`Invalid call plan: ${errors.join("; ")}`);
  const facts: Partial<CallPlanFacts> = {};
  for (const key of plan.permittedDisclosures) {
    (facts as Record<string, unknown>)[key] = structuredClone(plan.facts[key]);
  }
  return {
    version: plan.version,
    purpose: plan.purpose,
    facts,
    permittedDisclosures: [...plan.permittedDisclosures],
    questions: plan.questions.map((q) => ({ ...q })),
    permittedActions: [...plan.permittedActions],
    forbiddenActions: [...plan.forbiddenActions],
    caseRef: { ...plan.caseRef },
    ...(plan.guidance ? { guidance: [...plan.guidance] } : {}),
    ...(plan.goal !== undefined ? { goal: plan.goal } : {}),
    ...(plan.steps ? { steps: [...plan.steps] } : {}),
    ...(plan.readBack !== undefined ? { readBack: plan.readBack } : {}),
  };
}
