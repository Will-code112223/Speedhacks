/**
 * Server-renders the screens at each stage of a fixture call, so render paths
 * that would throw or drop a required control fail here, without a browser.
 */

import { renderToString as reactRenderToString } from "react-dom/server";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RefundApp from "../RefundApp";
import { createFixtureCaseApi } from "../api/fixture";
import type { CaseApi, CaseApiCapabilities, FixtureOptions, FixtureScenario, LiveCallV2 } from "../api/types";
import CallBar from "../call/CallBar";
import CallScreen from "../call/CallScreen";
import ChatColumn from "../chat/ChatColumn";
import MetricsStrip from "../metrics/MetricsStrip";
import PlansManager from "../plans/PlansManager";
import type { PlansController } from "../plans/usePlans";
import Rail from "../rail/Rail";
import { currentCall } from "../state/call";
import type { CaseSessionController } from "../state/controller";
import { toUiError } from "../state/errors";
import { EMPTY_WORKFLOW } from "../workflow/session";
import {
  decisionForCallScreen,
  initialSessionsState,
  pendingDecision,
  sessionsReducer,
  type CaseSession,
  type SessionAction,
  type SessionsState,
} from "../state/session";

const T0 = Date.parse("2026-10-11T19:00:00.000Z");
const KEY = "case-1";

/** Server HTML without the comment markers React puts between adjacent text nodes. */
function renderToString(element: ReactElement): string {
  return reactRenderToString(element).replaceAll("<!-- -->", "");
}

// One clock for the fixture and the components (countdowns and timers read Date.now()).
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});
const V2: CaseApiCapabilities = { liveCall: true, stepIn: true, decisions: true };
const V1: CaseApiCapabilities = { liveCall: false, stepIn: false, decisions: false };
const noop = () => {};

it("never offers the legacy refund call for an unknown or insurance HTTP workflow", async () => {
  const s = stage("duplicate_charge");
  s.begin("Prepare my case");
  await s.create("Prepare my case");
  const controller = s.controller();
  controller.apiMode = "http";
  const unknown = chat(controller);
  expect(unknown).not.toContain("Approve this call");
  const current = controller.active!.caseData!;
  controller.workflow = { ...EMPTY_WORKFLOW, refresh: async () => {}, upload: async () => false, retry: async () => false, analyze: async () => false, workflow: {
    caseId: current.id, caseRevision: current.revision, kind: "auto_insurance", stage: "ready", analysisStatus: "complete", facts: {},
    messages: [], questions: [], conflicts: [], contacts: [], actions: [], updatedAt: current.updatedAt,
    brief: { title: "Prepared auto claim", body: "The user described vehicle damage. Liability is unknown.", updatedAt: current.updatedAt },
  } };
  const insurance = chat(controller);
  expect(insurance).toContain("Prepared auto claim");
  expect(insurance).not.toContain("Approve this call");
  expect(insurance).not.toContain('data-testid="case-documents"');
  expect(insurance).not.toContain("Notes are local");
});

function stage(scenario: FixtureScenario, options: Omit<FixtureOptions, "now" | "scenario"> = {}) {
  const api: CaseApi = createFixtureCaseApi({ ...options, scenario, now: () => Date.now() });
  let state: SessionsState = initialSessionsState;
  const liveCapable = options.v2 !== false;
  const at = () => new Date().toISOString();
  const run = (action: SessionAction) => {
    state = sessionsReducer(state, action);
  };
  const session = (): CaseSession => state.sessions.find((candidate) => candidate.key === KEY)!;

  return {
    api,
    run,
    session,
    seconds: (value: number) => {
      vi.setSystemTime(T0 + value * 1000);
    },
    begin(text: string) {
      run({ type: "session/started", key: KEY, api, scenario, text, attachments: ["policy.pdf"], notice: null, at: at() });
    },
    async create(text: string, extra: { supportPhone?: string } = {}) {
      const created = await api.createCase({ summary: text, ...extra });
      run({ type: "create/succeeded", key: KEY, caseData: created, liveCapable, at: at() });
    },
    async approve() {
      const current = session().caseData!;
      try {
        const authorized = await api.authorize(current.id, current.revision);
        run({ type: "approval/authorized", key: KEY, caseData: authorized, liveCapable, at: at() });
        const call = await api.startCall(current.id, { authorizationId: authorized.authorization!.id, requestId: crypto.randomUUID() });
        run({ type: "approval/dispatched", key: KEY, call, liveCapable, at: at() });
      } catch (error) {
        run({ type: "approval/failed", key: KEY, error: toUiError(error) });
      }
      await this.poll();
    },
    async poll() {
      const next = await api.getCase(session().caseId!);
      run({ type: "case/received", key: KEY, caseData: next, liveCapable, at: at() });
    },
    async live(): Promise<LiveCallV2 | null> {
      const call = currentCall(session().caseData, session().startedCall)!;
      const value = await api.getLiveCall(session().caseId!, call.id);
      if (value) run({ type: "live/received", key: KEY, live: value, at: at() });
      return value;
    },
    controller(capabilities: CaseApiCapabilities = liveCapable ? V2 : V1): CaseSessionController {
      const active = session() ?? null;
      const call = active ? currentCall(active.caseData, active.startedCall) : null;
      return {
        apiMode: "fixture",
        scenario: null,
        setScenario: noop,
        fixtureSettings: { showLoading: false, v1Only: !liveCapable },
        setFixtureSettings: noop,
        sessions: state.sessions,
        active,
        capabilities,
        call,
        live: active?.live && call && active.live.callId === call.id ? active.live : null,
        liveError: null,
        pendingDecision: pendingDecision(active),
        activeMs: 72_000,
        selectCase: noop,
        send: async () => true,
        retryCreate: noop,
        saveFacts: async () => null,
        reloadCase: noop,
        retryUpdates: noop,
        approve: noop,
        answerDecision: noop,
        dismissDecision: noop,
        stepIn: noop,
        leaveCall: noop,
        downloadPacket: noop,
      };
    },
  };
}

