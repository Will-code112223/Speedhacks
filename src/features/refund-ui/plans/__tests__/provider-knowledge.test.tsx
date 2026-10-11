import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { InsurerLookup, InsurerSummary } from "../../api/insurer-types";
import type { InsurerApi } from "../../api/insurers";
import { ProviderDetails, ProviderKnowledgeView, ProviderMark } from "../ProviderKnowledge";
import { createProviderResource, providerUrl, type ProviderState } from "../provider-resource";

function provider(id = "geico"): InsurerLookup {
  return {
    id, name: id === "geico" ? "GEICO" : id, legalName: null, parentId: null, categories: ["auto"], lines: ["auto"], aliases: [], eligibility: null,
    website: "https://www.geico.com", tosUrl: null, privacyUrl: null, notes: null, supportPhone: null, supportPhoneConfidence: null,
    claimsPhone: null, claimsPhoneConfidence: null, needsPlanOrRegion: false, contacts: [], terms: [], openQuestions: [], match: { via: "id", matched: id },
  };
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function ready(): ProviderState { return { list: { status: "ready", items: [provider()], error: null }, selection: { id: null, status: "idle", insurer: null, error: null } }; }

describe("provider knowledge loading and selection", () => {
  it("exposes loading, reads the existing directory, and selects by canonical ID", async () => {
    const listing = deferred<InsurerSummary[]>();
    const lookup = vi.fn(async () => provider());
    const resource = createProviderResource({ listInsurers: () => listing.promise, lookupInsurer: lookup });
    const loading = resource.load();
    expect(resource.getSnapshot().list.status).toBe("loading");
    listing.resolve([provider()]); await loading;
    expect(resource.getSnapshot().list.items[0]?.id).toBe("geico");
    await resource.select("geico");
    expect(lookup).toHaveBeenCalledWith("geico");
    expect(resource.getSnapshot().selection).toMatchObject({ id: "geico", status: "ready", insurer: { name: "GEICO" } });
  });

  it("does not fall back to fictional providers when the directory is unavailable", async () => {
    const resource = createProviderResource({ listInsurers: async () => { throw new Error("offline"); }, lookupInsurer: async () => null });
    await resource.load();
    expect(resource.getSnapshot().list).toMatchObject({ status: "error", items: [] });
    const html = renderToStaticMarkup(<ProviderKnowledgeView state={resource.getSnapshot()} onReload={() => {}} onSelect={() => {}} />);
    expect(html).toContain("Provider directory unavailable"); expect(html).toContain("Retry"); expect(html).not.toContain("Northwind");
  });

  it("keeps unknown and unavailable providers distinct without retaining old guidance", async () => {
    const api: InsurerApi = { listInsurers: async () => [provider()], lookupInsurer: async () => provider() };
    const resource = createProviderResource(api);
    await resource.select("geico");
    api.lookupInsurer = async () => null;
    await resource.select("unknown");
    expect(resource.getSnapshot().selection).toMatchObject({ status: "missing", insurer: null });
    api.lookupInsurer = async () => { throw new Error("offline"); };
    await resource.select("geico");
    expect(resource.getSnapshot().selection).toMatchObject({ status: "error", insurer: null });
  });

  it("does not let a slower previous selection replace the current provider", async () => {
    const earlier = deferred<InsurerLookup | null>(); const later = deferred<InsurerLookup | null>();
    const resource = createProviderResource({ listInsurers: async () => [], lookupInsurer: (id) => id === "geico" ? earlier.promise : later.promise });
    const first = resource.select("geico"); const second = resource.select("progressive");
    later.resolve(provider("progressive")); await second;
    earlier.resolve(provider()); await first;
    expect(resource.getSnapshot().selection.insurer?.id).toBe("progressive");
  });

  it("clearing selection or unmounting invalidates an outstanding lookup", async () => {
    const request = deferred<InsurerLookup | null>();
    const resource = createProviderResource({ listInsurers: async () => [], lookupInsurer: () => request.promise });
    const work = resource.select("geico"); await resource.select(null); resource.dispose(); request.resolve(provider()); await work;
    expect(resource.getSnapshot().selection).toMatchObject({ status: "idle", id: null, insurer: null });
  });

  it("has an accessible loading dropdown and retains the policy-coverage boundary", () => {
    const state = ready(); state.list.status = "loading";
    const html = renderToStaticMarkup(<ProviderKnowledgeView state={state} onReload={() => {}} onSelect={() => {}} />);
    expect(html).toContain('role="combobox"'); expect(html).toContain('aria-label="Insurance provider"');
    expect(html).toContain("Loading providers"); expect(html).toContain("disabled");
    expect(html).toContain("Your policy determines coverage");
  });

  it("shows actual contact scope, verification and source date without auto-dial links", () => {
    const insurer = provider(); insurer.needsPlanOrRegion = true;
    insurer.contacts = [{ purpose: "claims", channel: "phone", scope: "plan_specific", region: "California", purposeVerified: false, phoneE164: "+18005550199", hours: null, url: null, notes: "Confirm your plan number.", sourceUrl: "https://www.geico.com/claims/", retrievedAt: "2026-10-11", confidence: "reported" }];
    const html = renderToStaticMarkup(<ProviderDetails insurer={insurer} />);
    expect(html).toContain("Plan specific"); expect(html).toContain("California"); expect(html).toContain("Contact purpose is unverified");
    expect(html).toContain("Checked 2026-10-11"); expect(html).toContain("Reported · confirm"); expect(html).not.toContain("tel:");
  });

  it("does not fabricate policy coverage or claim requirements when guidance is absent", () => {
    const html = renderToStaticMarkup(<ProviderDetails insurer={provider()} />);
    expect(html).toContain("No claim guidance recorded"); expect(html).toContain("No contacts recorded");
    expect(html).not.toContain("covered"); expect(html).not.toContain("deductible");
  });

  it("omits unknown terms and rejects executable source links", () => {
    const insurer = provider(); insurer.website = "javascript:alert(1)";
    insurer.terms = [{ line: "auto", key: "claim_report_deadline", value: null, valueNumber: null, unit: null, jurisdictionScope: null, notes: null, sourceUrl: "javascript:alert(1)", sourceQuote: null, retrievedAt: null, confidence: "unknown" }];
    const html = renderToStaticMarkup(<ProviderDetails insurer={insurer} />);
    expect(html).not.toContain("javascript:"); expect(html).toContain("No claim guidance recorded");
    expect(providerUrl("//evil.example")).toBeUndefined(); expect(providerUrl("https://www.geico.com")).toBe("https://www.geico.com/");
  });

  it("uses no invented mark when an official asset is unavailable", () => {
    const html = renderToStaticMarkup(<ProviderMark id="unknown-provider" name="Unknown Provider" />);
    expect(html).toBe("");
    const state = ready(); state.list.items = [provider("unknown-provider")]; state.selection = { id: "unknown-provider", status: "ready", insurer: provider("unknown-provider"), error: null };
    expect(renderToStaticMarkup(<ProviderKnowledgeView state={state} onReload={() => {}} onSelect={() => {}} />)).toContain("unknown-provider");
  });
});
