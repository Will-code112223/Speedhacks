import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createKeewano } from "@/integrations/keewano";
import { FixtureTransactionHistory } from "@/integrations/keewano/history";
import {
  FIXTURE_TRACK_RECORD,
  FixtureMerchantInsights,
  KeewanoMerchantInsights,
  buildOutcomesSql,
  fixtureOutcomeRows,
  outcomeRowsFromRows,
} from "@/integrations/keewano/insights";
import type { TransactionHistory } from "@/server/cases/history";
import { summarizeOutcomes, type MerchantInsights, type OutcomeRow } from "@/server/cases/insights";
import { CaseService } from "@/server/cases/service";
import { createSimulatedVoiceAdapter } from "@/server/cases/simulated-voice";
import { loadConfig } from "@/server/config";
import { HeuristicExtractor } from "@/server/documents/extractor";
import { UploadStore } from "@/server/documents/storage";
import { ApiHttpError } from "@/server/http/errors";
import { closeDatabase, openDatabase } from "@/server/persistence/db";
import { CaseRepository } from "@/server/persistence/repository";
import { COMPLETE_FIELDS, SESSION_A, SESSION_B, TEST_SECRET } from "./helpers";

/**
 * Additive routes (not in contract V1): GET /api/capabilities, GET /api/cases/:id/history,
 * GET /api/insights/merchant, and the MerchantInsights port behind the last one.
 */

// ---------------------------------------------------------------------------
// summarizeOutcomes: pure reduction of forward-filled outcome rows
// ---------------------------------------------------------------------------

const ROWS: OutcomeRow[] = [
  // Case A: requested, then approved (the later row wins); rows deliberately out of order.
  { caseId: "case-a", merchant: "Acme Streaming", outcome: "approved", at: "2026-10-05T10:00:00.000Z" },
  { caseId: "case-a", merchant: "Acme Streaming", outcome: "requested", at: "2026-10-04T10:00:00.000Z" },
  // Case B: denied under an abbreviated statement descriptor.
  { caseId: "case-b", merchant: "ACME STREAMING INC", outcome: "denied", at: "2026-10-06T10:00:00.000Z" },
  // Case C: needs information.
  { caseId: "case-c", merchant: "Acme Streaming", outcome: "needs_information", at: "2026-10-03T10:00:00.000Z" },
  // Case D: another merchant entirely.
  { caseId: "case-d", merchant: "Northwind Gym", outcome: "approved", at: "2026-10-07T10:00:00.000Z" },
  // Case E: outcome reset to unknown (unresolved; never counts as "last outcome").
  { caseId: "case-e", merchant: "Acme Streaming", outcome: "unknown", at: "2026-10-08T10:00:00.000Z" },
  // Case F: approved, then corrected to denied; the carried-forward repeat keeps the first "denied" time.
  { caseId: "case-f", merchant: "Acme Streaming", outcome: "approved", at: "2026-10-01T10:00:00.000Z" },
  { caseId: "case-f", merchant: "Acme Streaming", outcome: "denied", at: "2026-10-02T10:00:00.000Z" },
  { caseId: "case-f", merchant: "Acme Streaming", outcome: "denied", at: "2026-10-09T10:00:00.000Z" },
];

describe("summarizeOutcomes", () => {
  it("keeps the last outcome per case, matches descriptors, and ignores other merchants", () => {
    const acme = summarizeOutcomes(ROWS, "Acme Streaming");
    expect(acme).toEqual({
      merchant: "Acme Streaming",
      source: "keewano",
      cases: 5,
      approved: 1,
      denied: 2,
      needsInformation: 1,
      unresolved: 1,
      approvalRate: 0.333,
      lastOutcomeAt: "2026-10-06T10:00:00.000Z", // case B's denial; case E's unknown and F's repeat do not move it
    });
    expect(acme.cases).toBe(acme.approved + acme.denied + acme.needsInformation + acme.unresolved);
    const northwind = summarizeOutcomes(ROWS, "Northwind Gym", "fixture");
    expect(northwind).toMatchObject({ source: "fixture", cases: 1, approved: 1, denied: 0, approvalRate: 1, lastOutcomeAt: "2026-10-07T10:00:00.000Z" });
  });

  it("answers zeros and a null rate when nothing matches", () => {
    expect(summarizeOutcomes(ROWS, "Blue Bottle Coffee")).toEqual({
      merchant: "Blue Bottle Coffee",
      source: "keewano",
      cases: 0,
      approved: 0,
      denied: 0,
      needsInformation: 0,
      unresolved: 0,
      approvalRate: null,
      lastOutcomeAt: null,
    });
    expect(summarizeOutcomes([], "Acme Streaming").cases).toBe(0);
    // Only needs_information: nothing decided, so no rate, but the outcome time is known.
    const pending = summarizeOutcomes(ROWS.filter((r) => r.caseId === "case-c"), "Acme Streaming");
    expect(pending).toMatchObject({ cases: 1, needsInformation: 1, approvalRate: null, lastOutcomeAt: "2026-10-03T10:00:00.000Z" });
  });
});

