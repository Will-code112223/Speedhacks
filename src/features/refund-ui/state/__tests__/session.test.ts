/**
 * Drives the fixture backend with a controlled clock and folds every answer
 * into the session reducer in the order useCaseSession does, so the chat
 * thread is checked end to end without a browser.
 */

import { describe, expect, it } from "vitest";
import type { CaseV1 } from "../../../../contracts/case";
import { createFixtureCaseApi } from "../../api/fixture";
import { ApiRequestError, type CaseApi, type FixtureOptions, type FixtureScenario, type LiveCallV2 } from "../../api/types";
import { toUiError } from "../errors";
import {
  decisionForCallScreen,
  initialSessionsState,
  pendingDecision,
  sessionsReducer,
  type CaseSession,
  type SessionAction,
  type SessionsState,
  type ThreadItem,
} from "../session";
import { summaryAutoSend } from "../session";
import { inferDestination } from "../../api/summary";

const T0 = Date.parse("2026-10-11T19:00:00.000Z");
const KEY = "case-1";

function harness(scenario: FixtureScenario, options: Omit<FixtureOptions, "now" | "scenario"> = {}) {
  let now = T0;
  const api: CaseApi = createFixtureCaseApi({ ...options, scenario, now: () => now });
  let state: SessionsState = initialSessionsState;
  const at = () => new Date(now).toISOString();
  const run = (action: SessionAction) => {
    state = sessionsReducer(state, action);
  };
  const session = (): CaseSession => {
    const found = state.sessions.find((candidate) => candidate.key === KEY);
    if (!found) throw new Error("No session.");
    return found;
  };
  const caseId = () => {
    const id = session().caseId;
    if (!id) throw new Error("No case yet.");
    return id;
  };
  const liveCapable = options.v2 !== false;

  return {
    api,
    at,
    run,
    session,
    seconds: (value: number) => {
      now = T0 + value * 1000;
    },
    kinds: () => session().thread.map((item) => item.kind),
    events: () =>
      session()
        .thread.filter((item): item is Extract<ThreadItem, { kind: "event" }> => item.kind === "event")
        .map((item) => item.text),
    async start(text: string, input: Partial<Parameters<CaseApi["createCase"]>[0]> = {}) {
      run({ type: "session/started", key: KEY, api, scenario, text, attachments: [], notice: null, at: at() });
      const created = await api.createCase({ summary: text, ...input });
      run({ type: "create/succeeded", key: KEY, caseData: created, liveCapable, at: at() });
      return created;
    },
    async poll(): Promise<CaseV1> {
      const next = await api.getCase(caseId());
      run({ type: "case/received", key: KEY, caseData: next, liveCapable, at: at() });
      return next;
    },
    async approve() {
      const current = session().caseData!;
      run({ type: "approval/started", key: KEY, stage: "authorizing" });
      try {
        const authorized = await api.authorize(current.id, current.revision);
        run({ type: "approval/authorized", key: KEY, caseData: authorized, liveCapable, at: at() });
        const call = await api.startCall(current.id, {
          authorizationId: authorized.authorization!.id,
          requestId: crypto.randomUUID(),
        });
        run({ type: "approval/dispatched", key: KEY, call, liveCapable, at: at() });
      } catch (error) {
        run({ type: "approval/failed", key: KEY, error: toUiError(error) });
      }
    },
    async live(): Promise<LiveCallV2 | null> {
      const call = session().caseData?.calls.at(-1) ?? session().startedCall;
      if (!call) throw new Error("No call.");
      const value = await api.getLiveCall(caseId(), call.id);
      if (value) run({ type: "live/received", key: KEY, live: value, at: at() });
      return value;
    },
  };
}