function chat(controller: CaseSessionController): string {
  return renderToString(
    <ChatColumn controller={controller} fixture phoneHint={null} planCount={1} callBar={null} metrics={null} />,
  );
}

function callScreen(controller: CaseSessionController): string {
  const active = controller.active!;
  return renderToString(
    <CallScreen
      caseData={active.caseData!}
      call={controller.call!}
      live={controller.live}
      liveError={controller.liveError}
      capabilities={controller.capabilities}
      fixture
      decision={decisionForCallScreen(active, controller.call!.id)}
      join={active.join}
      handedBack={false}
      onAnswer={noop}
      onDismissDecision={noop}
      onStepIn={noop}
      onLeave={noop}
      onRetryUpdates={noop}
    />,
  );
}

describe("server render of each stage", () => {
  it("paints the boot shell without a global mode badge before the browser state exists", () => {
    const html = renderToString(<RefundApp serverMode="simulated" />);
    expect(html).toContain("Recourse");
    expect(html).not.toContain('data-testid="server-mode-pill"');
    expect(html).toContain("Loading Recourse");
  });

  it("shows the empty state, then the skeleton while the case is created", async () => {
    const s = stage("insurance_claim");
    const empty = renderToString(
      <ChatColumn
        controller={{ ...s.controller(), active: null, sessions: [], call: null }}
        fixture
        phoneHint={null}
        planCount={0}
        callBar={null}
        metrics={null}
      />,
    );
    expect(empty).toContain("New case");
    expect(empty).toContain("Describe the issue");
    expect(empty).toContain("Attach supporting documents");
    expect(empty).toContain("Review details and approve the action");
    expect(empty).not.toContain("Start with an example");
    expect(empty).not.toContain("Fictional cases");
    expect(empty).toContain("Activity graph");
    expect(empty).toContain('data-testid="composer-input"');
    expect(empty).toContain('data-testid="composer-send"');

    s.begin("File an insurance claim against Northwind");
    const creating = chat(s.controller());
    expect(creating).toContain("Reading your request");
    expect(creating).toContain("policy.pdf");
  });

  it("renders the facts card and the approval step for a ready case", async () => {
    const s = stage("insurance_claim");
    s.begin("File an insurance claim against Northwind");
    await s.create("File an insurance claim against Northwind");
    const html = chat(s.controller());
    for (const id of [
      "facts-card",
      "facts-edit-customerName",
      "facts-edit-customerEmail",
      "facts-edit-merchantName",
      "facts-edit-supportPhone",
      "facts-edit-amountMinor",
      "facts-edit-reason",
      "approve-checkbox",
      "approve-button",
      "draft-toggle",
      "case-documents",
      "document-packet-download",
    ]) {
      expect(html).toContain(`data-testid="${id}"`);
    }
    expect(html).toContain("Approve the call to Northwind Mutual claims line");
    expect(html).toContain("$1,200.00");
    expect(html.indexOf('data-testid="case-documents"')).toBeLessThan(html.indexOf('data-testid="approve-button"'));
  });

  it("lists missing information and holds the approval back", async () => {
    const s = stage("needs_evidence");
    s.begin("Ridgeline charged me twice but I lost the receipt");
    await s.create("Ridgeline charged me twice but I lost the receipt");
    const html = chat(s.controller());
    expect(html).toContain('data-testid="missing-list"');
    expect(html).not.toContain('data-testid="approve-button"');
    expect(html).not.toContain('data-testid="outcome-card"');
  });
  it("does not require call approval or call-only missing fields in the browser workflow", async () => {
    const s = stage("needs_evidence");
    s.begin("Help with a return form"); await s.create("Help with a return form");
    const html = renderToString(<ChatColumn controller={s.controller()} fixture={false} phoneHint={null} planCount={0} callBar={null} metrics={null} allowCallApproval={false} />);
    expect(html).toContain('data-testid="facts-card"'); expect(html).toContain('data-testid="case-documents"');
    expect(html).not.toContain('data-testid="approve-button"'); expect(html).not.toContain('data-testid="missing-list"');
  });

  it("keeps a completed request for information visible without treating initial missing facts as an outcome", async () => {
    const s = stage("duplicate_charge", { v2: false });
    s.begin("duplicate charge");
    await s.create("duplicate charge");
    await s.approve();
    const previous = s.session().caseData!;
    const completed = {
      ...previous,
      status: "needs_information" as const,
      calls: previous.calls.map((call) => ({ ...call, state: "completed" as const, transcript: "Support: Please send your receipt." })),
      outcome: {
        ...previous.outcome,
        decision: "needs_information" as const,
        nextAction: "Send the original receipt for review.",
        supportingQuote: "Please send your receipt.",
      },
    };
    const update: SessionAction = { type: "case/received", key: KEY, caseData: completed, liveCapable: false, at: new Date().toISOString() };
    s.run(update);
    s.run(update);
    const html = chat(s.controller());
    expect(s.session().thread.filter((item) => item.kind === "result")).toHaveLength(1);
    expect(html).toContain('data-testid="outcome-card"');
    expect(html).toContain("Send the original receipt for review.");
    expect(html).toContain("Money received has not been verified");
    expect(html).not.toContain('data-testid="approve-button"');
  });

  it("renders the live call at each phase, with the decision below the timer while it waits", async () => {
    const s = stage("insurance_claim");
    s.begin("insurance claim");
    await s.create("insurance claim");
    await s.approve();

    s.seconds(0);
    await s.live();
    let html = callScreen(s.controller());
    expect(html).toContain('data-testid="call-screen"');
    expect(html).toContain('data-testid="call-timer"');
    expect(html).toContain("Dialing");
    // Step in at any time: enabled while dialing, with the hint about the agent pausing.
    const stepIn = html.match(/<button[^>]*data-testid="step-in-button"[^>]*>/)?.[0];
    expect(stepIn).toBeDefined();
    expect(stepIn).not.toMatch(/\sdisabled(=|\s|>)/);
    expect(html).toContain("Step in at any point. The agent pauses while you are on the line and resumes when you hand back.");
    expect(html).not.toContain("Available once someone answers");
    // The plan dashboard and map, asserted by structure rather than step titles.
    expect(html).toContain('data-testid="call-plan"');
    expect(html).toContain('data-testid="call-plan-step"');
    expect(html).toContain("Step 1 of");
    expect(html).toContain('aria-current="step"');
    expect(html).toContain('aria-label="Call plan"');

    s.seconds(18);
    await s.live();
    html = callScreen(s.controller());
    expect(html).toContain("Talking to: an automated agent");
    expect(html).toContain('data-testid="call-notes"');
    expect(html).toContain("On hold");
    // The spoken lines stream above the agent's activity, each with who said it.
    expect(html).toContain('data-testid="call-transcript"');
    expect(html).toContain(">Support</span>");
    expect(html).toContain("This is the automated claims assistant. How can I help?");
    expect(html.indexOf('data-testid="call-plan"')).toBeLessThan(html.indexOf('data-testid="call-transcript"'));
    expect(html.indexOf('data-testid="call-transcript"')).toBeLessThan(html.indexOf('data-testid="call-notes"'));

    s.seconds(24);
    await s.live();
    const controller = s.controller();
    html = callScreen(controller);
    expect(html).toContain('data-testid="decision-card"');
    expect(html.indexOf('data-testid="call-timer"')).toBeLessThan(html.indexOf('data-testid="decision-card"'));
    expect(html).toContain('data-testid="decision-option-accept"');
    expect(html).toContain('data-testid="decision-countdown"');
    expect(html).toContain("Waiting for you");
    const thread = chat(controller);
    expect(thread).toContain('data-testid="decision-card-inline"');
    expect(thread).toContain('data-testid="decision-option-inline-accept"');

    const metrics = renderToString(<MetricsStrip activeMs={72_000} live={controller.live} />);
    expect(metrics).toContain("Your active time");
    expect(metrics).toContain("1:12");
    expect(metrics).toContain('data-testid="metrics-agent"');

    const bar = renderToString(
      <CallBar caseData={controller.active!.caseData!} call={controller.call!} live={controller.live} needsAnswer onOpen={noop} />,
    );
    expect(bar).toContain("Needs your answer");
    expect(bar).toContain('data-testid="call-bar-step"');
  });

  it("pauses the plan while the user is on the call and offers to hand back", async () => {
    const s = stage("insurance_claim");
    s.begin("insurance claim");
    await s.create("insurance claim");
    await s.approve();
    s.seconds(18);
    const before = await s.live();
    expect(before).not.toBeNull();

    const joined = await s.api.stepIn(s.session().caseId!, before!.callId);
    s.run({ type: "live/received", key: KEY, live: joined, at: new Date().toISOString() });
    const html = callScreen(s.controller());
    expect(html).toContain("You are on the call. The agent is paused.");
    expect(html).toContain('data-testid="leave-call-button"');
    expect(html).toContain("Hand back to the agent");
    expect(html).not.toContain('data-testid="step-in-button"');
    expect(html).toContain('data-testid="call-plan"');
    expect(html).toContain("Paused - you are on the line");
    expect(html).toContain('aria-current="step"');
  });

  it("renders the outcome with approval and payment kept apart", async () => {
    const s = stage("insurance_claim");
    s.begin("insurance claim");
    await s.create("insurance claim");
    await s.approve();
    s.seconds(120);
    await s.live();
    await s.poll();
    const html = chat(s.controller());
    for (const id of ["outcome-card", "outcome-reference", "outcome-approval", "outcome-payment", "transcript-toggle", "packet-download"]) {
      expect(html).toContain(`data-testid="${id}"`);
    }
    expect(html).toContain("NWM-2026-48213");
    const screen = callScreen(s.controller());
    expect(screen).toContain("Ended");
  });

  it("renders a V1-only call with its state as the phase and no timer", async () => {
    const s = stage("duplicate_charge", { v2: false });
    s.begin("duplicate charge");
    await s.create("duplicate charge");
    await s.approve();
    s.seconds(5);
    await s.poll();
    const html = callScreen(s.controller());
    expect(html).toContain("Counterpart not reported");
    expect(html).not.toContain('data-testid="call-timer"');
    expect(html).toContain("Not available with this backend");
    expect(html).toContain("Transcript");
  });

  it("renders a refused dispatch and an unknown dispatch", async () => {
    const refused = stage("duplicate_charge");
    refused.begin("duplicate charge");
    await refused.create("duplicate charge", { supportPhone: "+14155550001" });
    await refused.approve();
    await refused.live();
    expect(chat(refused.controller())).toContain("The call did not go through.");
    const screen = callScreen(refused.controller());
    expect(screen).toContain("The call did not connect.");
    expect(screen).toContain("Counterpart not identified");
    expect(screen).not.toContain('data-testid="call-timer"');

    const unknown = stage("uncertain_dispatch");
    unknown.begin("uncertain");
    await unknown.create("uncertain");
    await unknown.approve();
    unknown.seconds(10);
    await unknown.poll();
    const html = chat(unknown.controller());
    expect(html).toContain('data-testid="dispatch-unknown-card"');
    expect(html).toContain("We cannot tell whether the call went through.");
  });

  it("renders the rail and the plan onboarding", () => {
    const s = stage("insurance_claim");
    s.begin("insurance claim");
    const rail = renderToString(
      <Rail
        sessions={s.controller().sessions}
        activeKey={KEY}
        view="chat"
        plans={[]}
        onNewCase={noop}
        onSelectCase={noop}
        onManagePlans={noop}
      />,
    );
    expect(rail).toContain('data-testid="rail-new-case"');
    expect(rail).toContain('data-testid="rail-case"');
    expect(rail).toContain("Reading your request");
    expect(rail).not.toContain("Personal workspace");
    expect(rail).not.toContain("You approve. Then we call.");
    expect(rail).not.toContain("Cases stay in this tab.");

    const plans: PlansController = {
      status: "ready",
      plans: [],
      persistent: true,
      onboarded: false,
      saveError: null,
      addFiles: () => ({ added: [], rejected: [] }),
      updatePlan: noop,
      removePlan: () => null,
      restorePlan: noop,
      completeOnboarding: noop,
      planFiles: () => [],
    };
    const onboarding = renderToString(<PlansManager plans={plans} mode="onboarding" onDone={noop} />);
    expect(onboarding).toContain("Add your insurance plans");
    expect(onboarding).toContain('data-testid="plans-dropzone"');
    expect(onboarding).toContain('data-testid="plans-file-input"');
    expect(onboarding).toContain('data-testid="plans-continue"');
    expect(onboarding).not.toContain("Your next step");
    expect(onboarding).not.toContain("Plans stay in this browser");
  });
});