// ---------------------------------------------------------------------------
// Keewano implementation: one query, merchant matched in TypeScript
// ---------------------------------------------------------------------------

describe("KeewanoMerchantInsights", () => {
  it("issues the outcomes query and reduces forward-filled rows in mixed time formats", async () => {
    const rows = [
      { user_id: "11111111-1111-4111-8111-111111111111", event_datetime: "2026-10-03 14:02:11", RefundMerchant: "Acme Streaming", RefundOutcome: "requested" },
      { user_id: "11111111-1111-4111-8111-111111111111", event_datetime: 1791057600, RefundMerchant: "Acme Streaming", RefundOutcome: "requested" }, // carried forward (unix seconds = 2026-10-03T20:00:00Z)
      { user_id: "11111111-1111-4111-8111-111111111111", event_datetime: "2026-10-04T09:00:00Z", RefundMerchant: "Acme Streaming", RefundOutcome: "approved" },
      { user_id: "11111111-1111-4111-8111-111111111111", event_datetime: "2026-10-04T09:30:00Z", RefundMerchant: "Acme Streaming", RefundOutcome: "approved" }, // carried forward
      { user_id: "22222222-2222-4222-8222-222222222222", event_datetime: "2026-10-05T12:00:00Z", RefundMerchant: "Northwind Gym", RefundOutcome: "denied" },
      { user_id: "33333333-3333-4333-8333-333333333333", event_datetime: "2026-10-05T13:00:00Z", RefundMerchant: null, RefundOutcome: "denied" }, // dropped: no merchant
      { user_id: null, event_datetime: "2026-10-05T14:00:00Z", RefundMerchant: "Acme Streaming", RefundOutcome: "denied" }, // dropped: no case id
      { user_id: "44444444-4444-4444-8444-444444444444", event_datetime: "not a time", RefundMerchant: "Acme Streaming", RefundOutcome: "denied" }, // dropped: no time
    ];
    expect(outcomeRowsFromRows(rows).map((r) => `${r.caseId.slice(0, 1)}:${r.outcome}@${r.at}`)).toEqual([
      "1:requested@2026-10-03T14:02:11.000Z",
      "1:requested@2026-10-03T20:00:00.000Z",
      "1:approved@2026-10-04T09:00:00.000Z",
      "1:approved@2026-10-04T09:30:00.000Z",
      "2:denied@2026-10-05T12:00:00.000Z",
    ]);

    const seen: string[] = [];
    const insights = new KeewanoMerchantInsights({
      async runSql(sql) {
        seen.push(sql);
        return rows;
      },
    });
    const record = await insights.merchantRecord("ACME STREAMING INC");
    expect(seen).toEqual([buildOutcomesSql()]);
    const sql = seen[0]!;
    expect(sql).toContain(`SELECT user_id, event_datetime, "RefundMerchant", "RefundOutcome"`);
    expect(sql).toContain("FROM events");
    expect(sql).toContain(`WHERE "RefundOutcome" IS NOT NULL`);
    expect(sql).toContain("ORDER BY event_datetime");
    expect(sql).toContain("LIMIT 5000");
    expect(sql).not.toMatch(/SELECT \*|JOIN/i);
    expect(record).toEqual({
      merchant: "ACME STREAMING INC",
      source: "keewano",
      cases: 1,
      approved: 1,
      denied: 0,
      needsInformation: 0,
      unresolved: 0,
      approvalRate: 1,
      lastOutcomeAt: "2026-10-04T09:00:00.000Z", // when "approved" was first set, not the carried-forward repeat
    });
  });

  it("bounds the LIMIT clause", () => {
    expect(buildOutcomesSql(10)).toContain("LIMIT 10");
    expect(buildOutcomesSql(999_999)).toContain("LIMIT 5000");
    expect(buildOutcomesSql(-1)).toContain("LIMIT 5000");
  });
});

