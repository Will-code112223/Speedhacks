/**
 * Transaction-history port: "what does the customer's charge history say about this
 * refund?" Keewano implements it (src/integrations/keewano); a labeled fixture stands in
 * when Keewano is not configured. The check runs before authorization, its result is
 * shown on the timeline and frozen into the call brief. It never changes case facts and
 * never blocks authorization: unknown stays unknown.
 */

/** One card/bank charge. Synthetic in this hackathon: no real financial data is stored. */
export interface ChargeRecord {
  chargeId: string;
  merchant: string;
  amountMinor: number;
  currency: string;
  /** ISO-8601 UTC */
  at: string;
}

export interface CustomerRef {
  name: string | null;
  email: string | null;
}

export interface TransactionHistory {
  /** Label stored with every check, e.g. "keewano" or "fixture". */
  readonly kind: string;
  listCharges(customer: CustomerRef): Promise<ChargeRecord[]>;
}

export type HistoryCheckStatus =
  | "duplicate_found" // ≥2 matching charges within the window
  | "recurring_only" // ≥2 matching charges, none within the window (looks like a subscription)
  | "single_charge" // exactly one matching charge
  | "no_match" // history exists, nothing matches merchant + amount
  | "no_history" // nothing on file for this customer
  | "unavailable"; // the source could not be queried

export interface HistoryCheck {
  revision: number;
  checkedAt: string;
  source: string;
  status: HistoryCheckStatus;
  summary: string;
  /** Charges matching the case's merchant and amount, oldest first. */
  matches: ChargeRecord[];
  /** Minutes between the two closest matching charges, when there are at least two. */
  closestGapMinutes: number | null;
}

export interface HistoryFacts {
  merchantName: string;
  amountMinor: number;
  currency: string;
}

export interface HistoryCheckOptions {
  revision: number;
  checkedAt: string;
  source: string;
  windowMinutes: number;
}

export const DEFAULT_DUPLICATE_WINDOW_MINUTES = 24 * 60;

export function normalizeMerchant(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

/** Statement descriptors are often abbreviated ("ACME STREAMING INC"), so containment counts. */
export function merchantMatches(a: string, b: string): boolean {
  const x = normalizeMerchant(a);
  const y = normalizeMerchant(b);
  if (!x || !y) return false;
  return x === y || (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x)));
}

export function findMatchingCharges(charges: readonly ChargeRecord[], facts: HistoryFacts): ChargeRecord[] {
  return charges
    .filter(
      (c) =>
        c.amountMinor === facts.amountMinor &&
        c.currency.toUpperCase() === facts.currency.toUpperCase() &&
        merchantMatches(c.merchant, facts.merchantName),
    )
    .sort((a, b) => a.at.localeCompare(b.at) || a.chargeId.localeCompare(b.chargeId));
}

function fmt(amountMinor: number, currency: string): string {
  const major = (amountMinor / 100).toFixed(2);
  return currency.toUpperCase() === "USD" ? `$${major}` : `${major} ${currency.toUpperCase()}`;
}

function fmtGap(minutes: number): string {
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${Math.round(minutes)} minute${Math.round(minutes) === 1 ? "" : "s"}`;
  if (minutes < 48 * 60) {
    const h = Math.round(minutes / 60);
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  const d = Math.round(minutes / (24 * 60));
  return `${d} day${d === 1 ? "" : "s"}`;
}

function closestGap(matches: readonly ChargeRecord[]): number | null {
  let best: number | null = null;
  for (let i = 1; i < matches.length; i++) {
    const gap = Math.abs(Date.parse(matches[i]!.at) - Date.parse(matches[i - 1]!.at)) / 60_000;
    if (best === null || gap < best) best = gap;
  }
  return best;
}

/** Pure evaluation of a customer's charges against the case facts. */
export function evaluateHistory(charges: readonly ChargeRecord[], facts: HistoryFacts, opts: HistoryCheckOptions): HistoryCheck {
  const base = { revision: opts.revision, checkedAt: opts.checkedAt, source: opts.source };
  const amount = fmt(facts.amountMinor, facts.currency);
  const label = `Transaction history (${opts.source})`;
  if (charges.length === 0) {
    return { ...base, status: "no_history", summary: `${label}: no transaction history is on file for this customer.`, matches: [], closestGapMinutes: null };
  }
  const matches = findMatchingCharges(charges, facts);
  if (matches.length === 0) {
    return {
      ...base,
      status: "no_match",
      summary: `${label}: ${charges.length} charge${charges.length === 1 ? "" : "s"} on file, none of ${amount} at ${facts.merchantName}.`,
      matches: [],
      closestGapMinutes: null,
    };
  }
  if (matches.length === 1) {
    const only = matches[0]!;
    return {
      ...base,
      status: "single_charge",
      summary: `${label}: only one charge of ${amount} at ${facts.merchantName} on file (${only.chargeId} at ${only.at}); the history does not show a second charge.`,
      matches,
      closestGapMinutes: null,
    };
  }
  const gap = closestGap(matches);
  const list = matches.map((m) => `${m.chargeId} at ${m.at}`).join(", ");
  if (gap !== null && gap <= opts.windowMinutes) {
    return {
      ...base,
      status: "duplicate_found",
      summary: `${label}: ${matches.length} charges of ${amount} at ${facts.merchantName}, the closest ${fmtGap(gap)} apart — ${list}.`,
      matches,
      closestGapMinutes: gap,
    };
  }
  return {
    ...base,
    status: "recurring_only",
    summary: `${label}: ${matches.length} charges of ${amount} at ${facts.merchantName} but none within ${fmtGap(opts.windowMinutes)} of another (closest ${gap === null ? "unknown" : fmtGap(gap)}); this looks like a recurring charge, not a duplicate — ${list}.`,
    matches,
    closestGapMinutes: gap,
  };
}

export function unavailableHistory(opts: HistoryCheckOptions, reason: string): HistoryCheck {
  return {
    revision: opts.revision,
    checkedAt: opts.checkedAt,
    source: opts.source,
    status: "unavailable",
    summary: `Transaction history (${opts.source}) could not be checked: ${reason}`,
    matches: [],
    closestGapMinutes: null,
  };
}

/** Lines frozen into the call brief and printed in the packet. */
export function historyBriefLines(check: HistoryCheck): string[] {
  const lines = ["Transaction history evidence:", `- ${check.summary}`];
  if (check.status === "duplicate_found") {
    lines.push("- You may cite these transaction references and times to support the duplicate-charge claim.");
  } else {
    lines.push("- Do not claim that the transaction history shows a duplicate; rely only on the customer's evidence on file.");
  }
  return lines;
}
