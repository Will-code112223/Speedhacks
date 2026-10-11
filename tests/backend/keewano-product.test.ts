import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EVENT_TYPES, EVENTS_HASH, event, eventType } from "@/integrations/keewano/events";
import { KeewanoIngestClient } from "@/integrations/keewano/ingest";
import { MirroredCaseRepository } from "@/integrations/keewano/mirror";
import { createProductCaseRepository } from "@/integrations/keewano/product";
import { KeewanoSink, type EventSink } from "@/integrations/keewano/sink";
import { SCHEMA, type Db } from "@/server/persistence/db";
import { CaseRepository, type CaseRow, type CallRow } from "@/server/persistence/repository";

const databases: Db[] = [];
const at = "2026-10-11T20:00:00.000Z";
function db() { const value = new Database(":memory:"); value.exec(SCHEMA); databases.push(value); return value; }
function row(mode: "live" | "simulated" = "live"): CaseRow {
  return { id: randomUUID(), mode, revision: 1, ownerSession: "private-session-id", createdAt: at, updatedAt: at,
    doc: { customer: { name: "Private Person", email: "private@example.com" },
      merchant: { name: "Private Person account 9988", supportPhone: "+14155551234" }, amountMinor: 2500, currency: "USD",
      reason: "PRIVATE_REASON", missingFields: [], draft: { subject: "PRIVATE_SUBJECT", body: "PRIVATE_DRAFT" }, authorization: null,
      outcome: { decision: "unknown", referenceNumber: "PRIVATE_REFERENCE", nextAction: "PRIVATE_ACTION", paymentStatus: "unverified", supportingQuote: "PRIVATE_QUOTE" },
      timeline: [{ id: randomUUID(), type: "case_created", at, message: "PRIVATE_TIMELINE_MESSAGE" },
        { id: randomUUID(), type: "private@example.com", at, message: "PRIVATE_IMPORTED_TYPE" }] } };
}
function call(repo: CaseRepository, caseId: string, mode: "live" | "simulated" = "live"): CallRow {
  const authorizationId = randomUUID();
  repo.insertAuthorization({ id: authorizationId, caseId, revision: 1, approvedAt: at,
    snapshot: { caseId, revision: 1, customer: { name: "PRIVATE_NAME", email: "PRIVATE_EMAIL" },
      merchant: { name: "PRIVATE_MERCHANT", supportPhone: "+14155551234" }, amountMinor: 2500, currency: "USD",
      reason: "PRIVATE_REASON", evidence: [], brief: "PRIVATE_BRIEF", permittedActions: [] } });
  return { id: randomUUID(), caseId, authorizationId, requestId: randomUUID(), providerCallId: `PRIVATE_PROVIDER_ID_${randomUUID()}`, mode,
    state: "queued", transcript: "PRIVATE_TRANSCRIPT", error: "PRIVATE_ERROR", lastReconciledAt: null, createdAt: at, updatedAt: at };
}
function mirror() { const sink: EventSink = { emit: vi.fn(), flush: vi.fn(async () => {}) }; return { sink, repo: new MirroredCaseRepository(db(), sink) }; }
function client(transport: typeof fetch) { return new KeewanoIngestClient({ apiKey: "synthetic-key", eventTypes: EVENT_TYPES, eventsHash: EVENTS_HASH, fetch: transport }); }
function response(accepted = 1) { return new Response(JSON.stringify({ received: accepted, accepted }), { status: 200 }); }

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const database of databases.splice(0)) database.close(); });