// ---------------------------------------------------------------------------
// Fixture: the demo merchants only
// ---------------------------------------------------------------------------

describe("FixtureMerchantInsights", () => {
  const fixture = new FixtureMerchantInsights();

  it("returns zeros for an unknown merchant", async () => {
    expect(await fixture.merchantRecord("Unknown Merchant Co")).toEqual({
      merchant: "Unknown Merchant Co",
      source: "fixture",
      cases: 0,
      approved: 0,
      denied: 0,
      needsInformation: 0,
      unresolved: 0,
      approvalRate: null,
      lastOutcomeAt: null,
    });
  });

  it("answers the synthetic track record for every demo merchant, by descriptor too", async () => {
    const acme = await fixture.merchantRecord("ACME STREAMING INC");
    expect(acme).toMatchObject({ source: "fixture", cases: 13, approved: 9, denied: 2, needsInformation: 1, unresolved: 1, approvalRate: 0.818, lastOutcomeAt: "2026-10-09T17:42:13.000Z" });
    for (const m of FIXTURE_TRACK_RECORD) {
      const record = await fixture.merchantRecord(m.merchant);
      expect(record.cases).toBe(m.approved + m.denied + m.needsInformation + m.unresolved);
      expect(record).toMatchObject({ approved: m.approved, denied: m.denied, needsInformation: m.needsInformation, unresolved: m.unresolved, lastOutcomeAt: m.lastOutcomeAt });
    }
    expect(fixtureOutcomeRows().length).toBe(FIXTURE_TRACK_RECORD.reduce((n, m) => n + m.approved + m.denied + m.needsInformation + m.unresolved, 0));
  });
});

describe("createKeewano insights wiring", () => {
  it("mirrors the history wiring: fixture in simulated mode, nothing when disabled or live, Keewano with a token", () => {
    expect(createKeewano(loadConfig({ REFUND_MODE: "simulated" })).insights?.kind).toBe("fixture");
    expect(createKeewano(loadConfig({ REFUND_MODE: "simulated", KEEWANO_FIXTURE_HISTORY: "off" })).insights).toBeNull();
    expect(createKeewano(loadConfig({ REFUND_MODE: "live" })).insights).toBeNull();
    expect(createKeewano(loadConfig({ REFUND_MODE: "simulated", KEEWANO_ACCESS_TOKEN: "kwpat-x" })).insights).toBeInstanceOf(KeewanoMerchantInsights);
  });
});

