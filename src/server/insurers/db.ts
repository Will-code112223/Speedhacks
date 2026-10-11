import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import {
  CONFIDENCE_LEVELS,
  CONTACT_CHANNELS,
  CONTACT_PURPOSES,
  CONTACT_SCOPES,
  TERM_KEYS,
  US_E164,
  type InsurerSeed,
  type RegulatoryDefault,
} from "./types";
import insurersSeed from "./seed/insurers.json";
import regulatorySeed from "./seed/regulatory-defaults.json";

/**
 * Insurer knowledge base persistence. Separate SQLite file (insurers.sqlite)
 * next to the case database so reference data never contends with case
 * writes and can be rebuilt from the seed at any time. Same hackathon caveat
 * as refund.sqlite: local disk, not for ephemeral/serverless deployments.
 */
export const INSURER_SCHEMA = `
CREATE TABLE IF NOT EXISTS insurers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  legal_name TEXT,
  parent_id TEXT REFERENCES insurers(id),
  categories TEXT NOT NULL,
  lines TEXT NOT NULL,
  aliases TEXT NOT NULL,
  eligibility TEXT,
  website TEXT,
  official_domains TEXT NOT NULL,
  tos_url TEXT,
  privacy_url TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS insurer_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  insurer_id TEXT NOT NULL REFERENCES insurers(id),
  purpose TEXT NOT NULL,
  channel TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'national',
  region TEXT,
  purpose_verified INTEGER,
  phone_e164 TEXT,
  hours TEXT,
  url TEXT,
  notes TEXT,
  source_url TEXT,
  retrieved_at TEXT,
  confidence TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS insurer_contacts_insurer ON insurer_contacts(insurer_id, purpose);

CREATE TABLE IF NOT EXISTS insurer_terms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  insurer_id TEXT NOT NULL REFERENCES insurers(id),
  line TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  value_number REAL,
  unit TEXT,
  jurisdiction_scope TEXT,
  notes TEXT,
  source_url TEXT,
  source_quote TEXT,
  retrieved_at TEXT,
  confidence TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS insurer_terms_insurer ON insurer_terms(insurer_id, key);

CREATE TABLE IF NOT EXISTS regulatory_defaults (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line TEXT NOT NULL,
  jurisdiction TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  value_number REAL,
  unit TEXT,
  notes TEXT,
  source_url TEXT,
  source_quote TEXT,
  retrieved_at TEXT,
  confidence TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS regulatory_defaults_line ON regulatory_defaults(line, key);

CREATE TABLE IF NOT EXISTS insurer_open_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  insurer_id TEXT REFERENCES insurers(id),
  question TEXT NOT NULL,
  why_it_matters TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE IF NOT EXISTS insurer_seed_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export type InsurerDb = Database.Database;

export const INSURER_SEED: InsurerSeed[] = insurersSeed as InsurerSeed[];
export const REGULATORY_SEED: RegulatoryDefault[] = regulatorySeed as RegulatoryDefault[];

export class InsurerSeedError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Insurer seed rejected (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n- ${problems.join("\n- ")}`);
    this.name = "InsurerSeedError";
    this.problems = problems;
  }
}

/**
 * Validate the seed before it reaches the database. A wrong phone number is
 * the worst failure mode for a dialing agent, so non-E.164 numbers are
 * rejected rather than coerced.
 */
