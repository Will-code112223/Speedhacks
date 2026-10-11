import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CUSTOMERS,
  EXPECTED_BY_SCENARIO,
  MERCHANTS,
  PHONE_PREFIX,
  SCENARIOS,
  SUFFIX_BY_SCENARIO,
  mulberry32,
  planDemoCases,
  scenarioForPhone,
  scenarioQuotas,
  type DemoCasePlan,
  type DemoScenario,
} from "@/integrations/keewano/demo-plan";
import { E164, isValidAmountMinor } from "@/server/cases/facts";
import { scenarioFor } from "@/server/cases/simulated-voice";

/**
 * The synthetic case plan behind `npm run keewano:demo-cases`: deterministic, the documented
 * outcome mix, E.164 numbers whose suffix the simulated voice adapter actually maps to the
 * planned scenario, and merchants that differ enough for Keewano analytics to be interesting.
 */

const share = (plans: DemoCasePlan[], scenario: DemoScenario, subset = plans) =>
  subset.length === 0 ? 0 : subset.filter((p) => p.scenario === scenario).length / subset.length;

const byMerchant = (plans: DemoCasePlan[], merchant: string) => plans.filter((p) => p.merchant === merchant);

describe("planDemoCases: determinism", () => {
  it("returns the same plan for the same seed and a different one for another seed", () => {
    const a = planDemoCases({ count: 40, seed: 7 });
    const b = planDemoCases({ count: 40, seed: 7 });
    expect(b).toEqual(a);
    expect(a).toHaveLength(40);
    expect(a.map((p) => p.index)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    const c = planDemoCases({ count: 40, seed: 8 });
    expect(c).not.toEqual(a);
    // Same scenario quotas regardless of seed; only the arrangement changes.
    for (const scenario of SCENARIOS) expect(share(c, scenario)).toBe(share(a, scenario));
  });

  it("mulberry32 is a stable generator in [0, 1)", () => {
    const first = Array.from({ length: 5 }, mulberry32(42));
    const again = Array.from({ length: 5 }, mulberry32(42));
    expect(again).toEqual(first);
    for (const v of first) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(new Set(first).size).toBe(5);
  });

  it("handles degenerate counts", () => {
    expect(planDemoCases({ count: 0, seed: 1 })).toEqual([]);
    expect(planDemoCases({ count: -3, seed: 1 })).toEqual([]);
    expect(planDemoCases({ count: 1, seed: 1 })).toHaveLength(1);
    expect(planDemoCases({ count: 1, seed: 1 })[0]?.scenario).toBe("approved");
  });
});

describe("planDemoCases: outcome mix", () => {
  const plans = planDemoCases({ count: 200, seed: 1 });

  it("matches the documented mix within tolerance at count 200", () => {
    // Target: ~55% approved, 20% denied, 10% needs information, 5% failed, 5% cancelled, 5% dispatch_unknown
    // (a small slice of pre-dispatch rejections is carved out of the approved share).
    expect(share(plans, "approved")).toBeGreaterThanOrEqual(0.5);
    expect(share(plans, "approved")).toBeLessThanOrEqual(0.6);
    expect(share(plans, "denied")).toBeCloseTo(0.2, 1);
    expect(share(plans, "needs_info")).toBeCloseTo(0.1, 1);
    expect(share(plans, "failed")).toBeCloseTo(0.05, 1);
    expect(share(plans, "cancelled")).toBeCloseTo(0.05, 1);
    expect(share(plans, "dispatch_unknown")).toBeCloseTo(0.05, 1);
    expect(share(plans, "rejected")).toBeGreaterThan(0);
    expect(share(plans, "rejected")).toBeLessThanOrEqual(0.05);
  });

  it("quotas add up to the count and are a pure function of it", () => {
    for (const count of [1, 6, 24, 97, 200]) {
      const quotas = scenarioQuotas(count);
      expect(SCENARIOS.reduce((sum, s) => sum + quotas[s], 0)).toBe(count);
      expect(scenarioQuotas(count)).toEqual(quotas);
    }
    expect(scenarioQuotas(0)).toEqual({ approved: 0, denied: 0, needs_info: 0, failed: 0, cancelled: 0, dispatch_unknown: 0, rejected: 0 });
  });

  it("covers every scenario, every merchant and every customer at count 200", () => {
    for (const scenario of SCENARIOS) expect(plans.some((p) => p.scenario === scenario), scenario).toBe(true);
    for (const merchant of MERCHANTS) expect(plans.some((p) => p.merchant === merchant), merchant).toBe(true);
    for (const customer of CUSTOMERS) expect(plans.some((p) => p.customer.email === customer.email), customer.email).toBe(true);
  });
});

describe("planDemoCases: case fields", () => {
  const plans = planDemoCases({ count: 200, seed: 3 });

  it("uses E.164 numbers on the +1415555 exchange that the API accepts", () => {
    for (const p of plans) {
      expect(p.supportPhone).toMatch(E164);
      expect(p.supportPhone).toMatch(/^\+1415555\d{4}$/);
      expect(p.supportPhone.startsWith(PHONE_PREFIX)).toBe(true);
    }
  });

  it("produces valid amounts, USD, a 'charged twice' summary and a customer with name and email", () => {
    for (const p of plans) {
      expect(isValidAmountMinor(p.amountMinor)).toBe(true);
      expect(p.currency).toBe("USD");
      expect(p.summary).toMatch(/^I was charged twice for .+ on (September|October) \d{1,2}[.:]/);
      expect(p.summary).toContain(p.merchant);
      expect(p.summary.length).toBeLessThanOrEqual(5000);
      expect(p.customer.name.length).toBeGreaterThan(0);
      expect(p.customer.email).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    }
  });

  it("includes the four customers of the seed fixture", () => {
    const fixture = JSON.parse(readFileSync(new URL("../../src/integrations/keewano/seed/transactions.json", import.meta.url), "utf8")) as {
      customers: { name: string; email: string }[];
    };
    expect(fixture.customers).toHaveLength(4);
    for (const c of fixture.customers) expect(CUSTOMERS).toContainEqual({ name: c.name, email: c.email });
    expect(CUSTOMERS.length).toBeGreaterThanOrEqual(10);
  });
});

describe("planDemoCases: scenario suffixes", () => {
  it("maps every suffix to the documented outcome and agrees with the simulated voice adapter", () => {
    // README "Modes": 0001 rejected, 0002 dispatch_unknown, 0003 denied, 0004 needs information, 0005 failed, 0006 cancelled.
    expect(SUFFIX_BY_SCENARIO).toEqual({ rejected: "0001", dispatch_unknown: "0002", denied: "0003", needs_info: "0004", failed: "0005", cancelled: "0006" });
    for (const scenario of SCENARIOS) {
      const phone = scenario === "approved" ? `${PHONE_PREFIX}0100` : `${PHONE_PREFIX}${SUFFIX_BY_SCENARIO[scenario]}`;
      expect(scenarioForPhone(phone)).toBe(scenario);
      expect(scenarioFor(phone)).toBe(scenario);
    }
    expect(scenarioForPhone(`${PHONE_PREFIX}9999`)).toBe("approved");
    expect(EXPECTED_BY_SCENARIO).toEqual({
      approved: { callState: "completed", decision: "approved", status: "approved" },
      denied: { callState: "completed", decision: "denied", status: "denied" },
      needs_info: { callState: "completed", decision: "needs_information", status: "needs_information" },
      failed: { callState: "failed", decision: "unknown", status: "authorized" },
      cancelled: { callState: "cancelled", decision: "unknown", status: "authorized" },
      dispatch_unknown: { callState: "dispatch_unknown", decision: "unknown", status: "calling" },
      rejected: { callState: "failed", decision: "unknown", status: "authorized" },
    });
  });

  it("gives every planned case a number whose suffix the adapter resolves to the planned scenario", () => {
    const plans = planDemoCases({ count: 200, seed: 11 });
    for (const p of plans) {
      expect(scenarioFor(p.supportPhone), `#${p.index} ${p.supportPhone}`).toBe(p.scenario);
      expect(scenarioForPhone(p.supportPhone)).toBe(p.scenario);
    }
    const suffixes = new Set(plans.map((p) => p.supportPhone.slice(-4)));
    for (const suffix of Object.values(SUFFIX_BY_SCENARIO)) expect(suffixes.has(suffix), suffix).toBe(true);
    // Approved cases use each merchant's own line, never a reserved suffix.
    for (const p of plans.filter((x) => x.scenario === "approved")) {
      expect(Object.values(SUFFIX_BY_SCENARIO)).not.toContain(p.supportPhone.slice(-4));
    }
  });
});

describe("planDemoCases: merchant tendencies", () => {
  const plans = planDemoCases({ count: 600, seed: 5 });

  it("gives merchants distinct approval rates", () => {
    const acme = byMerchant(plans, "Acme Streaming");
    const gym = byMerchant(plans, "Northwind Gym");
    const orbit = byMerchant(plans, "Orbit Rideshare");
    expect(acme.length).toBeGreaterThan(50);
    expect(gym.length).toBeGreaterThan(30);
    expect(orbit.length).toBeGreaterThan(30);
    expect(share(plans, "approved", acme)).toBeGreaterThan(0.65);
    expect(share(plans, "approved", gym)).toBeLessThan(0.35);
    expect(share(plans, "denied", gym)).toBeGreaterThan(0.45);
    expect(share(plans, "needs_info", orbit)).toBeGreaterThan(0.2);
    expect(share(plans, "approved", acme) - share(plans, "approved", gym)).toBeGreaterThan(0.3);
  });

  it("spreads approvals and denials over several merchants", () => {
    const approvedMerchants = new Set(plans.filter((p) => p.scenario === "approved").map((p) => p.merchant));
    const deniedMerchants = new Set(plans.filter((p) => p.scenario === "denied").map((p) => p.merchant));
    expect(approvedMerchants.size).toBeGreaterThanOrEqual(6);
    expect(deniedMerchants.size).toBeGreaterThanOrEqual(5);
  });
});
