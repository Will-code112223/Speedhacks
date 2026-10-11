import path from "node:path";
import { openInsurerDatabase, type InsurerDb } from "./db";
import type { Confidence, ContactPurpose, ContactScope, InsurerCategory, InsurerContact, InsurerTerm, OpenQuestion, RegulatoryDefault } from "./types";

export type { InsurerContact, InsurerTerm, InsurerSeed, RegulatoryDefault, OpenQuestion, Confidence, ContactScope, TermKey } from "./types";
export { openInsurerDatabase, closeInsurerDatabase, loadSeed, validateSeed, InsurerSeedError, INSURER_SEED, REGULATORY_SEED } from "./db";

export interface InsurerSummary {
  id: string;
  name: string;
  legalName: string | null;
  parentId: string | null;
  categories: InsurerCategory[];
  lines: string[];
  aliases: string[];
  eligibility: string | null;
  website: string | null;
  tosUrl: string | null;
  privacyUrl: string | null;
  notes: string | null;
}

export interface InsurerLookup extends InsurerSummary {
  /**
   * Best NATIONAL customer-service number: verified_official preferred, then
   * reported. Null when none is usable or distinct best candidates tie —
   * national reach alone does not identify the customer's product or plan.
   */
  supportPhone: string | null;
  supportPhoneConfidence: Confidence | null;
  claimsPhone: string | null;
  claimsPhoneConfidence: Confidence | null;
  /** True when candidate numbers need clarification or depend on plan/region. False does not establish customer applicability. */
  needsPlanOrRegion: boolean;
  contacts: InsurerContact[];
  terms: InsurerTerm[];
  openQuestions: OpenQuestion[];
  match: { via: "id" | "name" | "alias" | "tokens"; matched: string };
}

const CONFIDENCE_RANK: Record<Confidence, number> = {
  verified_official: 3,
  reported: 2,
  regulatory_default: 1,
  unknown: 0,
};

const STOP_WORDS = new Set(["the", "inc", "inc.", "co", "co.", "company", "corp", "corporation", "insurance", "group", "financial", "llc", "ltd", "of"]);

/** Lowercase, strip punctuation, drop filler words. "The GEICO Insurance Co." -> "geico". */
export function normalizeInsurerName(input: string): string {
  return input
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t))
    .join(" ");
}

function defaultDataDir(): string {
  const raw = process.env.DATA_DIR?.trim() || "./data";
  // DATA_DIR is runtime configuration (same pattern as src/server/config.ts); keep turbopack from tracing the whole tree.
  return raw === ":memory:" ? raw : path.resolve(/*turbopackIgnore: true*/ process.cwd(), raw);
}

type InsurerRow = {
  id: string; name: string; legal_name: string | null; parent_id: string | null; categories: string; lines: string;
  aliases: string; eligibility: string | null; website: string | null; tos_url: string | null; privacy_url: string | null; notes: string | null;
};

function toSummary(r: InsurerRow): InsurerSummary {
  return {
    id: r.id,
    name: r.name,
    legalName: r.legal_name,
    parentId: r.parent_id,
    categories: JSON.parse(r.categories) as InsurerCategory[],
    lines: JSON.parse(r.lines) as string[],
    aliases: JSON.parse(r.aliases) as string[],
    eligibility: r.eligibility,
    website: r.website,
    tosUrl: r.tos_url,
    privacyUrl: r.privacy_url,
    notes: r.notes,
  };
}

export function listInsurers(dataDir: string = defaultDataDir()): InsurerSummary[] {
  const db = openInsurerDatabase(dataDir);
  return (db.prepare("SELECT * FROM insurers ORDER BY name").all() as InsurerRow[]).map(toSummary);
}

