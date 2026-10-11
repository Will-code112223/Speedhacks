import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CaseV1, ResolutionPlanV1 } from "@/contracts/case";
import { CALL_PLAN_ACTIONS } from "@/contracts/voice";
import { buildCallPlan } from "@/server/cases/facts";
import { buildResolutionPlan, type ResolutionCase, type ResolutionInsurer } from "@/server/cases/resolution";
import { closeInsurerDatabase, lookupInsurer } from "@/server/insurers";
import { closeDatabase } from "@/server/persistence/db";

let dataDir: string;
let stateFarm: ResolutionInsurer;
let routes: {
  cases: typeof import("@/app/api/cases/route");
  byId: typeof import("@/app/api/cases/[id]/route");
  authorize: typeof import("@/app/api/cases/[id]/authorize/route");
  plan: typeof import("@/app/api/cases/[id]/plan/route");
};

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "resolution-plan-"));
  process.env.REFUND_MODE = "simulated";
  process.env.DATA_DIR = dataDir;
  closeDatabase();
  (globalThis as { __refundService?: unknown }).__refundService = undefined;
  const hit = lookupInsurer("State Farm", dataDir);
  if (!hit) throw new Error("State Farm must be in the registry");
  stateFarm = hit;
  routes = {
    cases: await import("@/app/api/cases/route"),
    byId: await import("@/app/api/cases/[id]/route"),
    authorize: await import("@/app/api/cases/[id]/authorize/route"),
    plan: await import("@/app/api/cases/[id]/plan/route"),
  };
});
afterAll(() => {
  closeDatabase();
  closeInsurerDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const CASE_ID = "7f1d9a52-3c4b-4e8a-9b0c-1d2e3f4a5b6c";

function claimCase(overrides: Partial<ResolutionCase> = {}): ResolutionCase {
  return {
    id: CASE_ID,
    revision: 3,
    customer: { name: "Jordan Lee", email: "jordan@example.com" },
    merchant: { name: "State Farm", supportPhone: "+18007325246", source: null },
    amountMinor: 120000,
    currency: "USD",
    reason: "Water damage to my kitchen on Oct 3.",
    policyNumber: "SF-HO-123456",
    incidentDate: "2026-10-03",
    lossDescription: "A pipe under the sink burst and flooded the kitchen floor.",
    claimType: "water damage",
    evidence: [
      { id: "e1", name: "kitchen-floor.jpg", mimeType: "image/jpeg" },
      { id: "e2", name: "plumber-invoice.pdf", mimeType: "application/pdf" },
    ],
    ...overrides,
  };
}

function refundCase(overrides: Partial<ResolutionCase> = {}): ResolutionCase {
  return {
    id: CASE_ID,
    revision: 1,
    customer: { name: "Sam Rivera", email: null },
    merchant: { name: "Ridgeline Outfitters", supportPhone: "+14155550134", source: null },
    amountMinor: 4999,
    currency: "USD",
    reason: "I was charged twice for the same order.",
    policyNumber: null,
    incidentDate: null,
    lossDescription: null,
    claimType: null,
    evidence: [{ id: "e1", name: "order-receipt.pdf", mimeType: "application/pdf" }],
    ...overrides,
  };
}

const titles = (steps: ResolutionPlanV1["before"]) => steps.map((s) => s.title);
const statusOf = (plan: ResolutionPlanV1, title: string) => plan.before.find((s) => s.title === title)?.status;
const EM_DASH = /\u2014/;

function expectPlainWords(plan: ResolutionPlanV1): void {
  const text = JSON.stringify(plan);
  expect(text).not.toMatch(EM_DASH);
  for (const step of [...plan.before, ...plan.after]) {
    expect(step.detail).not.toMatch(/[{}[\]]|undefined|null/);
    expect(step.title.length).toBeGreaterThan(0);
  }
}

describe("buildResolutionPlan (pure)", () => {
  it("claim with a policy number and registry terms: ready, call taken from buildCallPlan, insurer rules cited", () => {
    const caseDoc = claimCase();
    const plan = buildResolutionPlan({ caseDoc, purpose: "file_claim", insurer: stateFarm });
    expect(plan.ready).toBe(true);
    expect(plan.frozen).toBe(false);
    expect(plan.missingFields).toEqual([]);
    expect(plan.insurerName).toBe("State Farm");

    const callPlan = buildCallPlan({
      purpose: "file_claim",
      caseId: caseDoc.id,
      revision: caseDoc.revision,
      customer: caseDoc.customer,
      merchantName: "State Farm",
      amountMinor: caseDoc.amountMinor,
      currency: caseDoc.currency,
      reason: caseDoc.reason,
      evidence: caseDoc.evidence,
      policyNumber: caseDoc.policyNumber,
      incidentDate: caseDoc.incidentDate,
      lossDescription: caseDoc.lossDescription,
      claimType: caseDoc.claimType,
    });
    expect(plan.call.goal).toBe(callPlan.goal);
    expect(plan.call.steps).toEqual(callPlan.steps);
    expect(plan.call.readBack).toBe(callPlan.readBack);
    expect(plan.call.questions).toEqual(callPlan.questions.map((q) => q.text));
    expect(plan.call.willNotDo).toHaveLength(CALL_PLAN_ACTIONS.file_claim.forbidden.length);
    expect(plan.call.willNotDo).toContain("Agree to a settlement or accept any amount. Only you decide that.");
    expect(plan.call.willNotDo.some((line) => /^Do not/.test(line))).toBe(false);

    expect(titles(plan.before)).toEqual([
      "Policy number",
      "Your name",
      "Date of loss",
      "What happened",
      "Photos of the damage",
      "Receipts and repair estimates",
      "Number to call",
      "Stop further damage",
    ]);
    expect(statusOf(plan, "Policy number")).toBe("done");
    expect(statusOf(plan, "Photos of the damage")).toBe("done");
    expect(statusOf(plan, "Receipts and repair estimates")).toBe("done");
    expect(plan.before.find((s) => s.title === "Date of loss")?.detail).toBe("October 3, 2026.");
    expect(plan.before.find((s) => s.title === "Number to call")?.detail).toBe("800-732-5246 (State Farm claims line, open 24 hours a day).");

    // Registry rules: only known values, each with confidence and source.
    const keys = plan.insurerTerms.map((t) => t.key);
    expect(keys).toContain("claim_filing_method");
    expect(keys).toContain("appeal_method");
    expect(keys).not.toContain("claim_report_deadline"); // unknown in the registry: never guessed
    for (const t of plan.insurerTerms) {
      expect(t.value.length).toBeGreaterThan(0);
      expect(t.confidenceLabel).toBe("From the insurer's own website");
      expect(t.sourceUrl).toMatch(/^https:\/\/www\.statefarm\.com\//);
    }
    // After: adjuster, documents, deadline and decision say what is not published, appeal cites the registry.
    expect(titles(plan.after)).toEqual([
      "You get a claim number",
      "An adjuster contacts you",
      "Send the documents they ask for",
      "Deadline to report the loss",
      "When to expect a decision",
      "If the claim is denied",
    ]);
    expect(plan.after.find((s) => s.title === "Deadline to report the loss")?.detail).toMatch(/does not publish a fixed deadline/);
    expect(plan.after.find((s) => s.title === "When to expect a decision")?.detail).toMatch(/does not publish how long/);
    const appeal = plan.after.find((s) => s.title === "If the claim is denied");
    expect(appeal?.detail).toMatch(/^State Farm says: No formal appeal process is published/);
    expect(appeal?.source?.url).toMatch(/statefarm\.com/);
    expect(plan.after.find((s) => s.title === "An adjuster contacts you")?.source?.url).toMatch(/statefarm\.com/);
    expectPlainWords(plan);
  });

  it("claim without a policy number but with the policyholder's name: still ready, policy marked missing", () => {
    const plan = buildResolutionPlan({ caseDoc: claimCase({ policyNumber: null }), purpose: "file_claim", insurer: stateFarm });
    expect(plan.ready).toBe(true);
    expect(statusOf(plan, "Policy number")).toBe("missing");
    expect(plan.call.steps.join(" ")).toMatch(/policy number is not known/);
  });

  it("claim missing facts: a best-effort draft marked ready:false with the missing fields", () => {
    const plan = buildResolutionPlan({
      caseDoc: claimCase({ policyNumber: null, customer: { name: null, email: null }, incidentDate: null, evidence: [] }),
      purpose: "file_claim",
      insurer: stateFarm,
    });
    expect(plan.ready).toBe(false);
    expect(plan.missingFields).toEqual(expect.arrayContaining(["policyNumber", "incidentDate"]));
    expect(statusOf(plan, "Date of loss")).toBe("missing");
    expect(statusOf(plan, "Photos of the damage")).toBe("missing");
    expect(plan.call.goal).toMatch(/^Open a new water damage claim with State Farm/);
    expect(plan.call.steps.length).toBeGreaterThan(0);
  });

  it("insurer without registry terms: no rules, and the after steps say nothing is published", () => {
    const plan = buildResolutionPlan({ caseDoc: claimCase({ merchant: { name: "Acme Mutual", supportPhone: "+14155550199", source: null } }), purpose: "file_claim", insurer: null });
    expect(plan.insurerTerms).toEqual([]);
    expect(plan.insurerName).toBe("Acme Mutual");
    expect(plan.before.find((s) => s.title === "Number to call")?.detail).toBe("415-555-0199 (Acme Mutual).");
    expect(plan.after.find((s) => s.title === "If the claim is denied")?.detail).toMatch(/department of insurance/);
    expect(plan.after.every((s) => s.source === undefined)).toBe(true);
    expectPlainWords(plan);
  });

  it("information call: asks the approved questions and promises not to file", () => {
    const plan = buildResolutionPlan({ caseDoc: claimCase(), purpose: "gather_information", insurer: stateFarm });
    expect(plan.purpose).toBe("gather_information");
    expect(plan.ready).toBe(true);
    expect(plan.call.questions).toContain("Is there a deadline for filing this claim?");
    expect(plan.call.willNotDo).toContain("File or open a claim, dispute or complaint.");
    expect(plan.after[0]?.detail).toMatch(/Nothing is filed or requested/);
    expect(plan.insurerTerms.map((t) => t.key)).toContain("claim_filing_method");
  });

  it("refund: receipt, statement line and order number before; reference number after", () => {
    const plan = buildResolutionPlan({ caseDoc: refundCase(), purpose: "request_refund", insurer: null });
    expect(plan.ready).toBe(true);
    expect(titles(plan.before)).toEqual(["Your name", "Amount charged", "Receipt or order confirmation", "Statement line", "Order or account number", "Number to call"]);
    expect(statusOf(plan, "Receipt or order confirmation")).toBe("done");
    expect(statusOf(plan, "Statement line")).toBe("missing");
    expect(statusOf(plan, "Order or account number")).toBeUndefined();
    expect(plan.before.find((s) => s.title === "Amount charged")?.detail).toMatch(/^\$49\.99/);
    expect(plan.call.goal).toBe("Ask Ridgeline Outfitters to refund the duplicate charge of $49.99 and get a reference number.");
    expect(plan.call.willNotDo).toContain("Give out or ask for card numbers, passwords or one-time codes.");
    expect(plan.after[0]?.title).toBe("You get a reference number");
    expectPlainWords(plan);
  });

  it("refund without an amount: draft, amount missing", () => {
    const plan = buildResolutionPlan({ caseDoc: refundCase({ amountMinor: null }), purpose: "request_refund", insurer: null });
    expect(plan.ready).toBe(false);
    expect(plan.missingFields).toContain("amountMinor");
    expect(statusOf(plan, "Amount charged")).toBe("missing");
  });

  it("a frozen plan is rendered as is, whatever purpose is asked for", () => {
    const caseDoc = claimCase();
    const frozen = buildCallPlan({
      purpose: "gather_information",
      caseId: caseDoc.id,
      revision: caseDoc.revision,
      customer: caseDoc.customer,
      merchantName: "State Farm",
      amountMinor: null,
      currency: "USD",
      reason: caseDoc.reason,
      evidence: caseDoc.evidence,
      claimType: "water damage",
    });
    const plan = buildResolutionPlan({ caseDoc, purpose: "file_claim", insurer: stateFarm, frozen });
    expect(plan.frozen).toBe(true);
    expect(plan.ready).toBe(true);
    expect(plan.purpose).toBe("gather_information");
    expect(plan.call.goal).toBe(frozen.goal);
    expect(plan.call.questions).toEqual(frozen.questions.map((q) => q.text));
  });
});

describe("GET /api/cases/:id/plan", () => {
  const BASE = "http://localhost/api/cases";
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  async function createClaim(): Promise<{ c: CaseV1; session: string }> {
    const form = new FormData();
    form.set("summary", "File a claim with State Farm for water damage to my kitchen on Oct 3.");
    form.set("customerName", "Jordan Lee");
    form.set("merchantName", "State Farm");
    form.set("incidentDate", "2026-10-03");
    form.set("lossDescription", "A pipe under the sink burst and flooded the kitchen floor.");
    form.set("claimType", "water damage");
    const res = await routes.cases.POST(new Request(BASE, { method: "POST", body: form }));
    expect(res.status).toBe(201);
    const session = res.headers.get("set-cookie")!.split(";")[0]!;
    return { c: ((await res.json()) as { case: CaseV1 }).case, session };
  }

  const getPlan = (id: string, session: string | null, query = "") =>
    routes.plan.GET(new Request(`${BASE}/${id}/plan${query}`, { headers: session ? { cookie: session } : {} }), ctx(id));

  it("defaults to the suggested purpose, follows ?purpose, and never authorizes", async () => {
    const { c, session } = await createClaim();
    expect(c.suggestedPurpose).toBe("file_claim");
    const res = await getPlan(c.id, session);
    expect(res.status).toBe(200);
    const { plan } = (await res.json()) as { plan: ResolutionPlanV1 };
    expect(plan.purpose).toBe("file_claim");
    expect(plan.ready).toBe(true);
    expect(plan.frozen).toBe(false);
    expect(plan.insurerName).toBe("State Farm");
    expect(plan.insurerTerms.length).toBeGreaterThan(0);

    const info = (await (await getPlan(c.id, session, "?purpose=gather_information")).json()) as { plan: ResolutionPlanV1 };
    expect(info.plan.purpose).toBe("gather_information");

    const after = (await (await routes.byId.GET(new Request(`${BASE}/${c.id}`, { headers: { cookie: session } }), ctx(c.id))).json()) as { case: CaseV1 };
    expect(after.case.authorization).toBeNull();
    expect(after.case.revision).toBe(c.revision);
  });

  it("answers 404 for another session and 400 for an unknown purpose", async () => {
    const { c, session } = await createClaim();
    expect((await getPlan(c.id, null)).status).toBe(404);
    expect((await getPlan(c.id, `refund_session=${"c".repeat(48)}`)).status).toBe(404);
    const bad = await getPlan(c.id, session, "?purpose=cancel_policy");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
  });

  it("after authorization returns the frozen plan, ignoring the purpose asked for", async () => {
    const { c, session } = await createClaim();
    const auth = await routes.authorize.POST(
      new Request(`${BASE}/${c.id}/authorize`, {
        method: "POST",
        headers: { cookie: session, "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: c.revision, purpose: "file_claim" }),
      }),
      ctx(c.id),
    );
    expect(auth.status).toBe(200);
    const { plan } = (await (await getPlan(c.id, session, "?purpose=gather_information")).json()) as { plan: ResolutionPlanV1 };
    expect(plan.frozen).toBe(true);
    expect(plan.purpose).toBe("file_claim");
    expect(plan.call.goal).toMatch(/^Open a new water damage claim with State Farm/);
  });
});
