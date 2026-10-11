/**
 * Wire types for GET /api/insurers, mirrored from the backend at
 * origin/codex/voice f8a65a4: src/server/insurers/types.ts (unions,
 * InsurerContact, InsurerTerm, OpenQuestion) and src/server/insurers/index.ts
 * (InsurerSummary, InsurerLookup). The UI cannot import src/server/**
 * (server-only code), so these are copied field for field. A type-only test
 * in __tests__/insurers.test.ts fails the typecheck if they drift.
 *
 * Server conventions: unknown facts are null, never fabricated; phone numbers
 * are E.164; every fact carries a source URL, a retrieval date and a
 * confidence level.
 */

export type InsurerCategory = "auto" | "property" | "life" | "health" | "disability" | "business" | "pet" | "travel";

export type ContactPurpose = "customer_service" | "claims" | "billing" | "cancellation" | "appeals";

export type ContactChannel = "phone" | "web" | "app" | "mail";

/**
 * national: geographic reach; notes may still limit the product or plan.
 * regional: only for a region or state (see `region`); never auto-filled.
 * plan_specific: the real number is on the member's ID card; never auto-filled.
 * corporate_only: switchboard or corporate line that cannot access accounts.
 */
export type ContactScope = "national" | "regional" | "plan_specific" | "corporate_only";

/**
 * verified_official: read from a page on the insurer's own domain (cited).
 * reported: third-party source; must be confirmed before dialing.
 * regulatory_default: a legal or regulatory figure, not the insurer's statement.
 * unknown: nothing found; the value is null.
 */
export type Confidence = "verified_official" | "reported" | "regulatory_default" | "unknown";

export type TermKey =
  | "free_look_days"
  | "cancellation_method"
  | "cancellation_refund_method"
  | "cancellation_fee"
  | "cancellation_notice_days"
  | "premium_refund_timeline"
  | "billing_dispute_process"
  | "grace_period_days"
  | "waiting_period_days"
  | "claim_filing_method"
  | "claim_report_deadline"
  | "claim_decision_timeline"
  | "appeal_method"
  | "appeal_window_days"
  | "external_review"
  | "external_review_window"
  | "identity_verification_on_call"
  | "arbitration_clause";

export interface InsurerContact {
  purpose: ContactPurpose;
  channel: ContactChannel;
  scope: ContactScope;
  /** Recorded region, state or plan; also review notes for restrictions on national contacts. */
  region: string | null;
  /**
   * Result of re-fetching sourceUrl: true = digits present and the page's label
   * fits `purpose`; false = digits absent or the label does not fit (never
   * auto-dialed); null = not re-checked.
   */
  purposeVerified: boolean | null;
  /** E.164 (+1 and ten digits for US). Null when the channel is not phone or the number is unverified. */
  phoneE164: string | null;
  hours: string | null;
  url: string | null;
  notes: string | null;
  sourceUrl: string | null;
  retrievedAt: string | null;
  confidence: Confidence;
}

export interface InsurerTerm {
  /** One of the insurer's lines, or "all". */
  line: string;
  key: TermKey;
  value: string | null;
  valueNumber: number | null;
  unit: string | null;
  jurisdictionScope: string | null;
  notes: string | null;
  sourceUrl: string | null;
  /** Optional, under 15 words. Never page text. */
  sourceQuote: string | null;
  retrievedAt: string | null;
  confidence: Confidence;
}

export interface OpenQuestion {
  question: string;
  whyItMatters: string;
}

export interface InsurerSummary {
  id: string;
  name: string;
  legalName: string | null;
  parentId: string | null;
  categories: InsurerCategory[];
  lines: string[];
  /** Names a customer or an extracted document might use for this insurer. */
  aliases: string[];
  eligibility: string | null;
  website: string | null;
  tosUrl: string | null;
  privacyUrl: string | null;
  notes: string | null;
}

export interface InsurerLookup extends InsurerSummary {
  /**
   * Best national customer-service number: verified_official preferred, then
   * reported. Null when none is usable or distinct best candidates tie;
   * national reach alone does not identify the customer's product or plan.
   */
  supportPhone: string | null;
  supportPhoneConfidence: Confidence | null;
  claimsPhone: string | null;
  claimsPhoneConfidence: Confidence | null;
  /** True when candidate numbers need clarification or depend on plan or region. False does not establish customer applicability. */
  needsPlanOrRegion: boolean;
  contacts: InsurerContact[];
  terms: InsurerTerm[];
  openQuestions: OpenQuestion[];
  /** How the looked-up name resolved; `matched` is the id, name or alias it matched. */
  match: { via: "id" | "name" | "alias" | "tokens"; matched: string };
}
