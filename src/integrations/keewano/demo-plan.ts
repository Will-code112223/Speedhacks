/**
 * Deterministic plan for SYNTHETIC refund cases, used by demo-cases.mts to fill Keewano
 * (through the app's own HTTP API) with enough case data for questions like "which
 * merchants approve refunds" and "where do cases stall".
 *
 * Pure and import-free on purpose: demo-cases.mts runs under Node type stripping, which
 * can only load relative modules that import nothing themselves (see seed.mts / sql.mts).
 *
 * Every person, merchant, amount and phone number here is invented. Simulated calls pick
 * their scenario from the LAST FOUR digits of the merchant support number (README "Modes"):
 *   0001 rejected before dispatch   0002 dispatch_unknown   0003 completed, denied
 *   0004 completed, needs information   0005 failed   0006 cancelled   other: completed, approved
 *
 * The global outcome mix is fixed per count (largest-remainder quotas over TARGET_MIX, then a
 * seeded shuffle), so it holds for any seed; merchants differ in which scenarios they draw.
 */

export type DemoScenario = "approved" | "denied" | "needs_info" | "failed" | "cancelled" | "dispatch_unknown" | "rejected";

export const SCENARIOS: readonly DemoScenario[] = ["approved", "denied", "needs_info", "failed", "cancelled", "dispatch_unknown", "rejected"];

export interface DemoCustomer {
  name: string;
  email: string;
}

export interface DemoCasePlan {
  /** 1-based position in the run. */
  index: number;
  customer: DemoCustomer;
  merchant: DemoMerchant;
  /** E.164, +1415555XXXX; the last four digits steer the simulated call. */
  supportPhone: string;
  scenario: DemoScenario;
  amountMinor: number;
  currency: "USD";
  summary: string;
}

/** What the API publishes once the simulated call for a scenario has settled. */
export interface ExpectedOutcome {
  callState: "completed" | "failed" | "cancelled" | "dispatch_unknown";
  decision: "approved" | "denied" | "needs_information" | "unknown";
  status: "approved" | "denied" | "needs_information" | "authorized" | "calling";
}

/**
 * Documented mapping (README "Modes" + deriveStatus): a completed call publishes the decision as
 * the case status; failed/cancelled/rejected attempts leave the case "authorized" with no decision
 * (the authorization is consumed; editing a fact re-authorizes); dispatch_unknown stays "calling"
 * until someone checks the provider. A rejected dispatch answers 503 and keeps the attempt as failed.
 */
export const EXPECTED_BY_SCENARIO: Readonly<Record<DemoScenario, ExpectedOutcome>> = {
  approved: { callState: "completed", decision: "approved", status: "approved" },
  denied: { callState: "completed", decision: "denied", status: "denied" },
  needs_info: { callState: "completed", decision: "needs_information", status: "needs_information" },
  failed: { callState: "failed", decision: "unknown", status: "authorized" },
  cancelled: { callState: "cancelled", decision: "unknown", status: "authorized" },
  dispatch_unknown: { callState: "dispatch_unknown", decision: "unknown", status: "calling" },
  rejected: { callState: "failed", decision: "unknown", status: "authorized" },
};

/** Share of cases per scenario, in percent (sums to 100). "rejected" is the 0001 pre-dispatch 503. */
export const TARGET_MIX: Readonly<Record<DemoScenario, number>> = {
  approved: 53,
  denied: 20,
  needs_info: 10,
  failed: 5,
  cancelled: 5,
  dispatch_unknown: 5,
  rejected: 2,
};

export const PHONE_PREFIX = "+1415555";

/** Reserved last-four-digit suffixes; any other suffix is "approved". */
export const SUFFIX_BY_SCENARIO: Readonly<Record<Exclude<DemoScenario, "approved">, string>> = {
  rejected: "0001",
  dispatch_unknown: "0002",
  denied: "0003",
  needs_info: "0004",
  failed: "0005",
  cancelled: "0006",
};

export function scenarioForPhone(phone: string): DemoScenario {
  const suffix = phone.slice(-4);
  for (const scenario of SCENARIOS) {
    if (scenario !== "approved" && SUFFIX_BY_SCENARIO[scenario] === suffix) return scenario;
  }
  return "approved";
}

export const MERCHANTS = [
  "Acme Streaming",
  "Northwind Gym",
  "Blue Bottle Coffee",
  "Bay Area Transit",
  "Sparta Workspace",
  "Northwind Mutual",
  "Pacific Fiber",
  "Orbit Rideshare",
] as const;
export type DemoMerchant = (typeof MERCHANTS)[number];