function contactsFor(db: InsurerDb, id: string): InsurerContact[] {
  type Row = { purpose: ContactPurpose; channel: InsurerContact["channel"]; scope: ContactScope; region: string | null; purpose_verified: number | null; phone_e164: string | null; hours: string | null; url: string | null; notes: string | null; source_url: string | null; retrieved_at: string | null; confidence: Confidence };
  return (db.prepare("SELECT * FROM insurer_contacts WHERE insurer_id = ? ORDER BY id").all(id) as Row[]).map((r) => ({
    purpose: r.purpose,
    channel: r.channel,
    scope: r.scope,
    region: r.region,
    purposeVerified: r.purpose_verified === null ? null : r.purpose_verified === 1,
    phoneE164: r.phone_e164,
    hours: r.hours,
    url: r.url,
    notes: r.notes,
    sourceUrl: r.source_url,
    retrievedAt: r.retrieved_at,
    confidence: r.confidence,
  }));
}

function termsFor(db: InsurerDb, id: string): InsurerTerm[] {
  type Row = { line: string; key: InsurerTerm["key"]; value: string | null; value_number: number | null; unit: string | null; jurisdiction_scope: string | null; notes: string | null; source_url: string | null; source_quote: string | null; retrieved_at: string | null; confidence: Confidence };
  return (db.prepare("SELECT * FROM insurer_terms WHERE insurer_id = ? ORDER BY id").all(id) as Row[]).map((r) => ({
    line: r.line,
    key: r.key,
    value: r.value,
    valueNumber: r.value_number,
    unit: r.unit,
    jurisdictionScope: r.jurisdiction_scope,
    notes: r.notes,
    sourceUrl: r.source_url,
    sourceQuote: r.source_quote,
    retrievedAt: r.retrieved_at,
    confidence: r.confidence,
  }));
}

function questionsFor(db: InsurerDb, id: string): OpenQuestion[] {
  type Row = { question: string; why_it_matters: string };
  return (db.prepare("SELECT question, why_it_matters FROM insurer_open_questions WHERE insurer_id = ? AND status = 'open' ORDER BY id").all(id) as Row[])
    .map((r) => ({ question: r.question, whyItMatters: r.why_it_matters }));
}

function bestPhone(contacts: InsurerContact[], purpose: ContactPurpose): { phone: string | null; confidence: Confidence | null; ambiguous: boolean } {
  const candidates = contacts
    .filter((c) => c.purpose === purpose && c.channel === "phone" && c.phoneE164 !== null && c.scope === "national" && c.purposeVerified !== false &&
      (c.confidence === "verified_official" || c.confidence === "reported"))
    .sort((a, b) => CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] || Number(b.purposeVerified === true) - Number(a.purposeVerified === true));
  const top = candidates[0];
  if (!top) return { phone: null, confidence: null, ambiguous: false };
  const ambiguous = candidates.some((c) => c.confidence === top.confidence &&
    (c.purposeVerified === true) === (top.purposeVerified === true) && c.phoneE164 !== top.phoneE164);
  // Never choose a product/plan-specific destination merely by seed order.
  return ambiguous
    ? { phone: null, confidence: null, ambiguous: true }
    : { phone: top.phoneE164, confidence: top.confidence, ambiguous: false };
}

/**
 * Resolve a merchant/insurer name as a customer or an extracted document
 * might write it ("Geico", "Anthem Blue Cross", "State Farm Insurance").
 * Exact id/name/alias matches win; otherwise every token of the query must
 * appear in a name/alias (or vice versa). Returns null rather than guessing.
 */
