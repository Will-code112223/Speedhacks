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
