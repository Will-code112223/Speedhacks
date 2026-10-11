/**
 * Merchant refund track record read back out of the mirrored cases in Keewano.
 *
 * Every case is mirrored as custom events keyed by case id (entity = user_id), with
 * "RefundMerchant" and "RefundOutcome" carried forward row to row. One query reads every
 * row that has an outcome; the merchant is matched in TypeScript (statement descriptors
 * vary, so SQL equality would miss "ACME STREAMING INC") and summarizeOutcomes keeps the
 * last row per case. Nothing here changes a case or reads customer data.
 */
import { summarizeOutcomes, type MerchantInsights, type MerchantRecord, type OutcomeRow } from "@/server/cases/insights";
import { asIso } from "./charges";
import type { KeewanoMcpClient } from "./mcp";

type SqlRow = Record<string, unknown>;

export function buildOutcomesSql(limit = 5000): string {
  const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 5000) : 5000;
  return [
    `SELECT user_id, event_datetime, "RefundMerchant", "RefundOutcome"`,
    `FROM events`,
    `WHERE "RefundOutcome" IS NOT NULL`,
    `ORDER BY event_datetime`,
    `LIMIT ${n}`,
  ].join("\n");
}

function keyOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function pick(row: SqlRow, ...names: string[]): unknown {
  const wanted = names.map(keyOf);
  for (const [k, v] of Object.entries(row)) {
    if (wanted.includes(keyOf(k))) return v;
  }
  return undefined;
}

function asString(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** Rows missing a case id, merchant, outcome or a parseable time are dropped (never guessed). */
export function outcomeRowsFromRows(rows: readonly SqlRow[]): OutcomeRow[] {
  const out: OutcomeRow[] = [];
  for (const row of rows) {
    const caseId = asString(pick(row, "user_id", "userId", "entity_id", "entity"));
    const merchant = asString(pick(row, "RefundMerchant"));
    const outcome = asString(pick(row, "RefundOutcome"));
    const at = asIso(pick(row, "event_datetime", "eventDatetime", "event_time", "timestamp"));
    if (!caseId || !merchant || !outcome || !at) continue;
    out.push({ caseId, merchant, outcome, at });
  }
  return out;
}

/** Live: the merchant's record from the mirrored cases in Keewano over MCP. */
export class KeewanoMerchantInsights implements MerchantInsights {
  readonly kind = "keewano";
  private readonly mcp: Pick<KeewanoMcpClient, "runSql">;
  private readonly limit: number;

  constructor(mcp: Pick<KeewanoMcpClient, "runSql">, opts: { limit?: number } = {}) {
    this.mcp = mcp;
    this.limit = opts.limit ?? 5000;
  }

  async merchantRecord(merchantName: string): Promise<MerchantRecord> {
    const rows = await this.mcp.runSql(buildOutcomesSql(this.limit));
    return summarizeOutcomes(outcomeRowsFromRows(rows), merchantName, this.kind);
  }
}

/**
 * SYNTHETIC track record for the demo merchants (the same ones as seed/transactions.json).
 * Expanded into outcome rows and reduced by summarizeOutcomes, so the fixture answers
 * exactly like Keewano would. Every number here is invented.
 */
export const FIXTURE_TRACK_RECORD: ReadonlyArray<{
  merchant: string;
  approved: number;
  denied: number;
  needsInformation: number;
  unresolved: number;
  /** When the most recent outcome was set; earlier cases are spaced one day apart before it. */
  lastOutcomeAt: string;
}> = [
  { merchant: "Acme Streaming", approved: 9, denied: 2, needsInformation: 1, unresolved: 1, lastOutcomeAt: "2026-10-09T17:42:13.000Z" },
  { merchant: "Northwind Gym", approved: 3, denied: 3, needsInformation: 0, unresolved: 1, lastOutcomeAt: "2026-10-08T15:10:44.000Z" },
  { merchant: "Blue Bottle Coffee", approved: 4, denied: 0, needsInformation: 0, unresolved: 0, lastOutcomeAt: "2026-10-06T19:05:30.000Z" },
  { merchant: "Bay Area Transit", approved: 1, denied: 3, needsInformation: 1, unresolved: 0, lastOutcomeAt: "2026-10-07T12:31:09.000Z" },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** One row per synthetic case: the newest approved/denied/needs_information case sits at lastOutcomeAt. */
export function fixtureOutcomeRows(table = FIXTURE_TRACK_RECORD): OutcomeRow[] {
  const rows: OutcomeRow[] = [];
  for (const m of table) {
    const slug = m.merchant.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const end = Date.parse(m.lastOutcomeAt);
    const buckets: Array<[string, number]> = [
      ["approved", m.approved],
      ["denied", m.denied],
      ["needs_information", m.needsInformation],
      ["requested", m.unresolved],
    ];
    let n = 0;
    for (const [outcome, count] of buckets) {
      for (let i = 0; i < count; i++) {
        n += 1;
        rows.push({ caseId: `fixture-${slug}-${n}`, merchant: m.merchant, outcome, at: new Date(end - (n - 1) * DAY_MS).toISOString() });
      }
    }
  }
  return rows;
}

/** Stand-in when Keewano is not configured: labeled "fixture"; zeros for any other merchant. */
export class FixtureMerchantInsights implements MerchantInsights {
  readonly kind = "fixture";
  private readonly rows: OutcomeRow[];

  constructor(rows: OutcomeRow[] = fixtureOutcomeRows()) {
    this.rows = rows;
  }

  async merchantRecord(merchantName: string): Promise<MerchantRecord> {
    return summarizeOutcomes(this.rows, merchantName, this.kind);
  }
}
