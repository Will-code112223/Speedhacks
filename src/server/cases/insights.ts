/**
 * Merchant-insights port: "how has this merchant handled refund requests so far?"
 * Keewano implements it over the mirrored cases (src/integrations/keewano/insights.ts);
 * a labeled fixture stands in when Keewano is not configured. Aggregate reference data
 * only: no customer data, no case facts, nothing here changes a case.
 */
import { merchantMatches } from "@/server/cases/history";

export interface MerchantRecord {
  /** The merchant name as asked (not the mirrored spelling). */
  merchant: string;
  /** Where the numbers came from, e.g. "keewano" or "fixture". */
  source: string;
  /** Mirrored cases at this merchant whose outcome was ever recorded. */
  cases: number;
  approved: number;
  denied: number;
  needsInformation: number;
  /** Cases with no decision yet: outcome unknown or requested (or any unrecognized value). */
  unresolved: number;
  /** approved / (approved + denied), rounded to three decimals; null when nothing was decided. */
  approvalRate: number | null;
  /** When the most recent non-unknown outcome was set (ISO-8601 UTC), null when none. */
  lastOutcomeAt: string | null;
}

export interface MerchantInsights {
  /** Label returned as MerchantRecord.source, e.g. "keewano" or "fixture". */
  readonly kind: string;
  merchantRecord(merchantName: string): Promise<MerchantRecord>;
}

/** One mirrored row: the case's merchant and outcome as of `at` (values carry forward). */
export interface OutcomeRow {
  caseId: string;
  merchant: string;
  outcome: string;
  /** ISO-8601 UTC */
  at: string;
}

/** What GET /api/insights/merchant returns: the record when a source answered, otherwise why not. */
export type MerchantInsightsResult = ({ available: true } & MerchantRecord) | { available: false; merchant: string; error?: string };

/** A record captured for one case revision and frozen with its authorization. */
export type FrozenMerchantRecord = MerchantRecord & { revision: number; checkedAt: string };

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** One-line summary for the timeline and the packet. */
export function merchantRecordSummary(r: MerchantRecord): string {
  const label = `Merchant track record (${r.source})`;
  if (r.cases === 0) return `${label}: no refund calls to ${r.merchant} on record yet.`;
  const parts = [`${r.approved} of ${r.cases} refund requests approved${r.approvalRate !== null ? ` (${pct(r.approvalRate)} of decided)` : ""}`];
  if (r.denied > 0) parts.push(`${r.denied} denied`);
  if (r.needsInformation > 0) parts.push(`${r.needsInformation} needed more information`);
  if (r.unresolved > 0) parts.push(`${r.unresolved} unresolved`);
  return `${label}: ${r.merchant} — ${parts.join(", ")}${r.lastOutcomeAt ? `; last outcome ${r.lastOutcomeAt}` : ""}.`;
}

/** Lines frozen into the call brief: the numbers, then what they mean for this call. */
export function merchantRecordLines(r: MerchantRecord): string[] {
  const lines = ["Merchant track record:", `- ${merchantRecordSummary(r)}`];
  if (r.cases === 0 || r.approvalRate === null) {
    lines.push("- No prior decisions are known for this merchant; proceed on the facts above.");
  } else if (r.approvalRate >= 0.6) {
    lines.push("- This merchant usually approves refund requests like this one: ask directly for the refund and a reference number.");
  } else if (r.approvalRate < 0.4) {
    lines.push("- This merchant often declines: ask what evidence or process is required and record the answer for the customer.");
  } else {
    lines.push("- Outcomes are mixed: state the evidence clearly and ask for a reference number for whatever is decided.");
  }
  return lines;
}

export function emptyMerchantRecord(merchant: string, source: string): MerchantRecord {
  return { merchant, source, cases: 0, approved: 0, denied: 0, needsInformation: 0, unresolved: 0, approvalRate: null, lastOutcomeAt: null };
}

/**
 * Pure reduction of forward-filled outcome rows into one merchant's record. Rows are
 * sorted by time here; the LAST row per case wins (it carries the case's current merchant
 * and outcome), then cases are matched to the merchant with merchantMatches, so abbreviated
 * statement descriptors still count and other merchants are ignored.
 */
export function summarizeOutcomes(rows: readonly OutcomeRow[], merchantName: string, source = "keewano"): MerchantRecord {
  const sorted = [...rows].sort((a, b) => a.at.localeCompare(b.at) || a.caseId.localeCompare(b.caseId));
  const last = new Map<string, { merchant: string; outcome: string; outcomeAt: string }>();
  for (const row of sorted) {
    const prev = last.get(row.caseId);
    // Rows repeat the outcome until it changes; remember when the current value was set.
    const outcomeAt = prev && prev.outcome === row.outcome ? prev.outcomeAt : row.at;
    last.set(row.caseId, { merchant: row.merchant, outcome: row.outcome, outcomeAt });
  }
  const record = emptyMerchantRecord(merchantName, source);
  for (const c of last.values()) {
    if (!merchantMatches(c.merchant, merchantName)) continue;
    record.cases += 1;
    switch (c.outcome) {
      case "approved":
        record.approved += 1;
        break;
      case "denied":
        record.denied += 1;
        break;
      case "needs_information":
        record.needsInformation += 1;
        break;
      default:
        record.unresolved += 1;
    }
    if (c.outcome !== "unknown" && (record.lastOutcomeAt === null || c.outcomeAt > record.lastOutcomeAt)) {
      record.lastOutcomeAt = c.outcomeAt;
    }
  }
  const decided = record.approved + record.denied;
  record.approvalRate = decided > 0 ? Math.round((record.approved / decided) * 1000) / 1000 : null;
  return record;
}
