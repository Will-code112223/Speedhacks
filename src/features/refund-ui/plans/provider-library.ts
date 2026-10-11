import type { Confidence, InsurerLookup } from "../api/insurer-types";
import { providerUrl } from "./provider-resource";

export interface LibraryResource {
  id: string;
  title: string;
  kind: "guidance" | "document" | "web" | "worksheet";
  excerpt: string;
  url: string | null;
  checkedAt: string | null;
  confidence: Confidence | null;
}

const filingKeys = new Set(["claim_filing_method", "claim_report_deadline", "claim_decision_timeline", "identity_verification_on_call", "appeal_method", "appeal_window_days"]);
function words(value: string) { const text = value.replaceAll("_", " "); return text.charAt(0).toUpperCase() + text.slice(1); }
function pdfName(url: string) {
  try { return decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "Source document"); } catch { return "Source document"; }
}

/** View model only: no new provider documents, policy terms or backend records are created. */
export function providerLibrary(insurer: InsurerLookup): LibraryResource[] {
  const resources: LibraryResource[] = [];
  const sourceUrls = new Set<string>();
  function addSource(raw: string | null, excerpt: string, date: string | null, confidence: Confidence, title: string, claimsPortal = false) {
    const url = providerUrl(raw);
    if (!url || sourceUrls.has(url)) return;
    const isPdf = /\.pdf(?:$|[?#])/i.test(url);
    if (!isPdf && !claimsPortal && !/forms?|claims?/i.test(new URL(url).pathname)) return;
    sourceUrls.add(url);
    resources.push({ id: `source:${url}`, title: isPdf ? pdfName(url) : title, kind: isPdf ? "document" : "web", excerpt, url, checkedAt: date, confidence });
  }
  for (const term of Array.isArray(insurer.terms) ? insurer.terms : []) {
    if (term.value && filingKeys.has(term.key)) resources.push({ id: `guidance:${resources.length}`, title: words(term.key), kind: "guidance", excerpt: [term.line !== "all" ? `${words(term.line)}${term.jurisdictionScope ? ` · ${term.jurisdictionScope}` : ""}` : term.jurisdictionScope, term.value, term.notes].filter(Boolean).join("\n\n"), url: providerUrl(term.sourceUrl) ?? null, checkedAt: term.retrievedAt, confidence: term.confidence });
    addSource(term.sourceUrl, [term.value, term.notes].filter(Boolean).join("\n\n"), term.retrievedAt, term.confidence, words(term.key));
  }
  for (const contact of Array.isArray(insurer.contacts) ? insurer.contacts : []) {
    const excerpt = [words(contact.purpose), words(contact.scope), contact.region, contact.notes].filter(Boolean).join("\n\n");
    addSource(contact.url, excerpt, contact.retrievedAt, contact.confidence, `${words(contact.purpose)} resources`, contact.purpose === "claims" && contact.channel === "web");
    addSource(contact.sourceUrl, excerpt, contact.retrievedAt, contact.confidence, `${words(contact.purpose)} reference`);
  }
  resources.push({ id: "recourse-worksheet", title: "Blank preparation worksheet", kind: "worksheet", excerpt: preparationWorksheet(insurer.name), url: null, checkedAt: null, confidence: null });
  return resources;
}

export function preparationWorksheet(providerName: string): string {
  return [
    "RECOURSE CLAIM PREPARATION WORKSHEET",
    "NOT AN INSURER FORM — NOT SUBMITTED",
    "Use this blank worksheet to collect facts. Check your provider's actual filing requirements.",
    "", `Provider: ${providerName}`, "", "Claimant name:", "Contact details:", "Policy or account number:", "Policy type and region:", "Incident date:", "What happened:", "Amount requested:", "Evidence available:", "Missing information:", "Questions for the provider:", "", "No coverage determination or claim submission is made by this worksheet.",
  ].join("\n");
}
