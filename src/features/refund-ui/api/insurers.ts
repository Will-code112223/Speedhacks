/**
 * Insurer knowledge base client. http mode reads GET /api/insurers
 * (src/app/api/insurers/route.ts on origin/codex/voice f8a65a4); fixture mode
 * serves the demo's AAA and a fictional health insurer from memory. The mode is
 * chosen up front, as for CaseApi; http never falls back to fixture data.
 *
 * Name matching mirrors the server's lookupInsurer: an exact id, then a unique
 * normalized name or alias, then a token match only one insurer satisfies.
 * Anything ambiguous resolves to null rather than a guess.
 */

import { assertNever } from "./assert-never";
import type { InsurerLookup, InsurerSummary } from "./insurer-types";
import { ApiRequestError, ApiUnreachableError, type ApiMode } from "./types";
import { isRecord, readApiError } from "./validate";

export interface InsurerApi {
  /** Every insurer, sorted by name. */
  listInsurers(): Promise<InsurerSummary[]>;
  /** Null when the name is blank, matches no insurer, or matches more than one. */
  lookupInsurer(name: string): Promise<InsurerLookup | null>;
}

export interface CreateInsurerApiOptions {
  mode: ApiMode;
  /** http only; defaults to same origin. */
  baseUrl?: string;
  /** fixture only. `latencyMs` delays every answer so loading states are visible; default 0. */
  fixture?: { latencyMs?: number };
}

export function createInsurerApi(options: CreateInsurerApiOptions): InsurerApi {
  switch (options.mode) {
    case "fixture":
      return createFixtureInsurerApi(options.fixture?.latencyMs ?? 0);
    case "http":
      return createHttpInsurerApi(options.baseUrl ?? "");
    default:
      return assertNever(options.mode);
  }
}

// ---------------------------------------------------------------------------
// Pure lookup logic
// ---------------------------------------------------------------------------

/** The trimmed name to look up, or null when it is blank. Never sent blank: the route would list instead. */
export function insurerQuery(name: string | null): string | null {
  const query = name?.trim() ?? "";
  return query === "" ? null : query;
}

// The server's STOP_WORDS. Its dotted forms ("inc.", "co.") cannot survive punctuation stripping.
const FILLER_WORDS = new Set([
  "the",
  "inc",
  "co",
  "company",
  "corp",
  "corporation",
  "insurance",
  "group",
  "financial",
  "llc",
  "ltd",
  "of",
]);

/** Lowercase, strip punctuation, drop filler words: "The Harborline Insurance Co." is "harborline". */
export function normalizeInsurerName(input: string): string {
  return input
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token.length > 0 && !FILLER_WORDS.has(token))
    .join(" ");
}

export type InsurerMatch = InsurerLookup["match"];

/** The server's lookupInsurer matching rules. Null when nothing or more than one insurer matches. */
export function matchInsurer<T extends Pick<InsurerSummary, "id" | "name" | "aliases">>(
  name: string,
  insurers: readonly T[],
): { insurer: T; match: InsurerMatch } | null {
  const query = normalizeInsurerName(name);
  if (query === "") return null;

  // An id is unique, so it wins outright.
  const id = name.trim().toLowerCase();
  const byId = insurers.find((insurer) => insurer.id === id);
  if (byId !== undefined) return { insurer: byId, match: { via: "id", matched: byId.id } };

  // Names and aliases may collide across insurers; a collision is ambiguous.
  const exact: { insurer: T; match: InsurerMatch }[] = [];
  for (const insurer of insurers) {
    if (normalizeInsurerName(insurer.name) === query) {
      exact.push({ insurer, match: { via: "name", matched: insurer.name } });
      continue;
    }
    const alias = insurer.aliases.find((a) => normalizeInsurerName(a) === query);
    if (alias !== undefined) exact.push({ insurer, match: { via: "alias", matched: alias } });
  }
  if (exact.length > 1) return null;
  const only = exact[0];
  if (only !== undefined) return only;

  // Every query token is in a name or alias, or every token of one is in the query.
  const queryTokens = query.split(" ");
  const candidates: { insurer: T; matched: string; extraTokens: number }[] = [];
  for (const insurer of insurers) {
    for (const candidate of [insurer.name, ...insurer.aliases]) {
      const tokens = normalizeInsurerName(candidate).split(" ");
      if (queryTokens.every((t) => tokens.includes(t)) || tokens.every((t) => queryTokens.includes(t))) {
        candidates.push({ insurer, matched: candidate, extraTokens: Math.abs(tokens.length - queryTokens.length) });
      }
    }
  }
  candidates.sort((a, b) => a.extraTokens - b.extraTokens);
  const best = candidates[0];
  // Ranking picks the tightest name within one insurer, never between insurers.
  if (best === undefined || candidates.some((c) => c.insurer.id !== best.insurer.id)) return null;
  return { insurer: best.insurer, match: { via: "tokens", matched: best.matched } };
}

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------

