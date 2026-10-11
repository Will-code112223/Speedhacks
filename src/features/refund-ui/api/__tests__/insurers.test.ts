import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type * as server from "@/server/insurers";
import type * as serverTypes from "@/server/insurers/types";
import * as client from "../client";
import { createFixtureCaseApi } from "../fixture";
import type * as mirror from "../insurer-types";
import type { InsurerLookup, InsurerSummary } from "../insurer-types";
import {
  createInsurerApi,
  insurerQuery,
  matchInsurer,
  normalizeInsurerName,
  type CreateInsurerApiOptions,
  type InsurerApi,
  type InsurerMatch,
} from "../insurers";
import { failureOf, jsonResponse, recordingFetch, textResponse, unreachableOf, type RecordedRequest } from "./support";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// The demo's AAA claims line, from the sample declarations page; the fixture dials nothing else.
const AAA_CLAIMS_PHONE = "+19495200007";
const REAL_INSURERS = [
  "Aetna",
  "Allstate",
  "GEICO",
  "State Farm",
  "Progressive",
  "Liberty Mutual",
  "USAA",
  "Travelers",
  "Chubb",
  "Humana",
  "Cigna",
  "Kaiser",
  "UnitedHealthcare",
  "Northwestern Mutual",
];

function sampleSummary(overrides: Partial<InsurerSummary> = {}): InsurerSummary {
  return {
    id: "aaa",
    name: "AAA",
    legalName: null,
    parentId: null,
    categories: ["auto"],
    lines: ["auto"],
    aliases: ["Triple A"],
    eligibility: null,
    website: null,
    tosUrl: null,
    privacyUrl: null,
    notes: null,
    ...overrides,
  };
}

function sampleLookup(): InsurerLookup {
  return {
    ...sampleSummary(),
    supportPhone: AAA_CLAIMS_PHONE,
    supportPhoneConfidence: "verified_official",
    claimsPhone: null,
    claimsPhoneConfidence: null,
    needsPlanOrRegion: false,
    contacts: [],
    terms: [],
    openQuestions: [],
    match: { via: "alias", matched: "Triple A" },
  };
}

const SUMMARY_KEYS = Object.keys(sampleSummary()).sort();

function apiError(status: number, code: string, message: string): Response {
  return jsonResponse(status, { error: { code, message } });
}

/** The http client on a stubbed global fetch that answers with `replies` in order. */
function httpApi(replies: (Response | Error)[], baseUrl?: string): { api: InsurerApi; requests: RecordedRequest[] } {
  const { fetchImpl, requests } = recordingFetch(...replies);
  vi.stubGlobal("fetch", fetchImpl);
  return { api: createInsurerApi({ mode: "http", baseUrl }), requests };
}

function fixtureApi(latencyMs?: number): InsurerApi {
  return createInsurerApi({ mode: "fixture", fixture: { latencyMs } });
}

async function lookupOrFail(api: InsurerApi, name: string): Promise<InsurerLookup> {
  const insurer = await api.lookupInsurer(name);
  if (insurer === null) throw new Error(`Expected "${name}" to resolve to an insurer.`);
  return insurer;
}

async function allFixtureInsurers(): Promise<InsurerLookup[]> {
  const api = fixtureApi();
  return Promise.all((await api.listInsurers()).map((summary) => lookupOrFail(api, summary.id)));
}

type Call = (api: InsurerApi) => Promise<unknown>;
const listCall: Call = (api) => api.listInsurers();
const lookupCall: Call = (api) => api.lookupInsurer("Triple A");

