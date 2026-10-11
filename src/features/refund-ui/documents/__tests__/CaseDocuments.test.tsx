import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { sampleCase } from "../../api/__tests__/support";
import { toUiError } from "../../state/errors";
import CaseDocuments, { draftText } from "../CaseDocuments";

const idle = { busy: false, error: null };
const noop = () => {};

describe("case document preparation", () => {
  it("makes the actual draft and packet available before approval or a call", () => {
    const caseData = sampleCase({ draft: { subject: "Review this request", body: "Provided fact.\n\nNo inferred policy terms." } });
    const html = renderToStaticMarkup(<CaseDocuments caseData={caseData} fixture={false} packet={idle} onDownloadPacket={noop} />);
    expect(caseData.authorization).toBeNull();
    expect(caseData.calls).toHaveLength(0);
    expect(html).toContain("Review this request");
    expect(html).toContain("Provided fact.\n\nNo inferred policy terms.");
    expect(html).toContain("Download case packet");
    expect(html).toContain("Copy draft");
    expect(html).toContain("Not submitted");
    expect(html).toContain("not an official insurer form");
    expect(html).not.toContain("<details");
  });

  it("shows unknown facts without inventing a draft and still offers the incomplete packet", () => {
    const caseData = sampleCase({ status: "needs_information", draft: null, missingFields: ["customer.name", "policyNumber"], evidence: [] });
    const html = renderToStaticMarkup(<CaseDocuments caseData={caseData} fixture={false} packet={idle} onDownloadPacket={noop} />);
    expect(html).toContain("Your name");
    expect(html).toContain("Policy number");
    expect(html).toContain("No draft available yet");
    expect(html).toContain("No evidence files are attached");
    expect(html).toContain("Download case packet");
    expect(html).not.toContain("Copy draft");
    expect(draftText(caseData, false)).toBeNull();
  });

  it("does not invent missing fields when a complete case has no draft", () => {
    const html = renderToStaticMarkup(<CaseDocuments caseData={sampleCase({ draft: null })} fixture={false} packet={idle} onDownloadPacket={noop} />);
    expect(html).toContain("has not returned a request draft");
    expect(html).not.toContain("Information still needed");
    expect(html).not.toContain("Complete the missing information");
  });

  it("distinguishes fixture documents from real insurer submissions in both display and copied text", () => {
    const caseData = sampleCase();
    const html = renderToStaticMarkup(<CaseDocuments caseData={caseData} fixture packet={idle} onDownloadPacket={noop} />);
    expect(html).toContain("Do not submit simulated data to an insurer.");
    expect(html).toContain("Simulated");
    expect(draftText(caseData, true)).toContain("FICTIONAL DEMO — fixture data");
    expect(draftText(caseData, false)).not.toContain("FICTIONAL DEMO");
    expect(draftText(caseData, false)).toContain("PREPARATION DRAFT — NOT SUBMITTED");
    expect(draftText(caseData, false)).toContain(caseData.draft!.body);
  });

  it("escapes document and evidence content instead of rendering supplied markup", () => {
    const caseData = sampleCase({
      draft: { subject: "<script>alert(1)</script>", body: "<img src=x onerror=alert(1)>" },
      evidence: [{ id: "e-1", name: "<strong>policy</strong>.pdf", mimeType: "application/pdf" }],
    });
    const html = renderToStaticMarkup(<CaseDocuments caseData={caseData} fixture={false} packet={idle} onDownloadPacket={noop} />);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;strong&gt;policy&lt;/strong&gt;.pdf");
    expect(html).toContain("does not bundle the original attachments");
  });

  it("announces download progress and retains a visible packet failure", () => {
    const caseData = sampleCase();
    const busy = renderToStaticMarkup(<CaseDocuments caseData={caseData} fixture={false} packet={{ busy: true, error: null }} onDownloadPacket={noop} />);
    expect(busy).toContain('aria-busy="true"');
    expect(busy).toContain("Preparing the case packet");
    const failed = renderToStaticMarkup(<CaseDocuments caseData={caseData} fixture={false} packet={{ busy: false, error: toUiError(new Error("offline")) }} onDownloadPacket={noop} />);
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Download case packet");
  });
});
