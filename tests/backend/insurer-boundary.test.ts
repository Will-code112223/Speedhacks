import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/insurers/route";
import {
  INSURER_SEED,
  closeInsurerDatabase,
  loadSeed,
  lookupInsurer,
  openInsurerDatabase,
  validateSeed,
} from "@/server/insurers";
import type { InsurerContact, InsurerSeed } from "@/server/insurers/types";

let temporaryDirectory: string | undefined;

beforeEach(() => {
  closeInsurerDatabase();
  vi.stubEnv("DATA_DIR", ":memory:");
  vi.stubGlobal("fetch", async () => { throw new Error("Insurer boundary tests must stay offline"); });
});

afterEach(() => {
  closeInsurerDatabase();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

function syntheticInsurer(id: string, name: string): InsurerSeed {
  const template = INSURER_SEED[0];
  if (!template) throw new Error("Test fixture requires a seed template");
  return {
    ...structuredClone(template),
    id,
    name,
    legalName: name,
    parentId: null,
    website: "https://insurer.example",
    officialDomains: ["insurer.example"],
    notes: null,
    aliases: ["Shared Example"],
    contacts: [],
    terms: [],
    openQuestions: [],
  };
}

function syntheticContact(overrides: Partial<InsurerContact> = {}): InsurerContact {
  return {
    purpose: "customer_service",
    channel: "phone",
    scope: "national",
    region: null,
    purposeVerified: true,
    phoneE164: "+16505550101",
    hours: null,
    url: "https://insurer.example/support",
    notes: "Synthetic support contact",
    sourceUrl: "https://insurer.example/support",
    retrievedAt: "2026-10-11",
    confidence: "verified_official",
    ...overrides,
  };
}

describe("insurer identity boundaries", () => {
  it.each(["GEICO or State Farm", "Allstate / Liberty Mutual"])(
    "does not choose the longer insurer name from ambiguous input %j",
    (query) => {
      expect(lookupInsurer(query, ":memory:")?.id ?? null).toBeNull();
    },
  );

  it("does not resolve a shared exact alias by seed insertion order", () => {
    const seeds = [
      syntheticInsurer("example-alpha", "Example Alpha"),
      syntheticInsurer("example-beta", "Example Beta"),
    ];
    expect(validateSeed(seeds, [])).toEqual([]);
    loadSeed(openInsurerDatabase(":memory:"), seeds, []);

    expect(lookupInsurer("Shared Example", ":memory:")?.id ?? null).toBeNull();
    expect(lookupInsurer("example-alpha", ":memory:")?.id).toBe("example-alpha");
    expect(lookupInsurer("example-beta", ":memory:")?.id).toBe("example-beta");
  });
});

describe("insurer destination boundaries", () => {
  it.each(["Humana", "UnitedHealthcare"])(
    "withholds %s support when several national-labeled contacts require different plans",
    (name) => {
      const insurer = lookupInsurer(name, ":memory:");
      expect(insurer).not.toBeNull();
      expect(insurer?.supportPhone).toBeNull();
      expect(insurer?.supportPhoneConfidence).toBeNull();
      expect(insurer?.needsPlanOrRegion).toBe(true);
    },
  );

  it.each(["unknown", "regulatory_default"] as const)("withholds a %s-confidence phone", (confidence) => {
    const seed = syntheticInsurer("example-alpha", "Example Alpha");
    seed.contacts = [syntheticContact({ confidence, purposeVerified: null })];
    expect(validateSeed([seed], [])).toEqual([]);
    loadSeed(openInsurerDatabase(":memory:"), [seed], []);

    const insurer = lookupInsurer("example-alpha", ":memory:");
    expect(insurer?.supportPhone).toBeNull();
    expect(insurer?.supportPhoneConfidence).toBeNull();
  });

  it("returns a unique verified national destination despite duplicate rows and unusable alternatives", () => {
    const seed = syntheticInsurer("example-alpha", "Example Alpha");
    seed.contacts = [
      syntheticContact(),
      syntheticContact({ notes: "A second synthetic source confirms the same destination" }),
      syntheticContact({ phoneE164: "+16505550102", purposeVerified: false }),
      syntheticContact({ phoneE164: "+16505550103", confidence: "unknown", purposeVerified: null }),
    ];
    expect(validateSeed([seed], [])).toEqual([]);
    loadSeed(openInsurerDatabase(":memory:"), [seed], []);

    const insurer = lookupInsurer("example-alpha", ":memory:");
    expect(insurer?.supportPhone).toBe("+16505550101");
    expect(insurer?.supportPhoneConfidence).toBe("verified_official");
    expect(insurer?.needsPlanOrRegion).toBe(false);
  });
});

describe("insurer API failure semantics", () => {
  it.each(["GEICO or State Farm", "Allstate / Liberty Mutual"])(
    "returns 404 NOT_FOUND for ambiguous input %j",
    async (query) => {
      const response = await GET(new Request(`http://localhost/api/insurers?name=${encodeURIComponent(query)}`));
      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe("NOT_FOUND");
    },
  );

  it("rejects a 201-character name with the standard 400 error envelope", async () => {
    const response = await GET(new Request(`http://localhost/api/insurers?name=${"x".repeat(201)}`));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "BAD_REQUEST", message: "name is too long" } });
  });

  it("reports storage failure as sanitized 500 rather than successful empty data", async () => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "insurer-boundary-"));
    const invalidDataDir = path.join(temporaryDirectory, "PRIVATE_STORAGE_MARKER");
    fs.writeFileSync(invalidDataDir, "not a directory");
    vi.stubEnv("DATA_DIR", invalidDataDir);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET(new Request("http://localhost/api/insurers"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: "INTERNAL", message: "Internal server error" } });
  });
});
