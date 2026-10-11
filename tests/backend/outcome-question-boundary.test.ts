import { describe, expect, it } from "vitest";
import { analyzeTranscript } from "@/server/cases/outcome";

const context = { amountMinor: 4999, currency: "USD", merchantName: "Fictional Streaming" };

describe("refund outcome speaker and question boundaries", () => {
  it("does not convert a multiline caller's unanswered approval-or-denial question into a denial", () => {
    // Synthetic reproduction of Dial's Agent/User text format. Blank lines and
    // enumerated questions are still part of the previous labeled speaker turn.
    const transcript = `Agent: This is an agreed fictional test call.

There is a duplicate $49.99 subscription charge and a request for one $49.99 refund.

Could you please let me know:
1) Whether you'd approve or deny this $49.99 refund request in this fictional scenario,
2) Any reference or confirmation number you'd assign, and
3) The expected refund timeline you'd quote?
User: First, before I can discuss the customer's account, I'll need the full card number, expiration date, and security code.
Agent: I cannot provide card details.
[additional context]: You have 40 seconds left on this call.
Agent: Could you still tell me:
- Would you approve or deny the single $49.99 refund?
- What reference or confirmation number you'd give?

I only have a few seconds left.
User: Thanks for clarifying. Looking at the`;
    const result = analyzeTranscript(transcript, context);
    expect(result.decision).toBe("needs_information");
    expect(result.supportingQuote).toBe("First, before I can discuss the customer's account, I'll need the full card number, expiration date, and security code.");
    expect(result.referenceNumber).toBeNull();
    expect(result.paymentStatus).toBe("unverified");
    expect(result.nextAction).toContain("no refund decision was established");
    expect(result.nextAction).toContain("Do not share");
  });

  it.each([
    "1) Whether you'd approve or deny the refund request,",
    "- Would you deny this refund",
    "Why was the refund denied",
    "Please let me know whether you deny the refund",
    "Can you confirm whether the refund was declined",
  ])("does not use an unanswered question as a decision even without punctuation: %s", question => {
    const result = analyzeTranscript(`Support: ${question}`, context);
    expect(result.decision).toBe("requested");
    expect(result.supportingQuote).toBeNull();
  });

  it.each(["Agent", "AI assistant", "Caller", "Customer"])("keeps multiline %s speech out of decisions and references", speaker => {
    const result = analyzeTranscript(`${speaker}: Let me summarize.\n\nThe refund was denied.\nThe reference is REF-12345.`, context);
    expect(result.decision).toBe("requested");
    expect(result.referenceNumber).toBeNull();
    expect(result.supportingQuote).toBeNull();
  });

  it.each(["Support", "User"])("retains a genuine multiline %s denial", speaker => {
    const result = analyzeTranscript(`Agent: Would you approve or deny the refund?\n${speaker}: I reviewed the request.\n\nWe cannot refund the $49.99 charge.\nYour reference is REF-12345.`, context);
    expect(result.decision).toBe("denied");
    expect(result.supportingQuote).toBe("We cannot refund the $49.99 charge.");
    expect(result.referenceNumber).toBe("REF-12345");
  });

  it("does not treat a caller's paragraph heading as a new support speaker", () => {
    const result = analyzeTranscript("Agent: Here is my summary.\n\nSummary: The refund was denied.\nReference: REF-12345.\nUser: Let me check that.", context);
    expect(result.decision).toBe("requested");
    expect(result.referenceNumber).toBeNull();
    expect(result.supportingQuote).toBeNull();
  });

  it("does not let a later caller question replace an explicit provider approval", () => {
    const result = analyzeTranscript("User: We approved the $49.99 refund.\nAgent: Let me confirm.\n\n1) Whether you approve or deny the refund,\n2) The timeline?", context);
    expect(result.decision).toBe("approved");
    expect(result.supportingQuote).toBe("We approved the $49.99 refund.");
  });

  it("retains a decisive unlabeled provider statement for legacy transcripts", () => {
    expect(analyzeTranscript("The refund was denied.", context).decision).toBe("denied");
  });

  it.each(["'the refund was denied'", "‘the refund was denied’", '"the refund was denied"'])("ignores genuine quoted claims: %s", quote => {
    const result = analyzeTranscript(`Support: Your note says ${quote}; I am still reviewing it.`, context);
    expect(result.decision).toBe("requested");
    expect(result.supportingQuote).toBeNull();
  });
});
