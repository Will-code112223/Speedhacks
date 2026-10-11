import type { CaseChanges, CaseV1 } from "@/contracts/case";
import { CALL_PLAN_ACTIONS, CALL_PLAN_LIMITS, CALL_PURPOSES, type CallPlanV1, type CallPurpose } from "@/contracts/voice";
import { historyBriefLines, type HistoryCheck } from "@/server/cases/history";
import { merchantRecordLines, type FrozenMerchantRecord } from "@/server/cases/insights";
import type { CaseDoc } from "@/server/persistence/repository";

/** E.164 with at least 8 digits, matching the Dial adapter's own validation so dispatch never fails on format. */
export const E164 = /^\+[1-9]\d{7,14}$/;
export const CURRENCY = /^[A-Z]{3}$/;

/**
 * NANP area codes outside the US and Canada. They look domestic (+1) but bill as
 * international calls and are the classic one-ring and callback-fraud destinations.
 */
const INTERNATIONAL_NANP_AREAS = new Set([
  "242", "246", "264", "268", "284", "345", "441", "473", "649", "658", "664", "721",
  "758", "767", "784", "809", "829", "849", "868", "869", "876",
]);

/**
 * Live-mode destination rule: a real call may only go to a North American (+1) number
 * with a valid NANP area code and exchange. Rejects premium 900 and 976, N11 and 0/1-leading
 * codes, unassigned N9X area codes, Caribbean and Atlantic NANP areas billed as
 * international, and the account's own caller ID. Returns why the number is refused, or null.
 */
export function liveDestinationProblem(phone: string, fromNumber: string | null): string | null {
  const m = /^\+1([2-9]\d{2})([2-9]\d{2})(\d{4})$/.exec(phone);
  if (!m) return "Live calls can only go to North American numbers: +1 followed by a valid 10-digit number";
  const [, area, exchange] = m as unknown as [string, string, string, string];
  if (area[1] === "1" && area[2] === "1") return `Area code ${area} is not a valid North American area code`;
  if (area[1] === "9") return `Area code ${area} is not an assigned North American area code`;
  if (area === "900") return "Premium-rate 900 numbers cannot be called";
  if (INTERNATIONAL_NANP_AREAS.has(area)) return `Area code ${area} is outside the US and Canada and bills as an international call`;
  if (exchange[1] === "1" && exchange[2] === "1") return `Exchange ${exchange} is not a valid North American exchange`;
  if (exchange === "976") return "Premium-rate 976 numbers cannot be called";
  if (fromNumber && phone === fromNumber.trim()) return "The support number cannot be this service's own caller ID";
  return null;
}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const REQUIRED_FIELDS = [
  "customer.name",
  "merchant.name",
  "merchant.supportPhone",
  "amountMinor",
  "currency",
  "reason",
] as const;

export type Facts = Pick<
  CaseDoc,
  "customer" | "merchant" | "amountMinor" | "currency" | "reason" | "policyNumber" | "incidentDate" | "lossDescription" | "claimType"
>;

/** ISO calendar date (YYYY-MM-DD) that exists on the calendar. */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * Required facts for authorization. gather_information does not need an amount (V1.1).
 * file_claim (V1.2) needs the policyholder (policyNumber, or customer.name when no policy
 * number is known), incidentDate and lossDescription, and never an amount.
 */
export function missingFields(facts: Facts, purpose: CallPurpose = "request_refund"): string[] {
  const missing: string[] = [];
  // Compared as a string so this compiles whether or not file_claim is in CALL_PURPOSES yet.
  const fileClaim = (purpose as string) === "file_claim";
  if (fileClaim) {
    if (!facts.policyNumber?.trim() && !facts.customer.name?.trim()) missing.push("policyNumber");
  } else if (!facts.customer.name?.trim()) missing.push("customer.name");
  if (!facts.merchant.name?.trim()) missing.push("merchant.name");
  if (!facts.merchant.supportPhone || !E164.test(facts.merchant.supportPhone)) missing.push("merchant.supportPhone");
  if (purpose === "request_refund" && !isValidAmountMinor(facts.amountMinor)) missing.push("amountMinor");
  if (!CURRENCY.test(facts.currency)) missing.push("currency");
  if (!facts.reason.trim()) missing.push("reason");
  if (fileClaim) {
    if (!isIsoDate(facts.incidentDate)) missing.push("incidentDate");
    if (!facts.lossDescription?.trim()) missing.push("lossDescription");
  }
  return missing;
}

