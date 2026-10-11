/**
 * The editable case facts, their labels, validation, and the mapping between
 * the form, the contract's CaseChanges, and server field names in
 * missingFields and 422 errors.
 */

import type { CaseChanges, CaseV1 } from "../../../contracts/case";
import {
  amountInputValue,
  isPlausibleEmail,
  normalizePhone,
  parseAmountToMinor,
  PHONE_HINT,
} from "../ui/format";

export type FactKey = "customerName" | "customerEmail" | "merchantName" | "supportPhone" | "amountMinor" | "currency" | "reason";

export const FACT_KEYS: readonly FactKey[] = [
  "customerName",
  "customerEmail",
  "merchantName",
  "supportPhone",
  "amountMinor",
  "currency",
  "reason",
];

export const FACT_LABELS: Record<FactKey, string> = {
  customerName: "Your name",
  customerEmail: "Your email",
  merchantName: "Insurer or merchant",
  supportPhone: "Support phone",
  amountMinor: "Amount",
  currency: "Currency",
  reason: "Reason",
};

export type FactsDraft = Record<FactKey, string>;
export type FactErrors = Partial<Record<FactKey, string>>;

export const CURRENCIES = ["USD", "CAD", "EUR", "GBP", "AUD"] as const;

export function draftFromCase(caseData: CaseV1): FactsDraft {
  return {
    customerName: caseData.customer.name ?? "",
    customerEmail: caseData.customer.email ?? "",
    merchantName: caseData.merchant.name ?? "",
    supportPhone: caseData.merchant.supportPhone ?? "",
    amountMinor: amountInputValue(caseData.amountMinor, caseData.currency),
    currency: caseData.currency,
    reason: caseData.reason,
  };
}

/**
 * Validates the draft against the same rules the server applies to a PATCH.
 * Facts may stay blank (they show as missing); anything typed must be valid,
 * and a reason the case already has cannot be cleared.
 */
export function validateFacts(draft: FactsDraft, caseData: CaseV1): FactErrors {
  const errors: FactErrors = {};
  if (draft.reason.trim() === "" && caseData.reason.trim() !== "") {
    errors.reason = "Add a short reason for the request.";
  }
  if (draft.customerEmail.trim() !== "" && !isPlausibleEmail(draft.customerEmail)) {
    errors.customerEmail = "Enter an email like name@example.com.";
  }
  if (draft.supportPhone.trim() !== "" && normalizePhone(draft.supportPhone) === null) {
    errors.supportPhone = PHONE_HINT;
  }
  const amount = parseAmountToMinor(draft.amountMinor, draft.currency);
  if (!amount.ok) errors.amountMinor = amount.error;
  if (!/^[A-Z]{3}$/.test(draft.currency)) errors.currency = "Choose a currency.";
  return errors;
}

function nullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The minimal CaseChanges that move the case to the draft. Groups follow the
 * contract: customer and merchant are sent whole. Returns null when nothing
 * changed. Call only with a draft that passed validateFacts.
 */
export function changesFromDraft(caseData: CaseV1, draft: FactsDraft): CaseChanges | null {
  const changes: CaseChanges = {};
  const customer = { name: nullable(draft.customerName), email: nullable(draft.customerEmail) };
  if (customer.name !== caseData.customer.name || customer.email !== caseData.customer.email) {
    changes.customer = customer;
  }
  const phoneInput = nullable(draft.supportPhone);
  const merchant = {
    name: nullable(draft.merchantName),
    supportPhone: phoneInput === null ? null : (normalizePhone(phoneInput) ?? phoneInput),
  };
  if (merchant.name !== caseData.merchant.name || merchant.supportPhone !== caseData.merchant.supportPhone) {
    changes.merchant = merchant;
  }
  const amount = parseAmountToMinor(draft.amountMinor, draft.currency);
  if (amount.ok && amount.minor !== caseData.amountMinor) changes.amountMinor = amount.minor;
  if (draft.currency !== caseData.currency) changes.currency = draft.currency;
  const reason = draft.reason.trim();
  if (reason !== caseData.reason.trim()) changes.reason = reason;
  return Object.keys(changes).length > 0 ? changes : null;
}

/**
 * Maps a server field name ("merchant.supportPhone", "amountMinor", "phone")
 * to a form field. Unknown names return null and are shown as written.
 */
export function factKeyForServerField(field: string): FactKey | null {
  const key = field.toLowerCase().replace(/[^a-z]/g, "");
  switch (key) {
    case "customername":
    case "name":
    case "customer":
      return "customerName";
    case "customeremail":
    case "email":
      return "customerEmail";
    case "merchantname":
    case "merchant":
    case "insurer":
    case "insurername":
      return "merchantName";
    case "supportphone":
    case "merchantsupportphone":
    case "phone":
    case "phonenumber":
      return "supportPhone";
    case "amount":
    case "amountminor":
      return "amountMinor";
    case "currency":
      return "currency";
    case "reason":
      return "reason";
    default:
      return null;
  }
}

/** A readable label for any server field name. */
export function labelForServerField(field: string): string {
  const key = factKeyForServerField(field);
  if (key) return FACT_LABELS[key];
  const spaced = field
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .trim()
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