// ---------------------------------------------------------------------------
// Service methods (hand-built CaseService, as tests/backend/keewano.test.ts does)
// ---------------------------------------------------------------------------

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function build(opts: { history?: TransactionHistory | null; insights?: MerchantInsights | null; env?: Record<string, string> } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "refund-insights-"));
  closeDatabase();
  const config = loadConfig({
    REFUND_MODE: "simulated",
    DATA_DIR: dataDir,
    SIMULATED_WEBHOOK_SECRET: TEST_SECRET,
    SIMULATED_QUEUED_MS: "1000",
    SIMULATED_IN_PROGRESS_MS: "2000",
    RECONCILE_MIN_INTERVAL_MS: "0",
    ...(opts.env ?? {}),
  });
  const clock = { now: Date.parse("2026-10-11T20:00:00.000Z") };
  const voice = createSimulatedVoiceAdapter({ ...config.simulated, now: () => clock.now });
  const db = openDatabase(config.dataDir);
  const repo = new CaseRepository(db);
  const service = new CaseService({
    config,
    repo,
    uploads: new UploadStore(config.dataDir),
    extractor: new HeuristicExtractor(),
    voice: () => voice,
    history: opts.history ?? null,
    insights: opts.insights ?? null,
    now: () => new Date(clock.now),
  });
  cleanups.push(() => {
    closeDatabase();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { service, repo, clock };
}

const createCase = (service: CaseService, session = SESSION_A) =>
  service.createCase(session, {
    summary: "I was charged twice for my monthly subscription on October 3.",
    files: [{ name: "receipt.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("Receipt\nTotal: $49.99\n") }],
    fields: COMPLETE_FIELDS,
  });

describe("CaseService.history", () => {
  it("returns the structured check for an owned case and 404 for a foreign session", async () => {
    const { service } = build({ history: new FixtureTransactionHistory() });
    const c = await createCase(service);
    const result = service.history(SESSION_A, c.id);
    expect(result.current).toBe(true);
    expect(result.history).toMatchObject({ revision: 1, source: "fixture", status: "duplicate_found", closestGapMinutes: expect.any(Number) });
    expect(result.history?.matches.map((m) => m.chargeId)).toEqual(["txn_3b00aa", "txn_2a91f0", "txn_2a91f7"]);
    for (const [session, id] of [
      [SESSION_B, c.id],
      [SESSION_A, "00000000-0000-4000-8000-000000000000"],
    ] as const) {
      let status: number | null = null;
      try {
        service.history(session, id);
      } catch (err) {
        status = err instanceof ApiHttpError ? err.status : -1;
      }
      expect(status).toBe(404);
    }
  });

  it("reports current:false after a fact edit until the next read re-checks, and null without a source", async () => {
    const { service } = build({ history: new FixtureTransactionHistory() });
    const c = await createCase(service);
    service.patchCase(SESSION_A, c.id, 1, { amountMinor: 5999 });
    const stale = service.history(SESSION_A, c.id);
    expect(stale.current).toBe(false);
    expect(stale.history?.revision).toBe(1);
    await service.getCase(SESSION_A, c.id);
    const fresh = service.history(SESSION_A, c.id);
    expect(fresh.current).toBe(true);
    expect(fresh.history).toMatchObject({ revision: 2, status: "no_match" });

    const bare = build();
    const plain = await createCase(bare.service);
    expect(bare.service.history(SESSION_A, plain.id)).toEqual({ history: null, current: false });
  });
});

describe("CaseService.merchantInsights", () => {
  it("answers available:false without a source and never throws when the source fails or stalls", async () => {
    expect(await build().service.merchantInsights("Acme Streaming")).toEqual({ available: false, merchant: "Acme Streaming" });

    const failing: MerchantInsights = {
      kind: "keewano",
      merchantRecord() {
        throw new Error("MCP connection refused");
      },
    };
    expect(await build({ insights: failing }).service.merchantInsights("Acme Streaming")).toEqual({
      available: false,
      merchant: "Acme Streaming",
      error: "MCP connection refused",
    });

    const stalled: MerchantInsights = { kind: "keewano", merchantRecord: () => new Promise(() => {}) };
    const slow = await build({ insights: stalled, env: { KEEWANO_TIMEOUT_MS: "50" } }).service.merchantInsights("Acme Streaming");
    expect(slow).toMatchObject({ available: false, merchant: "Acme Streaming" });
    expect(slow.available === false && slow.error).toContain("timed out after 50 ms");
  });

  it("spreads the record when a source answers", async () => {
    const result = await build({ insights: new FixtureMerchantInsights() }).service.merchantInsights("Acme Streaming");
    expect(result).toMatchObject({ available: true, merchant: "Acme Streaming", source: "fixture", cases: 13, approved: 9 });
  });
});

// ---------------------------------------------------------------------------
// Route handlers (same harness as tests/backend/routes.test.ts; runs last so the
// process-wide service built here is never closed by the hand-built ones above)
// ---------------------------------------------------------------------------

describe("additive HTTP routes", () => {
  let dataDir: string;
  let routes: {
    cases: typeof import("@/app/api/cases/route");
    capabilities: typeof import("@/app/api/capabilities/route");
    history: typeof import("@/app/api/cases/[id]/history/route");
    merchant: typeof import("@/app/api/insights/merchant/route");
  };
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const BASE = "http://localhost/api";

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "refund-insights-routes-"));
    process.env.REFUND_MODE = "simulated";
    process.env.DATA_DIR = dataDir;
    process.env.SIMULATED_QUEUED_MS = "0";
    process.env.SIMULATED_IN_PROGRESS_MS = "0";
    process.env.RECONCILE_MIN_INTERVAL_MS = "0";
    delete process.env.KEEWANO_FIXTURE_HISTORY;
    closeDatabase();
    (globalThis as { __refundService?: unknown }).__refundService = undefined;
    routes = {
      cases: await import("@/app/api/cases/route"),
      capabilities: await import("@/app/api/capabilities/route"),
      history: await import("@/app/api/cases/[id]/history/route"),
      merchant: await import("@/app/api/insights/merchant/route"),
    };
  });
  afterAll(() => {
    closeDatabase();
    (globalThis as { __refundService?: unknown }).__refundService = undefined;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("GET /api/capabilities answers explicit false for every V2 flag, no session needed", async () => {
    const res = await routes.capabilities.GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await res.json()).toEqual({ liveCall: false, stepIn: false, decisions: false, accessRequired: false });
  });

  it("GET /api/cases/:id/history is session-bound and returns the stored check", async () => {
    const form = new FormData();
    form.set("summary", "Charged twice for $49.99");
    form.set("customerName", COMPLETE_FIELDS.customerName);
    form.set("customerEmail", COMPLETE_FIELDS.customerEmail);
    form.set("merchantName", COMPLETE_FIELDS.merchantName);
    form.set("supportPhone", COMPLETE_FIELDS.supportPhone);
    form.set("amountMinor", String(COMPLETE_FIELDS.amountMinor));
    form.set("currency", COMPLETE_FIELDS.currency);
    const created = await routes.cases.POST(new Request(`${BASE}/cases`, { method: "POST", body: form }));
    expect(created.status).toBe(201);
    const session = created.headers.get("set-cookie")!.split(";")[0]!;
    const { case: c } = (await created.json()) as { case: { id: string } };

    const url = `${BASE}/cases/${c.id}/history`;
    expect((await routes.history.GET(new Request(url), ctx(c.id))).status).toBe(404);
    const foreign = await routes.history.GET(new Request(url, { headers: { cookie: `refund_session=${"f".repeat(48)}` } }), ctx(c.id));
    expect(foreign.status).toBe(404);
    expect(((await foreign.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND");
    const missing = "00000000-0000-4000-8000-000000000000";
    expect((await routes.history.GET(new Request(`${BASE}/cases/${missing}/history`, { headers: { cookie: session } }), ctx(missing))).status).toBe(404);

    const owned = await routes.history.GET(new Request(url, { headers: { cookie: session } }), ctx(c.id));
    expect(owned.status).toBe(200);
    const body = (await owned.json()) as { history: { status: string; source: string; revision: number; matches: unknown[] } | null; current: boolean };
    expect(body.current).toBe(true);
    expect(body.history).toMatchObject({ status: "duplicate_found", source: "fixture", revision: 1 });
    expect(body.history?.matches.length).toBe(3);
  });

  it("GET /api/insights/merchant validates the name and answers without a session", async () => {
    for (const query of ["", "?name=", "?name=%20%20", `?name=${"x".repeat(201)}`]) {
      const res = await routes.merchant.GET(new Request(`${BASE}/insights/merchant${query}`));
      expect(res.status).toBe(400);
      expect((await res.json()) as unknown).toMatchObject({ error: { code: "BAD_REQUEST", fields: ["name"] } });
    }
    const ok = await routes.merchant.GET(new Request(`${BASE}/insights/merchant?name=${encodeURIComponent("Acme Streaming")}`));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ available: true, merchant: "Acme Streaming", source: "fixture", cases: 13, approved: 9, denied: 2 });
    const unknown = await routes.merchant.GET(new Request(`${BASE}/insights/merchant?name=Nobody%20Inc`));
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toMatchObject({ available: true, merchant: "Nobody Inc", cases: 0, approvalRate: null });
  });
});