/**
 * V1.2: the purpose a case is prepared for. A case that describes an insurance loss
 * (lossDescription or claimType known) is a claim; everything else keeps the V1 refund
 * purpose. Stored missingFields, status and the draft follow it.
 */
export function suggestedPurpose(facts: Facts): CallPurpose {
  const claimLike = Boolean(facts.lossDescription?.trim() || facts.claimType?.trim());
  return claimLike && (CALL_PURPOSES as readonly string[]).includes("file_claim") ? ("file_claim" as CallPurpose) : "request_refund";
}

export function formatAmount(amountMinor: number | null, currency: string): string {
  if (amountMinor === null) return "[amount missing]";
  const major = (amountMinor / 100).toFixed(2);
  return currency === "USD" ? `$${major}` : `${major} ${currency}`;
}

/** Validate PATCH changes shape; returns the normalized changes or throws a field list. */
export function validateChanges(input: unknown): { changes: CaseChanges; invalid: string[] } {
  const invalid: string[] = [];
  const changes: CaseChanges = {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { changes, invalid: ["changes"] };
  }
  const c = input as Record<string, unknown>;

  if ("customer" in c) {
    const v = c.customer;
    if (typeof v !== "object" || v === null) invalid.push("customer");
    else {
      const o = v as Record<string, unknown>;
      const name = nullableString(o.name);
      const email = nullableString(o.email);
      if (name === undefined) invalid.push("customer.name");
      if (email === undefined || (email !== null && !EMAIL.test(email))) invalid.push("customer.email");
      if (name !== undefined && email !== undefined) changes.customer = { name, email };
    }
  }
  if ("merchant" in c) {
    const v = c.merchant;
    if (typeof v !== "object" || v === null) invalid.push("merchant");
    else {
      const o = v as Record<string, unknown>;
      const name = nullableString(o.name);
      const phone = nullableString(o.supportPhone);
      if (name === undefined) invalid.push("merchant.name");
      if (phone === undefined || (phone !== null && !E164.test(phone))) invalid.push("merchant.supportPhone");
      if (name !== undefined && phone !== undefined) changes.merchant = { name, supportPhone: phone };
    }
  }
  if ("amountMinor" in c) {
    const v = c.amountMinor;
    if (v === null) changes.amountMinor = null;
    else if (isValidAmountMinor(v)) changes.amountMinor = v;
    else invalid.push("amountMinor");
  }
  if ("currency" in c) {
    const v = c.currency;
    if (typeof v === "string" && CURRENCY.test(v)) changes.currency = v;
    else invalid.push("currency");
  }
  if ("reason" in c) {
    const v = c.reason;
    if (typeof v === "string" && v.trim().length > 0 && v.trim().length <= 2000) changes.reason = v.trim();
    else invalid.push("reason");
  }
  // V1.2 insurance facts: null (or blank) clears; unknown stays null.
  if ("policyNumber" in c) {
    const v = nullableString(c.policyNumber);
    if (v === undefined || (v !== null && v.length > 64)) invalid.push("policyNumber");
    else changes.policyNumber = v;
  }
  if ("incidentDate" in c) {
    const v = nullableString(c.incidentDate);
    if (v === undefined || (v !== null && !isIsoDate(v))) invalid.push("incidentDate");
    else changes.incidentDate = v;
  }
  if ("lossDescription" in c) {
    const v = c.lossDescription;
    if (v === null || (typeof v === "string" && v.trim().length === 0)) changes.lossDescription = null;
    else if (typeof v === "string" && v.length <= 2000) changes.lossDescription = v.trim();
    else invalid.push("lossDescription");
  }
  if ("claimType" in c) {
    const v = nullableString(c.claimType);
    if (v === undefined) invalid.push("claimType");
    else changes.claimType = v === null ? null : v.slice(0, 120);
  }
  return { changes, invalid };
}

function nullableString(v: unknown): string | null | undefined {
  if (v === null) return null;
  if (typeof v === "string") {
    const t = v.trim();
    return t.length === 0 ? null : t.slice(0, 200);
  }
  return undefined;
}

/** Apply changes; returns the new facts and whether anything material changed. */
export function pickFacts(facts: Facts): Facts {
  return {
    customer: { name: facts.customer.name, email: facts.customer.email },
    merchant: { name: facts.merchant.name, supportPhone: facts.merchant.supportPhone, source: facts.merchant.source ?? null },
    amountMinor: facts.amountMinor,
    currency: facts.currency,
    reason: facts.reason,
    policyNumber: facts.policyNumber ?? null,
    incidentDate: facts.incidentDate ?? null,
    lossDescription: facts.lossDescription ?? null,
    claimType: facts.claimType ?? null,
  };
}

