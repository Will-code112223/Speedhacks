import { describe, expect, it } from "vitest";
import { analyzeTranscript, type TranscriptContext } from "@/server/cases/outcome";

/** Refund calls read from real-world transcripts: contractions, recordings, policy numbers and the call cap. */
const context: TranscriptContext = { amountMinor: 10000, currency: "USD", merchantName: "Acme Store" };

describe("contractions are not quotes", () => {
  it("reads a contraction-heavy refusal as denied, never approved", () => {
    const result = analyzeTranscript("Support: We're sorry, but we can't approve your refund.", context);
    expect(result.decision).toBe("denied");
    expect(result.supportingQuote).toBe("We're sorry, but we can't approve your refund.");
  });

  it("keeps several contractions in one sentence intact", () => {
    const transcript = "Support: I'm afraid it's past the window, so we won't be issuing a refund and that's final.";
    expect(analyzeTranscript(transcript, context).decision).toBe("denied");
  });

  it("still ignores a claim the representative quotes back", () => {
    const transcript = "Support: You wrote 'your refund was approved' in the chat, but I don't see that on file.";
    expect(analyzeTranscript(transcript, context).decision).not.toBe("approved");
  });
});

describe("recordings are never a decision", () => {
  it("an IVR saying 'we cannot complete your request' is not a denial", () => {
    const result = analyzeTranscript("We're sorry. We cannot complete your request at this time. Please hang up and try again.", context);
    expect(result.decision).toBe("unknown");
    expect(result.nextAction).toContain("could not complete the call; nothing was filed");
    expect(result.nextAction).not.toMatch(/card issuer/);
  });

  it("a voicemail greeting is unknown, not requested", () => {
    const result = analyzeTranscript("You've reached Acme Store customer care. Please leave a message after the beep.", context);
    expect(result.decision).toBe("unknown");
    expect(result.nextAction).toContain("reached voicemail; nothing was filed");
  });

  it("a hold queue cut off at the time limit says nothing was filed", () => {
    const transcript = "Thank you for calling Acme Store. Please continue to hold for the next available agent.";
    const result = analyzeTranscript(transcript, { ...context, durationSeconds: 299, maxCallDurationSeconds: 300 });
    expect(result.decision).toBe("unknown");
    expect(result.nextAction).toMatch(/^The call was cut off at the time limit; nothing was filed\./);
  });

  it("a person answering after hold is still read as a conversation", () => {
    const transcript = "Please hold for the next available agent.\nSupport: Hi, this is Sam. I've processed your refund. Reference number is REF-12345.";
    const result = analyzeTranscript(transcript, context);
    expect(result.decision).toBe("approved");
    expect(result.referenceNumber).toBe("REF-12345");
  });

  it("a short call without the cap keeps the requested fallback", () => {
    const result = analyzeTranscript("Support: Thanks, I've noted that.", { ...context, durationSeconds: 40, maxCallDurationSeconds: 300 });
    expect(result.decision).toBe("requested");
  });
});

describe("reference numbers", () => {
  it("prefers the number next to 'confirmation number' over a policy number read first", () => {
    const transcript = "Support: I see policy HO-778812 on the account. Your confirmation number is 0412345678.";
    expect(analyzeTranscript(transcript, context).referenceNumber).toBe("0412345678");
  });

  it("skips a token introduced as a policy number even without the case policy", () => {
    const transcript = "Support: I see policy HO-778812 on the account.";
    expect(analyzeTranscript(transcript, context).referenceNumber).toBeNull();
  });

  it("joins a reference number spoken in digits", () => {
    const transcript = "Support: Your reference number is 7 7 3 1 9 0.";
    expect(analyzeTranscript(transcript, context).referenceNumber).toBe("773190");
  });

  it("reads 'claim #' labels", () => {
    expect(analyzeTranscript("Support: Okay, claim # 55-901-2 is yours.", context, "file_claim").referenceNumber).toBe("55-901-2");
  });
});