describe("session reducer with the fixture backend", () => {
  it("runs an insurance claim from facts to outcome without repeating lines", async () => {
    const h = harness("insurance_claim");
    await h.start("File an insurance claim against Northwind for the water damage");
    expect(h.kinds()).toEqual(["user", "understood", "approval"]);

    await h.approve();
    const approval = h.session().thread.find((item) => item.kind === "approval");
    expect(approval && approval.kind === "approval" ? approval.callId : null).toBe(h.session().startedCall?.id);
    await h.poll();
    expect(h.session().startedCall).toBeNull();
    expect(h.session().caseData?.status).toBe("calling");

    for (const second of [0, 1, 4, 10, 17, 18]) {
      h.seconds(second);
      await h.live();
    }
    expect(h.events()).toEqual([
      "Dialing Northwind Mutual claims line",
      "Navigating the phone menu",
      "On hold",
      "Talking",
      "An automated agent answered",
    ]);

    h.seconds(24);
    await h.live();
    const pending = pendingDecision(h.session());
    expect(pending?.decision.options.map((option) => option.id)).toEqual(["accept", "ask_for_other_times", "decline"]);
    expect(h.kinds().filter((kind) => kind === "decision")).toHaveLength(1);
    expect(h.events().at(-1)).toBe("Waiting for your answer");

    // The same poll again adds nothing.
    const before = h.session().thread.length;
    await h.live();
    expect(h.session().thread.length).toBe(before);

    h.seconds(25);
    const decisionId = pending!.decision.id;
    h.run({ type: "decision/answering", key: KEY, decisionId, optionId: "accept" });
    const answered = await h.api.answerDecision(h.session().caseId!, pending!.callId, decisionId, "accept");
    h.run({ type: "decision/answered", key: KEY, decisionId, optionId: "accept", live: answered, at: h.at() });
    expect(h.session().decisions[decisionId]).toMatchObject({ status: "answered", chosenOptionId: "accept" });
    expect(pendingDecision(h.session())).toBeNull();
    expect(decisionForCallScreen(h.session(), pending!.callId)?.status).toBe("answered");

    h.seconds(50);
    const ended = await h.live();
    expect(ended?.phase).toBe("ended");
    expect(h.events().at(-1)).toMatch(/^Call ended after \d+:\d{2}$/);
    const finished = await h.poll();
    expect(["approved", "awaiting_response"]).toContain(finished.status);
    expect(finished.outcome.referenceNumber).toBe("NWM-2026-48213");
    expect(h.kinds().filter((kind) => kind === "result")).toHaveLength(1);
    // A finished case does not offer another approval.
    expect(h.kinds().filter((kind) => kind === "approval")).toHaveLength(1);
  });

  it("closes a decision nobody answered and says the default applied", async () => {
    const h = harness("insurance_claim");
    await h.start("insurance claim");
    await h.approve();
    await h.poll();
    h.seconds(24);
    await h.live();
    const pending = pendingDecision(h.session());
    expect(pending).not.toBeNull();
    h.seconds(46);
    await h.live();
    expect(h.session().decisions[pending!.decision.id]).toMatchObject({ status: "closed", expired: true });
  });

  it("waits for missing facts, then offers the approval once a save fills them", async () => {
    const h = harness("needs_evidence");
    const created = await h.start("Ridgeline charged me twice but I lost the receipt");
    expect(created.status).toBe("needs_information");
    expect(h.kinds()).toEqual(["user", "understood"]);

    // Approving anyway names the missing fields; the error clears once a save fills them.
    await h.approve();
    expect(h.session().approval.error?.kind).toBe("missing_facts");
    expect(h.session().approval.error?.fieldKeys).toEqual(expect.arrayContaining(["supportPhone", "amountMinor"]));

    h.run({ type: "save/started", key: KEY });
    // The contract sends customer and merchant whole, as the facts card does.
    const saved = await h.api.patchCase(created.id, created.revision, {
      merchant: { name: created.merchant.name, supportPhone: "+14155550177" },
      amountMinor: 4999,
    });
    h.run({ type: "save/succeeded", key: KEY, caseData: saved, liveCapable: true, at: h.at() });
    expect(saved.status).toBe("ready_for_approval");
    expect(h.kinds()).toEqual(["user", "understood", "approval"]);
    expect(h.session().approval.error).toBeNull();
  });

  it("keeps a revision conflict until a reload, and ignores older snapshots", async () => {
    const h = harness("duplicate_charge");
    const created = await h.start("duplicate charge from Ridgeline");
    const newer = await h.api.patchCase(created.id, created.revision, { reason: "Charged twice on Oct 2." });

    h.run({ type: "save/started", key: KEY });
    try {
      await h.api.patchCase(created.id, created.revision, { reason: "Edited from a stale page." });
      throw new Error("Expected a conflict.");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiRequestError);
      h.run({ type: "save/failed", key: KEY, error: toUiError(error) });
    }
    expect(h.session().conflict).toBe(true);
    expect(h.session().caseData?.revision).toBe(1);

    h.run({ type: "reload/succeeded", key: KEY, caseData: newer, liveCapable: true, at: h.at() });
    expect(h.session()).toMatchObject({ conflict: false, reloads: 1 });
    expect(h.session().caseData?.revision).toBe(2);

    h.run({ type: "case/received", key: KEY, caseData: created, liveCapable: true, at: h.at() });
    expect(h.session().caseData?.revision).toBe(2);
  });

  it("shows a refused dispatch as a failed attempt and offers a new approval after an edit", async () => {
    const h = harness("duplicate_charge");
    const created = await h.start("duplicate charge", { supportPhone: "+14155550001" });
    await h.approve();
    expect(h.session().approval.error).toMatchObject({ kind: "provider_unavailable", code: "PROVIDER_UNAVAILABLE" });

    await h.poll();
    const approval = h.session().thread.find((item) => item.kind === "approval");
    const failed = h.session().caseData?.calls[0];
    expect(failed?.state).toBe("failed");
    expect(approval && approval.kind === "approval" ? approval.callId : null).toBe(failed?.id);
    expect(h.kinds().filter((kind) => kind === "result")).toHaveLength(1);

    await h.live();
    expect(h.events()).toEqual(["The call did not connect"]);

    const edited = await h.api.patchCase(created.id, h.session().caseData!.revision, {
      merchant: { name: created.merchant.name, supportPhone: "+14155550177" },
    });
    h.run({ type: "save/succeeded", key: KEY, caseData: edited, liveCapable: true, at: h.at() });
    const approvals = h.session().thread.filter((item) => item.kind === "approval");
    expect(approvals).toHaveLength(2);
    expect(approvals[1]).toMatchObject({ callId: null });
    expect(h.session().approval.error).toBeNull();
  });

  it("mirrors contract V1 call states as chat lines when there is no live data", async () => {
    const h = harness("call_complete_unconfirmed", { v2: false });
    await h.start("confirm my refund");
    await h.approve();
    await h.poll();
    expect(await h.api.getLiveCall(h.session().caseId!, h.session().caseData!.calls[0]!.id)).toBeNull();
    h.seconds(20);
    await h.poll();
    h.seconds(120);
    await h.poll();
    const lines = h.events();
    expect(lines[0]).toBe("Call status: queued");
    expect(lines.at(-1)).toBe("Call status: completed");
    expect(new Set(lines).size).toBe(lines.length);
    expect(h.kinds().filter((kind) => kind === "result")).toHaveLength(1);
  });

  it("turns an unknown dispatch into one warning result and no call line", async () => {
    const h = harness("uncertain_dispatch", { v2: false });
    await h.start("uncertain");
    await h.approve();
    await h.poll();
    h.seconds(10);
    const after = await h.poll();
    expect(after.calls[0]?.state).toBe("dispatch_unknown");
    expect(h.kinds().filter((kind) => kind === "result")).toHaveLength(1);
    expect(h.events().some((line) => line.includes("unknown"))).toBe(false);
  });

  it("answers later messages locally, with a reply that fits the case", async () => {
    const h = harness("duplicate_charge");
    await h.start("duplicate charge");
    h.run({ type: "note/added", key: KEY, text: "The order number is 1182.", reply: "Noted. I will use this on the call.", at: h.at() });
    expect(h.session().thread.slice(-2).map((item) => item.kind)).toEqual(["user", "assistant"]);
  });

  it("moves active time from before the first case into it", () => {
    let state = sessionsReducer(initialSessionsState, { type: "active/elapsed", ms: 3000 });
    const api = createFixtureCaseApi({ scenario: "duplicate_charge" });
    state = sessionsReducer(state, {
      type: "session/started",
      key: KEY,
      api,
      scenario: "duplicate_charge",
      text: "hi",
      attachments: [],
      notice: "A notice.",
      at: new Date(T0).toISOString(),
    });
    state = sessionsReducer(state, { type: "active/elapsed", ms: 2000 });
    expect(state.unassignedActiveMs).toBe(0);
    expect(state.sessions[0]?.activeMs).toBe(5000);
    expect(state.sessions[0]?.thread.map((item) => item.kind)).toEqual(["user", "assistant"]);
  });
});

