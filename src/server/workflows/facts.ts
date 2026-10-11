import type { CaseV1 } from "@/contracts/case";
import type { CaseWorkflow, WorkflowFact, WorkflowFactKey, WorkflowKind } from "@/contracts/workflow";
import type { CaseRow } from "@/server/persistence/repository";

export const FACT_LABELS: Record<WorkflowFactKey, string> = {
  customerName: "Customer name", customerEmail: "Email", merchantName: "Merchant", supportPhone: "Support phone",
  amount: "Amount", currency: "Currency", product: "Product or service", orderNumber: "Order or transaction reference",
  purchaseDate: "Purchase date", issue: "Issue", desiredOutcome: "Requested outcome", lossDate: "Loss date",
  lossLocation: "Loss location", vehicle: "Vehicle", incidentDescription: "Incident description", policyNumber: "Policy number",
  insuranceProvider: "Insurance provider", claimantRole: "Claimant role", otherPartyName: "Other party", otherPartyPhone: "Other party phone",
};
export const FACT_KEYS = Object.keys(FACT_LABELS) as WorkflowFactKey[];
export function caseFacts(c: CaseRow | CaseV1): Partial<Record<WorkflowFactKey, WorkflowFact>> {
  const d = "doc" in c ? c.doc : c;
  const values: Partial<Record<WorkflowFactKey, string | null>> = { customerName: d.customer.name, customerEmail: d.customer.email,
    merchantName: d.merchant.name, supportPhone: d.merchant.supportPhone, amount: d.amountMinor === null ? null : (d.amountMinor / 100).toFixed(2),
    currency: d.currency || null, issue: d.reason || null };
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { label: FACT_LABELS[key as WorkflowFactKey], value, source: "case", sourceRefs: [] }]));
}
export function initialKind(issue: string): WorkflowKind {
  if (/\b(?:car|auto|vehicle|collision|accident|damage)\b/i.test(issue) && /\b(?:insurance|claim|policy|insurer|collision|accident)\b/i.test(issue)) return "auto_insurance";
  if (/\b(?:twice|duplicate|double[ -]charged|charged[ -]double)\b/i.test(issue)) return "duplicate_charge";
  if (/\b(?:refund|return|charged|purchase|order)\b/i.test(issue)) return "refund";
  return "other";
}
export function requiredFor(kind: WorkflowKind): WorkflowFactKey[] {
  if (kind === "auto_insurance") return ["insuranceProvider", "incidentDescription", "lossDate", "lossLocation", "vehicle", "claimantRole", "desiredOutcome"];
  if (kind === "duplicate_charge") return ["merchantName", "product", "amount", "purchaseDate", "orderNumber", "desiredOutcome"];
  if (kind === "refund") return ["merchantName", "product", "purchaseDate", "issue", "desiredOutcome"];
  return ["issue", "desiredOutcome"];
}
export function value(workflow: Pick<CaseWorkflow, "facts">, key: WorkflowFactKey): string | null { return workflow.facts[key]?.value?.trim() || null; }

const PHONE_KEYS: ReadonlySet<WorkflowFactKey> = new Set<WorkflowFactKey>(["supportPhone", "otherPartyPhone"]);
/** Descriptive keys, where a longer value that carries every word of a shorter one is the same fact stated more fully. */
const REFINABLE_KEYS: ReadonlySet<WorkflowFactKey> = new Set<WorkflowFactKey>([
  "customerName", "merchantName", "product", "issue", "desiredOutcome", "lossLocation", "vehicle",
  "incidentDescription", "insuranceProvider", "claimantRole", "otherPartyName", "lossDate", "purchaseDate",
]);
export function isPhoneKey(key: WorkflowFactKey): boolean { return PHONE_KEYS.has(key); }
/** "+19495200007" and "+1 (949) 520-0007" are one number; a leading US country code does not make two numbers. */
const nationalDigits = (s: string): string => { const d = s.replace(/\D/g, ""); return d.length === 11 && d.startsWith("1") ? d.slice(1) : d; };
export function samePhone(a: string, b: string): boolean {
  const da = nationalDigits(a);
  return da.length >= 7 && da === nationalDigits(b);
}
/** A phone number as the dialer needs it: E.164 for a North American number written any usual way, else as given. */
export function e164Phone(value: string): string {
  const d = nationalDigits(value.trim());
  return d.length === 10 && /^\+?1?[\s().-]*\d/.test(value.trim()) ? `+1${d}` : value.trim();
}
const ROLE_SYNONYMS: [RegExp, string][] = [
  [/\b(?:policy ?holder|named insured|the insured|insured|owner|customer)\b/, "policyholder"],
  [/\b(?:other|third) party\b|\bclaimant against\b/, "other party"],
  [/\bhelping|on behalf|representative|family member\b/, "helper"],
];
const canonicalRole = (s: string): string | null => ROLE_SYNONYMS.find(([re]) => re.test(s.toLowerCase()))?.[1] ?? null;
const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/**
 * The value to keep when two sources agree in substance but not in wording: the longer one, once
 * every word of the shorter appears in it ("AAA" within "AAA Insurance (CSAA Insurance Group)",
 * "red 2021 Toyota Camry" within "2021 Toyota Camry SE, red, 4-door sedan"). Null when they differ,
 * and always null for identifiers, amounts, emails and phone numbers, which never refine this way.
 */
export function refinedValue(key: WorkflowFactKey, existing: string, candidate: string): string | null {
  if (key === "claimantRole") {
    const role = canonicalRole(existing);
    return role !== null && role === canonicalRole(candidate) ? existing : null;
  }
  if (!REFINABLE_KEYS.has(key)) return null;
  const a = words(existing), b = words(candidate);
  if (a.length === 0 || b.length === 0) return null;
  const candidateIsLonger = b.length >= a.length;
  const [shorter, longer] = candidateIsLonger ? [a, b] : [b, a];
  const pool = new Set(longer);
  return shorter.every(w => pool.has(w)) ? (candidateIsLonger ? candidate : existing) : null;
}