interface MerchantProfile {
  /** Last four digits of the merchant's regular support line (never a reserved suffix). */
  line: string;
  /** Relative case volume. */
  volume: number;
  /** Relative likelihood of each scenario for this merchant (0 = never). */
  tendency: Readonly<Record<DemoScenario, number>>;
  items: readonly string[];
  amountsMinor: readonly number[];
}

/** Merchants differ on purpose: Acme Streaming mostly approves, Northwind Gym mostly denies, Orbit Rideshare keeps asking for details. */
const PROFILES: Readonly<Record<DemoMerchant, MerchantProfile>> = {
  "Acme Streaming": {
    line: "0100",
    volume: 5,
    tendency: { approved: 80, denied: 6, needs_info: 4, failed: 3, cancelled: 2, dispatch_unknown: 3, rejected: 2 },
    items: ["my monthly streaming subscription", "the annual plan renewal", "a pay-per-view movie"],
    amountsMinor: [4999, 4999, 1499, 9999],
  },
  "Northwind Gym": {
    line: "0200",
    volume: 3,
    tendency: { approved: 15, denied: 65, needs_info: 6, failed: 4, cancelled: 4, dispatch_unknown: 4, rejected: 2 },
    items: ["my monthly membership", "a personal training session", "the annual membership fee"],
    amountsMinor: [3900, 3900, 7500, 42900],
  },
  "Blue Bottle Coffee": {
    line: "0300",
    volume: 3,
    tendency: { approved: 75, denied: 10, needs_info: 5, failed: 4, cancelled: 3, dispatch_unknown: 3, rejected: 0 },
    items: ["a latte and pastry order", "a bag of whole-bean coffee", "a mobile pickup order"],
    amountsMinor: [650, 725, 1850, 2200],
  },
  "Bay Area Transit": {
    line: "0400",
    volume: 2,
    tendency: { approved: 45, denied: 25, needs_info: 10, failed: 8, cancelled: 5, dispatch_unknown: 5, rejected: 2 },
    items: ["a transit card reload", "a monthly transit pass", "an airport express fare"],
    amountsMinor: [2500, 5000, 8600],
  },
  "Sparta Workspace": {
    line: "0500",
    volume: 2,
    tendency: { approved: 60, denied: 12, needs_info: 10, failed: 5, cancelled: 5, dispatch_unknown: 5, rejected: 3 },
    items: ["a hot-desk day pass", "the monthly coworking plan", "a meeting-room booking"],
    amountsMinor: [3500, 29900, 12000],
  },
  "Northwind Mutual": {
    line: "0600",
    volume: 2,
    tendency: { approved: 35, denied: 35, needs_info: 15, failed: 5, cancelled: 5, dispatch_unknown: 3, rejected: 2 },
    items: ["the monthly renters insurance premium", "an auto policy installment", "a policy change fee"],
    amountsMinor: [8900, 12450, 21000],
  },
  "Pacific Fiber": {
    line: "0700",
    volume: 2,
    tendency: { approved: 55, denied: 18, needs_info: 10, failed: 7, cancelled: 5, dispatch_unknown: 3, rejected: 2 },
    items: ["the monthly internet bill", "a modem rental fee", "the installation fee"],
    amountsMinor: [7999, 1200, 9900],
  },
  "Orbit Rideshare": {
    line: "0800",
    volume: 3,
    tendency: { approved: 30, denied: 15, needs_info: 40, failed: 5, cancelled: 4, dispatch_unknown: 4, rejected: 2 },
    items: ["a ride to the airport", "a ride home from downtown", "an airport pickup"],
    amountsMinor: [1845, 2730, 4120, 6350],
  },
};

/** The four customers from seed/transactions.json (so the fixture history check has something to say) plus six more. */
export const CUSTOMERS: readonly DemoCustomer[] = [
  { name: "Sam Rivera", email: "sam@example.com" },
  { name: "Priya Natarajan", email: "priya@example.com" },
  { name: "Diego Alvarez", email: "diego@example.com" },
  { name: "Mei Chen", email: "mei@example.com" },
  { name: "Avery Johnson", email: "avery@example.com" },
  { name: "Noor Haddad", email: "noor@example.com" },
  { name: "Lucas Moreau", email: "lucas@example.com" },
  { name: "Hana Sato", email: "hana@example.com" },
  { name: "Tomas Reyes", email: "tomas@example.com" },
  { name: "Imani Okafor", email: "imani@example.com" },
];