export function validateSeed(insurers: InsurerSeed[], defaults: RegulatoryDefault[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const confidence = new Set<string>(CONFIDENCE_LEVELS);
  const purposes = new Set<string>(CONTACT_PURPOSES);
  const channels = new Set<string>(CONTACT_CHANNELS);
  const scopes = new Set<string>(CONTACT_SCOPES);
  const termKeys = new Set<string>(TERM_KEYS);

  for (const ins of insurers) {
    if (!ins.id || !/^[a-z0-9-]+$/.test(ins.id)) problems.push(`insurer "${ins.name}": bad id "${ins.id}"`);
    if (ids.has(ins.id)) problems.push(`duplicate insurer id "${ins.id}"`);
    ids.add(ins.id);
    if (!ins.name) problems.push(`insurer "${ins.id}": missing name`);
    if (!Array.isArray(ins.lines) || ins.lines.length === 0) problems.push(`insurer "${ins.id}": no lines`);
    if (!Array.isArray(ins.categories) || ins.categories.length === 0) problems.push(`insurer "${ins.id}": no categories`);
    ins.contacts.forEach((c, i) => {
      const where = `insurer "${ins.id}" contact[${i}] (${c.purpose})`;
      if (!purposes.has(c.purpose)) problems.push(`${where}: bad purpose`);
      if (!channels.has(c.channel)) problems.push(`${where}: bad channel "${c.channel}"`);
      if (!scopes.has(c.scope)) problems.push(`${where}: bad scope "${c.scope}"`);
      if (c.scope === "regional" && !c.region) problems.push(`${where}: regional contact needs a region`);
      if (!confidence.has(c.confidence)) problems.push(`${where}: bad confidence "${c.confidence}"`);
      if (c.phoneE164 !== null && !US_E164.test(c.phoneE164)) problems.push(`${where}: phone "${c.phoneE164}" is not US E.164`);
      if (c.channel === "phone" && c.phoneE164 === null && !c.notes) problems.push(`${where}: phone channel with null number needs a note`);
      if (c.confidence !== "unknown" && !c.sourceUrl) problems.push(`${where}: confidence ${c.confidence} requires sourceUrl`);
      if (c.confidence === "verified_official" && c.sourceUrl && !isOfficial(c.sourceUrl, ins.officialDomains)) {
        problems.push(`${where}: verified_official but sourceUrl ${c.sourceUrl} is not on an official domain`);
      }
    });
    ins.terms.forEach((t, i) => {
      const where = `insurer "${ins.id}" term[${i}] (${t.key})`;
      if (!termKeys.has(t.key)) problems.push(`${where}: unknown term key`);
      if (!confidence.has(t.confidence)) problems.push(`${where}: bad confidence "${t.confidence}"`);
      if (t.confidence !== "unknown" && t.value !== null && !t.sourceUrl) problems.push(`${where}: value without sourceUrl`);
      if (t.sourceQuote && t.sourceQuote.trim().split(/\s+/).length >= 15) problems.push(`${where}: sourceQuote must be under 15 words`);
    });
  }
  for (const ins of insurers) {
    if (ins.parentId && !ids.has(ins.parentId)) problems.push(`insurer "${ins.id}": parentId "${ins.parentId}" not in seed`);
  }
  defaults.forEach((d, i) => {
    const where = `regulatory_defaults[${i}] (${d.line}/${d.key})`;
    if (!termKeys.has(d.key)) problems.push(`${where}: unknown term key`);
    if (!confidence.has(d.confidence)) problems.push(`${where}: bad confidence "${d.confidence}"`);
    if (!d.value) problems.push(`${where}: missing value`);
    if (!d.sourceUrl) problems.push(`${where}: missing sourceUrl`);
  });
  return problems;
}

function isOfficial(url: string, domains: string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some((d) => {
    const dom = d.toLowerCase();
    return host === dom || host.endsWith(`.${dom}`);
  });
}

/** Hash of seed + DDL: a schema change rebuilds the tables, so an old insurers.sqlite never lacks a column. */
export function seedHash(insurers: InsurerSeed[], defaults: RegulatoryDefault[]): string {
  return createHash("sha256").update(INSURER_SCHEMA).update(JSON.stringify([insurers, defaults])).digest("hex");
}

const INSURER_TABLES = ["insurer_open_questions", "insurer_terms", "insurer_contacts", "regulatory_defaults", "insurers", "insurer_seed_meta"];

/** Replace all reference rows with the seed, atomically. */
export function loadSeed(db: InsurerDb, insurers: InsurerSeed[] = INSURER_SEED, defaults: RegulatoryDefault[] = REGULATORY_SEED): void {
  const problems = validateSeed(insurers, defaults);
  if (problems.length > 0) throw new InsurerSeedError(problems);
  const hash = seedHash(insurers, defaults);
  const current = db.prepare("SELECT value FROM insurer_seed_meta WHERE key = 'seed_hash'").get() as { value: string } | undefined;
  if (current?.value === hash) return;

  db.transaction(() => {
    for (const t of INSURER_TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
    db.exec(INSURER_SCHEMA);
  })();
  const insertInsurer = db.prepare(`INSERT INTO insurers
    (id, name, legal_name, parent_id, categories, lines, aliases, eligibility, website, official_domains, tos_url, privacy_url, notes)
    VALUES (@id, @name, @legalName, @parentId, @categories, @lines, @aliases, @eligibility, @website, @officialDomains, @tosUrl, @privacyUrl, @notes)`);
  const insertContact = db.prepare(`INSERT INTO insurer_contacts
    (insurer_id, purpose, channel, scope, region, purpose_verified, phone_e164, hours, url, notes, source_url, retrieved_at, confidence)
    VALUES (@insurerId, @purpose, @channel, @scope, @region, @purposeVerified, @phoneE164, @hours, @url, @notes, @sourceUrl, @retrievedAt, @confidence)`);
  const insertTerm = db.prepare(`INSERT INTO insurer_terms
    (insurer_id, line, key, value, value_number, unit, jurisdiction_scope, notes, source_url, source_quote, retrieved_at, confidence)
    VALUES (@insurerId, @line, @key, @value, @valueNumber, @unit, @jurisdictionScope, @notes, @sourceUrl, @sourceQuote, @retrievedAt, @confidence)`);
  const insertDefault = db.prepare(`INSERT INTO regulatory_defaults
    (line, jurisdiction, key, value, value_number, unit, notes, source_url, source_quote, retrieved_at, confidence)
    VALUES (@line, @jurisdiction, @key, @value, @valueNumber, @unit, @notes, @sourceUrl, @sourceQuote, @retrievedAt, @confidence)`);
  const insertQuestion = db.prepare(`INSERT INTO insurer_open_questions (insurer_id, question, why_it_matters) VALUES (?, ?, ?)`);

  db.transaction(() => {
    // Parents first so the self-referencing FK holds.
    const ordered = [...insurers].sort((a, b) => Number(a.parentId !== null) - Number(b.parentId !== null));
    for (const ins of ordered) {
      insertInsurer.run({
        id: ins.id,
        name: ins.name,
        legalName: ins.legalName,
        parentId: ins.parentId,
        categories: JSON.stringify(ins.categories),
        lines: JSON.stringify(ins.lines),
        aliases: JSON.stringify(ins.aliases ?? []),
        eligibility: ins.eligibility,
        website: ins.website,
        officialDomains: JSON.stringify(ins.officialDomains ?? []),
        tosUrl: ins.tosUrl,
        privacyUrl: ins.privacyUrl,
        notes: ins.notes ?? null,
      });
      for (const c of ins.contacts) {
        insertContact.run({ insurerId: ins.id, ...c, purposeVerified: c.purposeVerified === null ? null : c.purposeVerified ? 1 : 0 });
      }
      for (const t of ins.terms) insertTerm.run({ insurerId: ins.id, ...t });
      for (const q of ins.openQuestions ?? []) insertQuestion.run(ins.id, q.question, q.whyItMatters);
    }
    for (const d of defaults) insertDefault.run(d);
    db.prepare("INSERT OR REPLACE INTO insurer_seed_meta (key, value) VALUES ('seed_hash', ?)").run(hash);
    db.prepare("INSERT OR REPLACE INTO insurer_seed_meta (key, value) VALUES ('loaded_at', ?)").run(new Date().toISOString());
  })();
}

type Cache = { dir: string; db: InsurerDb };
const globalCache = globalThis as unknown as { __insurerDb?: Cache };

/**
 * Open (and seed) the insurer database. Pass ":memory:" for tests. Reuses one
 * handle per data directory across Next.js hot reloads.
 */
export function openInsurerDatabase(dataDir: string): InsurerDb {
  const cached = globalCache.__insurerDb;
  if (cached && cached.dir === dataDir && cached.db.open) return cached.db;
  let db: InsurerDb;
  if (dataDir === ":memory:") {
    db = new Database(":memory:");
  } else {
    fs.mkdirSync(dataDir, { recursive: true });
    db = new Database(path.join(dataDir, "insurers.sqlite"));
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
  }
  db.pragma("foreign_keys = ON");
  db.exec(INSURER_SCHEMA);
  loadSeed(db);
  globalCache.__insurerDb = { dir: dataDir, db };
  return db;
}

export function closeInsurerDatabase(): void {
  const cached = globalCache.__insurerDb;
  if (cached) {
    cached.db.close();
    globalCache.__insurerDb = undefined;
  }
}