/** Largest amount accepted, in minor units (10 billion major units). */
export const MAX_AMOUNT_MINOR = 1_000_000_000_000;

export function isValidAmountMinor(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= MAX_AMOUNT_MINOR;
}

export function applyChanges(facts: Facts, changes: CaseChanges): { next: Facts; changed: boolean } {
  const prev = pickFacts(facts);
  const next: Facts = pickFacts(facts);
  if (changes.customer) next.customer = { ...changes.customer };
  if (changes.merchant) {
    // Provenance follows the number. A registry number never survives a change of insurer
    // name: it is cleared so the caller can re-resolve it for the new name (or leave it
    // empty), and is never kept under a different insurer. A newly typed number is "user".
    const prevSource = prev.merchant.source ?? null;
    const nameChanged = changes.merchant.name !== prev.merchant.name;
    const phoneChanged = changes.merchant.supportPhone !== prev.merchant.supportPhone;
    let supportPhone = changes.merchant.supportPhone;
    let source: Facts["merchant"]["source"] = null;
    if (!phoneChanged && prevSource?.kind === "insurer_registry") {
      if (nameChanged) supportPhone = null;
      else source = prevSource;
    } else if (!phoneChanged) {
      source = supportPhone ? prevSource : null;
    } else if (supportPhone) {
      source = { kind: "user" };
    }
    next.merchant = { name: changes.merchant.name, supportPhone, source };
  }
  if ("amountMinor" in changes && changes.amountMinor !== undefined) next.amountMinor = changes.amountMinor;
  if (changes.currency !== undefined) next.currency = changes.currency;
  if (changes.reason !== undefined) next.reason = changes.reason;
  if (changes.policyNumber !== undefined) next.policyNumber = changes.policyNumber;
  if (changes.incidentDate !== undefined) next.incidentDate = changes.incidentDate;
  if (changes.lossDescription !== undefined) next.lossDescription = changes.lossDescription;
  if (changes.claimType !== undefined) next.claimType = changes.claimType;
  const changed = JSON.stringify(next) !== JSON.stringify(prev);
  return { next, changed };
}

/**
 * Email draft. With an amount it is the V1 refund request (unchanged); without one it is a
 * neutral information request, so an insurance or general question is never framed as a
 * refund claim. null until the facts that purpose needs are present.
 */
export function buildDraft(facts: Facts, evidence: CaseV1["evidence"], purpose: CallPurpose = "request_refund"): CaseV1["draft"] {
  const evidenceLines =
    evidence.length > 0
      ? evidence.map((e, i) => `  ${i + 1}. ${e.name} (${e.mimeType})`).join("\n")
      : "  (none attached)";
  if ((purpose as string) === "file_claim") {
    if (missingFields(facts, purpose).length > 0) return null;
    const holder = facts.customer.name ?? "the policyholder";
    return {
      subject: `New claim: ${facts.claimType ?? "loss"} on ${facts.incidentDate}${facts.policyNumber ? ` (policy ${facts.policyNumber})` : ""}`,
      body: [
        `Hello ${facts.merchant.name} claims team,`,
        "",
        `My name is ${holder}${facts.customer.email ? ` (${facts.customer.email})` : ""}.`,
        `I am reporting a new claim${facts.policyNumber ? ` under policy ${facts.policyNumber}` : ""}.`,
        "",
        `Date of loss: ${facts.incidentDate}`,
        `What happened: ${facts.lossDescription}`,
        ...(isValidAmountMinor(facts.amountMinor) ? [`Estimated amount: ${formatAmount(facts.amountMinor, facts.currency)}`] : []),
        "",
        "Documents attached:",
        evidenceLines,
        "",
        "Please open a claim and send me the claim number and the next steps.",
        "",
        "Thank you,",
        facts.customer.name ?? "",
      ].join("\n"),
    };
  }
  if (missingFields(facts).length > 0) {
    if (missingFields(facts, "gather_information").length > 0) return null;
    return {
      subject: `Information request about a charge at ${facts.merchant.name}`,
      body: [
        `Hello ${facts.merchant.name} support,`,
        "",
        `My name is ${facts.customer.name}${facts.customer.email ? ` (${facts.customer.email})` : ""}.`,
        "I have a question about a charge on my account and am not requesting a refund at this time.",
        "",
        `Details: ${facts.reason}`,
        "",
        "Documents attached:",
        evidenceLines,
        "",
        "Please tell me what you need from me to resolve this, and any reference number for this inquiry.",
        "",
        "Thank you,",
        facts.customer.name ?? "",
      ].join("\n"),
    };
  }
  const amount = formatAmount(facts.amountMinor, facts.currency);
  const subject = `Refund request: duplicate charge of ${amount} at ${facts.merchant.name}`;
  const body = [
    `Hello ${facts.merchant.name} support,`,
    "",
    `My name is ${facts.customer.name}${facts.customer.email ? ` (${facts.customer.email})` : ""}.`,
    `I am requesting a refund of ${amount} for a duplicate charge.`,
    "",
    `Reason: ${facts.reason}`,
    "",
    "Evidence attached:",
    evidenceLines,
    "",
    "Please confirm the refund and provide a reference number.",
    "",
    "Thank you,",
    facts.customer.name ?? "",
  ].join("\n");
  return { subject, body };
}

