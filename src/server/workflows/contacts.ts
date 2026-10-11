import type { CaseWorkflow, WorkflowContact, WorkflowKind } from "@/contracts/workflow";
import { lookupInsurer } from "@/server/insurers";

type Facts = CaseWorkflow["facts"];
const phone = (value: string | null | undefined) => value && /^\+[1-9]\d{7,14}$/.test(value) ? value : null;
function httpsUrl(value: string | null | undefined): string | null {
  try { const url = new URL(value ?? ""); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; } catch { return null; }
}
const factSource = (facts: Facts, key: keyof Facts): WorkflowContact["source"] => facts[key]?.source === "document" ? "document" : "user";

/** Sourced candidates only. Reading a directory never selects or authorizes a recipient. */
export function workflowContacts(kind: WorkflowKind, facts: Facts, dataDir?: string): WorkflowContact[] {
  const result: WorkflowContact[] = [];
  const insurance = kind === "auto_insurance";
  const provider = (insurance ? facts.insuranceProvider?.value : null) || facts.merchantName?.value;
  const supplied = phone(facts.supportPhone?.value);
  if (supplied) result.push({ id: "provided-provider", role: insurance ? "insurer" : "merchant", name: provider || "Provided contact", phone: supplied,
    url: null, source: factSource(facts, "supportPhone"), sourceUrl: null, requiresConfirmation: true });
  if (insurance && (facts.otherPartyName?.value || facts.otherPartyPhone?.value)) result.push({ id: "provided-other-party", role: "other_party",
    name: facts.otherPartyName?.value || "Other party", phone: phone(facts.otherPartyPhone?.value), url: null,
    source: factSource(facts, "otherPartyPhone"), sourceUrl: null, requiresConfirmation: true });

  if (!insurance && provider && /^(?:amazon|amazon\.com)(?:\s+(?:inc\.?|marketplace))?$/i.test(provider.trim())) {
    result.push({ id: "amazon-orders", role: "merchant", name: "Amazon order history", phone: null,
      url: "https://www.amazon.com/gp/your-account/order-history", source: "knowledge_base",
      sourceUrl: "https://www.amazon.com/gp/your-account/order-history", requiresConfirmation: true });
  }
  if (insurance && provider) {
    const insurer = lookupInsurer(provider, dataDir);
    const seen = new Set<string>();
    for (const contact of insurer?.contacts ?? []) {
      if (contact.purpose !== "claims" || contact.purposeVerified === false || contact.scope === "corporate_only" ||
        !["verified_official", "reported"].includes(contact.confidence) || !httpsUrl(contact.sourceUrl)) continue;
      const number = contact.channel === "phone" ? phone(contact.phoneE164) : null;
      const url = contact.channel === "web" ? httpsUrl(contact.url) : null;
      if (!number && !url) continue;
      const key = `${number ?? ""}|${url ?? ""}`;
      if (seen.has(key)) continue; seen.add(key);
      const scope = contact.region ? ` (${contact.region})` : contact.scope !== "national" ? ` (${contact.scope.replaceAll("_", " ")})` : "";
      result.push({ id: `kb-${insurer!.id}-${result.length}`, role: "insurer", name: `${insurer!.name} claims${scope}`, phone: number, url,
        source: "knowledge_base", sourceUrl: httpsUrl(contact.sourceUrl), requiresConfirmation: true });
    }
  }
  return result;
}
