import { describe, expect, it } from "vitest";
import { analyzeTranscript } from "@/server/cases/outcome";

const context = { amountMinor: 10_000, currency: "USD", merchantName: "Fictional Merchant" };

describe("refund outcome amount boundaries", () => {
  it.each([
    "We approved a partial refund of $25.",
    "We approved a refund of $25.",
    "We approved a refund of USD 25.00 against your USD 100.00 charge.",
    "We approved a refund of 2500 cents.",
    "We approved a refund of EUR 100.",
    "We approved a refund of C$100.",
    "We approved a refund of $100.001.",
    "We approved a refund of twenty-five dollars.",
    "We approved a refund of $100 minus a fee.",
    "We approved a refund of $100 less fees.",
    "We approved a refund of up to $100.",
    "We approved a 50% refund.",
    "We approved $100 in store credit.",
    "We can offer a $25 refund.",
    "Would you accept our offer of a $25 refund?",
  ])("does not present the full requested amount as approved: %s", (statement) => {
    const result = analyzeTranscript(`Support: ${statement}`, context);
    expect(result.decision).toBe("needs_information");
    expect(result.supportingQuote).toBe(statement);
    expect(result.paymentStatus).toBe("unverified");
    expect(result.nextAction).toContain("have not been verified");
    expect(result.nextAction).not.toContain("$100.00 refund");
  });

  it.each([
    "We approved the refund of $100.",
    "We processed a USD 100.00 refund.",
    "We approved a refund of 100.00 dollars.",
    "We approved a refund of 10000 cents.",
  ])("retains an explicit full-amount approval without asserting payment: %s", (statement) => {
    const result = analyzeTranscript(`Support: ${statement}`, context);
    expect(result.decision).toBe("approved");
    expect(result.supportingQuote).toBe(statement);
    expect(result.paymentStatus).toBe("unverified");
    expect(result.nextAction).toContain("verify the payment");
  });

  it("does not fill an unspecified approval with the requested amount", () => {
    const result = analyzeTranscript("Support: I've processed the refund. Reference number is REF-12345.", context);
    expect(result.decision).toBe("approved");
    expect(result.referenceNumber).toBe("REF-12345");
    expect(result.nextAction).toContain("Confirm the approved amount");
    expect(result.nextAction).not.toContain("100");
    expect(result.paymentStatus).toBe("unverified");
  });

  it("uses exact minor units for decimal and grouped amounts", () => {
    expect(analyzeTranscript("Support: We processed the USD 49.99 refund.", { ...context, amountMinor: 4999 }).decision).toBe("approved");
    expect(analyzeTranscript("Support: We processed the USD 49.98 refund.", { ...context, amountMinor: 4999 }).decision).toBe("needs_information");
    expect(analyzeTranscript("Support: We approved a refund of $1,234.56.", { ...context, amountMinor: 123456 }).decision).toBe("approved");
    expect(analyzeTranscript("Support: We approved a refund of $1,23.45.", context).decision).toBe("needs_information");
  });

  it("a later smaller approval supersedes an earlier full approval", () => {
    const result = analyzeTranscript("Support: We approved a $100 refund. Correction: we approved a refund of $25.", context);
    expect(result.decision).toBe("needs_information");
    expect(result.supportingQuote).toBe("Correction: we approved a refund of $25.");
    expect(result.nextAction).not.toContain("$100.00 refund");
  });

  it("a later explicit full approval can supersede a partial offer", () => {
    const result = analyzeTranscript("Support: We can offer a $25 refund. I have now approved the full $100 refund.", context);
    expect(result.decision).toBe("approved");
    expect(result.supportingQuote).toBe("I have now approved the full $100 refund.");
    expect(result.paymentStatus).toBe("unverified");
  });

  it("retains an amount limitation in a following support sentence", () => {
    const result = analyzeTranscript("Support: The refund was approved. It will be $25.", context);
    expect(result.decision).toBe("needs_information");
    expect(result.supportingQuote).toBe("It will be $25.");
    expect(result.nextAction).not.toContain("$100.00 refund");
  });

  it("does not let an unrelated customer amount replace support's approval", () => {
    const result = analyzeTranscript("Support: We approved the refund of $100.\nCustomer: It will be $25.", context);
    expect(result.decision).toBe("approved");
    expect(result.supportingQuote).toBe("We approved the refund of $100.");
  });

  it("does not turn an agent acceptance into support approval of an offer", () => {
    const result = analyzeTranscript("Support: We can offer a $25 refund.\nAI assistant: I accept; the $100 refund is approved.", context);
    expect(result.decision).toBe("needs_information");
    expect(result.supportingQuote).toBe("We can offer a $25 refund.");
    expect(result.paymentStatus).toBe("unverified");
  });

  it.each([
    "Support: If the review passes, the $100 refund is approved.",
    "Support: Is the $100 refund approved?",
    'Support: Your note says "the $100 refund is approved" but the request is still under review.',
    "AI assistant: The refund of $100 was approved.",
    "Customer: I approved the refund of $100.",
  ])("does not weaken existing approval evidence checks: %s", (transcript) => {
    expect(analyzeTranscript(transcript, context).decision).not.toBe("approved");
  });

  it("preserves an explicit denial and its quote", () => {
    const result = analyzeTranscript("Support: We cannot refund the $100 charge.", context);
    expect(result.decision).toBe("denied");
    expect(result.supportingQuote).toBe("We cannot refund the $100 charge.");
    expect(result.paymentStatus).toBe("unverified");
  });
});
