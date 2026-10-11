import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CaseV1 } from "@/contracts/case";
import { createKeewano, MirroredCaseRepository } from "@/integrations/keewano";
import { buildChargesSql, chargesFromRows } from "@/integrations/keewano/charges";
import {
  EVENTS_HASH,
  EVENT_TYPES,
  UUID_NAMESPACE_DNS,
  canonicalJson,
  crc32,
  customerEntityId,
  event,
  uuidV5,
} from "@/integrations/keewano/events";
import { FixtureTransactionHistory, KeewanoTransactionHistory } from "@/integrations/keewano/history";
import { KeewanoIngestClient, KeewanoIngestError, type KeewanoIngestEvent } from "@/integrations/keewano/ingest";
import { guessSqlArg, parseRows, pickSqlTool } from "@/integrations/keewano/mcp";
import { KeewanoSink, type EventSink } from "@/integrations/keewano/sink";
import {
  evaluateHistory,
  historyBriefLines,
  merchantMatches,
  type ChargeRecord,
  type TransactionHistory,
} from "@/server/cases/history";
import { CaseService } from "@/server/cases/service";
import { createSimulatedVoiceAdapter } from "@/server/cases/simulated-voice";
import { loadConfig } from "@/server/config";
import { HeuristicExtractor } from "@/server/documents/extractor";
import { UploadStore } from "@/server/documents/storage";
import { closeDatabase, openDatabase } from "@/server/persistence/db";
import { CaseRepository } from "@/server/persistence/repository";
import { COMPLETE_FIELDS, SESSION_A, TEST_SECRET } from "./helpers";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type Captured = KeewanoIngestEvent & { entity: string };

function capturingSink(): EventSink & { events: Captured[] } {
  const events: Captured[] = [];
  return {
    events,
    emit(entity, batch) {
      for (const e of batch) events.push({ entity, ...e });
    },
    async flush() {},
  };
}

const NAME_OF = new Map<number, string>(EVENT_TYPES.map((t) => [t.eventTypeId, t.name]));
const named = (events: Captured[], name: string) => events.filter((e) => NAME_OF.get(e.eventTypeId) === name).map((e) => e.data);

type FakeFetchCall = { url: string; init: RequestInit; body: Record<string, unknown> };