describe("insurer api: http", () => {
  it("lists insurers with a same-origin GET that accepts JSON", async () => {
    const insurers = [sampleSummary(), sampleSummary({ id: "harborline-health", name: "Harborline Health" })];
    const { api, requests } = httpApi([jsonResponse(200, { insurers })]);
    expect(await api.listInsurers()).toEqual(insurers);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: "/api/insurers", method: "GET", credentials: "same-origin", cache: "no-store" });
    expect(requests[0]?.headers.get("accept")).toBe("application/json");
  });

  it("looks a trimmed name up on the base URL with same-origin credentials", async () => {
    const { api, requests } = httpApi([jsonResponse(200, { insurer: sampleLookup() })], "https://api.example.test/");
    expect(await api.lookupInsurer("  Triple A  ")).toEqual(sampleLookup());
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "https://api.example.test/api/insurers?name=Triple%20A",
      method: "GET",
      credentials: "same-origin",
    });
    expect(requests[0]?.headers.get("accept")).toBe("application/json");
  });

  it("URL-encodes the name", async () => {
    const name = "Harbor & Line, Inc. #2 / 50%?";
    const { api, requests } = httpApi([jsonResponse(200, { insurer: sampleLookup() })]);
    await api.lookupInsurer(name);
    const url = requests[0]?.url ?? "";
    expect(url).toBe(`/api/insurers?name=${encodeURIComponent(name)}`);
    expect(new URL(url, "https://app.example.test").searchParams.get("name")).toBe(name);
  });

  it.each<[string, () => Response]>([
    ["a NOT_FOUND error body", () => apiError(404, "NOT_FOUND", 'No insurer matches "Acme Widgets"')],
    ["an HTML page", () => textResponse(404, "<!DOCTYPE html><title>404: This page could not be found.</title>")],
  ])("resolves a 404 with %s to null", async (_label, reply) => {
    const { api } = httpApi([reply()]);
    expect(await api.lookupInsurer("Acme Widgets")).toBeNull();
  });

  it("passes a 400 through as an ApiRequestError with code BAD_REQUEST", async () => {
    const { api } = httpApi([apiError(400, "BAD_REQUEST", "name is too long")]);
    const error = await failureOf(api.lookupInsurer("n".repeat(201)));
    expect(error).toMatchObject({ status: 400, code: "BAD_REQUEST", message: "name is too long" });
  });

  it.each<[string, Call]>([
    ["listInsurers", listCall],
    ["lookupInsurer", lookupCall],
  ])("passes a 500 INTERNAL through as an ApiRequestError from %s", async (_method, call) => {
    const { api } = httpApi([apiError(500, "INTERNAL", "Internal server error")]);
    expect(await failureOf(call(api))).toMatchObject({ status: 500, code: "INTERNAL", message: "Internal server error" });
  });

  it("uses code UNKNOWN when an error answer has no error body", async () => {
    const { api } = httpApi([jsonResponse(503, { message: "busy" })]);
    expect(await failureOf(api.listInsurers())).toMatchObject({
      status: 503,
      code: "UNKNOWN",
      message: "The server answered HTTP 503 without an error body.",
    });
  });

  it("reports a rejected fetch as an ApiUnreachableError", async () => {
    const cause = new TypeError("Failed to fetch");
    const { api } = httpApi([cause]);
    const error = await unreachableOf(api.lookupInsurer("Triple A"));
    expect(error.message).toBe("The server could not be reached.");
    expect(error.cause).toBe(cause);
  });

  it.each<[string, () => Response, Call, string]>([
    ["a 200 list", () => textResponse(200, "<html>ok</html>"), listCall, "HTTP 200"],
    ["a 502 lookup", () => textResponse(502, "<html>Bad gateway</html>"), lookupCall, "HTTP 502"],
  ])("reports a non-JSON body on %s as an ApiUnreachableError naming the status", async (_label, reply, call, status) => {
    const { api } = httpApi([reply()]);
    expect((await unreachableOf(call(api))).message).toContain(status);
  });

  it.each<[string, unknown]>([
    ["no insurers member", {}],
    ["insurers that is not an array", { insurers: { id: "aaa" } }],
    ["an insurer without a string id", { insurers: [{ id: 7, name: "AAA" }] }],
    ["a bare array", [sampleSummary()]],
  ])("rejects a list body with %s as an unexpected shape", async (_label, body) => {
    const { api } = httpApi([jsonResponse(200, body)]);
    expect((await unreachableOf(api.listInsurers())).message).toBe(
      "The server answered HTTP 200 with an unexpected insurer response shape.",
    );
  });

  it.each<[string, unknown]>([
    ["no insurer member", {}],
    ["a null insurer", { insurer: null }],
    ["an insurer without a name", { insurer: { id: "aaa" } }],
    ["a summary without lookup details", { insurer: sampleSummary() }],
    ["a missing contacts array", { insurer: { ...sampleLookup(), contacts: null } }],
    ["a malformed contact", { insurer: { ...sampleLookup(), contacts: [{ purpose: "claims" }] } }],
    ["an invalid term", { insurer: { ...sampleLookup(), terms: [{ key: "claim_filing_method", value: {} }] } }],
    ["a non-string question", { insurer: { ...sampleLookup(), openQuestions: [{ question: {}, whyItMatters: "needed" }] } }],
    ["a list instead", { insurers: [sampleSummary()] }],
  ])("rejects a lookup body with %s as an unexpected shape", async (_label, body) => {
    const { api } = httpApi([jsonResponse(200, body)]);
    expect((await unreachableOf(api.lookupInsurer("Triple A"))).message).toMatch(/unexpected insurer response shape/);
  });

  it.each(["", "   ", "\t\n"])("resolves the blank name %j to null without a request", async (name) => {
    const { api, requests } = httpApi([]);
    expect(await api.lookupInsurer(name)).toBeNull();
    expect(requests).toHaveLength(0);
  });
});

