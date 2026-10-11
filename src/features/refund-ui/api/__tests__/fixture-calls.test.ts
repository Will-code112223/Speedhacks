import { describe, expect, it } from "vitest";
import { randomUuid } from "../uuid";
import { isCaseV1, isLiveCallV2 } from "../validate";
import { failureOf, iso, noteTexts, startedCall, T0 } from "./support";

const DEFAULT_LABEL = "Ask for other times";

describe("insurance_claim call", () => {
  it("plays dialing, menu, hold and the automated agent, then applies the default when nobody answers", async () => {
    const { api, caseId, live, caseAt } = await startedCall("insurance_claim");

    expect(await live(0)).toMatchObject({ phase: "dialing", counterpart: "unknown", startedAt: iso(T0), endedAt: null });
    expect((await caseAt(0)).calls[0]?.state).toBe("queued");

    expect((await live(4)).phase).toBe("navigating_menu");
    expect(noteTexts(await live(5))).toContain("Pressed 2 for existing claims");

    const holding = await live(12);
    expect(holding.phase).toBe("on_hold");
    expect(holding.holdSeconds).toBe(9);
    expect((await live(13)).holdSeconds).toBe(10);
    expect((await caseAt(12)).calls[0]?.state).toBe("in_progress");

    const answered = await live(17);
    expect(answered).toMatchObject({ phase: "talking", counterpart: "agent", counterpartConfidence: 0.9, holdSeconds: 14 });
    expect(noteTexts(answered).at(-1)).toBe("Automated claims assistant answered. Switching to concise mode.");

    const asking = await live(24);
    expect(isLiveCallV2(asking)).toBe(true);
    expect(asking.phase).toBe("waiting_for_user");
    expect(asking.pendingDecision).toMatchObject({
      question:
        "The claims line can open the claim now but asks to schedule an adjuster visit on Tuesday 10 to 12. Accept?",
      defaultOptionId: "ask_for_other_times",
      expiresAt: iso(T0 + 44_000),
    });
    expect(asking.pendingDecision?.options).toEqual([
      { id: "accept", label: "Accept Tuesday 10 to 12", tone: "primary" },
      { id: "ask_for_other_times", label: DEFAULT_LABEL, tone: "neutral" },
      { id: "decline", label: "Decline the visit", tone: "danger" },
    ]);

    // The script waits for the user: nothing moves until the prompt expires.
    expect((await live(43)).phase).toBe("waiting_for_user");
    const defaulted = await live(44);
    expect(defaulted).toMatchObject({ phase: "talking", pendingDecision: null });
    expect(noteTexts(defaulted).at(-1)).toBe(`No answer before the deadline. Went with the default: "${DEFAULT_LABEL}".`);

    // 45 s of script plus the 20 s spent waiting.
    expect((await live(64)).phase).toBe("talking");
    const ended = await live(65);
    expect(ended).toMatchObject({ phase: "ended", endedAt: iso(T0 + 65_000), userJoined: false });

    const c = await caseAt(65);
    expect(isCaseV1(c)).toBe(true);
    expect(c.status).toBe("awaiting_response");
    expect(c.outcome).toEqual({
      decision: "requested",
      referenceNumber: "NWM-2026-48213",
      nextAction: "A scheduler will call to book the adjuster visit; upload photos of the damage before then",
      paymentStatus: "unverified",
      supportingQuote: "Your claim NWM-2026-48213 is open. A scheduler will call to book the adjuster visit.",
    });
    const call = c.calls[0];
    expect(call?.state).toBe("completed");
    expect(call?.transcript?.split("\n")[0]).toBe("[SIMULATED] Fixture conversation. No phone call was placed.");
    expect(call?.transcript).toContain("Agent: I could not confirm Tuesday with Jordan Avery in time.");
    expect(c.timeline.map((t) => t.type)).toEqual([
      "case_created",
      "facts_extracted",
      "ready_for_approval",
      "authorized",
      "call_requested",
      "call_dispatched",
      "call_in_progress",
      "counterpart_detected",
      "decision_requested",
      "decision_defaulted",
      "call_completed",
      "outcome_published",
    ]);
    expect(c.timeline.find((t) => t.type === "call_completed")?.message).toBe("Call completed (65s, simulated).");
    expect(await api.getCase(caseId)).toEqual(c);
  });

  it("relays the user's answer and publishes the outcome that answer supports", async () => {
    const { api, caseId, callId, live, caseAt } = await startedCall("insurance_claim");
    const decision = (await live(26)).pendingDecision;
    if (decision === null) throw new Error("Expected a pending decision at 26 s.");

    const answered = await api.answerDecision(caseId, callId, decision.id, "accept");
    expect(answered).toMatchObject({ phase: "talking", pendingDecision: null });
    expect(noteTexts(answered).at(-1)).toBe('You chose "Accept Tuesday 10 to 12".');

    // Script time resumes at 24 s when answered at 26 s, so the call ends 21 s later.
    expect((await live(46.9)).phase).toBe("talking");
    expect((await live(47)).phase).toBe("ended");
    const c = await caseAt(47);
    expect(c.status).toBe("awaiting_response");
    expect(c.outcome).toEqual({
      decision: "requested",
      referenceNumber: "NWM-2026-48213",
      nextAction: "Adjuster visit Tuesday 10-12; upload photos of the damage before then",
      paymentStatus: "unverified",
      supportingQuote: "Your claim NWM-2026-48213 is open and an adjuster visit is scheduled.",
    });
    expect(c.timeline.find((t) => t.type === "decision_answered")?.message).toBe(
      "You answered: Accept Tuesday 10 to 12.",
    );
    expect(c.calls[0]?.transcript).toContain("Agent: Jordan Avery accepts Tuesday from 10 to 12.");
  });

  it("rejects unknown, invalid and repeated answers", async () => {
    const { api, caseId, callId, live } = await startedCall("insurance_claim");
    const decision = (await live(25)).pendingDecision;
    if (decision === null) throw new Error("Expected a pending decision at 25 s.");

    expect(await failureOf(api.answerDecision(caseId, callId, randomUuid(), "accept"))).toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
    expect(await failureOf(api.answerDecision(caseId, callId, decision.id, "maybe_later"))).toMatchObject({
      status: 400,
      fields: ["optionId"],
    });
    await api.answerDecision(caseId, callId, decision.id, "decline");
    expect(await failureOf(api.answerDecision(caseId, callId, decision.id, "accept"))).toMatchObject({
      status: 409,
      code: "DECISION_RESOLVED",
    });
  });

  it("rejects an answer that arrives after the default applied", async () => {
    const { api, caseId, callId, live } = await startedCall("insurance_claim");
    const decision = (await live(30)).pendingDecision;
    if (decision === null) throw new Error("Expected a pending decision at 30 s.");
    await live(44.5);
    expect(await failureOf(api.answerDecision(caseId, callId, decision.id, "accept"))).toMatchObject({
      status: 409,
      code: "DECISION_RESOLVED",
    });
  });

  it("keeps derived timeline ids stable between polls", async () => {
    const { caseAt } = await startedCall("insurance_claim");
    const early = await caseAt(20);
    const late = await caseAt(65);
    expect(late.timeline.slice(0, early.timeline.length)).toEqual(early.timeline);
    expect(new Set(late.timeline.map((t) => t.id)).size).toBe(late.timeline.length);
    const times = late.timeline.map((t) => Date.parse(t.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("scales every scripted duration by speed", async () => {
    const { live, caseAt } = await startedCall("insurance_claim", { speed: 4 });
    expect(await live(4.25)).toMatchObject({ phase: "talking", holdSeconds: 3 });
    expect(await live(6)).toMatchObject({
      phase: "waiting_for_user",
      pendingDecision: { expiresAt: iso(T0 + 11_000) },
    });
    expect((await live(11)).phase).toBe("talking");
    expect((await live(16.25)).phase).toBe("ended");
    expect((await caseAt(16.25)).status).toBe("awaiting_response");
  });
});

const JOIN_TEXT = "You stepped in. The agent is paused and takes over again when you hand back.";
const LEAVE_TEXT = "You handed back. The agent took over the call again.";

describe("stepping into a call", () => {
  it("lets the user step in while dialing and pauses the script until they hand back", async () => {
    const { api, caseId, callId, live, clock } = await startedCall("duplicate_charge");

    clock.at(1);
    const joined = await api.stepIn(caseId, callId);
    expect(joined).toMatchObject({ phase: "user_joined", userJoined: true });
    expect(noteTexts(joined).at(-1)).toBe(JOIN_TEXT);
    expect(joined.progress?.steps.map((s) => s.status)).toEqual(["paused", "upcoming", "upcoming", "upcoming", "upcoming"]);

    // The script stopped at 1 s: ringing (2 s of script) does not start while the user is on the line.
    expect((await live(20.9)).phase).toBe("user_joined");
    const resumed = await live(21);
    expect(resumed).toMatchObject({ phase: "dialing", userJoined: false });
    expect(noteTexts(resumed).at(-1)).toBe(LEAVE_TEXT);
    expect(resumed.progress?.steps[0]?.status).toBe("current");
    expect((await live(21.9)).phase).toBe("dialing");
    expect((await live(22)).phase).toBe("ringing");
    expect((await live(49.9)).phase).toBe("talking");
    expect((await live(50)).phase).toBe("ended");
  });

  it("pauses the script while the user is on the line and resumes after the join window", async () => {
    const { api, caseId, callId, live, caseAt, clock } = await startedCall("duplicate_charge");
    const explained = "Explained the duplicate $49.99 charge and asked for a refund of the second one.";

    clock.at(12);
    const joined = await api.stepIn(caseId, callId);
    expect(joined).toMatchObject({ phase: "user_joined", userJoined: true });
    expect(noteTexts(joined).at(-1)).toBe(JOIN_TEXT);
    expect(joined.progress?.steps.map((s) => [s.id, s.status])).toEqual([
      ["reach", "done"],
      ["explain", "paused"],
      ["ask", "upcoming"],
      ["confirm", "upcoming"],
      ["record", "upcoming"],
    ]);
    expect((await api.stepIn(caseId, callId)).notes).toEqual(joined.notes);

    const stillJoined = await live(31.9);
    expect(stillJoined.phase).toBe("user_joined");
    expect(stillJoined.notes).toEqual(joined.notes);

    const resumed = await live(32);
    expect(resumed).toMatchObject({ phase: "talking", userJoined: false });
    expect(noteTexts(resumed).at(-1)).toBe(LEAVE_TEXT);
    expect(resumed.progress?.steps[1]).toMatchObject({ id: "explain", status: "current" });
    // The script picks up at 12 s, so the 14 s note lands at 34 s and the 30 s end at 50 s.
    expect(noteTexts(await live(33.9))).not.toContain(explained);
    expect(noteTexts(await live(34))).toContain(explained);
    expect((await live(49.9)).phase).toBe("talking");
    expect((await live(50)).phase).toBe("ended");

    clock.at(51);
    expect(await failureOf(api.stepIn(caseId, callId))).toMatchObject({ status: 409, code: "CALL_ENDED" });
    const c = await caseAt(51);
    expect(c.status).toBe("approved");
    expect(c.timeline.map((t) => t.type)).toEqual(expect.arrayContaining(["user_joined_call", "user_left_call"]));
  });

  it("hands the call back to the agent when the user answers a pending decision", async () => {
    const { api, caseId, callId, live, clock } = await startedCall("insurance_claim");
    clock.at(25);
    const joined = await api.stepIn(caseId, callId);
    expect(joined).toMatchObject({ phase: "user_joined", userJoined: true });
    const decision = joined.pendingDecision;
    if (decision === null) throw new Error("The decision should stay pending while the user is on the call.");

    clock.at(27);
    const answered = await api.answerDecision(caseId, callId, decision.id, "accept");
    expect(answered).toMatchObject({ phase: "talking", userJoined: false, pendingDecision: null });
    expect(noteTexts(answered).slice(-2)).toEqual([
      'You chose "Accept Tuesday 10 to 12".',
      LEAVE_TEXT,
    ]);
    expect((await live(47.9)).phase).toBe("talking");
    expect((await live(48)).phase).toBe("ended");
  });
});

describe("the call plan", () => {
  const statuses = (plan: { steps: { id: string; status: string }[] } | null | undefined): string[] =>
    (plan?.steps ?? []).map((s) => `${s.id}:${s.status}`);

  it("moves through the duplicate charge plan as the script enters each step", async () => {
    const { live } = await startedCall("duplicate_charge");
    const start = await live(0);
    expect(isLiveCallV2(start)).toBe(true);
    expect(start.progress?.steps.map((s) => s.title)).toEqual([
      "Reach the billing team",
      "Explain the duplicate charge",
      "Ask for the refund",
      "Confirm the reference number",
      "Record the outcome",
    ]);
    expect(statuses(start.progress)).toEqual(["reach:current", "explain:upcoming", "ask:upcoming", "confirm:upcoming", "record:upcoming"]);
    expect(statuses((await live(12)).progress)).toEqual(["reach:done", "explain:current", "ask:upcoming", "confirm:upcoming", "record:upcoming"]);
    // The explanation note at 14 s is where the agent moves on to asking for the refund.
    expect(statuses((await live(15)).progress)).toEqual(["reach:done", "explain:done", "ask:current", "confirm:upcoming", "record:upcoming"]);
    expect(statuses((await live(22)).progress)).toEqual(["reach:done", "explain:done", "ask:done", "confirm:current", "record:upcoming"]);
    const ended = await live(30);
    expect(ended.phase).toBe("ended");
    expect(statuses(ended.progress)).toEqual(["reach:done", "explain:done", "ask:done", "confirm:done", "record:done"]);
  });

  it("marks the current step paused while the user is on the call and current again after", async () => {
    const { api, caseId, callId, live, clock } = await startedCall("duplicate_charge");
    clock.at(15);
    const joined = await api.stepIn(caseId, callId);
    expect(isLiveCallV2(joined)).toBe(true);
    expect(statuses(joined.progress)).toEqual(["reach:done", "explain:done", "ask:paused", "confirm:upcoming", "record:upcoming"]);
    expect(statuses((await live(35)).progress)).toEqual(["reach:done", "explain:done", "ask:current", "confirm:upcoming", "record:upcoming"]);
  });

  it("checks the adjuster visit with the user as its own step of the claim plan", async () => {
    const { live } = await startedCall("insurance_claim");
    expect(statuses((await live(18)).progress)).toEqual(["reach:done", "state:current", "decide:upcoming", "confirm:upcoming", "record:upcoming"]);
    const asking = await live(24);
    expect(asking.phase).toBe("waiting_for_user");
    expect(statuses(asking.progress)).toEqual(["reach:done", "state:done", "decide:current", "confirm:upcoming", "record:upcoming"]);
    // The default applies at 44 s; the claims line acts on it 7 s of script later.
    expect(statuses((await live(51)).progress)).toEqual(["reach:done", "state:done", "decide:done", "confirm:current", "record:upcoming"]);
    expect(statuses((await live(65)).progress)).toEqual(["reach:done", "state:done", "decide:done", "confirm:done", "record:done"]);
  });

  it("reports no live record and so no plan while a dispatch result is unknown", async () => {
    const { api, caseId, callId } = await startedCall("uncertain_dispatch");
    expect(await api.getLiveCall(caseId, callId)).toBeNull();
  });
});

describe("refund calls", () => {
  it("completes the duplicate charge with an approved refund whose payment is unverified", async () => {
    const { live, caseAt } = await startedCall("duplicate_charge");
    expect(await live(3)).toMatchObject({ phase: "ringing" });
    const talking = await live(10);
    expect(talking).toMatchObject({ phase: "talking", counterpart: "human", counterpartConfidence: 0.8, holdSeconds: 6 });
    expect(noteTexts(talking).at(-1)).toBe("A person answered.");
    expect((await caseAt(29.9)).status).toBe("calling");

    const c = await caseAt(30);
    expect(c.status).toBe("approved");
    expect(c.outcome).toEqual({
      decision: "approved",
      referenceNumber: "RO-77102",
      nextAction: "Refund expected within 5 to 7 business days. Confirm when it lands.",
      paymentStatus: "unverified",
      supportingQuote: "I've issued the refund of $49.99 to the original card, reference RO-77102",
    });
    expect(c.calls[0]?.state).toBe("completed");
    expect(c.calls[0]?.transcript).toContain(
      "Support: I've issued the refund of $49.99 to the original card, reference RO-77102.",
    );
  });

  it("completes call_complete_unconfirmed in about twelve seconds", async () => {
    const { live, caseAt } = await startedCall("call_complete_unconfirmed");
    expect((await live(11.9)).phase).toBe("talking");
    expect((await live(12)).phase).toBe("ended");
    expect(await caseAt(12)).toMatchObject({
      status: "approved",
      outcome: { decision: "approved", paymentStatus: "unverified", referenceNumber: "RO-77102" },
    });
  });
});

describe("uncertain dispatch", () => {
  it("settles in dispatch_unknown, keeps the case calling and never redials", async () => {
    const { api, caseId, callId, authorizationId, call, caseAt, clock } = await startedCall("uncertain_dispatch");
    expect(call).toMatchObject({ state: "dispatch_pending", providerCallId: null, error: null });
    expect((await caseAt(3.9)).calls[0]?.state).toBe("dispatch_pending");

    const c = await caseAt(4);
    expect(c.status).toBe("calling");
    expect(c.calls[0]).toMatchObject({
      state: "dispatch_unknown",
      error: "Dial may have received this call request. Do not redial; reconcile the stored attempt first.",
    });
    expect(c.outcome.decision).toBe("unknown");
    expect(c.outcome.nextAction).toContain("will not redial automatically");
    expect(c.timeline.at(-1)).toMatchObject({ type: "call_dispatch_unknown" });
    expect(await api.getLiveCall(caseId, callId)).toBeNull();

    const repeat = await api.startCall(caseId, { authorizationId, requestId: randomUuid() });
    expect(repeat).toMatchObject({ id: callId, state: "dispatch_unknown" });
    expect(await failureOf(api.patchCase(caseId, 1, { amountMinor: 100 }))).toMatchObject({ code: "CALL_IN_PROGRESS" });
    expect(await failureOf(api.authorize(caseId, 1))).toMatchObject({ code: "CALL_IN_PROGRESS" });
    expect(await failureOf(api.stepIn(caseId, callId))).toMatchObject({ status: 409, code: "CALL_NOT_CONNECTED" });

    clock.at(3_600);
    const hourLater = await api.getCase(caseId);
    expect(hourLater.status).toBe("calling");
    expect(hourLater.calls).toHaveLength(1);
    expect(hourLater.calls[0]?.state).toBe("dispatch_unknown");
  });
});

describe("V1-only mode", () => {
  it("reports no V2 support and still completes the call", async () => {
    const { api, caseId, callId, caseAt } = await startedCall("insurance_claim", { v2: false });
    expect(await api.capabilities()).toEqual({ liveCall: false, stepIn: false, decisions: false });
    expect(await api.getLiveCall(caseId, callId)).toBeNull();
    expect(await failureOf(api.stepIn(caseId, callId))).toMatchObject({ status: 501, code: "NOT_SUPPORTED" });
    expect(await failureOf(api.answerDecision(caseId, callId, randomUuid(), "accept"))).toMatchObject({
      status: 501,
      code: "NOT_SUPPORTED",
    });
    expect(await caseAt(65)).toMatchObject({ status: "awaiting_response", outcome: { decision: "requested" } });
  });
});

describe("the live transcript", () => {
  const MARKER = "[SIMULATED] Fixture conversation. No phone call was placed.";
  const LABEL: Record<string, string> = { support: "Support", agent: "Agent", user: "You" };
  const asLines = (turns: { speaker: string; text: string }[] | undefined): string[] =>
    (turns ?? []).map((t) => `${LABEL[t.speaker]}: ${t.text}`);

  it("grows line by line during the duplicate charge and ends as the call's transcript", async () => {
    const { live, caseAt } = await startedCall("duplicate_charge");
    expect((await live(5)).turns).toEqual([]);
    const counts: number[] = [];
    for (const seconds of [10.4, 11, 12, 14, 21, 24, 29]) counts.push((await live(seconds)).turns?.length ?? -1);
    expect(counts).toEqual([0, 1, 2, 4, 5, 6, 8]);
    const first = (await live(11)).turns?.[0];
    expect(first).toEqual({ at: iso(T0 + 10_500), speaker: "support", text: "Ridgeline Outfitters billing, this is Sam. How can I help?" });
    const ended = await live(30);
    expect(isLiveCallV2(ended)).toBe(true);
    const ats = (ended.turns ?? []).map((t) => Date.parse(t.at));
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
    expect((await caseAt(30)).calls[0]?.transcript).toBe([MARKER, ...asLines(ended.turns)].join("\n"));
  });

  it("speaks the answer the user chose, then the claim confirmation, matching the final transcript", async () => {
    const { api, caseId, callId, live, caseAt } = await startedCall("insurance_claim");
    const before = await live(18);
    expect(asLines(before.turns).at(-1)).toBe("Support: This is the automated claims assistant. How can I help?");
    const decision = (await live(26)).pendingDecision;
    if (decision === null) throw new Error("Expected a pending decision at 26 s.");
    await api.answerDecision(caseId, callId, decision.id, "decline");
    expect(asLines((await live(27)).turns).at(-1)).toBe("Agent: Jordan Avery declines the visit for now.");
    const ended = await live(47);
    expect(ended.phase).toBe("ended");
    expect((await caseAt(47)).calls[0]?.transcript).toBe([MARKER, ...asLines(ended.turns)].join("\n"));
  });

  it("says it could not confirm in time when the default applied", async () => {
    const { live, caseAt } = await startedCall("insurance_claim");
    const ended = await live(70);
    expect(ended.phase).toBe("ended");
    expect(asLines(ended.turns)).toContain(
      "Agent: I could not confirm Tuesday with Jordan Avery in time. What other times are available?",
    );
    expect((await caseAt(70)).calls[0]?.transcript).toBe([MARKER, ...asLines(ended.turns)].join("\n"));
  });
});