function createHttpInsurerApi(baseUrl: string): InsurerApi {
  const base = baseUrl.replace(/\/+$/, "");

  async function get(path: string): Promise<Response> {
    try {
      // The global fetch is looked up on every request.
      return await globalThis.fetch(`${base}${path}`, {
        method: "GET",
        headers: new Headers({ accept: "application/json" }),
        credentials: "same-origin",
        cache: "no-store",
      });
    } catch (cause) {
      throw unreachable("The server could not be reached.", cause);
    }
  }

  return {
    async listInsurers() {
      const res = await get("/api/insurers");
      const body = await readJson(res);
      if (!res.ok) throw requestError(res.status, body);
      const insurers = isRecord(body) ? body.insurers : undefined;
      if (!isInsurerList(insurers)) throw unexpectedShape(res.status);
      return insurers;
    },

    async lookupInsurer(name) {
      const query = insurerQuery(name);
      if (query === null) return null;
      const res = await get(`/api/insurers?name=${encodeURIComponent(query)}`);
      // The route answers 404 for an unknown or ambiguous name.
      if (res.status === 404) return null;
      const body = await readJson(res);
      if (!res.ok) throw requestError(res.status, body);
      const insurer = isRecord(body) ? body.insurer : undefined;
      if (!isInsurerLookup(insurer)) throw unexpectedShape(res.status);
      return insurer;
    },
  };
}

// Validate the fields consumed by the reference browser before rendering them.
// A partial 200 response is unavailable data, not a provider with empty facts.
const nullableText = (value: unknown): boolean => value === null || typeof value === "string";
const textList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const oneOf = (value: unknown, allowed: readonly string[]): boolean => typeof value === "string" && allowed.includes(value);
const confidence = (value: unknown): boolean => oneOf(value, ["verified_official", "reported", "regulatory_default", "unknown"]);

function isInsurerSummary(v: unknown): v is InsurerSummary {
  return isRecord(v) && typeof v.id === "string" && typeof v.name === "string"
    && textList(v.categories) && textList(v.lines) && textList(v.aliases)
    && [v.legalName, v.parentId, v.eligibility, v.website, v.tosUrl, v.privacyUrl, v.notes].every(nullableText);
}

function isInsurerList(v: unknown): v is InsurerSummary[] {
  return Array.isArray(v) && v.every(isInsurerSummary);
}

function isInsurerLookup(v: unknown): v is InsurerLookup {
  if (!isRecord(v) || !isInsurerSummary(v)) return false;
  const row = v as unknown as Record<string, unknown>;
  return [row.supportPhone, row.claimsPhone].every(nullableText)
    && [row.supportPhoneConfidence, row.claimsPhoneConfidence].every((value) => value === null || confidence(value))
    && typeof row.needsPlanOrRegion === "boolean"
    && isRecord(row.match) && oneOf(row.match.via, ["id", "name", "alias", "tokens"]) && typeof row.match.matched === "string"
    && Array.isArray(row.contacts) && row.contacts.every((contact) => isRecord(contact)
      && oneOf(contact.purpose, ["customer_service", "claims", "billing", "cancellation", "appeals"])
      && oneOf(contact.channel, ["phone", "web", "app", "mail"])
      && oneOf(contact.scope, ["national", "regional", "plan_specific", "corporate_only"])
      && (contact.purposeVerified === null || typeof contact.purposeVerified === "boolean")
      && [contact.region, contact.phoneE164, contact.hours, contact.url, contact.notes, contact.sourceUrl, contact.retrievedAt].every(nullableText)
      && confidence(contact.confidence))
    && Array.isArray(row.terms) && row.terms.every((term) => isRecord(term)
      && typeof term.line === "string" && typeof term.key === "string"
      && [term.value, term.unit, term.jurisdictionScope, term.notes, term.sourceUrl, term.sourceQuote, term.retrievedAt].every(nullableText)
      && (term.valueNumber === null || (typeof term.valueNumber === "number" && Number.isFinite(term.valueNumber)))
      && confidence(term.confidence))
    && Array.isArray(row.openQuestions) && row.openQuestions.every((question) => isRecord(question)
      && typeof question.question === "string" && typeof question.whyItMatters === "string");
}

/** JSON body; anything unreadable means nothing usable came back. */
async function readJson(res: Response): Promise<unknown> {
  let text: string;
  try {
    text = await res.text();
  } catch (cause) {
    throw unreachable(`The response (HTTP ${res.status}) could not be read.`, cause);
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw unreachable(`The server answered HTTP ${res.status} with a response that is not JSON.`, cause);
  }
}

/** A non-2xx answer. The body's error code and message pass through unchanged. */
function requestError(status: number, body: unknown): ApiRequestError {
  const parsed = readApiError(body);
  if (parsed === null) {
    return new ApiRequestError(status, "UNKNOWN", `The server answered HTTP ${status} without an error body.`);
  }
  return new ApiRequestError(status, parsed.code, parsed.message, parsed.fields);
}