describe("insurer api: fixture", () => {
  it("lists the demo's AAA and the fictional health insurer by name, as summaries only", async () => {
    const insurers = await fixtureApi().listInsurers();
    expect(insurers.map((i) => i.name)).toEqual(["AAA", "Harborline Health"]);
    for (const insurer of insurers) expect(Object.keys(insurer).sort()).toEqual(SUMMARY_KEYS);
  });

  it.each<[string, InsurerMatch]>([
    ["aaa", { via: "id", matched: "aaa" }],
    ["  AAA ", { via: "id", matched: "aaa" }],
    ["AAA Insurance", { via: "name", matched: "AAA" }],
    ["triple a", { via: "alias", matched: "Triple A" }],
    ["CSAA insurance group", { via: "alias", matched: "CSAA Insurance Group" }],
    ["harborline health plan", { via: "alias", matched: "Harborline Health Plan" }],
  ])("looks %j up by id, name or alias, ignoring case", async (name, match) => {
    expect((await lookupOrFail(fixtureApi(), name)).match).toEqual(match);
  });

  it('drops filler words as the server does: "the Triple A insurance co" is the alias "Triple A"', async () => {
    expect(await lookupOrFail(fixtureApi(), "the Triple A insurance co")).toMatchObject({
      id: "aaa",
      match: { via: "alias", matched: "Triple A" },
    });
  });

  it("matches the insurance_claim scenario's merchant by tokens and shares its claims line", async () => {
    const created = await createFixtureCaseApi({ scenario: "insurance_claim" }).createCase({
      summary: "Rear-ended on October 10",
    });
    expect(created.merchant).toEqual({ name: "AAA claims line", supportPhone: AAA_CLAIMS_PHONE });
    expect(await lookupOrFail(fixtureApi(), created.merchant.name ?? "")).toMatchObject({
      id: "aaa",
      claimsPhone: created.merchant.supportPhone,
      match: { via: "tokens", matched: "AAA" },
    });
  });

  it.each([
    ["an unknown name", "Acme Widgets"],
    ["a name that matches both insurers", "AAA or Harborline"],
    ["a name of filler words only", "The Insurance Company"],
    ["a blank name", "   "],
  ])("resolves %s to null", async (_label, name) => {
    expect(await fixtureApi().lookupInsurer(name)).toBeNull();
  });

  it("rejects a name over 200 characters as the server does", async () => {
    expect(await failureOf(fixtureApi().lookupInsurer("n".repeat(201)))).toMatchObject({
      status: 400,
      code: "BAD_REQUEST",
      message: "name is too long",
    });
  });

  it("gives AAA the demo claims line from the declarations page, one claims term and the deductible question", async () => {
    const aaa = await lookupOrFail(fixtureApi(), "AAA");
    expect(aaa).toMatchObject({
      id: "aaa",
      legalName: "CSAA Insurance Group",
      categories: ["auto"],
      lines: ["auto"],
      aliases: ["Triple A", "CSAA Insurance Group"],
      supportPhone: null,
      supportPhoneConfidence: null,
      claimsPhone: AAA_CLAIMS_PHONE,
      claimsPhoneConfidence: "verified_official",
      needsPlanOrRegion: false,
    });
    expect(aaa.contacts.map((c) => [c.purpose, c.scope, c.purposeVerified, c.phoneE164, c.hours, c.sourceUrl])).toEqual([
      ["claims", "national", true, AAA_CLAIMS_PHONE, "24/7", "https://example.invalid/aaa/declarations"],
    ]);
    expect(aaa.terms.map((t) => [t.line, t.key, t.value])).toEqual([["auto", "claim_filing_method", "Phone, 24 hours a day"]]);
    expect(aaa.openQuestions.map((q) => q.question)).toEqual([
      "Is the $500 collision deductible waived up front, or refunded once the other driver's insurer pays?",
    ]);
  });

  it("leaves Harborline Health's number to the member's ID card", async () => {
    const harborline = await lookupOrFail(fixtureApi(), "Harborline");
    expect(harborline).toMatchObject({
      id: "harborline-health",
      categories: ["health"],
      supportPhone: null,
      supportPhoneConfidence: null,
      claimsPhone: null,
      needsPlanOrRegion: true,
    });
    expect(harborline.contacts).toEqual([
      expect.objectContaining({
        scope: "plan_specific",
        phoneE164: null,
        notes: "Member services number is printed on the ID card",
      }),
    ]);
  });

  it.each<[string, Call]>([
    ["listInsurers", listCall],
    ["lookupInsurer", lookupCall],
  ])("waits latencyMs before %s answers", async (_method, call) => {
    vi.useFakeTimers();
    let settled = false;
    const pending = call(fixtureApi(300)).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(299);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await pending;
  });

  it("hands out copies, so callers cannot change the fixture", async () => {
    const api = fixtureApi();
    const first = await lookupOrFail(api, "AAA");
    first.contacts.length = 0;
    first.aliases.push("Changed");
    (await api.listInsurers())[1]?.aliases.push("Changed too");
    const again = await lookupOrFail(api, "AAA");
    expect(again.contacts).toHaveLength(1);
    expect(again.aliases).toEqual(["Triple A", "CSAA Insurance Group"]);
    expect((await api.listInsurers())[1]?.aliases).toEqual(["Harborline", "Harborline Health Plan"]);
  });

  it("lists no phone number but the demo's AAA claims line", async () => {
    const phones = (await allFixtureInsurers())
      .flatMap((i) => [i.supportPhone, i.claimsPhone, ...i.contacts.map((c) => c.phoneE164)])
      .filter((phone): phone is string => phone !== null);
    expect(phones.length).toBeGreaterThan(0);
    for (const phone of phones) expect(phone).toBe(AAA_CLAIMS_PHONE);
  });

  it("links only to the reserved example.invalid domain", async () => {
    const urls = (await allFixtureInsurers())
      .flatMap((i) => [
        i.website,
        i.tosUrl,
        i.privacyUrl,
        ...i.contacts.flatMap((c) => [c.url, c.sourceUrl]),
        ...i.terms.map((t) => t.sourceUrl),
      ])
      .filter((url): url is string => url !== null);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(new URL(url).hostname).toBe("example.invalid");
  });

  it("names no real insurer besides the demo's AAA and resolves none", async () => {
    const names = (await allFixtureInsurers())
      .flatMap((i) => [i.name, i.legalName, ...i.aliases])
      .filter((name): name is string => name !== null)
      .map((name) => name.toLowerCase());
    const api = fixtureApi();
    for (const real of REAL_INSURERS) {
      expect(names.filter((name) => name.includes(real.toLowerCase())), real).toEqual([]);
      expect(await api.lookupInsurer(real), real).toBeNull();
    }
  });
});

