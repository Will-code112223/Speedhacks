import type { CaseChanges, CaseV1 } from "@/contracts/case";
import type { CaseDoc } from "@/server/persistence/repository";

/** E.164 with at least 8 digits, matching the Dial adapter's own validation so dispatch never fails on format. */
export const E164 = /^\+[1-9]\d{7,14}$/;
export const CURRENCY = /^[A-Z]{3}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const REQUIRED_FIELDS = [
  "customer.name",
  "merchant.name",
  "merchant.supportPhone",
  "amountMinor",
  "currency",
  "reason",
] as const;

export type Facts = Pick<CaseDoc, "customer" | "merchant" | "amountMinor" | "currency" | "reason">;

export function missingFields(facts: Facts): string[] {
  const missing: string[] = [];
  if (!facts.customer.name?.trim()) missing.push("customer.name");
  if (!facts.merchant.name?.trim()) missing.push("merchant.name");
  if (!facts.merchant.supportPhone || !E164.test(facts.merchant.supportPhone)) missing.push("merchant.supportPhone");
  if (!isValidAmountMinor(facts.amountMinor)) missing.push("amountMinor");
  if (!CURRENCY.test(facts.currency)) missing.push("currency");
  if (!facts.reason.trim()) missing.push("reason");
  return missing;
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
    if (typeof v === "string" && v.trim().length > 0 && v.length <= 2000) changes.reason = v.trim();
    else invalid.push("reason");
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
    merchant: { name: facts.merchant.name, supportPhone: facts.merchant.supportPhone },
    amountMinor: facts.amountMinor,
    currency: facts.currency,
    reason: facts.reason,
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
  if (changes.merchant) next.merchant = { ...changes.merchant };
  if ("amountMinor" in changes && changes.amountMinor !== undefined) next.amountMinor = changes.amountMinor;
  if (changes.currency !== undefined) next.currency = changes.currency;
  if (changes.reason !== undefined) next.reason = changes.reason;
  const changed = JSON.stringify(next) !== JSON.stringify(prev);
  return { next, changed };
}

/** Refund request draft; null until every required fact is present. */
export function buildDraft(facts: Facts, evidence: CaseV1["evidence"]): CaseV1["draft"] {
  if (missingFields(facts).length > 0) return null;
  const amount = formatAmount(facts.amountMinor, facts.currency);
  const subject = `Refund request: ${amount} at ${facts.merchant.name}`;
  const evidenceLines =
    evidence.length > 0
      ? evidence.map((e, i) => `  ${i + 1}. ${e.name} (${e.mimeType})`).join("\n")
      : "  (none attached)";
  const body = [
    `Hello ${facts.merchant.name} support,`,
    "",
    `My name is ${facts.customer.name}${facts.customer.email ? ` (${facts.customer.email})` : ""}.`,
    `I am requesting a refund of ${amount} for the reason described below.`,
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

export const PERMITTED_ACTIONS = [
  "Identify yourself as an AI assistant calling on behalf of the customer about their stated issue.",
  "Request a refund for the exact amount and reason approved by the customer.",
  "Do not assume a duplicate charge, eligibility, policy coverage, or an incident that the customer did not state.",
  "Ask for a reference or confirmation number and the expected refund timeline.",
  "Answer verification questions only with the facts listed; say you do not know otherwise.",
];

export const FORBIDDEN_ACTIONS = [
  "Do not agree to new charges, upgrades, or retention offers.",
  "Do not change the amount, the merchant, or the reason.",
  "Do not share or request payment card numbers, passwords, or one-time codes.",
  "Do not make commitments on the customer's behalf beyond requesting this refund.",
];

/** Immutable factual call brief frozen with the authorization. */
export function buildBrief(input: {
  caseId: string;
  revision: number;
  customer: CaseV1["customer"];
  merchant: { name: string; supportPhone: string };
  amountMinor: number;
  currency: string;
  reason: string;
  evidence: CaseV1["evidence"];
}): string {
  const amount = formatAmount(input.amountMinor, input.currency);
  return [
    `You are calling ${input.merchant.name} customer support on behalf of ${input.customer.name ?? "the customer"}.`,
    `Purpose: request a refund of ${amount} for the customer's stated reason below.`,
    "",
    "Approved facts (do not alter):",
    `- Customer name: ${input.customer.name ?? "unknown"}`,
    `- Customer email: ${input.customer.email ?? "not provided"}`,
    `- Merchant: ${input.merchant.name}`,
    `- Amount: ${amount}`,
    `- Reason given by the customer: ${input.reason}`,
    `- Evidence on file: ${input.evidence.length > 0 ? input.evidence.map((e) => e.name).join(", ") : "none"}`,
    "",
    "Permitted actions:",
    ...PERMITTED_ACTIONS.map((a) => `- ${a}`),
    "",
    "Not permitted:",
    ...FORBIDDEN_ACTIONS.map((a) => `- ${a}`),
    "",
    `Case reference: ${input.caseId} (revision ${input.revision}).`,
  ].join("\n");
}