// V1 brief wording = the V1.1 server-owned constants for request_refund, so the brief and plan never drift.
export const PERMITTED_ACTIONS = CALL_PLAN_ACTIONS.request_refund.permitted;
export const FORBIDDEN_ACTIONS = CALL_PLAN_ACTIONS.request_refund.forbidden;

/** Immutable factual call brief frozen with the authorization. */
export function buildBrief(input: {
  caseId: string;
  revision: number;
  customer: CaseV1["customer"];
  merchant: { name: string; supportPhone: string };
  amountMinor: number | null;
  currency: string;
  reason: string;
  evidence: CaseV1["evidence"];
  /** Transaction-history check for this exact revision, if one ran. */
  history?: HistoryCheck | null;
  /** Merchant track record for this exact revision, if one was captured. */
  merchantRecord?: FrozenMerchantRecord | null;
  /** V1.1; absent = request_refund (the V1 brief, byte-identical). */
  purpose?: CallPurpose;
  /** V1.2 insurance facts; each line appears only when the fact is known, so a V1 brief stays byte-identical. */
  policyNumber?: string | null;
  incidentDate?: string | null;
  lossDescription?: string | null;
  claimType?: string | null;
}): string {
  const purpose = input.purpose ?? "request_refund";
  const amount = input.amountMinor === null ? "unknown" : formatAmount(input.amountMinor, input.currency);
  const actions = CALL_PLAN_ACTIONS[purpose];
  const insuranceLines = [
    ...(input.policyNumber ? [`- Policy number: ${input.policyNumber}`] : []),
    ...(input.claimType ? [`- Claim type: ${input.claimType}`] : []),
    ...(input.incidentDate ? [`- Date of loss: ${input.incidentDate}`] : []),
    ...(input.lossDescription ? [`- What happened: ${input.lossDescription}`] : []),
  ];
  return [
    `You are calling ${input.merchant.name} customer support on behalf of ${input.customer.name ?? "the customer"}.`,
    purpose === "request_refund"
      ? `Purpose: request a refund of ${amount} for a duplicate charge.`
      : (purpose as string) === "file_claim"
        ? "Purpose: file a new insurance claim for the policyholder and get the claim number. Do not accept a settlement or agree to anything on the customer's behalf."
        : "Purpose: gather information about a charge. Do not request a refund or file a claim.",
    "",
    "Approved facts (do not alter):",
    `- Customer name: ${input.customer.name ?? "unknown"}`,
    `- Customer email: ${input.customer.email ?? "not provided"}`,
    `- Merchant: ${input.merchant.name}`,
    `- Amount: ${amount}`,
    `- Reason given by the customer: ${input.reason}`,
    ...insuranceLines,
    `- Evidence on file: ${input.evidence.length > 0 ? input.evidence.map((e) => e.name).join(", ") : "none"}`,
    ...(input.history ? ["", ...historyBriefLines(input.history)] : []),
    ...(input.merchantRecord ? ["", ...merchantRecordLines(input.merchantRecord)] : []),
    "",
    "Permitted actions:",
    ...actions.permitted.map((a) => `- ${a}`),
    "",
    "Not permitted:",
    ...actions.forbidden.map((a) => `- ${a}`),
    "",
    `Case reference: ${input.caseId} (revision ${input.revision}).`,
  ].join("\n");
}