describe("insurer lookup helpers", () => {
  it.each([
    ["The Harborline Insurance Co.", "harborline"],
    ["Harbor & Line, Inc.", "harbor and line"],
    ["  HARBORLINE   Mutual Group ", "harborline mutual"],
    ["CSAA Insurance Group", "csaa"],
    ["The Insurance Company", ""],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeInsurerName(input)).toBe(expected);
  });

  it.each<[string | null, string | null]>([
    [" Triple A ", "Triple A"],
    ["", null],
    [" \t\n", null],
    [null, null],
  ])("turns the name %j into the query %j", (name, expected) => {
    expect(insurerQuery(name)).toBe(expected);
  });

  it("treats a name or alias that two insurers share as ambiguous", () => {
    const insurers = [
      { id: "alpha", name: "Alpha Harbor", aliases: ["Harbor"] },
      { id: "beta", name: "Harbor", aliases: [] },
    ];
    expect(matchInsurer("harbor", insurers)).toBeNull();
  });

  it("prefers an exact id over another insurer's name", () => {
    const insurers = [
      { id: "harbor", name: "Alpha Harbor", aliases: [] },
      { id: "beta", name: "Harbor", aliases: [] },
    ];
    expect(matchInsurer("Harbor", insurers)).toEqual({ insurer: insurers[0], match: { via: "id", matched: "harbor" } });
  });

  it("rejects a mode it does not know", () => {
    const options = { mode: "mock" } as unknown as CreateInsurerApiOptions;
    expect(() => createInsurerApi(options)).toThrow('Unexpected value: "mock"');
  });

  it("is re-exported from the client entry point", () => {
    expect(client.createInsurerApi).toBe(createInsurerApi);
  });
});

