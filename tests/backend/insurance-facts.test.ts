import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CALL_PURPOSES, type CallPurpose } from "@/contracts/voice";
import { buildBrief, isIsoDate, missingFields, validateChanges, type Facts } from "@/server/cases/facts";
import { findInsurerInText } from "@/server/cases/service";
import { HeuristicExtractor, OpenAIExtractor } from "@/server/documents/extractor";
import { ApiHttpError } from "@/server/http/errors";
import { listInsurers, lookupInsurer } from "@/server/insurers";
import { SESSION_A, makeHarness, type Harness } from "./helpers";

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.cleanup());

const CLAIM_FIELDS = {
  customerName: "Jordan Lee",
  policyNumber: "NWM-HO-0441772",
  incidentDate: "2026-10-03",
  lossDescription: "Water damage in the kitchen from a burst pipe",
  claimType: "water damage",
};

const baseFacts = (over: Partial<Facts> = {}): Facts => ({
  customer: { name: "Jordan Lee", email: null },
  merchant: { name: "Lemonade", supportPhone: "+18447338666" },
  amountMinor: null,
  currency: "USD",
  reason: "Water damage in the kitchen",
  policyNumber: null,
  incidentDate: null,
  lossDescription: null,
  claimType: null,
  ...over,
});

describe("insurance facts (V1.2)", () => {
  it("a claim case missing its incident date asks for it, not for an amount", async () => {
    const c = await h.service.createCase(SESSION_A, {
      summary: "Burst pipe.",
      files: [],
      fields: { customerName: "Jordan Lee", merchantName: "Lemonade", lossDescription: "Burst pipe flooded the kitchen" },
    });
    expect(c.suggestedPurpose).toBe("file_claim");
    expect(c.missingFields).toEqual(["incidentDate"]);
    expect(c.status).toBe("needs_information");
    expect(c.draft).toBeNull();
    const fixed = h.service.patchCase(SESSION_A, c.id, c.revision, { incidentDate: "2026-10-03" });
    expect(fixed.missingFields).toEqual([]);
    expect(fixed.status).toBe("ready_for_approval");
    expect(fixed.draft?.body).toContain("Date of loss: 2026-10-03");
  });

  it("defaults every insurance fact to null and never fabricates one", async () => {
    const c = await h.service.createCase(SESSION_A, { summary: "Charged twice by Acme Streaming for $49.99.", files: [], fields: {} });
    expect(c.suggestedPurpose).toBe("request_refund");
    expect(c.policyNumber).toBeNull();
    expect(c.incidentDate).toBeNull();
    expect(c.lossDescription).toBeNull();
    expect(c.claimType).toBeNull();
    expect(c.merchant.source).toBeNull();
  });

  it("stores user-entered insurance facts with provenance and lets PATCH edit and clear them", async () => {
    const c = await h.service.createCase(SESSION_A, {
      summary: "File a claim for the water damage in my kitchen.",
      files: [],
      fields: { ...CLAIM_FIELDS, merchantName: "Northwind Mutual", supportPhone: "+18005550142" },
    });
    expect(c.policyNumber).toBe("NWM-HO-0441772");
    expect(c.incidentDate).toBe("2026-10-03");
    expect(c.lossDescription).toBe(CLAIM_FIELDS.lossDescription);
    expect(c.claimType).toBe("water damage");
    const prov = h.repo.listProvenance(c.id).map((p) => p.field);
    expect(prov).toEqual(expect.arrayContaining(["policyNumber", "incidentDate", "lossDescription", "claimType"]));

    const { changes, invalid } = validateChanges({ policyNumber: null, incidentDate: "2026-10-04", claimType: "  " });
    expect(invalid).toEqual([]);
    const patched = h.service.patchCase(SESSION_A, c.id, c.revision, changes);
    expect(patched.revision).toBe(2);
    expect(patched.policyNumber).toBeNull();
    expect(patched.incidentDate).toBe("2026-10-04");
    expect(patched.claimType).toBeNull();
    expect(patched.lossDescription).toBe(CLAIM_FIELDS.lossDescription);
  });

  it("validates insurance fact edits", () => {
    expect(isIsoDate("2026-10-03")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("Oct 3")).toBe(false);
    expect(validateChanges({ incidentDate: "2026-02-30" }).invalid).toEqual(["incidentDate"]);
    expect(validateChanges({ policyNumber: 42 }).invalid).toEqual(["policyNumber"]);
    expect(validateChanges({ lossDescription: "x".repeat(2001) }).invalid).toEqual(["lossDescription"]);
  });

  it("the heuristic extractor picks up a labeled policy number from the summary and text documents", async () => {
    const ex = new HeuristicExtractor();
    const fromSummary = await ex.extract({ summary: "Policy number: ho-889201. Pipe burst in the kitchen.", documents: [] });
    expect(fromSummary.fields.policyNumber).toBe("HO-889201");
    expect(fromSummary.provenance.find((p) => p.field === "policyNumber")?.excerpt).toContain("Policy number: ho-889201");
    const fromDoc = await ex.extract({
      summary: "",
      documents: [{ evidenceId: "ev", name: "letter.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("Re: Policy # NWM-77120\nDear customer") }],
    });
    expect(fromDoc.fields.policyNumber).toBe("NWM-77120");
    const none = await ex.extract({ summary: "The policy no longer covers floods.", documents: [] });
    expect(none.fields.policyNumber).toBeNull();
  });

  it("the OpenAI extractor keeps only insurance facts whose cited source checks out", async () => {
    const realFetch = globalThis.fetch;
    let sent: { text: { format: { schema: { required: string[] } } } } | null = null;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      const output = {
        customerName: null,
        customerEmail: null,
        merchantName: "Northwind Mutual",
        supportPhone: null,
        amountMinor: null,
        currency: null,
        policyNumber: "NWM-HO-0441772",
        incidentDate: "2026-10-03",
        lossDescription: "water damage in my kitchen",
        claimType: "water damage",
        sources: [
          { field: "merchantName", source: "summary", excerpt: "against Northwind Mutual" },
          { field: "policyNumber", source: "Policy.PDF", excerpt: "Policy number NWM-HO-0441772" },
          { field: "incidentDate", source: "summary", excerpt: "on Oct 3" },
          { field: "lossDescription", source: "summary", excerpt: "water damage in my kitchen" },
          { field: "claimType", source: "summary", excerpt: "made up quote" },
        ],
      };
      return new Response(JSON.stringify({ output_text: JSON.stringify(output) }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const ex = new OpenAIExtractor({ model: "test-model", apiKey: "test", baseUrl: "http://llm.test", now: () => new Date("2026-10-11T20:00:00Z") });
      const r = await ex.extract({
        summary: "File a claim against Northwind Mutual for the water damage in my kitchen on Oct 3, about $1,200.",
        documents: [{ evidenceId: "ev-1", name: "policy.pdf", mimeType: "application/pdf", bytes: new Uint8Array([37, 80, 68, 70]) }],
      });
      expect(sent!.text.format.schema.required).toEqual(expect.arrayContaining(["policyNumber", "incidentDate", "lossDescription", "claimType"]));
      expect(r.fields.merchantName).toBe("Northwind Mutual");
      expect(r.fields.policyNumber).toBe("NWM-HO-0441772");
      expect(r.provenance.find((p) => p.field === "policyNumber")?.sourceRef).toBe("ev-1");
      expect(r.fields.incidentDate).toBe("2026-10-03");
      expect(r.fields.lossDescription).toBe("water damage in my kitchen");
      expect(r.fields.claimType).toBeNull(); // excerpt not in the summary: dropped, never guessed
      expect(r.notes.join(" ")).toContain("Dropped claimType");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("insurer registry destination (V1.2)", () => {
  const registry = (name: string) => lookupInsurer(name, h.config.dataDir)!;

  it("fills the verified official claims line and records its provenance", async () => {
    const lemonade = registry("Lemonade");
    expect(lemonade.needsPlanOrRegion).toBe(false);
    const c = await h.service.createCase(SESSION_A, { summary: "Water damage in my kitchen.", files: [], fields: { ...CLAIM_FIELDS, merchantName: "Lemonade" } });
    expect(c.merchant.supportPhone).toBe(lemonade.claimsPhone);
    expect(c.merchant.source).toMatchObject({
      kind: "insurer_registry",
      insurerId: "lemonade",
      insurerName: lemonade.name,
      purpose: "claims",
      confidence: "verified_official",
    });
    expect(c.merchant.source?.sourceUrl).toMatch(/^https:\/\//);
    expect(c.timeline.some((t) => t.type === "insurer_registry" && t.message.includes("Confirm it before approving"))).toBe(true);
    const prov = h.repo.listProvenance(c.id).find((p) => p.field === "supportPhone");
    expect(prov).toMatchObject({ sourceKind: "insurer_registry", sourceRef: "lemonade", value: lemonade.claimsPhone });
  });

  it("falls back to the verified customer-service line when the claims line is only reported", async () => {
    const allianz = registry("Allianz Global Assistance");
    expect(allianz.claimsPhoneConfidence).toBe("reported");
    const c = await h.service.createCase(SESSION_A, { summary: "Trip question.", files: [], fields: { merchantName: "Allianz Global Assistance" } });
    expect(c.merchant.supportPhone).toBe(allianz.supportPhone);
    expect(c.merchant.source?.purpose).toBe("customer_service");
  });

  it("finds an insurer named only in the user's text", async () => {
    const c = await h.service.createCase(SESSION_A, { summary: "My Farmers home policy should cover the burst pipe last week.", files: [], fields: {} });
    expect(c.merchant.name).toBe(registry("Farmers").name);
    expect(c.merchant.supportPhone).toBe(registry("Farmers").claimsPhone);
    expect(c.merchant.source?.insurerId).toBe("farmers");
    expect(h.repo.listProvenance(c.id).find((p) => p.field === "merchantName")?.sourceKind).toBe("summary");
  });

  it("does not fill plan- or region-specific insurers and says the number is on the ID card", async () => {
    expect(registry("Blue Shield of California").needsPlanOrRegion).toBe(true);
    const c = await h.service.createCase(SESSION_A, { summary: "Claim question.", files: [], fields: { merchantName: "Blue Shield of California" } });
    expect(c.merchant.supportPhone).toBeNull();
    expect(c.merchant.source).toBeNull();
    expect(c.missingFields).toContain("merchant.supportPhone");
    expect(c.timeline.some((t) => t.type === "insurer_registry" && t.message.includes("ID card"))).toBe(true);
  });

  it.each(["GEICO", "State Farm", "Progressive", "USAA", "Chubb"])(
    "fills the one verified national claims line for %s on a claim even though member services is plan-specific",
    async (name) => {
      const insurer = registry(name);
      expect(insurer.needsPlanOrRegion).toBe(true);
      const c = await h.service.createCase(SESSION_A, { summary: "Claim.", files: [], fields: { ...CLAIM_FIELDS, merchantName: name } });
      const line = insurer.contacts.find((x) => x.purpose === "claims" && x.scope === "national" && x.confidence === "verified_official" && x.phoneE164);
      expect(c.merchant.supportPhone).toBe(line?.phoneE164);
      expect(c.merchant.source).toMatchObject({ kind: "insurer_registry", insurerId: insurer.id, purpose: "claims", confidence: "verified_official" });
      expect(c.timeline.some((t) => t.message.includes("ID card"))).toBe(false);
    },
  );

  it("keeps the strict rule for a refund-shaped case and for two distinct national claims lines", async () => {
    const refund = await h.service.createCase(SESSION_A, { summary: "Charged twice.", files: [], fields: { merchantName: "GEICO", amountMinor: 4999, customerName: "Sam" } });
    expect(refund.suggestedPurpose).toBe("request_refund");
    expect(refund.merchant.supportPhone).toBeNull();
    expect(refund.timeline.some((t) => t.type === "insurer_registry" && t.message.includes("ID card"))).toBe(true);

    expect(registry("New York Life").needsPlanOrRegion).toBe(true);
    const twoLines = await h.service.createCase(SESSION_A, { summary: "Claim.", files: [], fields: { ...CLAIM_FIELDS, merchantName: "New York Life" } });
    expect(twoLines.merchant.supportPhone).toBeNull();
    expect(twoLines.merchant.source).toBeNull();

    const noClaimsLine = await h.service.createCase(SESSION_A, { summary: "Claim.", files: [], fields: { ...CLAIM_FIELDS, merchantName: "Blue Shield of California" } });
    expect(noClaimsLine.merchant.supportPhone).toBeNull();
    expect(noClaimsLine.timeline.some((t) => t.type === "insurer_registry" && t.message.includes("ID card"))).toBe(true);
  });

  it("never fills when the number came from the user or the insurer is unknown", async () => {
    const own = await h.service.createCase(SESSION_A, { summary: "x", files: [], fields: { merchantName: "Lemonade", supportPhone: "+14155550100" } });
    expect(own.merchant.supportPhone).toBe("+14155550100");
    expect(own.merchant.source).toBeNull();
    const unknown = await h.service.createCase(SESSION_A, { summary: "File a claim against Northwind Mutual.", files: [], fields: {} });
    expect(unknown.merchant.name).toBe("Northwind Mutual");
    expect(unknown.merchant.supportPhone).toBeNull();
    expect(unknown.merchant.source).toBeNull();
  });

  it("does not guess between two insurers named in the text", () => {
    const all = listInsurers(":memory:");
    expect(findInsurerInText("Lemonade or Farmers, not sure which", all)).toBeNull();
    expect(findInsurerInText("progressive water damage", all)).toBeNull();
    expect(findInsurerInText("I am with Lemonade.", all)?.id).toBe("lemonade");
  });

  it("stays editable: a manual number clears the source, an unchanged resend keeps it, a new insurer re-resolves", async () => {
    const c = await h.service.createCase(SESSION_A, { summary: "x", files: [], fields: { ...CLAIM_FIELDS, merchantName: "Lemonade" } });
    const kept = h.service.patchCase(SESSION_A, c.id, c.revision, { merchant: { name: c.merchant.name, supportPhone: c.merchant.supportPhone }, claimType: "theft" });
    expect(kept.merchant.source?.insurerId).toBe("lemonade");
    const edited = h.service.patchCase(SESSION_A, c.id, kept.revision, { merchant: { name: "Lemonade", supportPhone: "+14155550199" } });
    expect(edited.merchant.supportPhone).toBe("+14155550199");
    expect(edited.merchant.source).toBeNull();
    const renamed = h.service.patchCase(SESSION_A, c.id, edited.revision, { merchant: { name: "Farmers", supportPhone: null } });
    expect(renamed.merchant.supportPhone).toBe(registry("Farmers").claimsPhone);
    expect(renamed.merchant.source?.insurerId).toBe("farmers");
  });
});

describe("authorization purpose (V1.2)", () => {
  it("file_claim needs policyholder, incident date and loss description, never an amount", () => {
    const purpose = "file_claim" as CallPurpose;
    expect(missingFields(baseFacts(), purpose)).toEqual(["incidentDate", "lossDescription"]);
    expect(missingFields(baseFacts({ customer: { name: null, email: null } }), purpose)).toEqual(["policyNumber", "incidentDate", "lossDescription"]);
    expect(
      missingFields(baseFacts({ customer: { name: null, email: null }, policyNumber: "P-1", incidentDate: "2026-10-03", lossDescription: "Pipe burst" }), purpose),
    ).toEqual([]);
    expect(missingFields(baseFacts(), "gather_information")).toEqual([]);
    expect(missingFields(baseFacts())).toEqual(["amountMinor"]);
  });

  it("the brief carries insurance facts only when known, so the V1 brief is unchanged", () => {
    const input = {
      caseId: "c",
      revision: 1,
      customer: { name: "Jordan Lee", email: null },
      merchant: { name: "Lemonade", supportPhone: "+18447338666" },
      amountMinor: 4999,
      currency: "USD",
      reason: "r",
      evidence: [],
    };
    const v1 = buildBrief(input);
    expect(buildBrief({ ...input, policyNumber: null, incidentDate: null, lossDescription: null, claimType: null })).toBe(v1);
    const claim = buildBrief({ ...input, ...CLAIM_FIELDS });
    expect(claim).toContain("- Policy number: NWM-HO-0441772");
    expect(claim).toContain("- Date of loss: 2026-10-03");
    expect(claim).toContain("- Claim type: water damage");
  });

  it("authorizes a claim call and freezes the insurance facts and registry source in the snapshot", async () => {
    if (!(CALL_PURPOSES as readonly string[]).includes("file_claim")) return; // purpose not merged yet
    const c = await h.service.createCase(SESSION_A, { summary: "Kitchen water damage.", files: [], fields: { ...CLAIM_FIELDS, merchantName: "Lemonade" } });
    const missingRefund = (() => {
      try {
        h.service.authorize(SESSION_A, c.id, c.revision);
        return null;
      } catch (err) {
        return (err as ApiHttpError).fields;
      }
    })();
    expect(missingRefund).toEqual(["amountMinor"]);
    const a = h.service.authorize(SESSION_A, c.id, c.revision, "file_claim" as CallPurpose);
    expect(a.authorization?.purpose).toBe("file_claim");
    const snap = h.repo.findAuthorization(c.id, c.revision)!.snapshot;
    expect(snap).toMatchObject({ policyNumber: "NWM-HO-0441772", incidentDate: "2026-10-03", claimType: "water damage" });
    expect(snap.merchant.source?.insurerId).toBe("lemonade");
    expect(snap.brief).toContain("Purpose: file a new insurance claim");
    expect(snap.brief).toContain("- Policy number: NWM-HO-0441772");
  });
});