describe("live-only Keewano product reuse", () => {
  it.each([
    {}, { KEEWANO_API_KEY: "synthetic-key" }, { KEEWANO_LIVE_PROJECT_CONFIRMED: "true" },
    { KEEWANO_API_KEY: "synthetic-key", KEEWANO_LIVE_PROJECT_CONFIRMED: "false" },
    { KEEWANO_API_KEY: "synthetic-key", KEEWANO_LIVE_PROJECT_CONFIRMED: "TRUE" },
    { KEEWANO_API_KEY: "invalid\nkey", KEEWANO_LIVE_PROJECT_CONFIRMED: "true" },
  ])("does not create a network sink without both explicit safe settings: %j", async env => {
    const transport = vi.fn(); const repo = createProductCaseRepository(db(), { env, fetch: transport });
    expect(repo.constructor).toBe(CaseRepository); repo.insertCase(row());
    expect(transport).not.toHaveBeenCalled();
  });

  it("does not register or ingest on factory creation; a committed live change starts the actual adapter", async () => {
    vi.useFakeTimers();
    const transport = vi.fn(async (input, init) => {
      const body = JSON.parse(String(init?.body));
      return String(input).endsWith("/custom") ? new Response("{}") : response(body.events.length);
    }) as unknown as ReturnType<typeof vi.fn> & typeof fetch;
    const repo = createProductCaseRepository(db(), { env: { KEEWANO_API_KEY: "synthetic-key", KEEWANO_LIVE_PROJECT_CONFIRMED: "true" }, fetch: transport });
    expect(repo).toBeInstanceOf(MirroredCaseRepository); expect(transport).not.toHaveBeenCalled();
    repo.insertCase(row()); await vi.advanceTimersByTimeAsync(250);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[1]?.[0]).toBe("https://api.keewano.com/event/ingress/v1/json/in");
  });

  it("never emits simulated cases or calls, including after later updates", () => {
    const { sink, repo } = mirror(); const simulated = row("simulated"); repo.insertCase(simulated);
    repo.updateCase(simulated.id, { doc: { ...simulated.doc, amountMinor: 9999 }, updatedAt: at });
    const attempt = call(repo, simulated.id, "simulated"); repo.insertCall(attempt); repo.updateCall(attempt.id, { state: "completed", updatedAt: at });
    expect(sink.emit).not.toHaveBeenCalled();
    const live = row(); repo.insertCase(live); vi.mocked(sink.emit).mockClear();
    const mixed = call(repo, live.id, "simulated"); repo.insertCall(mixed); repo.updateCall(mixed.id, { state: "completed", updatedAt: at });
    expect(sink.emit).not.toHaveBeenCalled();
  });

  it("exports only reviewed enums and amounts, never free text, customer data or call contents", () => {
    const { sink, repo } = mirror(); const initial = row(); repo.insertCase(initial);
    const attempt = call(repo, initial.id); repo.insertCall(attempt);
    repo.updateCall(attempt.id, { state: "completed", transcript: "PRIVATE_FINAL_TRANSCRIPT", error: "PRIVATE_FINAL_ERROR", updatedAt: at });
    repo.updateCase(initial.id, { doc: { ...initial.doc, outcome: { ...initial.doc.outcome, decision: "approved" } }, updatedAt: at });
    const payload = JSON.stringify(vi.mocked(sink.emit).mock.calls);
    for (const privateValue of ["Private", "PRIVATE", "private@example.com", "+14155551234", "9988", "private-session-id"]) expect(payload).not.toContain(privateValue);
    const events = vi.mocked(sink.emit).mock.calls.flatMap(([, events]) => events);
    expect(events.some(e => e.eventTypeId === eventType("RefundMerchant").eventTypeId)).toBe(false);
    expect(events.some(e => e.eventTypeId === eventType("RefundAmount").eventTypeId && e.data === 2500)).toBe(true);
    expect(events.some(e => e.eventTypeId === eventType("RefundOutcome").eventTypeId && e.data === "approved")).toBe(true);
    expect(events.every(e => e.eventTypeId <= 2006)).toBe(true);
  });

  it("does not emit rolled-back transactions or caught nested savepoint mutations", () => {
    const { sink, repo } = mirror(); const failed = row();
    expect(() => repo.transaction(() => { repo.insertCase(failed); throw new Error("rollback"); })).toThrow();
    expect(repo.getCase(failed.id)).toBeNull(); expect(sink.emit).not.toHaveBeenCalled();
    const committed = row();
    repo.transaction(() => {
      repo.insertCase(committed);
      try { repo.transaction(() => { repo.updateCase(committed.id, { doc: { ...committed.doc, amountMinor: 77777 }, updatedAt: at }); throw new Error("nested"); }); } catch {}
      expect(sink.emit).not.toHaveBeenCalled();
    });
    const payload = JSON.stringify(vi.mocked(sink.emit).mock.calls);
    expect(payload).not.toContain("77777"); expect(payload).toContain("2500");
    expect(repo.getCase(committed.id)?.doc.amountMinor).toBe(2500);
  });

  it("omits unsupported currency, invalid amounts, and unreviewed event types", () => {
    const { sink, repo } = mirror(); const initial = row(); initial.doc.currency = "EUR";
    repo.insertCase(initial);
    expect(vi.mocked(sink.emit).mock.calls.flatMap(([, e]) => e).some(e => e.eventTypeId === 2004)).toBe(false);
    vi.mocked(sink.emit).mockClear();
    repo.updateCase(initial.id, { doc: { ...initial.doc, currency: "USD", amountMinor: -1 }, updatedAt: at });
    expect(vi.mocked(sink.emit).mock.calls.flatMap(([, e]) => e).some(e => e.eventTypeId === 2004)).toBe(false);
  });
});

