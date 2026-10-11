import { describe, expect, it } from "vitest";
import {
  JOIN_NOTE,
  JOIN_WINDOW_MS,
  LEAVE_NOTE,
  runCall,
  type CallRun,
  type CallScript,
  type Intervention,
} from "../fixture-engine/call-run";

const phases = (run: CallRun): string[] =>
  run.events.flatMap((e) => (e.kind === "phase" ? [`${e.at} ${e.phase}`] : []));
const notes = (run: CallRun): string[] => run.events.flatMap((e) => (e.kind === "note" ? [`${e.at} ${e.text}`] : []));
const kinds = (run: CallRun): string[] => run.events.map((e) => e.kind);

const BASIC: CallScript = {
  steps: [
    { at: 0, phase: "dialing" },
    { at: 1_000, phase: "ringing" },
    { at: 2_000, phase: "navigating_menu" },
    { at: 3_000, phase: "on_hold", note: "Hold music." },
    { at: 5_000, phase: "talking", counterpart: { who: "human", confidence: 0.8 }, note: "A person answered." },
    { at: 8_000, phase: "ended" },
  ],
  gate: null,
};

const GATED: CallScript = {
  steps: [
    { at: 0, phase: "dialing" },
    { at: 1_000, phase: "talking", counterpart: { who: "agent", confidence: 0.9 } },
    { at: 2_000, note: "Asked about the visit." },
  ],
  gate: {
    at: 2_000,
    question: "Accept the visit?",
    options: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ],
    defaultOptionId: "no",
    timeoutMs: 5_000,
    after: {
      yes: [
        { at: 3_000, note: "Confirmed." },
        { at: 4_000, phase: "ended" },
      ],
      no: [
        { at: 3_500, note: "Declined." },
        { at: 6_000, phase: "ended" },
      ],
    },
  },
};

describe("runCall: a plain script", () => {
  it("replays the script up to the requested time", () => {
    const early = runCall(BASIC, [], 1_500);
    expect(early).toMatchObject({ phase: "ringing", counterpart: "unknown", counterpartConfidence: 0, endedAt: null });
    expect(phases(early)).toEqual(["1000 ringing"]);

    const talking = runCall(BASIC, [], 6_000);
    expect(talking).toMatchObject({ phase: "talking", counterpart: "human", counterpartConfidence: 0.8, holdMs: 3_000 });
    expect(notes(talking)).toEqual(["3000 Hold music.", "5000 A person answered."]);
  });

  it("ends at the end step and adds nothing afterwards", () => {
    const ended = runCall(BASIC, [], 8_000);
    expect(ended).toMatchObject({ phase: "ended", endedAt: 8_000, pendingDecision: null, joined: false });
    expect(runCall(BASIC, [], 3_600_000)).toEqual(ended);
  });

  it("is a pure function of script, interventions and time", () => {
    const interventions: Intervention[] = [{ kind: "join", at: 6_000 }];
    expect(runCall(BASIC, interventions, 30_000)).toEqual(runCall(BASIC, interventions, 30_000));
  });
});

describe("runCall: decision gate", () => {
  it("raises the prompt after the steps at the same time and waits for the user", () => {
    const run = runCall(GATED, [], 2_000);
    expect(run.phase).toBe("waiting_for_user");
    expect(run.pendingDecision).toEqual({ raisedAt: 2_000, expiresAt: 7_000 });
    expect(kinds(run).slice(-2)).toEqual(["note", "decision_raised"]);
    expect(runCall(GATED, [], 6_999).events).toEqual(run.events);
  });

  it("applies the default when the prompt expires and resumes the script from the gate", () => {
    const run = runCall(GATED, [], 7_000);
    expect(run).toMatchObject({ phase: "talking", pendingDecision: null, resolution: { optionId: "no", by: "default", at: 7_000 } });
    expect(notes(run).at(-1)).toBe('7000 No answer before the deadline. Went with the default: "No".');
    expect(notes(runCall(GATED, [], 8_499))).not.toContain("8500 Declined.");
    expect(notes(runCall(GATED, [], 8_500))).toContain("8500 Declined.");
    expect(runCall(GATED, [], 11_000)).toMatchObject({ phase: "ended", endedAt: 11_000 });
  });

  it("follows the user's answer", () => {
    const run = runCall(GATED, [{ kind: "answer", at: 3_000, optionId: "yes" }], 10_000);
    expect(run.resolution).toEqual({ optionId: "yes", by: "user", at: 3_000 });
    expect(notes(run)).toEqual(['2000 Asked about the visit.', '3000 You chose "Yes".', "4000 Confirmed."]);
    expect(run).toMatchObject({ phase: "ended", endedAt: 5_000 });
  });

  it("lets the default win a tie with an answer at the deadline", () => {
    const run = runCall(GATED, [{ kind: "answer", at: 7_000, optionId: "yes" }], 20_000);
    expect(run.resolution).toEqual({ optionId: "no", by: "default", at: 7_000 });
    expect(notes(run)).toContain("8500 Declined.");
    expect(notes(run)).not.toContain("8000 Confirmed.");
  });

  it("ignores an answer when no prompt is pending", () => {
    const run = runCall(GATED, [{ kind: "answer", at: 1_500, optionId: "yes" }], 2_500);
    expect(run).toMatchObject({ phase: "waiting_for_user", resolution: null });
  });
});

