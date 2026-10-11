/**
 * Keewano custom event registry for the refund assistant.
 *
 * Keewano stores one typed value per event, per entity, in time order. Two entity
 * kinds are used here:
 *   - a refund case (entity id = case id): timeline entry types, derived status,
 *     merchant, amount, call states, outcome and the history-check result;
 *   - a customer (entity id = uuidV5 of email or name): synthetic card charges as
 *     ChargeMerchant, ChargeAmount, ChargeCurrency and finally ChargeId. Keewano
 *     carries each column forward until the next value, so the ChargeId row is
 *     the row where the other three columns describe that charge.
 *
 * Append only: a registered id never changes its name or type (Keewano rejects
 * that); add a new id instead. Ids start at 2000 as in the SpeedHacks quickstart and
 * stay contiguous: Keewano's own listing (list_event_types, 2026-10-11) numbers the
 * registered list by position (2000 + index). Events sent with the registry hash were
 * mapped correctly even when this list had a gap, but keeping both numberings identical
 * removes any doubt when reading ids off the Keewano UI or MCP tools.
 *
 * No "@/" or relative imports here: plain `node` loads this module from the seed CLI.
 */
import { createHash } from "node:crypto";

export type KeewanoDataType = "none" | "string" | "uint" | "bool" | "price_usd_cent" | "timestamp";

export interface KeewanoEventType {
  eventTypeId: number;
  name: string;
  dataType: KeewanoDataType;
}

export const EVENT_TYPES = [
  // Refund case entity (id = case id)
  { eventTypeId: 2000, name: "RefundCaseEvent", dataType: "string" },
  { eventTypeId: 2001, name: "RefundCaseStatus", dataType: "string" },
  { eventTypeId: 2002, name: "RefundCaseMode", dataType: "string" },
  { eventTypeId: 2003, name: "RefundMerchant", dataType: "string" },
  { eventTypeId: 2004, name: "RefundAmount", dataType: "price_usd_cent" },
  { eventTypeId: 2005, name: "RefundCallState", dataType: "string" },
  { eventTypeId: 2006, name: "RefundOutcome", dataType: "string" },
  { eventTypeId: 2007, name: "RefundHistoryCheck", dataType: "string" },
  // Customer entity (id = customerEntityId): synthetic transaction history
  { eventTypeId: 2008, name: "ChargeMerchant", dataType: "string" },
  { eventTypeId: 2009, name: "ChargeAmount", dataType: "price_usd_cent" },
  { eventTypeId: 2010, name: "ChargeCurrency", dataType: "string" },
  { eventTypeId: 2011, name: "ChargeId", dataType: "string" },
] as const satisfies readonly KeewanoEventType[];

// Guard the positional contract above at module load.
EVENT_TYPES.forEach((t, i) => {
  if (t.eventTypeId !== 2000 + i) throw new Error(`Keewano event ids must be contiguous from 2000: ${t.name} is ${t.eventTypeId}, expected ${2000 + i}`);
});

export type KeewanoEventName = (typeof EVENT_TYPES)[number]["name"];

const BY_NAME = new Map<string, KeewanoEventType>(EVENT_TYPES.map((t) => [t.name, t]));

export function eventType(name: KeewanoEventName): KeewanoEventType {
  const t = BY_NAME.get(name);
  if (!t) throw new Error(`Unknown Keewano event ${name}`);
  return t;
}

export interface KeewanoEvent {
  eventTypeId: number;
  dataType: KeewanoDataType;
  /** Unix seconds, UTC. */
  timestamp: number;
  data: string | number | boolean | null;
}

export const MAX_STRING_LENGTH = 256;
export const MAX_UINT32 = 0xffff_ffff;

export function toUnixSeconds(at: string | number | Date): number {
  const ms = at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(ms)) throw new Error(`Invalid timestamp ${String(at)}`);
  return Math.floor(ms / 1000);
}

/** Build one event. Strings are truncated to Keewano's limit; integer types must fit uint32. */
export function event(name: KeewanoEventName, data: string | number | boolean | null, at: string | number | Date): KeewanoEvent {
  const t = eventType(name);
  let value: KeewanoEvent["data"] = data;
  switch (t.dataType) {
    case "string":
      value = String(data ?? "").slice(0, MAX_STRING_LENGTH);
      break;
    case "price_usd_cent":
    case "uint":
    case "timestamp":
      if (typeof data !== "number" || !Number.isInteger(data) || data < 0 || data > MAX_UINT32) {
        throw new Error(`${name} needs an integer in 0..${MAX_UINT32}, got ${String(data)}`);
      }
      break;
    case "bool":
      value = Boolean(data);
      break;
    case "none":
      value = null;
      break;
  }
  return { eventTypeId: t.eventTypeId, dataType: t.dataType, timestamp: toUnixSeconds(at), data: value };
}

// ---------------------------------------------------------------------------
// customEventsHash: names this exact registry in /custom and in every /in batch.
// ---------------------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(input: string | Uint8Array): number {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let crc = 0xffffffff;
  for (const b of bytes) crc = (CRC_TABLE[(crc ^ b) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** JSON with object keys sorted at every level, so the hash does not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** CRC32 of the canonical registry, never 0 (0 means "no custom events" to Keewano). */
export const EVENTS_HASH = crc32(canonicalJson(EVENT_TYPES)) || 1;

// ---------------------------------------------------------------------------
// Entity ids: Keewano needs UUIDs. Cases already have one; customers get a v5
// UUID derived from their email (preferred) or name, as the quickstart suggests.
// ---------------------------------------------------------------------------

export const UUID_NAMESPACE_DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
export const UUID_NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuidV5(name: string, namespace: string = UUID_NAMESPACE_URL): string {
  if (!UUID_PATTERN.test(namespace)) throw new Error("namespace must be a UUID");
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(ns).update(name, "utf8").digest();
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function normalizeName(input: string): string {
  return input.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

/**
 * Candidate entity ids for a customer, best first: the email-derived id, then the
 * name-derived id. Charges are stored under the email id when an email is known, so a
 * lookup tries the email id first and falls back to the name id (a case created with a
 * name only must still find a customer who was seeded with an email).
 */
export function customerEntityIds(customer: { email: string | null; name: string | null }): string[] {
  const ids: string[] = [];
  const email = customer.email?.trim().toLowerCase();
  if (email) ids.push(uuidV5(`speedhacks-refund:customer:email:${email}`));
  const name = customer.name ? normalizeName(customer.name) : "";
  if (name) ids.push(uuidV5(`speedhacks-refund:customer:name:${name}`));
  return ids;
}

/** Stable customer entity id (the best candidate), or null when neither email nor name is known. */
export function customerEntityId(customer: { email: string | null; name: string | null }): string | null {
  return customerEntityIds(customer)[0] ?? null;
}