const SUMMARY_TEMPLATES: readonly ((item: string, date: string, merchant: string, money: string) => string)[] = [
  (item, date, merchant, money) =>
    `I was charged twice for ${item} at ${merchant} on ${date}. The second ${money} charge is a duplicate and I would like it refunded.`,
  (item, date, merchant, money) =>
    `I was charged twice for ${item} on ${date}: ${merchant} billed ${money} two times a few minutes apart. Please refund the duplicate.`,
  (item, date, merchant, money) =>
    `I was charged twice for ${item} on ${date}. My statement shows two ${money} charges from ${merchant} for a single purchase.`,
];

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** mulberry32: small, fast, deterministic; returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rand() * items.length)];
  if (item === undefined) throw new Error("pick from an empty list");
  return item;
}

function weighted<T>(rand: () => number, items: readonly T[], weightOf: (item: T) => number): T {
  let total = 0;
  for (const item of items) total += Math.max(0, weightOf(item));
  if (total <= 0) throw new Error("no item has a positive weight");
  let roll = rand() * total;
  for (const item of items) {
    roll -= Math.max(0, weightOf(item));
    if (roll < 0) return item;
  }
  const last = items[items.length - 1];
  if (last === undefined) throw new Error("weighted pick from an empty list");
  return last;
}

/** Exact per-scenario counts for a run: largest-remainder apportionment of TARGET_MIX. */
export function scenarioQuotas(count: number): Record<DemoScenario, number> {
  const quotas = { approved: 0, denied: 0, needs_info: 0, failed: 0, cancelled: 0, dispatch_unknown: 0, rejected: 0 };
  if (!Number.isInteger(count) || count <= 0) return quotas;
  let total = 0;
  for (const scenario of SCENARIOS) total += TARGET_MIX[scenario];
  const remainders: { scenario: DemoScenario; fraction: number }[] = [];
  let assigned = 0;
  for (const scenario of SCENARIOS) {
    const exact = (count * TARGET_MIX[scenario]) / total;
    const floor = Math.floor(exact);
    quotas[scenario] = floor;
    assigned += floor;
    remainders.push({ scenario, fraction: exact - floor });
  }
  // Stable: ties keep SCENARIOS order, so quotas are a pure function of count.
  remainders.sort((a, b) => b.fraction - a.fraction);
  for (let i = 0; i < count - assigned; i += 1) {
    const r = remainders[i];
    if (r) quotas[r.scenario] += 1;
  }
  return quotas;
}

function formatMoney(amountMinor: number): string {
  return `$${(amountMinor / 100).toFixed(2)}`;
}

/** A charge date in the weeks before the demo (Sept 1 – Oct 9, 2026). */
function chargeDate(rand: () => number): string {
  const day = Math.floor(rand() * 39); // 0..38
  return day < 30 ? `${MONTHS[8]} ${day + 1}` : `${MONTHS[9]} ${day - 29}`;
}

export function planDemoCases(opts: { count: number; seed: number }): DemoCasePlan[] {
  const count = Number.isInteger(opts.count) && opts.count > 0 ? opts.count : 0;
  const rand = mulberry32(Number.isFinite(opts.seed) ? Math.trunc(opts.seed) : 1);
  const quotas = scenarioQuotas(count);
  const deck: DemoScenario[] = [];
  for (const scenario of SCENARIOS) for (let i = 0; i < quotas[scenario]; i += 1) deck.push(scenario);
  // Fisher–Yates with the seeded generator.
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const a = deck[i];
    const b = deck[j];
    if (a !== undefined && b !== undefined) {
      deck[i] = b;
      deck[j] = a;
    }
  }
  return deck.map((scenario, i) => {
    // P(merchant | scenario) ∝ volume × tendency, so the global mix stays exact while merchants differ.
    const merchant = weighted(rand, MERCHANTS, (m) => PROFILES[m].volume * PROFILES[m].tendency[scenario]);
    const profile = PROFILES[merchant];
    const customer = pick(rand, CUSTOMERS);
    const amountMinor = pick(rand, profile.amountsMinor);
    const item = pick(rand, profile.items);
    const date = chargeDate(rand);
    const template = pick(rand, SUMMARY_TEMPLATES);
    const suffix = scenario === "approved" ? profile.line : SUFFIX_BY_SCENARIO[scenario];
    return {
      index: i + 1,
      customer,
      merchant,
      supportPhone: `${PHONE_PREFIX}${suffix}`,
      scenario,
      amountMinor,
      currency: "USD",
      summary: template(item, date, merchant, formatMoney(amountMinor)),
    };
  });
}
