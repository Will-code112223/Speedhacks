/**
 * Insurer knowledge base — seed shapes.
 *
 * Owned by teammate 2 (case engine). This is reference data the case engine
 * can use to fill `merchant.supportPhone` and to brief the voice agent on an
 * insurer's cancellation/refund, billing-dispute, claim and appeal terms.
 *
 * Conventions follow the shared contract: unknown facts are null, never
 * fabricated; every fact carries a source URL, a retrieval date and a
 * confidence level. Phone numbers are E.164 and are rejected at load time if
 * they are not.
 */

export const INSURER_CATEGORIES = [
  "auto",
  "property",
  "life",
  "health",
  "disability",
  "business",
  "pet",
  "travel",
] as const;
export type InsurerCategory = (typeof INSURER_CATEGORIES)[number];

export const CONTACT_PURPOSES = [
  "customer_service",
  "claims",
  "billing",
  "cancellation",
  "appeals",
] as const;
export type ContactPurpose = (typeof CONTACT_PURPOSES)[number];

export const CONTACT_CHANNELS = ["phone", "web", "app", "mail"] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

/**
 * national       — one line for every customer; safe to dial for any case.
 * regional       — only for a region/state (see `region`); never auto-filled.
 * plan_specific  — the real number is on the member's ID card; never auto-filled.
 * corporate_only — switchboard/corporate line that cannot access accounts.
 */
export const CONTACT_SCOPES = ["national", "regional", "plan_specific", "corporate_only"] as const;
export type ContactScope = (typeof CONTACT_SCOPES)[number];

/**
 * verified_official — read from a page on the insurer's own domain (cited).
 * reported          — third-party source; must be confirmed before dialing.
 * regulatory_default — a legal/regulatory figure, not the insurer's statement.
 * unknown           — nothing found; value is null.
 */
export const CONFIDENCE_LEVELS = [
  "verified_official",
  "reported",
  "regulatory_default",
  "unknown",
] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export const TERM_KEYS = [
  "free_look_days",
  "cancellation_method",
  "cancellation_refund_method",
  "cancellation_fee",
  "cancellation_notice_days",
  "premium_refund_timeline",
  "billing_dispute_process",
  "grace_period_days",
  "waiting_period_days",
  "claim_filing_method",
  "claim_report_deadline",
  "claim_decision_timeline",
  "appeal_method",
  "appeal_window_days",
  "external_review",
  "external_review_window",
  "identity_verification_on_call",
  "arbitration_clause",
] as const;
export type TermKey = (typeof TERM_KEYS)[number];

export interface InsurerContact {
  purpose: ContactPurpose;
  channel: ContactChannel;
  scope: ContactScope;
  /** Region/state/plan the contact applies to when scope is not national. */
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
  /** Optional, under 15 words. Never store page text. */
  sourceQuote: string | null;
  retrievedAt: string | null;
  confidence: Confidence;
}

export interface OpenQuestion {
  question: string;
  whyItMatters: string;
}

export interface InsurerSeed {
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
  officialDomains: string[];
  tosUrl: string | null;
  privacyUrl: string | null;
  notes: string | null;
  contacts: InsurerContact[];
  terms: InsurerTerm[];
  openQuestions: OpenQuestion[];
}

export interface RegulatoryDefault {
  line: string;
  jurisdiction: string;
  key: TermKey;
  value: string;
  valueNumber: number | null;
  unit: string | null;
  notes: string | null;
  sourceUrl: string | null;
  sourceQuote: string | null;
  retrievedAt: string | null;
  confidence: Confidence;
}

/** Strict E.164 for US numbers: "+1" followed by ten digits. */
export const US_E164 = /^\+1\d{10}$/;