describe("post-call summary", () => {
  async function completedRefund(input: { customerEmail?: string } = {}) {
    const h = harness("duplicate_charge");
    await h.start("Get a refund for a duplicate $49.99 charge from Ridgeline Outfitters", input);
    await h.approve();
    await h.poll();
    return h;
  }

  it("sends to the email on file once, when the call completes with a transcript", async () => {
    const h = await completedRefund({ customerEmail: "jordan@example.com" });
    h.seconds(10);
    await h.poll();
    expect(summaryAutoSend(h.session())).toBeNull();

    h.seconds(30);
    await h.poll();
    const callId = h.session().caseData!.calls[0]!.id;
    const target = summaryAutoSend(h.session());
    expect(target).toEqual({ callId, destination: { channel: "email", to: "jordan@example.com" } });

    // What useCaseSession does with the target.
    h.run({ type: "summary/sending", key: KEY, text: target!.destination.to, autoCallId: target!.callId });
    expect(summaryAutoSend(h.session())).toBeNull();
    const delivery = await h.api.sendSummary(h.session().caseId!, target!.destination);
    h.run({ type: "summary/sent", key: KEY, delivery });
    expect(h.session().summaryShare).toMatchObject({ status: "sent", delivery, error: null, autoSentCallId: callId });

    // Going back to the form to send elsewhere never re-triggers the automatic send for this call.
    h.run({ type: "summary/reset", key: KEY });
    expect(h.session().summaryShare).toMatchObject({ status: "idle", delivery: null, destinationText: "", autoSentCallId: callId });
    await h.poll();
    expect(summaryAutoSend(h.session())).toBeNull();
    expect(h.session().caseData!.timeline.filter((t) => t.type === "summary_sent")).toHaveLength(1);
  });

  it("stores the delivery the person sends from the form when no email is on file", async () => {
    const h = await completedRefund();
    h.seconds(30);
    await h.poll();
    expect(summaryAutoSend(h.session())).toBeNull();

    h.run({ type: "summary/edited", key: KEY, text: "+1 415 555 0123" });
    const destination = inferDestination(h.session().summaryShare.destinationText)!;
    h.run({ type: "summary/sending", key: KEY, text: "+1 415 555 0123", autoCallId: null });
    expect(h.session().summaryShare.status).toBe("sending");
    const delivery = await h.api.sendSummary(h.session().caseId!, destination);
    h.run({ type: "summary/sent", key: KEY, delivery });
    expect(h.session().summaryShare).toEqual({
      status: "sent",
      delivery,
      error: null,
      destinationText: "+1 415 555 0123",
      autoSentCallId: null,
    });
    expect(delivery).toMatchObject({ channel: "sms", to: "+1 415 555 0123", subject: null });

    // A composed message (http path, sentAt null) is "composed", not "sent".
    h.run({ type: "summary/sent", key: KEY, delivery: { ...delivery, sentAt: null } });
    expect(h.session().summaryShare.status).toBe("composed");

    h.run({ type: "summary/failed", key: KEY, error: toUiError(new ApiRequestError(409, "CALL_NOT_COMPLETE", "The call has not finished yet.")) });
    expect(h.session().summaryShare).toMatchObject({ status: "error", error: { message: "The call has not finished yet." } });
  });
});