function fakeFetch(responder: (call: FakeFetchCall) => { status?: number; body?: unknown } = () => ({})) {
  const calls: FakeFetchCall[] = [];
  const impl: typeof fetch = async (input, init) => {
    const call = { url: String(input), init: init ?? {}, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> };
    calls.push(call);
    const r = responder(call);
    const status = r.status ?? 200;
    return new Response(r.body === undefined ? JSON.stringify({ received: call.body.events ? (call.body.events as unknown[]).length : 0, accepted: call.body.events ? (call.body.events as unknown[]).length : 0 }) : JSON.stringify(r.body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetch: impl };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** CaseService with a chosen repository/history source; fake clock drives the simulated call. */
function build(opts: { sink?: EventSink; history?: TransactionHistory | null; env?: Record<string, string> } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "refund-keewano-"));
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
  const repo = opts.sink ? new MirroredCaseRepository(db, opts.sink) : new CaseRepository(db);
  const service = new CaseService({
    config,
    repo,
    uploads: new UploadStore(config.dataDir),
    extractor: new HeuristicExtractor(),
    voice: () => voice,
    history: opts.history ?? null,
    now: () => new Date(clock.now),
  });
  cleanups.push(() => {
    closeDatabase();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { service, repo, clock };
}

const createCase = (service: CaseService, fields = COMPLETE_FIELDS) =>
  service.createCase(SESSION_A, {
    summary: "I was charged twice for my monthly subscription on October 3.",
    files: [{ name: "receipt.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("Receipt\nTotal: $49.99\n") }],
    fields,
  });

const timelineTypes = (c: CaseV1) => c.timeline.map((t) => t.type);

// ---------------------------------------------------------------------------
// Registry, hash and entity ids
// ---------------------------------------------------------------------------

describe("keewano event registry", () => {
  it("has unique ids from 2000 and a stable non-zero hash", () => {
    const ids = EVENT_TYPES.map((t) => t.eventTypeId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Math.min(...ids)).toBeGreaterThanOrEqual(2000);
    expect(EVENTS_HASH).toBeGreaterThan(0);
    expect(EVENTS_HASH).toBe(crc32(canonicalJson(EVENT_TYPES)) || 1);
  });

  it("crc32 and canonical JSON match known vectors regardless of key order", () => {
    expect(crc32("123456789")).toBe(0xcbf43926);
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
    expect(crc32(canonicalJson([{ name: "X", eventTypeId: 1 }]))).toBe(crc32(canonicalJson([{ eventTypeId: 1, name: "X" }])));
  });

  it("derives RFC 4122 v5 UUIDs (python.org vector) and stable customer ids", () => {
    expect(uuidV5("python.org", UUID_NAMESPACE_DNS)).toBe("886313e1-3b8a-5372-9b90-0c9aee199e5d");
    const a = customerEntityId({ email: "Sam@Example.com ", name: "Sam Rivera" });
    const b = customerEntityId({ email: "sam@example.com", name: null });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(customerEntityId({ email: null, name: "Sam   Rivera" })).toBe(customerEntityId({ email: null, name: "sam rivera" }));
    expect(customerEntityId({ email: null, name: "sam rivera" })).not.toBe(b);
    expect(customerEntityId({ email: null, name: null })).toBeNull();
  });

  it("builds typed events: seconds timestamps, truncated strings, uint32 prices", () => {
    const e = event("RefundCaseEvent", "x".repeat(300), "2026-10-11T20:00:00.500Z");
    expect(e).toMatchObject({ eventTypeId: 2000, dataType: "string", timestamp: 1791748800 });
    expect((e.data as string).length).toBe(256);
    expect(event("RefundAmount", 4999, 1791748800000).data).toBe(4999);
    expect(() => event("RefundAmount", -1, "2026-10-11T20:00:00Z")).toThrow(/integer/);
    expect(() => event("RefundAmount", 12.5, "2026-10-11T20:00:00Z")).toThrow(/integer/);
    expect(() => event("RefundCaseEvent", "x", "not a date")).toThrow(/Invalid timestamp/);
  });
});

// ---------------------------------------------------------------------------
// REST ingestion
// ---------------------------------------------------------------------------

describe("keewano ingest client", () => {
  const client = (f: typeof fetch) =>
    new KeewanoIngestClient({ apiKey: "k-test", baseUrl: "https://ingest.test/v1/", eventTypes: EVENT_TYPES, eventsHash: EVENTS_HASH, fetch: f });

  it("registers the event list and sends chronologically ordered batches with the k-token header", async () => {
    const f = fakeFetch();
    const c = client(f.fetch);
    await c.registerEventTypes();
    const entity = randomUUID();
    const late = event("RefundCaseEvent", "later", "2026-10-11T20:00:05Z");
    const early = event("RefundCaseEvent", "earlier", "2026-10-11T20:00:01Z");
    const result = await c.sendBatch(entity, [late, early]);
    expect(result).toEqual({ received: 2, accepted: 2 });
    expect(f.calls.map((x) => x.url)).toEqual(["https://ingest.test/v1/custom", "https://ingest.test/v1/in"]);
    const headers = new Headers(f.calls[1]!.init.headers);
    expect(headers.get("k-token")).toBe("k-test");
    expect(f.calls[0]!.body).toEqual({ customEventsHash: EVENTS_HASH, eventTypes: EVENT_TYPES });
    const body = f.calls[1]!.body;
    expect(body).toMatchObject({ batch: 1, customEventsHash: EVENTS_HASH, installId: entity, userId: entity });
    expect(String(body.dataSessionId)).toMatch(/^[0-9a-f-]{36}$/);
    expect((body.events as KeewanoIngestEvent[]).map((e) => e.data)).toEqual(["earlier", "later"]);
  });

  it("rejects non-UUID entities, skips empty batches and surfaces HTTP failures", async () => {
    const f = fakeFetch(() => ({ status: 403, body: { error: "bad key" } }));
    const c = client(f.fetch);
    await expect(c.sendBatch("customer-42", [event("RefundCaseEvent", "x", "2026-10-11T20:00:00Z")])).rejects.toThrow(/UUID/);
    expect(await c.sendBatch(randomUUID(), [])).toEqual({ received: 0, accepted: 0 });
    expect(f.calls.length).toBe(0);
    await expect(c.registerEventTypes()).rejects.toBeInstanceOf(KeewanoIngestError);
    await expect(c.registerEventTypes()).rejects.toMatchObject({ status: 403 });
  });
});

describe("keewano sink", () => {
  const silent = { warn() {} };

  it("registers once, ships one batch per entity, and never throws into the caller", async () => {
    const f = fakeFetch();
    const sink = new KeewanoSink(
      new KeewanoIngestClient({ apiKey: "k", baseUrl: "https://ingest.test", eventTypes: EVENT_TYPES, eventsHash: EVENTS_HASH, fetch: f.fetch }),
      { logger: silent, debounceMs: 1 },
    );
    const a = randomUUID();
    const b = randomUUID();
    sink.emit(a, [event("RefundCaseEvent", "one", "2026-10-11T20:00:00Z")]);
    sink.emit(b, [event("RefundCaseEvent", "two", "2026-10-11T20:00:00Z")]);
    sink.emit(a, [event("RefundCaseEvent", "three", "2026-10-11T20:00:01Z")]);
    await sink.flush();
    await sink.flush(); // nothing new: no extra requests
    const urls = f.calls.map((x) => x.url);
    expect(urls.filter((u) => u.endsWith("/custom")).length).toBe(1);
    expect(urls.filter((u) => u.endsWith("/in")).length).toBe(2);
    const forA = f.calls.find((x) => x.body.installId === a)!;
    expect((forA.body.events as KeewanoIngestEvent[]).map((e) => e.data)).toEqual(["one", "three"]);
    expect(sink.stats).toEqual({ sent: 3, accepted: 3, dropped: 0, failures: 0 });
  });

  it("keeps events queued while registration fails and drops a batch the endpoint rejects", async () => {
    let registerOk = false;
    const f = fakeFetch((call) => {
      if (call.url.endsWith("/custom")) return registerOk ? {} : { status: 500, body: {} };
      return call.body.installId === "00000000-0000-4000-8000-000000000001" ? { status: 400, body: {} } : {};
    });
    const sink = new KeewanoSink(
      new KeewanoIngestClient({ apiKey: "k", baseUrl: "https://ingest.test", eventTypes: EVENT_TYPES, eventsHash: EVENTS_HASH, fetch: f.fetch }),
      { logger: silent, debounceMs: 1 },
    );
    const bad = "00000000-0000-4000-8000-000000000001";
    const good = randomUUID();
    sink.emit(bad, [event("RefundCaseEvent", "x", "2026-10-11T20:00:00Z")]);
    sink.emit(good, [event("RefundCaseEvent", "y", "2026-10-11T20:00:00Z")]);
    await sink.flush();
    expect(sink.stats).toMatchObject({ sent: 0, failures: 1 });
    expect(f.calls.filter((x) => x.url.endsWith("/in")).length).toBe(0);
    registerOk = true;
    await sink.flush();
    expect(sink.stats).toMatchObject({ sent: 1, accepted: 1, dropped: 1, failures: 2 });
  });
});

// ---------------------------------------------------------------------------
// Mirror: the whole simulated flow lands in Keewano, keyed by case id
// ---------------------------------------------------------------------------

describe("case mirror", () => {
  it("emits every timeline entry once, plus status, merchant, amount, call states and outcome", async () => {
    const sink = capturingSink();
    const { service, clock } = build({ sink });
    let c = await createCase(service);
    const authorized = service.authorize(SESSION_A, c.id, c.revision);
    await service.startCall(SESSION_A, c.id, { authorizationId: authorized.authorization!.id, requestId: randomUUID() });
    for (let i = 0; i < 8; i++) {
      clock.now += 2000;
      c = await service.getCase(SESSION_A, c.id);
      if (c.calls.some((call) => call.state === "completed")) break;
    }
    expect(c.status).toBe("approved");

    const mine = sink.events.filter((e) => e.entity === c.id);
    expect(sink.events.length).toBe(mine.length); // nothing leaks to another entity
    expect(named(mine, "RefundCaseEvent")).toEqual(timelineTypes(c));
    expect(named(mine, "RefundCaseMode")).toEqual(["simulated"]);
    expect(named(mine, "RefundMerchant")).toEqual(["Acme Streaming"]);
    expect(named(mine, "RefundAmount")).toEqual([4999]);
    const callStates = named(mine, "RefundCallState");
    expect(callStates[0]).toBe("dispatch_pending");
    expect(callStates.at(-1)).toBe("completed");
    expect(named(mine, "RefundOutcome")).toEqual(["approved"]);
    const statuses = named(mine, "RefundCaseStatus");
    expect(statuses).toEqual(["ready_for_approval", "authorized", "calling", "approved"]);
    // Timeline events carry the entry's own time, in seconds.
    const first = c.timeline[0]!;
    const firstEvent = mine.find((e) => NAME_OF.get(e.eventTypeId) === "RefundCaseEvent")!;
    expect(firstEvent.timestamp).toBe(Math.floor(Date.parse(first.at) / 1000));
  });

  it("emits a fact edit as new merchant/amount values and a status change", async () => {
    const sink = capturingSink();
    const { service } = build({ sink });
    const c = await createCase(service);
    sink.events.length = 0;
    service.patchCase(SESSION_A, c.id, 1, { amountMinor: 5999, merchant: { name: "Acme Streaming Inc", supportPhone: "+14155551000" } });
    expect(named(sink.events, "RefundAmount")).toEqual([5999]);
    expect(named(sink.events, "RefundMerchant")).toEqual(["Acme Streaming Inc"]);
    expect(named(sink.events, "RefundCaseEvent")).toEqual(["facts_updated"]);
    expect(named(sink.events, "RefundCaseStatus")).toEqual([]); // still ready_for_approval
  });
});

// ---------------------------------------------------------------------------
// Duplicate-charge evaluation (pure) and the fixture
// ---------------------------------------------------------------------------

const OPTS = { revision: 1, checkedAt: "2026-10-11T20:00:00.000Z", source: "test", windowMinutes: 24 * 60 };
const ACME = { merchantName: "Acme Streaming", amountMinor: 4999, currency: "USD" };

describe("history evaluation", () => {
  const fixture = new FixtureTransactionHistory();

  it("matches abbreviated statement descriptors but not unrelated merchants", () => {
    expect(merchantMatches("ACME STREAMING INC", "Acme Streaming")).toBe(true);
    expect(merchantMatches("Acme", "Acme Streaming")).toBe(true);
    expect(merchantMatches("Blue Bottle Coffee", "Acme Streaming")).toBe(false);
    expect(merchantMatches("", "Acme")).toBe(false);
  });

  it("finds Sam's duplicate: two $49.99 Acme charges minutes apart, plus last month's", async () => {
    const check = evaluateHistory(await fixture.listCharges({ email: "sam@example.com", name: null }), ACME, OPTS);
    expect(check.status).toBe("duplicate_found");
    expect(check.matches.map((m) => m.chargeId)).toEqual(["txn_3b00aa", "txn_2a91f0", "txn_2a91f7"]);
    expect(check.closestGapMinutes).toBeCloseTo(3.48, 1);
    expect(check.summary).toContain("3 charges of $49.99 at Acme Streaming");
    expect(check.summary).toContain("3 minutes apart");
    expect(historyBriefLines(check).join("\n")).toContain("You may cite these transaction references");
  });

  it("classifies single, recurring, no-match and unknown customers; by name when no email", async () => {
    const priya = evaluateHistory(await fixture.listCharges({ email: "priya@example.com", name: null }), ACME, OPTS);
    expect(priya.status).toBe("single_charge");
    expect(historyBriefLines(priya).join("\n")).toContain("Do not claim");
    const diego = evaluateHistory(await fixture.listCharges({ email: null, name: "DIEGO ALVAREZ" }), ACME, OPTS);
    expect(diego.status).toBe("recurring_only");
    expect(diego.matches.length).toBe(3);
    expect(diego.summary).toContain("recurring charge");
    const noMatch = evaluateHistory(await fixture.listCharges({ email: "sam@example.com", name: null }), { ...ACME, amountMinor: 1234 }, OPTS);
    expect(noMatch.status).toBe("no_match");
    expect(noMatch.summary).toContain("6 charges on file, none of $12.34");
    const nobody = evaluateHistory(await fixture.listCharges({ email: "nobody@example.com", name: "Nobody" }), ACME, OPTS);
    expect(nobody.status).toBe("no_history");
  });

  it("treats two charges outside the window as recurring and inside as duplicate", () => {
    const charges: ChargeRecord[] = [
      { chargeId: "a", merchant: "Acme Streaming", amountMinor: 4999, currency: "USD", at: "2026-10-01T10:00:00Z" },
      { chargeId: "b", merchant: "Acme Streaming", amountMinor: 4999, currency: "USD", at: "2026-10-01T22:00:00Z" },
    ];
    expect(evaluateHistory(charges, ACME, { ...OPTS, windowMinutes: 60 }).status).toBe("recurring_only");
    expect(evaluateHistory(charges, ACME, { ...OPTS, windowMinutes: 24 * 60 }).status).toBe("duplicate_found");
    expect(evaluateHistory(charges, { ...ACME, currency: "EUR" }, OPTS).status).toBe("no_match");
  });
});

// ---------------------------------------------------------------------------
// Service integration: timeline, frozen brief, packet; never blocks authorization
// ---------------------------------------------------------------------------

describe("history check in the case flow", () => {
  it("runs at creation, is frozen into the brief and printed in the packet", async () => {
    const { service, repo } = build({ history: new FixtureTransactionHistory() });
    const c = await createCase(service);
    const entry = c.timeline.find((t) => t.type === "history_checked");
    expect(entry?.message).toContain("Transaction history (fixture): 3 charges of $49.99 at Acme Streaming");
    expect(c.status).toBe("ready_for_approval");
    const authorized = service.authorize(SESSION_A, c.id, c.revision);
    const auth = repo.getAuthorization(authorized.authorization!.id)!;
    expect(auth.snapshot.history?.status).toBe("duplicate_found");
    expect(auth.snapshot.brief).toContain("Transaction history evidence:");
    expect(auth.snapshot.brief).toContain("txn_2a91f0 at 2026-10-03T14:02:11Z");
    expect(auth.snapshot.brief).toContain("You may cite these transaction references");
    const packet = service.packet(SESSION_A, c.id);
    expect(packet).toContain("TRANSACTION HISTORY");
    expect(packet).toContain("status: duplicate_found");
  });

  it("re-checks after a fact edit on the next read and the stale check is not frozen", async () => {
    const { service, repo } = build({ history: new FixtureTransactionHistory() });
    let c = await createCase(service);
    c = service.patchCase(SESSION_A, c.id, 1, { amountMinor: 5999 });
    expect(c.revision).toBe(2);
    expect(timelineTypes(c).filter((t) => t === "history_checked").length).toBe(1); // not yet re-checked
    c = await service.getCase(SESSION_A, c.id);
    const checks = c.timeline.filter((t) => t.type === "history_checked");
    expect(checks.length).toBe(2);
    expect(checks[1]!.message).toContain("none of $59.99");
    expect(c.revision).toBe(2); // timeline updates never bump the revision
    c = await service.getCase(SESSION_A, c.id);
    expect(c.timeline.filter((t) => t.type === "history_checked").length).toBe(2); // once per revision
    const authorized = service.authorize(SESSION_A, c.id, c.revision);
    const auth = repo.getAuthorization(authorized.authorization!.id)!;
    expect(auth.snapshot.history?.status).toBe("no_match");
    expect(auth.snapshot.brief).toContain("Do not claim that the transaction history shows a duplicate");
  });

  it("records an explicit unavailable result, never blocks authorization, and retries after the pause", async () => {
    let calls = 0;
    const flaky: TransactionHistory = {
      kind: "keewano",
      async listCharges() {
        calls += 1;
        if (calls === 1) throw new Error("MCP connection refused");
        return new FixtureTransactionHistory().listCharges({ email: "sam@example.com", name: null });
      },
    };
    const { service, repo, clock } = build({ history: flaky, env: { KEEWANO_RETRY_MS: "1000" } });
    let c = await createCase(service);
    const unavailable = c.timeline.find((t) => t.type === "history_unavailable");
    expect(unavailable?.message).toContain("Transaction history (keewano) could not be checked: MCP connection refused");
    expect(c.status).toBe("ready_for_approval");
    c = await service.getCase(SESSION_A, c.id);
    expect(calls).toBe(1); // inside the retry pause
    clock.now += 1500;
    c = await service.getCase(SESSION_A, c.id);
    expect(calls).toBe(2);
    expect(c.timeline.find((t) => t.type === "history_checked")?.message).toContain("Transaction history (keewano)");
    const authorized = service.authorize(SESSION_A, c.id, c.revision);
    expect(repo.getAuthorization(authorized.authorization!.id)!.snapshot.history?.status).toBe("duplicate_found");
  });

  it("times out a slow source and freezes the unavailable result rather than waiting", async () => {
    const slow: TransactionHistory = { kind: "keewano", listCharges: () => new Promise(() => {}) };
    const { service, repo } = build({ history: slow, env: { KEEWANO_TIMEOUT_MS: "50", KEEWANO_RETRY_MS: "60000" } });
    const c = await createCase(service);
    expect(c.timeline.find((t) => t.type === "history_unavailable")?.message).toContain("timed out after 50 ms");
    const authorized = service.authorize(SESSION_A, c.id, c.revision);
    expect(repo.getAuthorization(authorized.authorization!.id)!.snapshot.brief).toContain("could not be checked");
  });

  it("skips the check when there is no source or no merchant/amount/customer to check", async () => {
    const { service } = build();
    const c = await createCase(service);
    expect(timelineTypes(c).some((t) => t.startsWith("history_"))).toBe(false);
    const withSource = build({ history: new FixtureTransactionHistory() });
    const partial = await withSource.service.createCase(SESSION_A, { summary: "Something is wrong with a charge.", files: [], fields: {} });
    expect(timelineTypes(partial).some((t) => t.startsWith("history_"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Wiring from configuration
// ---------------------------------------------------------------------------

describe("createKeewano", () => {
  it("uses the labeled fixture in simulated mode without credentials, and nothing when disabled or live", () => {
    const sim = createKeewano(loadConfig({ REFUND_MODE: "simulated" }));
    expect(sim.sink).toBeNull();
    expect(sim.history?.kind).toBe("fixture");
    expect(createKeewano(loadConfig({ REFUND_MODE: "simulated", KEEWANO_FIXTURE_HISTORY: "off" })).history).toBeNull();
    expect(createKeewano(loadConfig({ REFUND_MODE: "live" })).history).toBeNull();
  });

  it("mirrors with an API key and queries Keewano with an access token", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "refund-keewano-wire-"));
    cleanups.push(() => {
      closeDatabase();
      fs.rmSync(dataDir, { recursive: true, force: true });
    });
    const wired = createKeewano(loadConfig({ REFUND_MODE: "simulated", KEEWANO_API_KEY: "k", KEEWANO_ACCESS_TOKEN: "kwpat-x", DATA_DIR: dataDir }));
    expect(wired.sink).toBeInstanceOf(KeewanoSink);
    expect(wired.history).toBeInstanceOf(KeewanoTransactionHistory);
    closeDatabase();
    expect(wired.repository(openDatabase(dataDir))).toBeInstanceOf(MirroredCaseRepository);
  });
});

// ---------------------------------------------------------------------------
// MCP result handling and the charges query (no server needed)
// ---------------------------------------------------------------------------

describe("keewano MCP client helpers", () => {
  it("discovers the SQL tool and its argument, honouring overrides", () => {
    const tools = [
      { name: "run_lua", inputSchema: { type: "object", properties: { script: { type: "string" } } } },
      { name: "execute_sql", inputSchema: { type: "object", properties: { limit: { type: "number" }, query: { type: "string" } } } },
    ];
    expect(pickSqlTool(tools)).toEqual({ name: "execute_sql", arg: "query" });
    expect(pickSqlTool(tools, "run_lua", "script")).toEqual({ name: "run_lua", arg: "script" });
    expect(() => pickSqlTool(tools, "missing")).toThrow(/not offered; tools: run_lua, execute_sql/);
    expect(() => pickSqlTool([{ name: "nothing" }])).toThrow(/No SQL tool found/);
    expect(guessSqlArg({ type: "object", properties: { statement: { type: "string" } } })).toBe("statement");
    expect(guessSqlArg(undefined)).toBe("sql");
  });

  it("normalizes structured, JSON, markdown and CSV results into rows", () => {
    expect(parseRows({ structuredContent: { columns: ["a", "b"], rows: [[1, "x"]] } })).toEqual([{ a: 1, b: "x" }]);
    expect(parseRows({ structuredContent: { columns: [{ name: "a" }], rows: [[2]] } })).toEqual([{ a: 2 }]);
    expect(parseRows({ content: [{ type: "text", text: '[{"a":1},{"a":2}]' }] })).toEqual([{ a: 1 }, { a: 2 }]);
    expect(parseRows({ content: [{ type: "text", text: '{"result":{"rows":[{"a":3}]}}' }] })).toEqual([{ a: 3 }]);
    expect(parseRows({ content: [{ type: "text", text: "| a | b |\n|---|---|\n| 1 | x |" }] })).toEqual([{ a: "1", b: "x" }]);
    expect(parseRows({ content: [{ type: "text", text: "a,b\n1,x" }] })).toEqual([{ a: "1", b: "x" }]);
    expect(parseRows({ content: [{ type: "text", text: "" }] })).toEqual([]);
    expect(() => parseRows({ content: [{ type: "text", text: "no rows here" }] })).toThrow(/Unrecognized/);
  });

  it("queries the customer's entity and de-duplicates forward-filled ChargeId rows", async () => {
    const entity = customerEntityId({ email: "sam@example.com", name: null })!;
    const sql = buildChargesSql(entity);
    expect(sql).toContain(`user_id = '${entity}'`);
    expect(sql).toContain('"ChargeId" IS NOT NULL');
    expect(() => buildChargesSql("1 OR 1=1")).toThrow(/UUID/);
    const rows = [
      { event_datetime: "2026-10-03 14:02:11", ChargeId: "txn_1", ChargeMerchant: "ACME STREAMING INC", ChargeAmount: "4999", ChargeCurrency: "USD" },
      { event_datetime: 1791122531, ChargeId: "txn_1", ChargeMerchant: "ACME STREAMING INC", ChargeAmount: 4999, ChargeCurrency: "USD" }, // carried forward
      { event_datetime: "2026-10-03T14:05:40Z", ChargeId: "txn_2", ChargeMerchant: "ACME STREAMING INC", ChargeAmount: 4999, ChargeCurrency: null },
      { event_datetime: "2026-10-04T00:00:00Z", ChargeId: null, ChargeMerchant: "Ignored", ChargeAmount: 1, ChargeCurrency: "USD" },
    ];
    expect(chargesFromRows(rows)).toEqual([
      { chargeId: "txn_1", merchant: "ACME STREAMING INC", amountMinor: 4999, currency: "USD", at: "2026-10-03T14:02:11.000Z" },
      { chargeId: "txn_2", merchant: "ACME STREAMING INC", amountMinor: 4999, currency: "USD", at: "2026-10-03T14:05:40.000Z" },
    ]);
    const seen: string[] = [];
    const history = new KeewanoTransactionHistory({
      async runSql(q) {
        seen.push(q);
        return rows;
      },
    });
    const charges = await history.listCharges({ email: "sam@example.com", name: null });
    expect(seen[0]).toBe(sql);
    expect(evaluateHistory(charges, ACME, OPTS).status).toBe("duplicate_found");
    expect(await history.listCharges({ email: null, name: null })).toEqual([]);
    expect(seen.length).toBe(1);
  });
});
