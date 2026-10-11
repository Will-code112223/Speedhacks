import { describe, expect, it } from "vitest";
import { randomUuid } from "../uuid";
import { isCaseV1, isLiveCallV2 } from "../validate";
import { failureOf, iso, noteTexts, startedCall, T0 } from "./support";

const DEFAULT_LABEL = "Decide with the adjuster";
const CLAIM_QUOTE =
  "I've opened the claim. Your claim number is 1002-48-7731. An adjuster will be assigned and will call Jordan within one business day.";

describe("insurance_claim call", () => {
  it("plays the menu, the automated assistant, hold and the rep, then applies the default when nobody answers", async () => {
    const { api, caseId, live, caseAt } = await startedCall("insurance_claim");

    expect(await live(0)).toMatchObject({
      phase: "dialing",
      counterpart: "unknown",
      calling: { name: "AAA claims line", phone: "+19495200007" },
      startedAt: iso(T0),
      endedAt: null,
    });
    expect((await caseAt(0)).calls[0]?.state).toBe("queued");
    expect((await live(1)).phase).toBe("ringing");

    expect((await live(3)).phase).toBe("navigating_menu");
    expect(noteTexts(await live(6))).toContain("Pressed 1 to report a new claim.");

    const assistant = await live(7);
    expect(assistant).toMatchObject({ phase: "talking", counterpart: "agent", counterpartConfidence: 0.9, holdSeconds: 4 });
    expect(noteTexts(assistant).at(-1)).toBe("Automated claims assistant answered. Switching to concise mode.");
    expect((await caseAt(7)).calls[0]?.state).toBe("in_progress");

    const holding = await live(12);
    expect(holding.phase).toBe("on_hold");
    expect(holding.holdSeconds).toBe(5);
    expect((await live(13)).holdSeconds).toBe(6);

    const rep = await live(15);
    expect(rep).toMatchObject({ phase: "talking", counterpart: "human", counterpartConfidence: 0.85, holdSeconds: 8 });
    expect(noteTexts(rep).at(-1)).toBe("A claims representative answered. Back to a conversational tone.");

    const asking = await live(45);
    expect(isLiveCallV2(asking)).toBe(true);
    expect(asking.phase).toBe("waiting_for_user");
    expect(asking.pendingDecision).toMatchObject({
      question:
        "AAA can book one of its direct repair shops near you, with the work guaranteed while you own the car. Use AAA's shop?",
      defaultOptionId: "decide_later",
      expiresAt: iso(T0 + 65_000),
    });
    expect(asking.pendingDecision?.options).toEqual([
      { id: "accept", label: "Use AAA's shop", tone: "primary" },
      { id: "own_shop", label: "Choose my own shop", tone: "neutral" },
      { id: "decide_later", label: DEFAULT_LABEL, tone: "neutral" },
    ]);

    // The script waits for the user: nothing moves until the prompt expires.
    expect((await live(64)).phase).toBe("waiting_for_user");
    const defaulted = await live(65);
    expect(defaulted).toMatchObject({ phase: "talking", pendingDecision: null });
    expect(noteTexts(defaulted).at(-1)).toBe(`No answer before the deadline. Went with the default: "${DEFAULT_LABEL}".`);

    // 75.5 s of script plus the 20 s spent waiting.
    expect((await live(95.4)).phase).toBe("talking");
    const ended = await live(95.5);
    expect(ended).toMatchObject({ phase: "ended", endedAt: iso(T0 + 95_500), userJoined: false });

    const c = await caseAt(95.5);
    expect(isCaseV1(c)).toBe(true);
    expect(c.status).toBe("awaiting_response");
    expect(c.outcome).toEqual({
      decision: "requested",
      referenceNumber: "1002-48-7731",
      nextAction:
        "Upload the damage and plate photos to claim 1002-48-7731 before the adjuster calls within one business day; choose the repair shop on that call",
      paymentStatus: "unverified",
      supportingQuote: CLAIM_QUOTE,
    });
    const call = c.calls[0];
    expect(call?.state).toBe("completed");
    expect(call?.transcript?.split("\n")[0]).toBe("[SIMULATED] Fixture conversation. No phone call was placed.");
    expect(call?.transcript).toContain(`Support: ${CLAIM_QUOTE}`);
    expect(call?.transcript).toContain(
      "Agent: I couldn't reach Jordan in time, so Jordan will decide on the shop with the adjuster.",
    );
    expect(c.timeline.map((t) => t.type)).toEqual([
      "case_created",
      "facts_extracted",
      "ready_for_approval",
      "authorized",
      "call_requested",
      "call_dispatched",
      "call_in_progress",
      "counterpart_detected",
      "counterpart_detected",
      "decision_requested",
      "decision_defaulted",
      "call_completed",
      "outcome_published",
    ]);
    expect(c.timeline.filter((t) => t.type === "counterpart_detected").map((t) => t.message)).toEqual([
      "Talking to an automated agent (confidence 90%).",
      "Talking to a person (confidence 85%).",
    ]);
    expect(c.timeline.find((t) => t.type === "call_completed")?.message).toBe("Call completed (96s, simulated).");
    expect(await api.getCase(caseId)).toEqual(c);
  });

  it("tells the AAA story: policy ending 4471, the October 10 rear-end, plate 8UFJ426, the claim number and next steps", async () => {
    const { live, caseAt } = await startedCall("insurance_claim");
    await live(100);
    const transcript = (await caseAt(100)).calls[0]?.transcript ?? "";
    for (const line of [
      "Support: Thank you for calling AAA claims. To report a new claim, press 1. For an existing claim, press 2.",
      "Support: AAA claims, this is Dana. Who am I speaking with?",
      "Agent: Jordan Avery, policy ending 4471, for a red 2021 Toyota Camry.",
      "Agent: Yesterday, October 10, in San Francisco, a silver sedan rear-ended the car while it was stopped in traffic. The rear bumper and trunk are damaged. The sedan's California plate is 8UFJ426.",
      "Agent: No one was injured. Jordan photographed the damage and the other car's plate, and the photos are on file. Jordan was not at fault.",
      `Support: ${CLAIM_QUOTE}`,
      "Support: Jordan's policy has rental reimbursement at $40 a day, for up to 30 days while the car is being repaired.",
      "Support: And since the other driver hit Jordan from behind, we'll pursue their insurer. Once they accept liability, the $500 collision deductible may be waived.",
      "Support: I'm also texting Jordan a link to upload the photos to the claim.",
    ]) {
      expect(transcript.split("\n")).toContain(line);
    }
  });

  it("relays the user's answer and publishes the outcome that answer supports", async () => {
    const { api, caseId, callId, live, caseAt } = await startedCall("insurance_claim");
    const decision = (await live(46)).pendingDecision;
    if (decision === null) throw new Error("Expected a pending decision at 46 s.");

    const answered = await api.answerDecision(caseId, callId, decision.id, "accept");
    expect(answered).toMatchObject({ phase: "talking", pendingDecision: null });
    expect(noteTexts(answered).at(-1)).toBe('You chose "Use AAA\'s shop".');

    // Script time resumes at 45 s when answered at 46 s, so the call ends 30.5 s later.
    expect((await live(76.4)).phase).toBe("talking");
    expect((await live(76.5)).phase).toBe("ended");
    const c = await caseAt(76.5);
    expect(c.status).toBe("awaiting_response");
    expect(c.outcome).toEqual({
      decision: "requested",
      referenceNumber: "1002-48-7731",
      nextAction:
        "Upload the damage and plate photos to claim 1002-48-7731 before the adjuster calls within one business day; the direct repair shop will call to schedule the repair",
      paymentStatus: "unverified",
      supportingQuote: CLAIM_QUOTE,
    });
    expect(c.timeline.find((t) => t.type === "decision_answered")?.message).toBe("You answered: Use AAA's shop.");
    expect(c.calls[0]?.transcript).toContain("Agent: Jordan would like one of your direct repair shops.");
    expect(c.calls[0]?.transcript).toContain(
      "Agent: To confirm: claim 1002-48-7731, an adjuster call within one business day, the repair at your direct repair shop, and rental at $40 a day. The $500 deductible may be waived once the other insurer accepts liability.",
    );
  });

  it("rejects unknown, invalid and repeated answers", async () => {
    const { api, caseId, callId, live } = await startedCall("insurance_claim");
    const decision = (await live(46)).pendingDecision;
    if (decision === null) throw new Error("Expected a pending decision at 46 s.");

    expect(await failureOf(api.answerDecision(caseId, callId, randomUuid(), "accept"))).toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
    expect(await failureOf(api.answerDecision(caseId, callId, decision.id, "maybe_later"))).toMatchObject({
      status: 400,
      fields: ["optionId"],
    });
    await api.answerDecision(caseId, callId, decision.id, "own_shop");
    expect(await failureOf(api.answerDecision(caseId, callId, decision.id, "accept"))).toMatchObject({
      status: 409,
      code: "DECISION_RESOLVED",
    });
  });

  it("rejects an answer that arrives after the default applied", async () => {
    const { api, caseId, callId, live } = await startedCall("insurance_claim");
    const decision = (await live(50)).pendingDecision;
    if (decision === null) throw new Error("Expected a pending decision at 50 s.");
    await live(65.5);
    expect(await failureOf(api.answerDecision(caseId, callId, decision.id, "accept"))).toMatchObject({
      status: 409,
      code: "DECISION_RESOLVED",
    });
  });

  it("keeps derived timeline ids stable between polls", async () => {
    const { caseAt } = await startedCall("insurance_claim");
    const early = await caseAt(20);
    const late = await caseAt(95.5);
    expect(late.timeline.slice(0, early.timeline.length)).toEqual(early.timeline);
    expect(new Set(late.timeline.map((t) => t.id)).size).toBe(late.timeline.length);
    const times = late.timeline.map((t) => Date.parse(t.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("scales every scripted duration by speed", async () => {
    const { live, caseAt } = await startedCall("insurance_claim", { speed: 4 });
    expect(await live(3.75)).toMatchObject({ phase: "talking", counterpart: "human", holdSeconds: 2 });
    expect(await live(11.25)).toMatchObject({
      phase: "waiting_for_user",
      pendingDecision: { expiresAt: iso(T0 + 16_250) },
    });
    expect((await live(16.25)).phase).toBe("talking");
    expect((await live(23.875)).phase).toBe("ended");
    expect((await caseAt(23.875)).status).toBe("awaiting_response");
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
    clock.at(46);
    const joined = await api.stepIn(caseId, callId);
    expect(joined).toMatchObject({ phase: "user_joined", userJoined: true });
    const decision = joined.pendingDecision;
    if (decision === null) throw new Error("The decision should stay pending while the user is on the call.");

    clock.at(48);
    const answered = await api.answerDecision(caseId, callId, decision.id, "accept");
    expect(answered).toMatchObject({ phase: "talking", userJoined: false, pendingDecision: null });
    expect(noteTexts(answered).slice(-2)).toEqual(['You chose "Use AAA\'s shop".', LEAVE_TEXT]);
    expect((await live(78.4)).phase).toBe("talking");
    expect((await live(78.5)).phase).toBe("ended");
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

  it("moves through the five-step AAA claim plan and asks about the shop within its last step", async () => {
    const { live } = await startedCall("insurance_claim");
    const start = await live(0);
    expect(start.progress?.steps.map((s) => [s.title, s.detail])).toEqual([
      ["Reach AAA claims", "Phone menu, then hold for a claims rep."],
      ["Verify the policy", "Jordan Avery, policy ending 4471, from the declarations page."],
      ["Report the loss", "Oct 10 rear-end, plate 8UFJ426, photos on file, no injuries."],
      ["Get a claim number and adjuster", "A claim number now, an adjuster within one business day."],
      ["Confirm next steps", "Repair shop, rental car and the deductible."],
    ]);
    expect(statuses(start.progress)).toEqual(["reach:current", "verify:upcoming", "report:upcoming", "claim:upcoming", "next:upcoming"]);
    // The menu, the automated assistant and the hold all belong to reaching the claims line.
    expect(statuses((await live(12)).progress)).toEqual(["reach:current", "verify:upcoming", "report:upcoming", "claim:upcoming", "next:upcoming"]);
    expect(statuses((await live(15)).progress)).toEqual(["reach:done", "verify:current", "report:upcoming", "claim:upcoming", "next:upcoming"]);
    expect(statuses((await live(27)).progress)).toEqual(["reach:done", "verify:done", "report:current", "claim:upcoming", "next:upcoming"]);
    expect(statuses((await live(40)).progress)).toEqual(["reach:done", "verify:done", "report:done", "claim:current", "next:upcoming"]);
    const asking = await live(45);
    expect(asking.phase).toBe("waiting_for_user");
    expect(statuses(asking.progress)).toEqual(["reach:done", "verify:done", "report:done", "claim:done", "next:current"]);
    expect(statuses((await live(80)).progress)).toEqual(["reach:done", "verify:done", "report:done", "claim:done", "next:current"]);
    expect(statuses((await live(95.5)).progress)).toEqual(["reach:done", "verify:done", "report:done", "claim:done", "next:done"]);
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
    expect(await caseAt(95.5)).toMatchObject({
      status: "awaiting_response",
      outcome: { decision: "requested", referenceNumber: "1002-48-7731" },
    });
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

  it("speaks the answer the user chose, then the next steps, matching the final transcript", async () => {
    const { api, caseId, callId, live, caseAt } = await startedCall("insurance_claim");
    expect(asLines((await live(8)).turns).at(-1)).toBe(
      "Support: This is the automated claims assistant. Please enter the policy number, then press pound.",
    );
    expect(asLines((await live(16)).turns).at(-1)).toBe("Support: AAA claims, this is Dana. Who am I speaking with?");
    const decision = (await live(46)).pendingDecision;
    if (decision === null) throw new Error("Expected a pending decision at 46 s.");
    await api.answerDecision(caseId, callId, decision.id, "own_shop");
    expect(asLines((await live(47)).turns).at(-1)).toBe("Agent: Jordan will choose a repair shop.");
    const ended = await live(76.5);
    expect(ended.phase).toBe("ended");
    expect(asLines(ended.turns)).toContain(
      "Support: That's fine. Once a shop is chosen, have them send their estimate to the adjuster.",
    );
    expect((await caseAt(76.5)).calls[0]?.transcript).toBe([MARKER, ...asLines(ended.turns)].join("\n"));
  });

  it("says it could not reach the user in time when the default applied", async () => {
    const { live, caseAt } = await startedCall("insurance_claim");
    const ended = await live(100);
    expect(ended.phase).toBe("ended");
    expect(asLines(ended.turns)).toContain(
      "Agent: I couldn't reach Jordan in time, so Jordan will decide on the shop with the adjuster.",
    );
    expect((await caseAt(100)).calls[0]?.transcript).toBe([MARKER, ...asLines(ended.turns)].join("\n"));
  });
});
