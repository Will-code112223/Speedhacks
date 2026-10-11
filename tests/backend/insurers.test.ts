import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  INSURER_SEED,
  REGULATORY_SEED,
  closeInsurerDatabase,
  getRegulatoryDefaults,
  listInsurers,
  lookupInsurer,
  normalizeInsurerName,
  validateSeed,
} from "@/server/insurers";
import { US_E164 } from "@/server/insurers/types";

const MEM = ":memory:";

const EXPECTED_IDS = [
  "state-farm", "geico", "progressive", "allstate", "usaa", "liberty-mutual",
  "northwestern-mutual", "new-york-life", "prudential", "lincoln-financial", "massmutual", "mutual-of-omaha",
  "first-american-title", "fidelity-national-financial", "chicago-title", "commonwealth-land-title", "fidelity-national-title", "travelers", "chubb",
  "unitedhealthcare", "elevance-health", "aetna", "cigna", "kaiser-permanente", "humana",
  "unum", "principal-financial", "guardian-life", "the-hartford", "cna",
  "trupanion", "healthy-paws", "allianz-global-assistance",
];

afterAll(() => closeInsurerDatabase());

describe("insurer seed", () => {
  it("passes validation (E.164 phones, enums, provenance)", () => {
    expect(validateSeed(INSURER_SEED, REGULATORY_SEED)).toEqual([]);
  });

  it("contains every company from the brief exactly once", () => {
    const ids = INSURER_SEED.map((i) => i.id).sort();
    expect(ids).toEqual([...EXPECTED_IDS].sort());
  });

  it("never stores a non-E.164 phone number", () => {
    for (const ins of INSURER_SEED) {
      for (const c of ins.contacts) {
        if (c.phoneE164 !== null) expect(c.phoneE164, `${ins.id} ${c.purpose}`).toMatch(US_E164);
      }
    }
  });

  it("marks every stated fact with a source and never fabricates unknowns", () => {
    for (const ins of INSURER_SEED) {
      for (const t of ins.terms) {
        if (t.value !== null) expect(t.sourceUrl, `${ins.id} ${t.key}`).toBeTruthy();
        if (t.confidence === "unknown") expect(t.value, `${ins.id} ${t.key}`).toBeNull();
      }
    }
  });
});

describe("lookupInsurer", () => {
  it("loads the seed into SQLite and lists every insurer", () => {
    expect(listInsurers(MEM).map((i) => i.id).sort()).toEqual([...EXPECTED_IDS].sort());
  });

  it("normalizes names", () => {
    expect(normalizeInsurerName("The GEICO Insurance Co.")).toBe("geico");
    expect(normalizeInsurerName("State Farm Insurance")).toBe("state farm");
  });

  it("resolves exact names, aliases and token matches", () => {
    expect(lookupInsurer("GEICO", MEM)?.id).toBe("geico");
    expect(lookupInsurer("State Farm Insurance", MEM)?.id).toBe("state-farm");
    expect(lookupInsurer("Anthem Blue Cross", MEM)?.id).toBe("elevance-health");
    expect(lookupInsurer("Kaiser", MEM)?.id).toBe("kaiser-permanente");
    expect(lookupInsurer("Aetna (CVS Health)", MEM)?.id).toBe("aetna");
    expect(lookupInsurer("Chicago Title", MEM)?.parentId).toBe("fidelity-national-financial");
  });

  it("never auto-fills a number whose purpose failed re-verification", () => {
    // Lincoln's loans page does not carry 800-487-1485; it must not surface as a cancellation line.
    const lincoln = lookupInsurer("Lincoln Financial", MEM);
    const bad = lincoln?.contacts.find((c) => c.purpose === "cancellation" && c.phoneE164 === "+18004871485");
    if (bad) {
      expect(bad.purposeVerified).toBe(false);
      expect(bad.confidence).toBe("reported");
    }
  });

  it("returns null instead of guessing", () => {
    expect(lookupInsurer("Acme Widgets", MEM)).toBeNull();
    expect(lookupInsurer("", MEM)).toBeNull();
    // "Fidelity" alone is ambiguous between FNF and Fidelity National Title.
    expect(lookupInsurer("Fidelity", MEM)).toBeNull();
  });

  it("never auto-fills a regional or plan-specific number", () => {
    const kaiser = lookupInsurer("Kaiser", MEM);
    expect(kaiser?.supportPhone).toBeNull();
    expect(kaiser?.needsPlanOrRegion).toBe(true);
    expect(kaiser?.contacts.some((c) => c.scope === "regional" && c.region && c.phoneE164)).toBe(true);
    for (const ins of INSURER_SEED) {
      const hit = lookupInsurer(ins.id, MEM);
      if (hit?.supportPhone) {
        const src = hit.contacts.find((c) => c.phoneE164 === hit.supportPhone && c.purpose === "customer_service" && c.scope === "national");
        expect(src?.scope, ins.id).toBe("national");
        expect(src?.purposeVerified, ins.id).not.toBe(false);
      }
    }
  });

  it("prefers verified_official numbers and exposes confidence", () => {
    for (const ins of INSURER_SEED) {
      const hit = lookupInsurer(ins.id, MEM);
      expect(hit, ins.id).not.toBeNull();
      if (hit?.supportPhone) {
        expect(hit.supportPhone).toMatch(US_E164);
        expect(hit.supportPhoneConfidence).not.toBeNull();
        const better = hit.contacts.find((c) => c.purpose === "customer_service" && c.phoneE164 && c.scope === "national" && c.confidence === "verified_official");
        if (better) expect(hit.supportPhoneConfidence).toBe("verified_official");
      }
    }
  });
});

describe("regulatory defaults", () => {
  it("provides a health appeal window fallback", () => {
    const health = getRegulatoryDefaults("health", MEM);
    expect(health.some((d) => d.key === "appeal_window_days")).toBe(true);
  });
});

describe("GET /api/insurers", () => {
  const savedDataDir = process.env.DATA_DIR;
  beforeAll(() => {
    process.env.DATA_DIR = ":memory:";
  });
  afterAll(() => {
    if (savedDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = savedDataDir;
  });

  it("lists insurers and resolves a name, with 404 for unknown", async () => {
    const { GET } = await import("@/app/api/insurers/route");
    const list = await GET(new Request("http://localhost/api/insurers"));
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { insurers: { id: string }[] };
    expect(listed.insurers.map((i) => i.id)).toContain("geico");

    const hit = await GET(new Request("http://localhost/api/insurers?name=Anthem%20Blue%20Cross"));
    expect(hit.status).toBe(200);
    const body = (await hit.json()) as { insurer: { id: string; needsPlanOrRegion: boolean; supportPhone: string | null } };
    expect(body.insurer.id).toBe("elevance-health");
    expect(body.insurer.supportPhone).toBeNull();
    expect(body.insurer.needsPlanOrRegion).toBe(true);

    const miss = await GET(new Request("http://localhost/api/insurers?name=Acme%20Widgets"));
    expect(miss.status).toBe(404);
    expect(((await miss.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });
});
