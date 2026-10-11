import { describe, expect, it, vi } from "vitest";
import type { CaseWorkflow } from "@/contracts/workflow";
const kb = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("@/server/insurers", () => ({ lookupInsurer: kb.lookup }));
import { workflowContacts } from "@/server/workflows/contacts";
const facts = (values: Record<string, string>): CaseWorkflow["facts"] => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { label: key, value, source: "user", sourceRefs: ["message-id"] }]));
const contact = { purpose: "claims", channel: "web", scope: "national", region: null, purposeVerified: true, phoneE164: null,
  url: "https://claims.geico.com/", sourceUrl: "https://www.geico.com/claims/", confidence: "verified_official" };

describe("workflow contact candidates", () => {
  it("uses recorded claims purpose even when the filing URL has no claim/form pathname", () => {
    kb.lookup.mockReturnValue({ id: "geico", name: "GEICO", contacts: [contact] });
    const input = facts({ insuranceProvider: "GEICO" }); const before = structuredClone(input);
    const result = workflowContacts("auto_insurance", input);
    expect(result).toHaveLength(1); expect(result[0]).toMatchObject({ url: "https://claims.geico.com/", sourceUrl: contact.sourceUrl, requiresConfirmation: true });
    expect(input).toEqual(before); expect(input.supportPhone).toBeUndefined();
  });
  it("does not turn unverified, rejected, corporate, or unrelated phone records into call targets", () => {
    kb.lookup.mockReturnValue({ id: "geico", name: "GEICO", contacts: [
      { ...contact, confidence: "unknown" }, { ...contact, purposeVerified: false }, { ...contact, scope: "corporate_only" },
      { ...contact, purpose: "billing" }, { ...contact, sourceUrl: null }, { ...contact, url: "javascript:alert(1)" },
    ] });
    expect(workflowContacts("auto_insurance", facts({ insuranceProvider: "GEICO" }))).toEqual([]);
  });
  it("keeps separately supplied third-party contacts separate and requires review", () => {
    kb.lookup.mockReturnValue(null);
    expect(workflowContacts("auto_insurance", facts({ insuranceProvider: "Unknown", supportPhone: "+12025550101", otherPartyName: "Test party", otherPartyPhone: "+12025550102" }))).toEqual([
      expect.objectContaining({ role: "insurer", phone: "+12025550101", requiresConfirmation: true }),
      expect.objectContaining({ role: "other_party", phone: "+12025550102", requiresConfirmation: true }),
    ]);
  });
  it("never invents a merchant phone or applies Amazon's portal to a similar-looking merchant", () => {
    expect(workflowContacts("refund", facts({ merchantName: "Unlisted shop" }))).toEqual([]);
    expect(workflowContacts("refund", facts({ merchantName: "Amazon competitor" }))).toEqual([]);
    expect(workflowContacts("refund", facts({ merchantName: "Amazon" }))).toEqual([expect.objectContaining({ phone: null, url: "https://www.amazon.com/gp/your-account/order-history", requiresConfirmation: true })]);
  });
});
