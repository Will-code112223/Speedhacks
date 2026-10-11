import { describe, expect, it } from "vitest";
import { e164Phone, refinedValue, samePhone } from "@/server/workflows/facts";

describe("workflow facts: agreement between sources", () => {
  it("treats one phone number written two ways as the same number", () => {
    expect(samePhone("+19495200007", "+1 (949) 520-0007")).toBe(true);
    expect(samePhone("949-520-0007", "+1 949 520 0007")).toBe(true);
    expect(samePhone("+19495200007", "+19495200008")).toBe(false);
    expect(samePhone("520-0007", "0007")).toBe(false);
  });

  it("keeps the fuller wording when a longer value carries every word of the shorter one", () => {
    expect(refinedValue("insuranceProvider", "AAA", "AAA Insurance (CSAA Insurance Group)")).toBe("AAA Insurance (CSAA Insurance Group)");
    expect(refinedValue("vehicle", "red 2021 Toyota Camry", "2021 Toyota Camry SE, red, 4-door sedan")).toBe("2021 Toyota Camry SE, red, 4-door sedan");
    expect(refinedValue("vehicle", "2021 Toyota Camry SE, red, 4-door sedan", "red 2021 Toyota Camry")).toBe("2021 Toyota Camry SE, red, 4-door sedan");
    expect(refinedValue("lossDate", "October 10", "October 10, 2026")).toBe("October 10, 2026");
  });

  it("reads the policyholder's role the same way however it is worded", () => {
    expect(refinedValue("claimantRole", "insured", "policyholder")).toBe("insured");
    expect(refinedValue("claimantRole", "Named insured", "I am the policyholder")).toBe("Named insured");
    expect(refinedValue("claimantRole", "policyholder", "other party")).toBeNull();
  });

  it("stores a North American phone number as E.164 whatever way it was typed", () => {
    expect(e164Phone("+1 949 520 0007")).toBe("+19495200007");
    expect(e164Phone("(949) 520-0007")).toBe("+19495200007");
    expect(e164Phone("+19495200007")).toBe("+19495200007");
    expect(e164Phone("+44 20 7946 0958")).toBe("+44 20 7946 0958");
  });

  it("still reports values that genuinely differ", () => {
    expect(refinedValue("vehicle", "2021 Toyota Camry", "2019 Honda Civic")).toBeNull();
    expect(refinedValue("insuranceProvider", "AAA", "GEICO")).toBeNull();
    expect(refinedValue("lossLocation", "Oakland", "San Francisco")).toBeNull();
  });

  it("never refines identifiers, amounts, emails or phone numbers", () => {
    expect(refinedValue("amount", "100", "100 and 1000")).toBeNull();
    expect(refinedValue("orderNumber", "BILL-001", "BILL-001 and BILL-002")).toBeNull();
    expect(refinedValue("policyNumber", "CAA 0931", "CAA 0931 4471")).toBeNull();
    expect(refinedValue("customerEmail", "a@example.com", "a@example.com and b@example.com")).toBeNull();
    expect(refinedValue("supportPhone", "+1 949", "+1 949 520 0007")).toBeNull();
  });
});