function unexpectedShape(status: number): ApiUnreachableError {
  return new ApiUnreachableError(`The server answered HTTP ${status} with an unexpected insurer response shape.`);
}

function unreachable(message: string, cause: unknown): ApiUnreachableError {
  const error = new ApiUnreachableError(message);
  error.cause = cause;
  return error;
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

type FixtureInsurer = Omit<InsurerLookup, "match">;

// AAA is the insurer in the insurance_claim scenario (fixture-engine/scenarios.ts),
// and its claims line is that scenario's "AAA claims line", so both fixtures
// agree. That number and every AAA fact here come from the demo's sample
// declarations page, not from AAA's published contacts or terms. Harborline
// Health is fictional. URLs use the reserved .invalid domain.
const AAA_CLAIMS_PHONE = "+19495200007";
const AAA_SOURCE = "https://example.invalid/aaa/declarations";
const HARBORLINE_SOURCE = "https://example.invalid/harborline/contact";
const RETRIEVED_AT = "2026-10-11";

const FIXTURE_INSURERS: readonly FixtureInsurer[] = [
  {
    id: "aaa",
    name: "AAA",
    legalName: "CSAA Insurance Group",
    parentId: null,
    categories: ["auto"],
    lines: ["auto"],
    aliases: ["Triple A", "CSAA Insurance Group"],
    eligibility: null,
    website: "https://example.invalid/aaa",
    tosUrl: null,
    privacyUrl: null,
    notes: "Demo data from the sample declarations page.",
    supportPhone: null,
    supportPhoneConfidence: null,
    claimsPhone: AAA_CLAIMS_PHONE,
    claimsPhoneConfidence: "verified_official",
    needsPlanOrRegion: false,
    contacts: [
      {
        purpose: "claims",
        channel: "phone",
        scope: "national",
        region: null,
        purposeVerified: true,
        phoneE164: AAA_CLAIMS_PHONE,
        hours: "24/7",
        url: null,
        notes: "Press 1 to report a new claim.",
        sourceUrl: AAA_SOURCE,
        retrievedAt: RETRIEVED_AT,
        confidence: "verified_official",
      },
    ],
    terms: [
      {
        line: "auto",
        key: "claim_filing_method",
        value: "Phone, 24 hours a day",
        valueNumber: null,
        unit: null,
        jurisdictionScope: "CA",
        notes: "Have the policy number, the date and place of the loss, the other driver's plate and insurer, and photos ready.",
        sourceUrl: AAA_SOURCE,
        sourceQuote: "Report a claim 24 hours a day.",
        retrievedAt: RETRIEVED_AT,
        confidence: "verified_official",
      },
    ],
    openQuestions: [
      {
        question: "Is the $500 collision deductible waived up front, or refunded once the other driver's insurer pays?",
        whyItMatters: "It decides whether the deductible is due when the car is repaired.",
      },
    ],
  },
  {
    id: "harborline-health",
    name: "Harborline Health",
    legalName: null,
    parentId: null,
    categories: ["health"],
    lines: ["individual_health"],
    aliases: ["Harborline", "Harborline Health Plan"],
    eligibility: null,
    website: "https://example.invalid/harborline",
    tosUrl: null,
    privacyUrl: null,
    notes: null,
    supportPhone: null,
    supportPhoneConfidence: null,
    claimsPhone: null,
    claimsPhoneConfidence: null,
    needsPlanOrRegion: true,
    contacts: [
      {
        purpose: "customer_service",
        channel: "phone",
        scope: "plan_specific",
        region: null,
        purposeVerified: null,
        phoneE164: null,
        hours: null,
        url: null,
        notes: "Member services number is printed on the ID card",
        sourceUrl: HARBORLINE_SOURCE,
        retrievedAt: RETRIEVED_AT,
        confidence: "verified_official",
      },
    ],
    terms: [],
    openQuestions: [],
  },
];

function createFixtureInsurerApi(latencyMs: number): InsurerApi {
  const delayMs = Math.max(0, latencyMs);
  // Same delay as the case fixture engine: a plain timer, so fake timers drive it.
  async function respond(): Promise<void> {
    if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }

  return {
    async listInsurers() {
      await respond();
      // The server sorts by name.
      return [...FIXTURE_INSURERS].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map(toSummary);
    },

    async lookupInsurer(name) {
      const query = insurerQuery(name);
      if (query === null) return null;
      await respond();
      if (query.length > 200) throw new ApiRequestError(400, "BAD_REQUEST", "name is too long");
      const hit = matchInsurer(query, FIXTURE_INSURERS);
      // Copies, so a caller cannot change the fixture.
      return hit === null ? null : { ...structuredClone(hit.insurer), match: hit.match };
    },
  };
}

function toSummary(insurer: FixtureInsurer): InsurerSummary {
  const { id, name, legalName, parentId, categories, lines, aliases, eligibility, website, tosUrl, privacyUrl, notes } =
    insurer;
  return structuredClone({ id, name, legalName, parentId, categories, lines, aliases, eligibility, website, tosUrl, privacyUrl, notes });
}