export function lookupInsurer(name: string, dataDir: string = defaultDataDir()): InsurerLookup | null {
  const query = normalizeInsurerName(name);
  if (!query) return null;
  const db = openInsurerDatabase(dataDir);
  const rows = db.prepare("SELECT * FROM insurers").all() as InsurerRow[];

  type Match = { row: InsurerRow; via: InsurerLookup["match"]["via"]; matched: string };
  // An explicit ID is unique. Names and aliases may collide across insurers;
  // collect those matches before selecting instead of depending on seed order.
  const byId = rows.find((row) => row.id === name.trim().toLowerCase());
  let hit: Match | null = byId ? { row: byId, via: "id", matched: byId.id } : null;
  if (!hit) {
    const exact: Match[] = [];
    for (const row of rows) {
      if (normalizeInsurerName(row.name) === query) {
        exact.push({ row, via: "name", matched: row.name });
        continue;
      }
      const alias = (JSON.parse(row.aliases) as string[]).find((a) => normalizeInsurerName(a) === query);
      if (alias) exact.push({ row, via: "alias", matched: alias });
    }
    if (exact.length > 1) return null;
    hit = exact[0] ?? null;
  }
  if (!hit) {
    const qTokens = query.split(" ");
    const scored: { row: InsurerRow; matched: string; score: number }[] = [];
    for (const row of rows) {
      const names = [row.name, ...(JSON.parse(row.aliases) as string[])];
      for (const candidate of names) {
        const cTokens = normalizeInsurerName(candidate).split(" ");
        const qInC = qTokens.every((t) => cTokens.includes(t));
        const cInQ = cTokens.every((t) => qTokens.includes(t));
        if (qInC || cInQ) {
          // Prefer the tightest candidate (fewest extra tokens).
          scored.push({ row, matched: candidate, score: Math.abs(cTokens.length - qTokens.length) });
        }
      }
    }
    scored.sort((a, b) => a.score - b.score);
    const best = scored[0];
    // A shorter name is not evidence that a multi-insurer query selected it.
    // Ranking chooses an alias within one insurer, never between insurers.
    if (best && !scored.some((s) => s.row.id !== best.row.id)) {
      hit = { row: best.row, via: "tokens", matched: best.matched };
    }
  }
  if (!hit) return null;

  const contacts = contactsFor(db, hit.row.id);
  const support = bestPhone(contacts, "customer_service");
  const claims = bestPhone(contacts, "claims");
  const needsPlanOrRegion =
    support.ambiguous || claims.ambiguous ||
    (support.phone === null &&
      contacts.some((c) => c.purpose === "customer_service" && (c.scope === "regional" || c.scope === "plan_specific")));
  return {
    ...toSummary(hit.row),
    supportPhone: support.phone,
    supportPhoneConfidence: support.confidence,
    claimsPhone: claims.phone,
    claimsPhoneConfidence: claims.confidence,
    needsPlanOrRegion,
    contacts,
    terms: termsFor(db, hit.row.id),
    openQuestions: questionsFor(db, hit.row.id),
    match: { via: hit.via, matched: hit.matched },
  };
}

export function getRegulatoryDefaults(line?: string, dataDir: string = defaultDataDir()): RegulatoryDefault[] {
  const db = openInsurerDatabase(dataDir);
  type Row = { line: string; jurisdiction: string; key: RegulatoryDefault["key"]; value: string; value_number: number | null; unit: string | null; notes: string | null; source_url: string | null; source_quote: string | null; retrieved_at: string | null; confidence: Confidence };
  const rows = (line
    ? db.prepare("SELECT * FROM regulatory_defaults WHERE line = ? OR line = 'all' ORDER BY id").all(line)
    : db.prepare("SELECT * FROM regulatory_defaults ORDER BY id").all()) as Row[];
  return rows.map((r) => ({
    line: r.line,
    jurisdiction: r.jurisdiction,
    key: r.key,
    value: r.value,
    valueNumber: r.value_number,
    unit: r.unit,
    notes: r.notes,
    sourceUrl: r.source_url,
    sourceQuote: r.source_quote,
    retrievedAt: r.retrieved_at,
    confidence: r.confidence,
  }));
}

export function listOpenQuestions(dataDir: string = defaultDataDir()): (OpenQuestion & { insurerId: string | null })[] {
  const db = openInsurerDatabase(dataDir);
  type Row = { insurer_id: string | null; question: string; why_it_matters: string };
  return (db.prepare("SELECT insurer_id, question, why_it_matters FROM insurer_open_questions WHERE status = 'open' ORDER BY insurer_id, id").all() as Row[])
    .map((r) => ({ insurerId: r.insurer_id, question: r.question, whyItMatters: r.why_it_matters }));
}