const TAGGED: CallScript = {
  steps: [
    { at: 0, phase: "dialing" },
    { at: 1_000, phase: "ringing", step: "reach" },
    { at: 3_000, phase: "talking", step: "explain" },
    { at: 4_000, note: "Asked.", step: "ask" },
    { at: 6_000, phase: "ended", step: "record" },
  ],
  gate: null,
};

describe("runCall: plan steps", () => {
  it("tracks the plan step the script entered last", () => {
    expect(runCall(TAGGED, [], 500).stepId).toBeNull();
    expect(runCall(TAGGED, [], 1_000).stepId).toBe("reach");
    expect(runCall(TAGGED, [], 3_500).stepId).toBe("explain");
    expect(runCall(TAGGED, [], 4_000).stepId).toBe("ask");
    expect(runCall(TAGGED, [], 6_000)).toMatchObject({ phase: "ended", stepId: "record" });
  });

  it("keeps the step while the user is on the line and moves on after they hand back", () => {
    const join: Intervention[] = [{ kind: "join", at: 3_500 }];
    expect(runCall(TAGGED, join, 10_000)).toMatchObject({ phase: "user_joined", stepId: "explain" });
    expect(runCall(TAGGED, join, 23_999).stepId).toBe("explain");
    expect(runCall(TAGGED, join, 24_000)).toMatchObject({ phase: "talking", stepId: "ask" });
  });
});

describe("runCall: stepping in", () => {
  it("lets the user step in while dialing and resumes the script where it stopped", () => {
    const join: Intervention[] = [{ kind: "join", at: 500 }];
    const joined = runCall(BASIC, join, 500);
    expect(joined).toMatchObject({ phase: "user_joined", joined: true });
    expect(notes(joined).at(-1)).toBe(`500 ${JOIN_NOTE}`);
    expect(runCall(BASIC, join, 20_499)).toMatchObject({ phase: "user_joined", joined: true });
    // Nothing in the script moved on while the user was on the line.
    expect(phases(runCall(BASIC, join, 20_499))).toEqual([]);

    const back = runCall(BASIC, join, 20_500);
    expect(back).toMatchObject({ phase: "dialing", joined: false });
    expect(notes(back).at(-1)).toBe(`20500 ${LEAVE_NOTE}`);
    // Half a second of dialing was left when the user stepped in.
    expect(runCall(BASIC, join, 20_999).phase).toBe("dialing");
    expect(runCall(BASIC, join, 21_000).phase).toBe("ringing");
    expect(runCall(BASIC, join, 28_000)).toMatchObject({ phase: "ended", endedAt: 28_000 });
  });

  it("lets the user step in while ringing", () => {
    const run = runCall(BASIC, [{ kind: "join", at: 1_500 }], 2_000);
    expect(run).toMatchObject({ phase: "user_joined", joined: true });
    expect(runCall(BASIC, [{ kind: "join", at: 1_500 }], 22_000).phase).toBe("navigating_menu");
  });

  it("pauses the script while the user is on the line, then hands back to the agent", () => {
    expect(JOIN_WINDOW_MS).toBe(20_000);
    const join: Intervention[] = [{ kind: "join", at: 6_000 }];
    const joined = runCall(BASIC, join, 6_000);
    expect(joined).toMatchObject({ phase: "user_joined", joined: true });
    expect(notes(joined).at(-1)).toBe(`6000 ${JOIN_NOTE}`);
    expect(runCall(BASIC, join, 25_999)).toMatchObject({ phase: "user_joined", endedAt: null });

    const back = runCall(BASIC, join, 26_000);
    expect(back).toMatchObject({ phase: "talking", joined: false });
    expect(notes(back).at(-1)).toBe(`26000 ${LEAVE_NOTE}`);
    // Two seconds of script were left when the user joined.
    expect(runCall(BASIC, join, 27_999).phase).toBe("talking");
    expect(runCall(BASIC, join, 28_000)).toMatchObject({ phase: "ended", endedAt: 28_000 });
  });

  it("ignores a second join while the user is already on the line", () => {
    const run = runCall(BASIC, [{ kind: "join", at: 6_000 }, { kind: "join", at: 10_000 }], 26_000);
    expect(kinds(run).filter((k) => k === "joined")).toHaveLength(1);
    expect(run.phase).toBe("talking");
  });

  it("delays the prompt when the user joins before it", () => {
    const run = runCall(GATED, [{ kind: "join", at: 1_500 }], 22_000);
    expect(run.pendingDecision).toEqual({ raisedAt: 22_000, expiresAt: 27_000 });
  });

  it("stays paused when the prompt expires while the user is on the line", () => {
    const interventions: Intervention[] = [{ kind: "join", at: 3_000 }];
    const expired = runCall(GATED, interventions, 7_000);
    expect(expired).toMatchObject({
      phase: "user_joined",
      pendingDecision: null,
      resolution: { optionId: "no", by: "default", at: 7_000 },
    });
    expect(notes(runCall(GATED, interventions, 22_999))).not.toContain("24500 Declined.");
    const resumed = runCall(GATED, interventions, 24_500);
    expect(notes(resumed).slice(-2)).toEqual([`23000 ${LEAVE_NOTE}`, "24500 Declined."]);
    expect(runCall(GATED, interventions, 27_000)).toMatchObject({ phase: "ended", endedAt: 27_000 });
  });

  it("hands the call back when the user answers while on the line", () => {
    const run = runCall(
      GATED,
      [
        { kind: "join", at: 3_000 },
        { kind: "answer", at: 4_000, optionId: "yes" },
      ],
      4_000,
    );
    expect(run).toMatchObject({ phase: "talking", joined: false, resolution: { by: "user", optionId: "yes" } });
    expect(kinds(run).slice(-4)).toEqual(["decision_resolved", "note", "left", "note"]);
    expect(runCall(GATED, [{ kind: "join", at: 3_000 }, { kind: "answer", at: 4_000, optionId: "yes" }], 6_000))
      .toMatchObject({ phase: "ended", endedAt: 6_000 });
  });
});