describe("real ingestion boundary with injected offline transport", () => {
  it("pins the official URL and rejects HTTP redirects rather than forwarding the credential", async () => {
    const transport = vi.fn(async () => response()); const ingest = client(transport);
    await ingest.sendBatch(randomUUID(), [event("RefundCaseMode", "live", at)]);
    expect(transport).toHaveBeenCalledWith("https://api.keewano.com/event/ingress/v1/json/in", expect.objectContaining({ redirect: "error", headers: { "k-token": "synthetic-key", "content-type": "application/json" }, signal: expect.any(AbortSignal) }));
  });

  it.each([{ accepted: 999, received: 1 }, { accepted: -1, received: 1 }, { accepted: "1", received: 1 }, { received: 1 }])("rejects malformed acknowledgement counts %j", async result => {
    const ingest = client(vi.fn(async () => new Response(JSON.stringify(result))));
    await expect(ingest.sendBatch(randomUUID(), [event("RefundCaseMode", "live", at)])).rejects.toThrow("invalid ingestion counts");
  });

  it("preserves batch identity and payload on ambiguous retry; new events get a separate batch", async () => {
    vi.useFakeTimers(); let count = 0;
    const transport = vi.fn(async (input, init) => {
      if (String(input).endsWith("/custom")) return new Response("{}");
      count++; if (count === 1) throw new Error("PRIVATE_PROVIDER_RESPONSE");
      return response(JSON.parse(String(init?.body)).events.length);
    });
    const logger = { warn: vi.fn() }; const sink = new KeewanoSink(client(transport), { logger }); const entity = randomUUID();
    sink.emit(entity, [event("RefundCaseMode", "live", at)]); await sink.flush();
    sink.emit(entity, [event("RefundCallState", "completed", at)]); await sink.flush();
    const bodies = transport.mock.calls.filter(([url]) => String(url).endsWith("/in")).map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toHaveLength(3); expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2].dataSessionId).not.toBe(bodies[0].dataSessionId); expect(bodies[2].events).toHaveLength(1);
    expect(sink.stats).toEqual({ sent: 2, accepted: 2, failures: 1, dropped: 0 });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("PRIVATE");
  });

  it("automatically retries failed registration without a new case write and bounds persistent failures", async () => {
    vi.useFakeTimers(); const logger = { warn: vi.fn() }; const transport = vi.fn(async () => { throw new Error("PRIVATE_REGISTRATION_ERROR"); });
    const sink = new KeewanoSink(client(transport), { logger }); sink.emit(randomUUID(), [event("RefundCaseMode", "live", at)]);
    await vi.advanceTimersByTimeAsync(4250);
    expect(transport).toHaveBeenCalledTimes(3); expect(sink.stats).toMatchObject({ dropped: 1, failures: 3 });
    await vi.advanceTimersByTimeAsync(10000); expect(transport).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("PRIVATE");
  });

  it("accounts for partial acceptance without duplicating the accepted prefix", async () => {
    const transport = vi.fn(async input => String(input).endsWith("/custom") ? new Response("{}") : new Response('{"received":2,"accepted":1}'));
    const sink = new KeewanoSink(client(transport), { logger: { warn: vi.fn() } });
    sink.emit(randomUUID(), [event("RefundCaseMode", "live", at), event("RefundCallState", "queued", at)]); await sink.flush(); await sink.flush();
    expect(transport).toHaveBeenCalledTimes(2); expect(sink.stats).toEqual({ sent: 2, accepted: 1, failures: 1, dropped: 1 });
  });
});
