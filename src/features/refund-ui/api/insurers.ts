/**
 * Insurer knowledge base client. http mode reads GET /api/insurers
 * (src/app/api/insurers/route.ts on origin/codex/voice f8a65a4); fixture mode
 * serves a few fictional insurers from memory. The mode is chosen up front, as
 * for CaseApi; http never falls back to fixture data.
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

/** Lowercase, strip punctuation, drop filler words: "The Northwind Insurance Co." is "northwind". */
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

// Minimal shape checks; the server owns the full shape.
function isInsurerSummary(v: unknown): v is InsurerSummary {
  return isRecord(v) && typeof v.id === "string" && typeof v.name === "string";
}

function isInsurerList(v: unknown): v is InsurerSummary[] {
  return Array.isArray(v) && v.every(isInsurerSummary);
}

function isInsurerLookup(v: unknown): v is InsurerLookup {
  return isInsurerSummary(v);
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

// Fictional insurers only. Phone numbers come from the NANP fictional range
// (555-0100 to 555-0199) and URLs from the reserved .invalid domain.
// Northwind's number is the insurance_claim scenario's "Northwind Mutual claims
// line" in fixture-engine/scenarios.ts, so both fixtures agree.
const NORTHWIND_PHONE = "+14155550162";
const NORTHWIND_SOURCE = "https://example.invalid/northwind/contact";
const HARBORLINE_SOURCE = "https://example.invalid/harborline/contact";
const RETRIEVED_AT = "2026-10-11";

const FIXTURE_INSURERS: readonly FixtureInsurer[] = [
  {
    id: "northwind-mutual",
    name: "Northwind Mutual",
    legalName: "Northwind Mutual Insurance Company",
    parentId: null,
    categories: ["property"],
    lines: ["homeowners", "renters"],
    aliases: ["Northwind", "Northwind Mutual Insurance"],
    eligibility: null,
    website: "https://example.invalid/northwind",
    tosUrl: null,
    privacyUrl: null,
    notes: null,
    supportPhone: NORTHWIND_PHONE,
    supportPhoneConfidence: "verified_official",
    claimsPhone: NORTHWIND_PHONE,
    claimsPhoneConfidence: "verified_official",
    needsPlanOrRegion: false,
    contacts: [
      {
        purpose: "customer_service",
        channel: "phone",
        scope: "national",
        region: null,
        purposeVerified: true,
        phoneE164: NORTHWIND_PHONE,
        hours: "Mon-Fri 8am-8pm ET",
        url: null,
        notes: "One number for service and claims; press 2 for existing claims.",
        sourceUrl: NORTHWIND_SOURCE,
        retrievedAt: RETRIEVED_AT,
        confidence: "verified_official",
      },
      {
        purpose: "claims",
        channel: "phone",
        scope: "national",
        region: null,
        purposeVerified: true,
        phoneE164: NORTHWIND_PHONE,
        hours: "24/7",
        url: null,
        notes: null,
        sourceUrl: NORTHWIND_SOURCE,
        retrievedAt: RETRIEVED_AT,
        confidence: "verified_official",
      },
    ],
    terms: [
      {
        line: "all",
        key: "claim_filing_method",
        value: "Phone or online claim form",
        valueNumber: null,
        unit: null,
        jurisdictionScope: "US",
        notes: null,
        sourceUrl: NORTHWIND_SOURCE,
        sourceQuote: null,
        retrievedAt: RETRIEVED_AT,
        confidence: "verified_official",
      },
      {
        line: "homeowners",
        key: "claim_report_deadline",
        value: "Within 60 days of the loss",
        valueNumber: 60,
        unit: "days",
        jurisdictionScope: "US",
        notes: null,
        sourceUrl: NORTHWIND_SOURCE,
        sourceQuote: null,
        retrievedAt: RETRIEVED_AT,
        confidence: "verified_official",
      },
      {
        line: "all",
        key: "claim_decision_timeline",
        value: "Within 30 days of a complete claim",
        valueNumber: 30,
        unit: "days",
        jurisdictionScope: "US",
        notes: null,
        sourceUrl: NORTHWIND_SOURCE,
        sourceQuote: null,
        retrievedAt: RETRIEVED_AT,
        confidence: "verified_official",
      },
    ],
    openQuestions: [
      {
        question: "Does the 60-day reporting window also apply to renters policies?",
        whyItMatters: "A late renters claim could be refused if the window differs.",
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