describe("insurer wire types", () => {
  // Type-only imports are erased at runtime, so no server code loads; the typecheck fails if the mirror drifts.
  it("mirror the server's types field for field", () => {
    expectTypeOf<mirror.InsurerCategory>().toEqualTypeOf<serverTypes.InsurerCategory>();
    expectTypeOf<mirror.ContactPurpose>().toEqualTypeOf<serverTypes.ContactPurpose>();
    expectTypeOf<mirror.ContactChannel>().toEqualTypeOf<serverTypes.ContactChannel>();
    expectTypeOf<mirror.ContactScope>().toEqualTypeOf<serverTypes.ContactScope>();
    expectTypeOf<mirror.Confidence>().toEqualTypeOf<serverTypes.Confidence>();
    expectTypeOf<mirror.TermKey>().toEqualTypeOf<serverTypes.TermKey>();
    expectTypeOf<mirror.InsurerContact>().toEqualTypeOf<serverTypes.InsurerContact>();
    expectTypeOf<mirror.InsurerTerm>().toEqualTypeOf<serverTypes.InsurerTerm>();
    expectTypeOf<mirror.OpenQuestion>().toEqualTypeOf<serverTypes.OpenQuestion>();
    expectTypeOf<mirror.InsurerSummary>().toEqualTypeOf<server.InsurerSummary>();
    expectTypeOf<mirror.InsurerLookup>().toEqualTypeOf<server.InsurerLookup>();
  });
});
