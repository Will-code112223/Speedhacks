/**
 * Case fact rules, mirroring the server (src/server/cases/facts.ts on
 * codex/case-engine) so fixture mode rejects and accepts the same input.
 */

import type { CaseChanges, CaseV1 } from "../../../../contracts/case";
import { isRecord } from "../validate";

export type Facts = Pick<CaseV1, "customer" | "merchant" | "amountMinor" | "currency" | "reason"> & {
  /** V1.2 insurance facts; null when unknown. Not required for a call. */
  policyNumber: string | null;
  incidentDate: string | null;
  lossDescription: string | null;
  claimType: string | null;
};

const INSURANCE_FACTS = ["policyNumber", "incidentDate", "lossDescription", "claimType"] as const;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const E164 = /^\+[1-9]\d{1,14}$/;
export const CURRENCY = /^[A-Z]{3}$/;
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_AMOUNT_MINOR = 1_000_000_000_000;
const MAX_REASON_LENGTH = 2000;

export function isValidAmountMinor(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= MAX_AMOUNT_MINOR;
}

/** In the server's order, which is also the order of a 422 `fields` list. */
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

export function copyFacts(facts: Facts): Facts {
  return {
    customer: { name: facts.customer.name, email: facts.customer.email },
    merchant: { name: facts.merchant.name, supportPhone: facts.merchant.supportPhone },
    amountMinor: facts.amountMinor,
    currency: facts.currency,
    reason: facts.reason,
    policyNumber: facts.policyNumber ?? null,
    incidentDate: facts.incidentDate ?? null,
    lossDescription: facts.lossDescription ?? null,
    claimType: facts.claimType ?? null,
  };
}

/** Trimmed text, with blank meaning null; undefined when the value is not text at all. */
export function nullableText(v: unknown, max = 200): string | null | undefined {
  if (v === null) return null;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length === 0 ? null : t.slice(0, max);
}

/** Normalized changes plus the dotted names of every invalid field (400 when non-empty). */
export function validateChanges(input: unknown): { changes: CaseChanges; invalid: string[] } {
  const invalid: string[] = [];
  const changes: CaseChanges = {};
  if (!isRecord(input)) return { changes, invalid: ["changes"] };
  const c = input;

  if ("customer" in c) {
    const o = c.customer;
    if (!isRecord(o)) invalid.push("customer");
    else {
      const name = nullableText(o.name);
      const email = nullableText(o.email);
      if (name === undefined) invalid.push("customer.name");
      if (email === undefined || (email !== null && !EMAIL.test(email))) invalid.push("customer.email");
      if (name !== undefined && email !== undefined) changes.customer = { name, email };
    }
  }
  if ("merchant" in c) {
    const o = c.merchant;
    if (!isRecord(o)) invalid.push("merchant");
    else {
      const name = nullableText(o.name);
      const phone = nullableText(o.supportPhone);
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
    if (typeof v === "string" && v.trim().length > 0 && v.length <= MAX_REASON_LENGTH) changes.reason = v.trim();
    else invalid.push("reason");
  }
  for (const key of INSURANCE_FACTS) {
    if (!(key in c)) continue;
    const value = nullableText(c[key], key === "lossDescription" ? MAX_REASON_LENGTH : 200);
    if (value === undefined || (key === "incidentDate" && value !== null && !ISO_DATE.test(value))) invalid.push(key);
    else changes[key] = value;
  }
  return { changes, invalid };
}

export function applyChanges(facts: Facts, changes: CaseChanges): { next: Facts; changed: boolean } {
  const next = copyFacts(facts);
  if (changes.customer) next.customer = { ...changes.customer };
  if (changes.merchant) next.merchant = { ...changes.merchant };
  if (changes.amountMinor !== undefined) next.amountMinor = changes.amountMinor;
  if (changes.currency !== undefined) next.currency = changes.currency;
  if (changes.reason !== undefined) next.reason = changes.reason;
  for (const key of INSURANCE_FACTS) if (changes[key] !== undefined) next[key] = changes[key] ?? null;
  return { next, changed: JSON.stringify(next) !== JSON.stringify(copyFacts(facts)) };
}

/** The facts an authorization freezes; the call reads only these, never the live case. */
export interface FrozenFacts {
  customerName: string;
  customerEmail: string | null;
  merchantName: string;
  supportPhone: string;
  amountMinor: number;
  currency: string;
  reason: string;
}

/** Every required fact, narrowed to non-null, or null while any is missing. */
export function freeze(facts: Facts): FrozenFacts | null {
  const { customer, merchant, amountMinor } = facts;
  if (missingFields(facts).length > 0) return null;
  if (customer.name === null || merchant.name === null || merchant.supportPhone === null || amountMinor === null) {
    return null;
  }
  return {
    customerName: customer.name,
    customerEmail: customer.email,
    merchantName: merchant.name,
    supportPhone: merchant.supportPhone,
    amountMinor,
    currency: facts.currency,
    reason: facts.reason,
  };
}