/** Facts the agent may say aloud under V1.1: the same facts the V1 brief already carried. */
const PLAN_DISCLOSURES: CallPlanV1["permittedDisclosures"] = [
  "customerName",
  "customerEmail",
  "merchantName",
  "amountMinor",
  "currency",
  "reason",
  "evidenceNames",
  "history",
];

/**
 * V1.1 structured call plan, frozen with the authorization next to the brief. Built only
 * from server-side facts; actions are the server constants for the purpose. Callers must
 * run validateCallPlan before freezing it. V1.2 adds file_claim, the optional insurance
 * facts, and a server-written goal, steps and read-back the policyholder approves.
 */
export function buildCallPlan(input: {
  purpose: CallPurpose;
  caseId: string;
  revision: number;
  customer: CaseV1["customer"];
  merchantName: string;
  amountMinor: number | null;
  currency: string;
  reason: string;
  evidence: CaseV1["evidence"];
  history?: HistoryCheck | null;
  merchantRecord?: FrozenMerchantRecord | null;
  /** V1.2 insurance facts; absent or null = unknown. */
  policyNumber?: string | null;
  incidentDate?: string | null;
  lossDescription?: string | null;
  claimType?: string | null;
}): CallPlanV1 {
  const insurance = planInsuranceFacts(input);
  const purpose = input.purpose;
  const fileClaim = purpose === "file_claim";
  // Insurance keys appear only on insurance plans, so refund and charge plans keep their V1.1 shape.
  const insurer = fileClaim || Object.values(insurance).some((v) => v !== null);
  const duplicate = input.history?.status === "duplicate_found" ? input.history : null;
  // A claim call never states an amount: the insurer's adjuster sets it, and the agent may not agree to one.
  // Nor does it read the raw summary ("reason"): free text the person typed can hold an SSN, an
  // amount or anything else. The claim is described by lossDescription and claimType only.
  const disclosures = PLAN_DISCLOSURES.filter((k) => !(fileClaim && (k === "amountMinor" || k === "currency" || k === "reason")));
  if (insurer) {
    for (const key of ["policyNumber", "incidentDate", "lossDescription", "claimType"] as const) {
      if (insurance[key] !== null) disclosures.push(key);
    }
  }
  const script = planScript(input, insurance, insurer);
  return {
    version: 1,
    purpose,
    facts: {
      customerName: input.customer.name?.trim() ? input.customer.name : null,
      customerEmail: input.customer.email?.trim() ? input.customer.email : null,
      merchantName: input.merchantName,
      amountMinor: input.amountMinor,
      currency: input.amountMinor === null ? null : input.currency,
      reason: input.reason,
      evidenceNames: input.evidence.map((e) => e.name),
      // Only a duplicate finding may be cited; anything else stays out of the plan.
      history: duplicate ? { status: duplicate.status, transactionRefs: duplicate.matches.map((m) => m.chargeId) } : null,
      ...(insurer ? insurance : {}),
    },
    permittedDisclosures: disclosures,
    questions: planQuestions(input, insurance, insurer),
    permittedActions: [...CALL_PLAN_ACTIONS[purpose].permitted],
    forbiddenActions: [...CALL_PLAN_ACTIONS[purpose].forbidden],
    caseRef: { caseId: input.caseId, revision: input.revision },
    ...(input.merchantRecord ? { guidance: merchantRecordLines(input.merchantRecord).slice(1).map((l) => l.replace(/^- /, "").slice(0, CALL_PLAN_LIMITS.guidanceChars)) } : {}),
    ...script,
  };
}

type PlanInput = Parameters<typeof buildCallPlan>[0];
type PlanInsurance = { policyNumber: string | null; incidentDate: string | null; lossDescription: string | null; claimType: string | null };

function planInsuranceFacts(input: PlanInput): PlanInsurance {
  const text = (v: string | null | undefined) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    policyNumber: text(input.policyNumber),
    incidentDate: isIsoDate(input.incidentDate) ? input.incidentDate : null,
    lossDescription: text(input.lossDescription),
    claimType: text(input.claimType),
  };
}

/** "2026-10-03" -> "October 3, 2026", so the agent says the date the way a person would. */
function spokenDate(iso: string): string {
  return new Date(`${iso}T00:00:00.000Z`).toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" });
}