describe("runCall: spoken lines", () => {
  const SPOKEN: CallScript = {
    steps: [
      { at: 0, phase: "dialing" },
      { at: 1_000, phase: "talking", counterpart: { who: "human", confidence: 0.8 } },
      { at: 1_500, say: { speaker: "support", text: "Billing, this is Sam." } },
      { at: 2_500, say: { speaker: "agent", text: "Hi Sam. I'm calling about a duplicate charge." } },
      { at: 4_000, say: { speaker: "support", text: "I can see it." } },
      { at: 6_000, phase: "ended" },
    ],
    gate: null,
  };
  const lines = (run: CallRun): string[] => run.turns.map((t) => `${t.at} ${t.speaker}: ${t.text}`);

  it("emits each line as a turn event, in order, at its script time", () => {
    expect(lines(runCall(SPOKEN, [], 2_000))).toEqual(["1500 support: Billing, this is Sam."]);
    const done = runCall(SPOKEN, [], 10_000);
    expect(lines(done)).toEqual([
      "1500 support: Billing, this is Sam.",
      "2500 agent: Hi Sam. I'm calling about a duplicate charge.",
      "4000 support: I can see it.",
    ]);
    const events = done.events.flatMap((e) => (e.kind === "turn" ? [`${e.at} ${e.speaker}`] : []));
    expect(events).toEqual(["1500 support", "2500 agent", "4000 support"]);
  });

  it("holds the next line while the user is on the call and plays it after the hand back", () => {
    const joins: Intervention[] = [{ kind: "join", at: 2_000 }];
    const joined = runCall(SPOKEN, joins, 2_000 + JOIN_WINDOW_MS - 1);
    expect(joined.joined).toBe(true);
    expect(lines(joined)).toEqual(["1500 support: Billing, this is Sam."]);
    // Script time resumes at 2 s when the window ends, so the agent's line lands 0.5 s later.
    const resumed = runCall(SPOKEN, joins, 2_000 + JOIN_WINDOW_MS + 500);
    expect(lines(resumed).at(-1)).toBe(`${2_500 + JOIN_WINDOW_MS} agent: Hi Sam. I'm calling about a duplicate charge.`);
  });

  it("plays the default branch's lines when nobody answers and the chosen branch's when someone does", () => {
    const gated: CallScript = {
      ...GATED,
      gate: {
        ...GATED.gate!,
        after: { yes: [{ at: 2_500, say: { speaker: "agent", text: "They accept." } }], no: [{ at: 2_500, say: { speaker: "agent", text: "They decline." } }] },
        afterByDefault: { no: [{ at: 2_500, say: { speaker: "agent", text: "I could not reach them in time." } }] },
      },
    };
    const byDefault = runCall(gated, [], 2_000 + 5_000 + 1_000);
    expect(byDefault.resolution).toMatchObject({ optionId: "no", by: "default" });
    expect(byDefault.turns.map((t) => t.text)).toEqual(["I could not reach them in time."]);
    const byUser = runCall(gated, [{ kind: "answer", at: 3_000, optionId: "no" }], 5_000);
    expect(byUser.turns.map((t) => t.text)).toEqual(["They decline."]);
  });
});
