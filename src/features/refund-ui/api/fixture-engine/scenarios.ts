/** The fixture scenarios: what simulated extraction finds and how the provider behaves. */

import type { FixtureScenario } from "../types";
import { insuranceClaimCall, refundCallQuick, refundCallStandard, type Conversation } from "./conversations";

export type RequestKind = "refund" | "claim";

export type DispatchBehavior =
  /** The provider accepts the call and the conversation plays. */
  | { kind: "accepted"; conversation: Conversation }
  /** The request may have reached the provider but no answer came back; never redialed. */
  | { kind: "unknown"; afterMs: number; error: string };

export interface ScenarioDefinition {
  id: FixtureScenario;
  kind: RequestKind;
  /** Facts the simulated extraction returns; null is "not found", never a guess. */
  extracted: {
    customerName: string | null;
    customerEmail: string | null;
    merchantName: string | null;
    supportPhone: string | null;
    amountMinor: number | null;
    currency: string;
  };
  /** Reason used when the case is created from files alone, as if read from them. */
  documentReason: string;
  dispatch: DispatchBehavior;
}

const CUSTOMER = "Jordan Avery";
const RIDGELINE = { merchantName: "Ridgeline Outfitters billing", supportPhone: "+14155550177" };
/** The demo's AAA claims line; the policyholder's AAA auto declarations page gives this number. */
const AAA_CLAIMS = { merchantName: "AAA claims line", supportPhone: "+19495200007" };
const DUPLICATE_REASON = "Charged twice for the same order; refund the duplicate charge.";

export const DISPATCH_UNKNOWN_ERROR =
  "Dial may have received this call request. Do not redial; reconcile the stored attempt first.";

export const SCENARIOS: Record<FixtureScenario, ScenarioDefinition> = {
  insurance_claim: {
    id: "insurance_claim",
    kind: "claim",
    // No repair estimate exists yet, so no amount is known; a claim is filed without one (see facts.ts).
    extracted: { customerName: CUSTOMER, customerEmail: null, ...AAA_CLAIMS, amountMinor: null, currency: "USD" },
    documentReason:
      "Rear-ended on October 10 by a silver sedan, CA plate 8UFJ426; filing a collision claim for the damage to my car.",
    dispatch: { kind: "accepted", conversation: insuranceClaimCall },
  },
  duplicate_charge: {
    id: "duplicate_charge",
    kind: "refund",
    extracted: { customerName: CUSTOMER, customerEmail: null, ...RIDGELINE, amountMinor: 4_999, currency: "USD" },
    documentReason: DUPLICATE_REASON,
    dispatch: { kind: "accepted", conversation: refundCallStandard },
  },
  needs_evidence: {
    id: "needs_evidence",
    kind: "refund",
    extracted: {
      customerName: CUSTOMER,
      customerEmail: null,
      merchantName: RIDGELINE.merchantName,
      supportPhone: null,
      amountMinor: null,
      currency: "USD",
    },
    documentReason: DUPLICATE_REASON,
    dispatch: { kind: "accepted", conversation: refundCallStandard },
  },
  uncertain_dispatch: {
    id: "uncertain_dispatch",
    kind: "refund",
    extracted: { customerName: CUSTOMER, customerEmail: null, ...RIDGELINE, amountMinor: 4_999, currency: "USD" },
    documentReason: DUPLICATE_REASON,
    dispatch: { kind: "unknown", afterMs: 4_000, error: DISPATCH_UNKNOWN_ERROR },
  },
  call_complete_unconfirmed: {
    id: "call_complete_unconfirmed",
    kind: "refund",
    extracted: { customerName: CUSTOMER, customerEmail: null, ...RIDGELINE, amountMinor: 4_999, currency: "USD" },
    documentReason: DUPLICATE_REASON,
    dispatch: { kind: "accepted", conversation: refundCallQuick },
  },
};

/** Words that pick the insurance claim: a claim or insurance, a car accident, or AAA by name. */
const CLAIM_WORDS = ["claim", "insurance", "accident", "rear-end", "rear end", "collision", "aaa", "triple a"];

/**
 * Picks a scenario from the user's words. Checked in this order, first match
 * wins, case-insensitive substrings; the header's fixture picker overrides it.
 */
export function inferScenario(summary: string): FixtureScenario {
  const text = summary.toLowerCase();
  if (CLAIM_WORDS.some((word) => text.includes(word))) return "insurance_claim";
  if (text.includes("duplicate")) return "duplicate_charge";
  if (text.includes("no receipt") || text.includes("lost")) return "needs_evidence";
  if (text.includes("uncertain")) return "uncertain_dispatch";
  if (text.includes("confirm")) return "call_complete_unconfirmed";
  return "insurance_claim";
}
