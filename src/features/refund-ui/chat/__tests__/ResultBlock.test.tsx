/**
 * Server-renders the outcome card: a claim or information call must never read as a refund.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CallV1, CaseV1 } from "../../../../contracts/case";
import type { CallPurpose } from "../../../../contracts/voice";
import ResultBlock from "../ResultBlock";

const at = "2026-10-11T19:00:00.000Z";
const call: CallV1 = {
  id: "call-1", requestId: "request-1", authorizationId: "approval-1", providerCallId: "dial-1", mode: "live",
  state: "completed", transcript: "Support: Your claim number is 04-1234-5678.", error: null, createdAt: at, updatedAt: at,
};

function makeCase(purpose: CallPurpose | undefined, outcome: Partial<CaseV1["outcome"]>, status: CaseV1["status"] = "approved"): CaseV1 {
  return {
    schemaVersion: 1, id: "case-1", revision: 2, mode: "live", status,
    customer: { name: "Jordan Lee", email: null }, merchant: { name: "Harbor Mutual", supportPhone: "+15555550100" },
    amountMinor: 120000, currency: "USD", reason: "Water damage", evidence: [], missingFields: [], draft: null,
    authorization: { id: "approval-1", revision: 2, approvedAt: at, ...(purpose ? { purpose } : {}) },
    calls: [call],
    outcome: { decision: "approved", referenceNumber: null, nextAction: null, paymentStatus: "unverified", supportingQuote: null, ...outcome },
    timeline: [], createdAt: at, updatedAt: at,
  };
}

function heading(caseData: CaseV1): string {
  const html = renderToStaticMarkup(
    <ResultBlock caseData={caseData} call={call} latest fixture={false} packet={{ busy: false, error: null }} onDownloadPacket={() => {}} />,
  );
  const match = /data-testid="outcome-heading">(.*?)<\/h3>/s.exec(html);
  return (match?.[1] ?? "").replace(/<[^>]+>/g, "");
}

describe("outcome headline by call purpose", () => {
  it("keeps the refund headline with the amount for a refund call", () => {
    expect(heading(makeCase(undefined, { decision: "approved" }))).toBe("Approved - $1,200.00 refund");
  });

  it("shows the claim number, never a refund or an amount, when a claim was opened", () => {
    const text = heading(makeCase("file_claim", { decision: "approved", referenceNumber: "04-1234-5678" }));
    expect(text).toBe("Claim opened - claim 04-1234-5678");
    expect(text).not.toMatch(/refund|\$/i);
  });

  it("says no claim was filed yet, with the reason, when no claim was opened", () => {
    const text = heading(makeCase("file_claim", { decision: "unknown" }, "awaiting_response"));
    expect(text).toBe("No claim filed yet - no claim number was given on the call");
    expect(heading(makeCase("file_claim", { decision: "denied" }, "denied"))).toBe("No claim filed yet - the insurer declined to open one");
  });

  it("never mentions a refund or an amount for an information call", () => {
    const text = heading(makeCase("gather_information", { decision: "needs_information" }, "awaiting_response"));
    expect(text).toBe("Information call - Harbor Mutual");
    expect(text).not.toMatch(/refund|\$/i);
  });
});
