/**
 * Reading a customer's synthetic charges back out of Keewano.
 *
 * No imports at all: plain `node` loads this module from the CLI, and the case engine
 * uses it through src/integrations/keewano/history.ts.
 */

export interface ChargeRow {
  chargeId: string;
  merchant: string;
  amountMinor: number;
  currency: string;
  /** ISO-8601 UTC */
  at: string;
}

export type SqlRow = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Keewano SQL (PostgreSQL-like, one `events` table, one column per event name, values
 * carried forward). ChargeId is the last event sent for a charge, so rows where it is set
 * carry that charge's merchant, amount and currency. Rows after it still carry the same
 * ChargeId forward; chargesFromRows() keeps the first row per id.
 */
export function buildChargesSql(entityId: string, limit = 500): string {
  if (!UUID.test(entityId)) throw new Error("entity id must be a UUID");
  const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 5000) : 500;
  return [
    `SELECT event_datetime, "ChargeId", "ChargeMerchant", "ChargeAmount", "ChargeCurrency"`,
    `FROM events`,
    `WHERE user_id = '${entityId}' AND "ChargeId" IS NOT NULL`,
    `ORDER BY event_datetime, "ChargeId"`,
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

function asInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : Number.NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** Accepts ISO strings, "YYYY-MM-DD HH:MM:SS" (UTC), unix seconds or milliseconds. */
export function asIso(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === "number" && Number.isFinite(v)) {
    const ms = v < 1e12 ? v * 1000 : v;
    return new Date(ms).toISOString();
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) return asIso(Number(s));
    // Keewano times are UTC: a zone-less "YYYY-MM-DD HH:MM:SS[.fff]" must not be read as local time.
    const zoneless = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(s);
    const ms = zoneless ? Date.parse(`${zoneless[1]}T${zoneless[2]}Z`) : Date.parse(s);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  return null;
}

/** First row per ChargeId wins (later rows only carry the id forward). Oldest first. */
export function chargesFromRows(rows: readonly SqlRow[]): ChargeRow[] {
  const out = new Map<string, ChargeRow>();
  for (const row of rows) {
    const chargeId = asString(pick(row, "ChargeId"));
    if (!chargeId || out.has(chargeId)) continue;
    const merchant = asString(pick(row, "ChargeMerchant"));
    const amountMinor = asInt(pick(row, "ChargeAmount"));
    const currency = (asString(pick(row, "ChargeCurrency")) ?? "USD").toUpperCase();
    const at = asIso(pick(row, "event_datetime", "eventDatetime", "event_time", "timestamp"));
    if (!merchant || amountMinor === null || !at) continue;
    out.set(chargeId, { chargeId, merchant, amountMinor, currency, at });
  }
  return [...out.values()].sort((a, b) => a.at.localeCompare(b.at) || a.chargeId.localeCompare(b.chargeId));
}
