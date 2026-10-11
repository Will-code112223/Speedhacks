import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSimulatedWebhook } from "@/server/cases/simulated-voice";
import { SESSION_A, TEST_SECRET, authorizeAndCall, createReadyCase, makeHarness, type Harness } from "./helpers";

const ts = (hh: Harness) => ({ timestampSeconds: Math.floor(hh.clock.now / 1000) });

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.cleanup());

describe("POST /api/webhooks/dial semantics", () => {
  it("rejects an invalid signature with 401 and stores nothing", async () => {
    const { body, headers } = buildSimulatedWebhook("wrong-secret", "sim_1_approved_deadbeef", ts(h));
    const r = await h.service.handleWebhook(body, headers);
    expect(r.status).toBe(401);
    expect((r.body as { error: { code: string } }).error.code).toBe("INVALID_WEBHOOK");
    expect(h.repo.getEvent(headers.get("x-dial-event-id")!)).toBeNull();
  });

  it("rejects a stale timestamp and a tampered body", async () => {
    const stale = buildSimulatedWebhook(TEST_SECRET, "sim_1_approved_deadbeef", { timestampSeconds: 1 });
    expect((await h.service.handleWebhook(stale.body, stale.headers)).status).toBe(401);
    const ok = buildSimulatedWebhook(TEST_SECRET, "sim_1_approved_deadbeef", ts(h));
    const tampered = new TextEncoder().encode(new TextDecoder().decode(ok.body).replace("deadbeef", "cafebabe"));
    expect((await h.service.handleWebhook(tampered, ok.headers)).status).toBe(401);
  });

  it("authenticated irrelevant events (webhook.ping) are 204 and not stored", async () => {
    const { body, headers } = buildSimulatedWebhook(TEST_SECRET, "sim_1_approved_deadbeef", { type: "webhook.ping", ...ts(h) });
    expect((await h.service.handleWebhook(body, headers)).status).toBe(204);
    expect(h.repo.getEvent(headers.get("x-dial-event-id")!)).toBeNull();
  });

  it("a valid call.ended event publishes the outcome; duplicates are 204 and processed once", async () => {
    const c = await createReadyCase(h);
    const { call } = await authorizeAndCall(h, c);
    h.clock.advance(10_000); // provider now reports completed
    const { body, headers } = buildSimulatedWebhook(TEST_SECRET, call.providerCallId!, { eventId: "evt_1", ...ts(h) });
    expect((await h.service.handleWebhook(body, headers)).status).toBe(204);
    let cs = await h.service.getCase(SESSION_A, c.id);
    expect(cs.calls[0]?.state).toBe("completed");
    expect(cs.outcome.decision).toBe("approved");
    const published = cs.timeline.filter((t) => t.type === "outcome_published").length;
    expect(published).toBe(1);
    expect(h.repo.getEvent("evt_1")?.processedAt).toBeTruthy();

    // Redelivery of the same event id: accepted, no double processing.
    expect((await h.service.handleWebhook(body, headers)).status).toBe(204);
    cs = await h.service.getCase(SESSION_A, c.id);
    expect(cs.timeline.filter((t) => t.type === "outcome_published").length).toBe(1);
  });

  it("a late event never regresses a terminal state", async () => {
    const c = await createReadyCase(h);
    const { call } = await authorizeAndCall(h, c);
    h.clock.advance(10_000);
    await h.service.getCase(SESSION_A, c.id); // completed via poll
    const before = await h.service.getCase(SESSION_A, c.id);
    const { body, headers } = buildSimulatedWebhook(TEST_SECRET, call.providerCallId!, { eventId: "evt_late", ...ts(h) });
    expect((await h.service.handleWebhook(body, headers)).status).toBe(204);
    const after = await h.service.getCase(SESSION_A, c.id);
    expect(after.calls[0]?.state).toBe("completed");
    expect(after.outcome).toEqual(before.outcome);
    expect(after.timeline.length).toBe(before.timeline.length);
    expect(h.repo.getEvent("evt_late")?.processedAt).toBeTruthy();
  });

  it("an early webhook (before the provider id is known) is queued, then reconciled on dispatch", async () => {
    // Adapter whose startCall "takes a while": the webhook for its provider id lands first.
    const providerCallId = `sim_${h.clock.now}_approved_0badf00d`;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = makeHarness({
      voice: {
        async startCall() {
          await gate;
          return { state: "accepted", mode: "simulated", providerCallId };
        },
        getCall: (id) => h.voice.getCall(id),
        verifyWebhook: (b, hd) => h.voice.verifyWebhook(b, hd),
      },
    });
    try {
      const c = await createReadyCase(slow);
      const a = slow.service.authorize(SESSION_A, c.id, 1);
      const pending = slow.service.startCall(SESSION_A, c.id, {
        authorizationId: a.authorization!.id,
        requestId: "11111111-1111-4111-8111-111111111111",
      });
      await new Promise((r) => setTimeout(r, 20));
      slow.clock.advance(10_000);
      h.clock.advance(10_000);
      const { body, headers } = buildSimulatedWebhook(TEST_SECRET, providerCallId, { eventId: "evt_early", ...ts(h) });
      expect((await slow.service.handleWebhook(body, headers)).status).toBe(204);
      expect(slow.repo.getEvent("evt_early")?.callId).toBeNull(); // unmatched, queued
      release();
      const call = await pending;
      expect(call.state).toBe("completed");
      expect(slow.repo.getEvent("evt_early")?.processedAt).toBeTruthy();
      const cs = await slow.service.getCase(SESSION_A, c.id);
      expect(cs.outcome.decision).toBe("approved");
    } finally {
      slow.cleanup();
    }
  });
});
