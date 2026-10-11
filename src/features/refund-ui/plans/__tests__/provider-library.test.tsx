import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { InsurerLookup, InsurerTerm } from "../../api/insurer-types";
import ProviderLibrary, { ResourcePreview } from "../ProviderLibrary";
import { providerLibrary, preparationWorksheet } from "../provider-library";
import { policyPreviewKind } from "../PolicyPreview";
import providerSeeds from "../../../../server/insurers/seed/insurers.json";

function provider(terms: InsurerTerm[] = []): InsurerLookup {
  return { id: "geico", name: "GEICO", legalName: null, parentId: null, categories: ["auto"], lines: ["auto"], aliases: [], eligibility: null, website: "https://www.geico.com", tosUrl: null, privacyUrl: null, notes: null, supportPhone: null, supportPhoneConfidence: null, claimsPhone: null, claimsPhoneConfidence: null, needsPlanOrRegion: false, contacts: [], terms, openQuestions: [], match: { via: "id", matched: "geico" } };
}
function term(overrides: Partial<InsurerTerm> = {}): InsurerTerm {
  return { line: "auto", key: "claim_filing_method", value: "Contact the provider with the incident details.", valueNumber: null, unit: null, jurisdictionScope: "California", notes: "Confirm this applies to your policy.", sourceUrl: "https://www.geico.com/claims/", sourceQuote: null, retrievedAt: "2026-10-11", confidence: "verified_official", ...overrides };
}

describe("provider resource library", () => {
  it("keeps the canonical GEICO claims portal even though its path has no claim keyword", () => {
    const data = { ...provider(), ...providerSeeds.find((item) => item.id === "geico") } as InsurerLookup;
    expect(providerLibrary(data).find((resource) => resource.url === "https://claims.geico.com/")).toMatchObject({ kind: "web", title: "Claims resources" });
  });

  it("derives source PDFs and actual excerpts without inventing official blank forms", () => {
    const data = provider([term({ sourceUrl: "https://www.geico.com/reference.pdf" })]);
    const resources = providerLibrary(data);
    expect(resources.find((resource) => resource.kind === "document")).toMatchObject({ title: "reference.pdf", url: "https://www.geico.com/reference.pdf", checkedAt: "2026-10-11" });
    expect(resources.find((resource) => resource.kind === "guidance")?.excerpt).toContain("Contact the provider with the incident details.");
    expect(resources.filter((resource) => resource.kind === "worksheet")).toHaveLength(1);
    expect(resources.find((resource) => resource.kind === "worksheet")?.excerpt).toContain("NOT AN INSURER FORM");
  });

  it("deduplicates a PDF cited by several terms while preserving their separate guidance", () => {
    const resources = providerLibrary(provider([term({ sourceUrl: "https://www.geico.com/reference.pdf" }), term({ key: "claim_report_deadline", value: "See your policy.", sourceUrl: "https://www.geico.com/reference.pdf" })]));
    expect(resources.filter((resource) => resource.kind === "document")).toHaveLength(1);
    expect(resources.filter((resource) => resource.kind === "guidance")).toHaveLength(2);
  });

  it("shows only the clearly authored worksheet when official resources are absent", () => {
    const resources = providerLibrary(provider());
    expect(resources.map((resource) => resource.kind)).toEqual(["worksheet"]);
    const html = renderToStaticMarkup(<ProviderLibrary insurer={provider()} />);
    expect(html).toContain("Blank preparation worksheet");
    expect(html).not.toContain("Source PDF");
    expect(html).not.toContain("Claim form.pdf");
  });

  it("never treats a null filing value as a known requirement", () => {
    expect(providerLibrary(provider([term({ value: null, notes: null, sourceUrl: null })])).some((resource) => resource.kind === "guidance")).toBe(false);
    const worksheet = preparationWorksheet("GEICO");
    expect(worksheet).toContain("Policy or account number:\n");
    expect(worksheet).not.toContain("policy covers");
    expect(worksheet).toContain("Check your provider's actual filing requirements");
  });

  it("rejects executable source URLs at projection and preview boundaries", () => {
    const resources = providerLibrary(provider([term({ sourceUrl: "javascript:alert(1)" })]));
    expect(resources.every((resource) => resource.url === null)).toBe(true);
    const html = renderToStaticMarkup(<ResourcePreview resource={{ id: "bad", title: "Untrusted", kind: "document", excerpt: "<script>alert(1)</script>", url: "javascript:alert(1)", checkedAt: null, confidence: "unknown" }} onClose={() => {}} />);
    expect(html).not.toContain("javascript:"); expect(html).not.toContain("<script>"); expect(html).not.toContain("<iframe");
  });

  it("labels previews as excerpts and gives an actual source fallback", () => {
    const resource = providerLibrary(provider([term({ sourceUrl: "https://www.geico.com/reference.pdf" })])).find((item) => item.kind === "document")!;
    const html = renderToStaticMarkup(<ResourcePreview resource={resource} onClose={() => {}} />);
    expect(html).toContain("Knowledge-base excerpt"); expect(html).toContain("Open source PDF"); expect(html).toContain('href="https://www.geico.com/reference.pdf"'); expect(html).toContain("Close resource preview");
    expect(html).not.toContain("<iframe");
  });

  it("limits uploaded inline previews to supported MIME types and keeps active files download-only", () => {
    expect(policyPreviewKind("application/pdf")).toBe("pdf");
    expect(policyPreviewKind("image/png")).toBe("image");
    expect(policyPreviewKind("image/heic")).toBe("download");
    expect(policyPreviewKind("image/svg+xml")).toBe("download");
    expect(policyPreviewKind("text/html")).toBe("download");
  });
});
