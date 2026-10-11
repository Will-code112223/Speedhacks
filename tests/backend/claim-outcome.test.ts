import { describe, expect, it } from "vitest";
import { analyzeTranscript, type TranscriptContext } from "@/server/cases/outcome";

/** Realistic insurer calls: what a claim call or an information call must and must not produce. */
const claim: TranscriptContext = {
  amountMinor: 120000,
  currency: "USD",
  merchantName: "Harbor Mutual",
  policyNumber: "HO-778812",
  durationSeconds: 140,
  maxCallDurationSeconds: 300,
};

const NO_REFUND = /refund|card issuer|dispute the/i;

describe("file_claim calls", () => {
  it("records the claim number, not the policy number the representative read first", () => {
    const transcript = [
      "Support: Thank you for calling Harbor Mutual claims, this is Dana.",
      "AI assistant: I am calling to file a water damage claim for Jordan Lee.",
      "Support: I see policy HO-778812 for Jordan Lee at 14 Elm Street.",
      "Support: Okay, I've processed your request. Your claim number is 04-1234-5678.",
      "Support: An adjuster will call within two business days.",
    ].join("\n");
    const result = analyzeTranscript(transcript, claim, "file_claim");
    expect(result.decision).toBe("approved");
    expect(result.referenceNumber).toBe("04-1234-5678");
    expect(result.nextAction).toMatch(/^Claim 04-1234-5678 opened with Harbor Mutual\. Next: /);
    expect(result.nextAction).not.toMatch(NO_REFUND);
  });

  it("joins a claim number spoken digit by digit and still skips the policy number", () => {
    const transcript = [
      "Insurer: I have your policy HO-778812 here.",
      "Insurer: Your claim number is 0 4 1 2 3 4 5 6 7 8.",
    ].join("\n");
    const result = analyzeTranscript(transcript, { ...claim, policyNumber: null }, "file_claim");
    expect(result.decision).toBe("approved");
    expect(result.referenceNumber).toBe("0412345678");
    expect(result.nextAction).toContain("Claim 0412345678 opened");
  });

  it("never records the case's own policy number as the reference", () => {
    const transcript = "Support: Your reference number is HO-778812. We will open the claim once photos arrive.";
    const result = analyzeTranscript(transcript, claim, "file_claim");
    expect(result.referenceNumber).toBeNull();
    expect(result.decision).not.toBe("approved");
  });

  it("reads a voicemail greeting as no claim filed", () => {
    const transcript = "You have reached the Harbor Mutual claims department. Please leave a message after the tone and we will return your call.";
    const result = analyzeTranscript(transcript, claim, "file_claim");
    expect(result.decision).toBe("unknown");
    expect(result.nextAction).toMatch(/voicemail; no claim was filed/);
    expect(result.nextAction).not.toMatch(NO_REFUND);
  });

  it("reads an IVR 'we cannot complete your request' as a phone-system failure, not a denial", () => {
    const transcript = "We're sorry. We cannot complete your request at this time. Please hang up and try again.";
    const result = analyzeTranscript(transcript, claim, "file_claim");
    expect(result.decision).toBe("unknown");
    expect(result.nextAction).toMatch(/could not complete the call; no claim was filed/);
    expect(result.nextAction).not.toMatch(NO_REFUND);
  });

  it("reads a closed-line recording as no claim filed and keeps the hours", () => {
    const transcript = "Thank you for calling Harbor Mutual. Our offices are currently closed. Our business hours are Monday through Friday, 8 a.m. to 6 p.m. Eastern. Goodbye.";
    const result = analyzeTranscript(transcript, claim, "file_claim");
    expect(result.decision).toBe("unknown");
    expect(result.nextAction).toMatch(/line was closed; no claim was filed/);
    expect(result.nextAction).toContain("8 a.m. to 6 p.m.");
    expect(result.nextAction).not.toMatch(NO_REFUND);
  });

  it("says a call cut off at the time limit while on hold filed nothing", () => {
    const transcript = [
      "Thank you for calling Harbor Mutual. Your call is important to us.",
      "Please continue to hold for the next available representative.",
      "Please continue to hold for the next available representative.",
    ].join("\n");
    const result = analyzeTranscript(transcript, { ...claim, durationSeconds: 300 }, "file_claim");
    expect(result.decision).toBe("unknown");
    expect(result.nextAction).toContain("cut off at the time limit; nothing was filed");
    expect(result.nextAction).not.toMatch(NO_REFUND);
    expect(result.decision).not.toBe("requested");
  });

  it("only denies when the insurer says it will not open the claim", () => {
    const transcript = "Support: I'm sorry, but we can't open a claim on this policy because it lapsed in March.";
    const result = analyzeTranscript(transcript, claim, "file_claim");
    expect(result.decision).toBe("denied");
    expect(result.nextAction).toMatch(/will not open a claim; no claim was filed/);
    expect(result.nextAction).not.toMatch(NO_REFUND);
  });

  it("asks for information when the insurer needs documents first", () => {
    const transcript = "Support: Before I can open anything we'll need photos of the damage and the repair estimate.";
    const result = analyzeTranscript(transcript, claim, "file_claim");
    expect(result.decision).toBe("needs_information");
    expect(result.nextAction).toMatch(/No claim was filed yet/);
  });

  it("never approves or denies when a representative answered but opened nothing", () => {
    const transcript = "Support: Thanks for the details. Let me look into the policy and someone will follow up.";
    const result = analyzeTranscript(transcript, claim, "file_claim");
    expect(["unknown", "needs_information"]).toContain(result.decision);
    expect(result.nextAction).toMatch(/No claim was filed/);
  });
});

describe("gather_information calls", () => {
  const info: TranscriptContext = { ...claim, amountMinor: null };

  it("summarizes the documents, deadline and hours that support stated, never approved or denied", () => {
    const transcript = [
      "Support: For a water claim we need photos of the damage, the repair estimate and your receipts.",
      "Support: You have to report the loss within 30 days of the incident.",
      "Support: Our claims line is open Monday through Friday, 8 a.m. to 8 p.m.",
    ].join("\n");
    const result = analyzeTranscript(transcript, info, "gather_information");
    expect(result.decision).toBe("needs_information");
    expect(result.nextAction).toContain('Documents: "For a water claim we need photos');
    expect(result.nextAction).toContain('Deadline: "You have to report the loss within 30 days');
    expect(result.nextAction).toContain('Hours: "Our claims line is open Monday through Friday');
  });

  it("keeps the hours from a closed-line recording", () => {
    const transcript = "Thank you for calling Harbor Mutual. Our offices are currently closed. Our business hours are Monday through Friday, 8 a.m. to 6 p.m. Eastern.";
    const result = analyzeTranscript(transcript, info, "gather_information");
    expect(result.decision).toBe("needs_information");
    expect(result.nextAction).toContain("Hours:");
  });

  it("an IVR refusal is not a denial", () => {
    const result = analyzeTranscript("We cannot complete your request as dialed.", info, "gather_information");
    expect(result.decision).toBe("unknown");
  });

  it("asks for information when nothing useful was said", () => {
    const result = analyzeTranscript("Support: Thanks for calling, have a nice day.", info, "gather_information");
    expect(result.decision).toBe("needs_information");
    expect(result.decision).not.toMatch(/approved|denied/);
  });
});