function planQuestions(input: PlanInput, ins: PlanInsurance, insurer: boolean): CallPlanV1["questions"] {
  if (input.purpose === "request_refund") {
    return [
      { id: "reference", text: "What is the reference or confirmation number for this refund request?" },
      { id: "timeline", text: "When should the customer expect the refund to appear?" },
    ];
  }
  if (input.purpose === "file_claim") {
    return [
      { id: "claim_number", text: "What is the claim number for this new claim?" },
      { id: "next_steps", text: "What are the next steps, and when will an adjuster contact the policyholder?" },
      { id: "documents", text: "Which documents do you still need from the policyholder, and how should they be sent?" },
    ];
  }
  if (insurer) {
    const kind = ins.claimType ? `a ${ins.claimType} claim` : "a claim";
    return [
      { id: "how_to_file", text: `How does the policyholder file ${kind} like this one, and can it be started by phone?` },
      { id: "documents", text: "Which documents are required for this type of claim?" },
      { id: "deadline", text: "Is there a deadline for filing this claim?" },
      { id: "hours", text: "What are the claims line hours?" },
      { id: "reference", text: "Is there a reference or ticket number for this call?" },
    ];
  }
  return [
    ...(input.amountMinor === null ? [{ id: "amount", text: "What amount was charged, and on what date?" }] : []),
    { id: "requirements", text: "What does the customer need to provide to resolve this charge?" },
    { id: "reference", text: "Is there a reference or case number for this inquiry?" },
  ];
}

function planScript(input: PlanInput, ins: PlanInsurance, insurer: boolean): Required<Pick<CallPlanV1, "goal" | "steps" | "readBack">> {
  const L = CALL_PLAN_LIMITS;
  const who = input.purpose === "request_refund" || !insurer ? "customer" : "policyholder";
  const name = input.merchantName.slice(0, 80);
  const kind = ins.claimType ? `${ins.claimType.slice(0, 60)} claim` : "insurance claim";
  const opening = `Say you are an AI assistant calling with the ${who}'s authorization, not the ${who}.`;
  const menu = input.purpose === "request_refund" || !insurer
    ? "Use the phone menu to reach customer support, and wait on hold as long as needed."
    : "Use the phone menu to reach claims (new claim or report a loss), and wait on hold as long as needed.";
  const verify = `Answer verification questions only with approved facts; for anything else, say the ${who} will provide it.`;
  let goal: string;
  let steps: string[];
  let readBack: string;
  if (input.purpose === "file_claim") {
    goal = `Open a new ${kind} with ${name}${ins.incidentDate ? ` for the loss on ${spokenDate(ins.incidentDate)}` : ""} and get the claim number.`;
    steps = [
      opening,
      menu,
      ins.policyNumber
        ? "Give the policy number, one character at a time, and the policyholder's name so they can find the policy."
        : "Give the policyholder's name so they can find the policy; the policy number is not known, so do not offer one.",
      "Report the loss in the approved words: what happened, the date of loss and the claim type.",
      verify,
      "Ask for the claim number, the next steps and which documents they still need.",
    ];
    readBack = "Read back the claim number one character at a time, the next step and each document they asked for, then ask them to confirm.";
  } else if (input.purpose === "gather_information") {
    goal = insurer
      ? `Learn from ${name} how to file this ${kind}, what documents it needs, the filing deadline and the claims line hours. Do not file it.`
      : `Learn from ${name} what the customer needs to resolve this charge. Do not request a refund.`;
    steps = [
      opening,
      menu,
      "Briefly describe the situation using the approved facts.",
      "Ask each approved question in order, one at a time, and note each answer.",
      verify,
      "Ask for a reference or ticket number if they have one.",
    ];
    readBack = "Read back each answer and any reference or ticket number, then ask them to confirm.";
  } else {
    const amount = input.amountMinor === null ? "the duplicate charge" : formatAmount(input.amountMinor, input.currency);
    goal = `Ask ${name} to refund the duplicate charge of ${amount} and get a reference number.`;
    steps = [
      opening,
      menu,
      `Explain the duplicate charge and request a refund of ${amount}.`,
      verify,
      "Ask for a reference number and when the refund will appear.",
    ];
    readBack = "Read back the reference number, the refund timeline and the next step, then ask them to confirm.";
  }
  return {
    goal: goal.slice(0, L.goalChars),
    steps: steps.slice(0, L.steps).map((s) => s.slice(0, L.stepChars)),
    readBack: readBack.slice(0, L.readBackChars),
  };
}
