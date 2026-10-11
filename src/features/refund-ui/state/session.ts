/**
 * Case sessions and the chat thread, as a pure reducer.
 *
 * Server state is authoritative. The thread stores only what the server does
 * not: the person's own words, and the order in which things were observed.
 * Cards in the thread (facts, approval, decisions, results) hold ids, not
 * copies, and render from the latest case and live call, so they can never
 * show stale facts.
 */

import type { CallState, CallV1, CaseV1 } from "../../../contracts/case";
import type { CaseApi, Counterpart, FixtureScenario, LiveCallPhase, LiveCallV2, PendingDecision } from "../api/types";
import { formatDuration, secondsBetween } from "../ui/format";
import {
  callStateEventText,
  counterpartEventText,
  currentCall,
  hasCallOutcome,
  isOutcomeStatus,
  phaseEventText,
} from "./call";
import type { UiError } from "./errors";
import { createLocalId } from "./ids";
import type { RecoveredCase } from "./recovery";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EventTone = "neutral" | "accent" | "warning" | "danger";

export type ThreadItem =
  | { kind: "user"; id: string; at: string; text: string; attachments: string[] }
  | { kind: "assistant"; id: string; at: string; text: string }
  /** "Here is what I understood" with the facts card for the current case. */
  | { kind: "understood"; id: string; at: string }
  /** The approval step. callId is set once a call was placed under it, which freezes it as a record. */
  | { kind: "approval"; id: string; at: string; callId: string | null }
  /** A compact system line mirroring what happened on the call. */
  | { kind: "event"; id: string; at: string; text: string; tone: EventTone }
  | { kind: "decision"; id: string; at: string; decisionId: string; callId: string }
  /** Outcome, failure, or dispatch_unknown for a call. */
  | { kind: "result"; id: string; at: string; callId: string | null };

export type DecisionStatus = "pending" | "answering" | "answered" | "closed";

export interface DecisionRecord {
  decision: PendingDecision;
  callId: string;
  status: DecisionStatus;
  /** The person's answer when answered. */
  chosenOptionId: string | null;
  /** True when the decision closed after its deadline without an answer from here. */
  expired: boolean;
  error: UiError | null;
  /** Hidden from the call screen; the chat keeps the record. */
  dismissed: boolean;
}

export interface RequestState {
  busy: boolean;
  error: UiError | null;
}

const idle: RequestState = { busy: false, error: null };

export interface CaseSession {
  /** Local key; stays the same before and after the case exists. */
  key: string;
  /** The API instance this case lives in. Fixture cases keep their own scenario. */
  api: CaseApi;
  scenario: FixtureScenario | null;
  /** The first message, used for the title until the case has a merchant. */
  summary: string;
  startedAt: string;
  caseId: string | null;
  caseData: CaseV1 | null;
  thread: ThreadItem[];
  create: RequestState;
  save: RequestState & { savedRevision: number | null };
  /** A 409 REVISION_CONFLICT was returned; the banner stays until a reload succeeds. */
  conflict: boolean;
  reload: RequestState;
  /** Increments on every successful reload so editors drop their drafts. */
  reloads: number;
  approval: RequestState & { stage: "authorizing" | "dispatching" | null };
  /** The call returned by startCall until the case lists it. */
  startedCall: CallV1 | null;
  live: LiveCallV2 | null;
  liveError: UiError | null;
  /** Set when reading the case failed; cleared by the next good read. */
  pollError: UiError | null;
  /** A saved pointer is visible while its initial server read is pending. */
  recoveryPending: boolean;
  decisions: Record<string, DecisionRecord>;
  join: RequestState;
  /** Calls the person stepped into and then handed back, until the server phase moves on. */
  handedBack: Record<string, boolean>;
  packet: RequestState;
  /** Milliseconds of active attention attributed to this case. */
  activeMs: number;
  /** Last V1 call state seen per call, for chat lines when there is no live data. */
  seenCallStates: Record<string, CallState>;
}

export interface SessionsState {
  sessions: CaseSession[];
  activeKey: string | null;
  /** Active time before the first case exists; moves into the first case. */
  unassignedActiveMs: number;
}

export const initialSessionsState: SessionsState = { sessions: [], activeKey: null, unassignedActiveMs: 0 };

export type SessionAction =
  | {
      type: "session/started";
      key: string;
      api: CaseApi;
      scenario: FixtureScenario | null;
      text: string;
      attachments: string[];
      /** A short assistant line about the attachments, for example a plan that could not be sent. */
      notice: string | null;
      at: string;
    }
  | { type: "session/selected"; key: string | null }
  | { type: "sessions/recovered"; api: CaseApi; entries: RecoveredCase[]; activeCaseId: string | null; discardedCaseIds?: string[]; preserveSelection: boolean; liveCapable: boolean; at: string }
  | { type: "create/retrying"; key: string }
  /** A message before the case exists: it joins the summary and creation is tried again. */
  | { type: "create/message"; key: string; text: string; summary: string; at: string }
  | { type: "create/succeeded"; key: string; caseData: CaseV1; liveCapable: boolean; at: string }
  | { type: "create/failed"; key: string; error: UiError }
  | { type: "case/received"; key: string; caseData: CaseV1; liveCapable: boolean; at: string }
  | { type: "poll/failed"; key: string; error: UiError | null }
  | { type: "save/started"; key: string }
  | { type: "save/succeeded"; key: string; caseData: CaseV1; liveCapable: boolean; at: string }
  | { type: "save/failed"; key: string; error: UiError }
  | { type: "save/cleared"; key: string }
  | { type: "reload/started"; key: string }
  | { type: "reload/succeeded"; key: string; caseData: CaseV1; liveCapable: boolean; at: string }
  | { type: "reload/failed"; key: string; error: UiError }
  | { type: "approval/started"; key: string; stage: "authorizing" | "dispatching" }
  | { type: "approval/authorized"; key: string; caseData: CaseV1; liveCapable: boolean; at: string }
  | { type: "approval/dispatched"; key: string; call: CallV1; liveCapable: boolean; at: string }
  | { type: "approval/failed"; key: string; error: UiError }
  | { type: "live/received"; key: string; live: LiveCallV2 | null; at: string }
  | { type: "live/failed"; key: string; error: UiError | null }
  | { type: "decision/answering"; key: string; decisionId: string; optionId: string }
  | { type: "decision/answered"; key: string; decisionId: string; optionId: string; live: LiveCallV2; at: string }
  | { type: "decision/failed"; key: string; decisionId: string; error: UiError }
  /** The server no longer takes an answer (already resolved, or the call ended). */
  | { type: "decision/closed"; key: string; decisionId: string; at: string }
  | { type: "decision/dismissed"; key: string; decisionId: string }
  | { type: "join/started"; key: string }
  | { type: "join/succeeded"; key: string; live: LiveCallV2; at: string }
  | { type: "join/failed"; key: string; error: UiError }
  | { type: "join/handed-back"; key: string; callId: string; at: string }
  | { type: "note/added"; key: string; text: string; reply: string; at: string }
  | { type: "packet/started"; key: string }
  | { type: "packet/finished"; key: string; error: UiError | null }
  | { type: "active/elapsed"; ms: number };

// ---------------------------------------------------------------------------
// Derivation helpers
// ---------------------------------------------------------------------------

/** Accepts a case snapshot only if it is not older than the one we hold. */
function isNotOlder(next: CaseV1, previous: CaseV1 | null): boolean {
  if (!previous || previous.id !== next.id) return true;
  if (next.revision !== previous.revision) return next.revision > previous.revision;
  const nextTime = Date.parse(next.updatedAt);
  const previousTime = Date.parse(previous.updatedAt);
  if (Number.isNaN(nextTime) || Number.isNaN(previousTime)) return true;
  return nextTime >= previousTime;
}

function lastIndexWhere<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}

function eventTone(state: CallState): EventTone {
  switch (state) {
    case "failed":
    case "cancelled":
      return "danger";
    case "dispatch_unknown":
      return "warning";
    default:
      return "neutral";
  }
}

/**
 * Folds a case snapshot into the session and appends the chat items it implies:
 * the facts card once, closed and new approval steps, V1 call lines when
 * there is no live data, and one result item per finished call.
 */
function applyCase(session: CaseSession, next: CaseV1, liveCapable: boolean, at: string, force = false): CaseSession {
  if (!force && !isNotOlder(next, session.caseData)) return session;

  let thread = session.thread;
  const append = (item: ThreadItem) => {
    thread = [...thread, item];
  };

  if (!thread.some((item) => item.kind === "understood")) {
    append({ kind: "understood", id: createLocalId(), at });
  }

  const startedCall = session.startedCall && next.calls.some((call) => call.id === session.startedCall!.id) ? null : session.startedCall;
  const call = currentCall(next, startedCall);

  // A new call freezes the open approval step as the record it was placed under.
  const openApproval = lastIndexWhere(thread, (item) => item.kind === "approval" && item.callId === null);
  if (call && openApproval >= 0 && !thread.some((item) => item.kind === "approval" && item.callId === call.id)) {
    thread = thread.map((item, index) => (index === openApproval && item.kind === "approval" ? { ...item, callId: call.id } : item));
  }

  // Without live data, mirror V1 call states as chat lines.
  let seenCallStates = session.seenCallStates;
  if (!liveCapable) {
    const calls = [...next.calls].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const candidate of calls) {
      if (seenCallStates[candidate.id] !== candidate.state) {
        seenCallStates = { ...seenCallStates, [candidate.id]: candidate.state };
        // dispatch_unknown gets its own warning card instead of a line.
        if (candidate.state !== "dispatch_unknown") {
          append({ kind: "event", id: createLocalId(), at, text: callStateEventText(candidate.state), tone: eventTone(candidate.state) });
        }
      }
    }
  }

  // One result item per finished, failed or uncertain call.
  if (call) {
    const finished =
      call.state === "dispatch_unknown" || call.state === "failed" || call.state === "cancelled" || hasCallOutcome(next, call);
    if (finished && !thread.some((item) => item.kind === "result" && item.callId === call.id)) {
      append({ kind: "result", id: createLocalId(), at, callId: call.id });
    }
  } else if (isOutcomeStatus(next.status) && !thread.some((item) => item.kind === "result")) {
    append({ kind: "result", id: createLocalId(), at, callId: null });
  }

  // An approval step whenever the case is ready and no call runs under its authorization.
  // A fresh step starts clean: an error from the previous attempt does not carry over.
  let approval = session.approval;
  const needsApproval =
    (next.status === "ready_for_approval" || next.status === "authorized") &&
    !(call && next.authorization && call.authorizationId === next.authorization.id);
  if (needsApproval && !thread.some((item) => item.kind === "approval" && item.callId === null)) {
    append({ kind: "approval", id: createLocalId(), at, callId: null });
    if (!approval.busy) approval = { ...idle, stage: null };
  }

  return { ...session, caseId: next.id, caseData: next, thread, startedCall, seenCallStates, approval, recoveryPending: false };
}

/**
 * Folds a live call snapshot into the session: one chat line per phase change
 * and counterpart change, one decision card per new pending decision, and the
 * closing of decisions that disappeared without an answer from here.
 */
function applyLive(session: CaseSession, live: LiveCallV2 | null, at: string): CaseSession {
  if (!live) return session.live === null ? session : { ...session, live: null };
  const previous = session.live && session.live.callId === live.callId ? session.live : null;
  if (previous && Date.parse(live.updatedAt) < Date.parse(previous.updatedAt)) return session;

  let thread = session.thread;
  let decisions = session.decisions;
  const append = (item: ThreadItem) => {
    thread = [...thread, item];
  };

  if (!previous || previous.phase !== live.phase) {
    let text = phaseEventText(live);
    if (live.phase === "ended") {
      text = live.startedAt
        ? `Call ended after ${formatDuration(secondsBetween(live.startedAt, live.endedAt, Date.parse(at)))}`
        : "The call did not connect";
    }
    append({ kind: "event", id: createLocalId(), at, text, tone: phaseTone(live.phase) });
  }

  const counterpartText = counterpartEventText(previous ? previous.counterpart : null, live.counterpart);
  if (counterpartText && (!previous || previous.counterpart !== live.counterpart)) {
    append({ kind: "event", id: createLocalId(), at, text: counterpartText, tone: counterpartTone(live.counterpart) });
  }

  const pending = live.pendingDecision;
  const nowMs = Date.parse(at);
  // A decision that disappears without an answer from here is closed; its card says how.
  for (const [id, record] of Object.entries(decisions)) {
    if (record.callId !== live.callId || record.status !== "pending" || pending?.id === id) continue;
    const expired = Date.parse(record.decision.expiresAt) <= nowMs;
    decisions = { ...decisions, [id]: { ...record, status: "closed", expired } };
  }

  if (pending) {
    const known = decisions[pending.id];
    if (!known) {
      decisions = {
        ...decisions,
        [pending.id]: {
          decision: pending,
          callId: live.callId,
          status: "pending",
          chosenOptionId: null,
          expired: false,
          error: null,
          dismissed: false,
        },
      };
      append({ kind: "decision", id: createLocalId(), at, decisionId: pending.id, callId: live.callId });
    } else if (known.decision !== pending) {
      decisions = { ...decisions, [pending.id]: { ...known, decision: pending } };
    }
  }

  let handedBack = session.handedBack;
  if (handedBack[live.callId] && (live.phase !== "user_joined" || !live.userJoined)) {
    handedBack = { ...handedBack, [live.callId]: false };
  }

  return { ...session, live, thread, decisions, handedBack, liveError: null };
}

function phaseTone(phase: LiveCallPhase): EventTone {
  switch (phase) {
    case "waiting_for_user":
      return "warning";
    case "user_joined":
      return "accent";
    case "dialing":
    case "ringing":
    case "navigating_menu":
    case "on_hold":
    case "talking":
    case "ended":
      return "neutral";
    default: {
      const unreachable: never = phase;
      return unreachable;
    }
  }
}

function counterpartTone(counterpart: Counterpart): EventTone {
  return counterpart === "agent" ? "accent" : "neutral";
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function update(state: SessionsState, key: string, change: (session: CaseSession) => CaseSession): SessionsState {
  let changed = false;
  const sessions = state.sessions.map((session) => {
    if (session.key !== key) return session;
    const next = change(session);
    if (next !== session) changed = true;
    return next;
  });
  return changed ? { ...state, sessions } : state;
}

export function newSession(input: {
  key: string;
  api: CaseApi;
  scenario: FixtureScenario | null;
  text: string;
  attachments: string[];
  notice: string | null;
  at: string;
  activeMs: number;
}): CaseSession {
  const thread: ThreadItem[] = [{ kind: "user", id: createLocalId(), at: input.at, text: input.text, attachments: input.attachments }];
  if (input.notice) thread.push({ kind: "assistant", id: createLocalId(), at: input.at, text: input.notice });
  return {
    key: input.key,
    api: input.api,
    scenario: input.scenario,
    summary: input.text,
    startedAt: input.at,
    caseId: null,
    caseData: null,
    thread,
    create: { busy: true, error: null },
    save: { ...idle, savedRevision: null },
    conflict: false,
    reload: idle,
    reloads: 0,
    approval: { ...idle, stage: null },
    startedCall: null,
    live: null,
    liveError: null,
    pollError: null,
    recoveryPending: false,
    decisions: {},
    join: idle,
    handedBack: {},
    packet: idle,
    activeMs: input.activeMs,
    seenCallStates: {},
  };
}

export function sessionsReducer(state: SessionsState, action: SessionAction): SessionsState {
  switch (action.type) {
    case "sessions/recovered": {
      if (action.api.mode !== "http") return state;
      const sessions = state.sessions.filter(session => !(session.api === action.api
        && session.caseData === null && session.key === `http:${session.caseId}`
        && action.discardedCaseIds?.includes(session.caseId ?? "")));
      for (const entry of action.entries) {
        const existing = sessions.findIndex(session => session.api.mode === "http" && session.caseId === entry.caseId);
        // Hydrate only our placeholder. A newer poll, edit or creation wins over
        // a delayed recovery result, including a delayed failure.
        const previous = existing >= 0 ? sessions[existing]! : null;
        if (previous && (previous.api !== action.api || previous.key !== `http:${entry.caseId}` || previous.caseData !== null)) continue;
        if (previous && !previous.recoveryPending && entry.caseData === null) continue;
        const recoveryPending = entry.caseData === null && entry.error === null;
        const text = entry.caseData
          ? "Reopened the saved case from the server. Earlier local conversation notes were not retained."
          : entry.error
            ? "This saved case could not be loaded. Try updating it again when the server is available. No new call was requested."
            : "Reopening this saved case from the server. No new call is being requested.";
        const fresh = newSession({ key: `http:${entry.caseId}`, api: action.api, scenario: null,
          text: entry.caseData?.reason || "Saved case", attachments: [], notice: null,
          at: entry.caseData?.createdAt ?? action.at, activeMs: 0 });
        const restored: CaseSession = { ...(previous ?? fresh), caseId: entry.caseId, create: idle,
          pollError: entry.error, recoveryPending,
          summary: entry.caseData?.reason || previous?.summary || "Saved case",
          thread: previous
            ? previous.thread.map((item, index) => index === 0 && item.kind === "assistant" ? { ...item, text } : item)
            : [{ kind: "assistant", id: createLocalId(), at: action.at, text }] };
        const hydrated = entry.caseData ? applyCase(restored, entry.caseData, action.liveCapable, action.at) : restored;
        if (existing >= 0) sessions[existing] = hydrated;
        else sessions.push(hydrated);
      }
      const recoveredActive = sessions.find(session => session.api.mode === "http" && session.caseId === action.activeCaseId)?.key ?? null;
      const activeKey = action.preserveSelection ? state.activeKey : recoveredActive;
      return { ...state, sessions, activeKey: sessions.some(session => session.key === activeKey) ? activeKey : null };
    }
    case "session/started": {
      const session = newSession({ ...action, activeMs: state.unassignedActiveMs });
      return { sessions: [session, ...state.sessions], activeKey: action.key, unassignedActiveMs: 0 };
    }
    case "session/selected":
      return state.activeKey === action.key ? state : { ...state, activeKey: action.key };
    case "create/retrying":
      return update(state, action.key, (session) => ({ ...session, create: { busy: true, error: null } }));
    case "create/message":
      return update(state, action.key, (session) => ({
        ...session,
        summary: action.summary,
        create: { busy: true, error: null },
        thread: [...session.thread, { kind: "user", id: createLocalId(), at: action.at, text: action.text, attachments: [] }],
      }));
    case "create/succeeded":
      return update(state, action.key, (session) =>
        applyCase({ ...session, create: idle }, action.caseData, action.liveCapable, action.at),
      );
    case "create/failed":
      return update(state, action.key, (session) => ({ ...session, create: { busy: false, error: action.error } }));
    case "case/received":
      return update(state, action.key, (session) =>
        session.caseId === null || session.caseId === action.caseData.id
          ? applyCase(session, action.caseData, action.liveCapable, action.at)
          : session,
      );
    case "poll/failed":
      return update(state, action.key, (session) =>
        session.pollError === action.error ? session : { ...session, pollError: action.error },
      );
    case "save/started":
      return update(state, action.key, (session) => ({ ...session, save: { ...session.save, busy: true, error: null } }));
    case "save/succeeded":
      return update(state, action.key, (session) =>
        applyCase(
          {
            ...session,
            save: { busy: false, error: null, savedRevision: action.caseData.revision },
            // Saved facts answer any earlier approval error (for example a 422 naming missing fields).
            approval: session.approval.busy ? session.approval : { ...idle, stage: null },
          },
          action.caseData,
          action.liveCapable,
          action.at,
        ),
      );
    case "save/failed":
      return update(state, action.key, (session) => ({
        ...session,
        save: { ...session.save, busy: false, error: action.error },
        conflict: session.conflict || action.error.kind === "revision_conflict",
      }));
    case "save/cleared":
      return update(state, action.key, (session) => ({ ...session, save: { ...session.save, error: null, savedRevision: null } }));
    case "reload/started":
      return update(state, action.key, (session) => ({ ...session, reload: { busy: true, error: null } }));
    case "reload/succeeded":
      return update(state, action.key, (session) =>
        applyCase(
          {
            ...session,
            reload: idle,
            reloads: session.reloads + 1,
            conflict: false,
            save: { busy: false, error: null, savedRevision: null },
            approval: { ...idle, stage: null },
          },
          action.caseData,
          action.liveCapable,
          action.at,
          true,
        ),
      );
    case "reload/failed":
      return update(state, action.key, (session) => ({ ...session, reload: { busy: false, error: action.error } }));
    case "approval/started":
      return update(state, action.key, (session) => ({ ...session, approval: { busy: true, error: null, stage: action.stage } }));
    case "approval/authorized":
      return update(state, action.key, (session) =>
        applyCase(
          { ...session, approval: { busy: true, error: null, stage: "dispatching" } },
          action.caseData,
          action.liveCapable,
          action.at,
        ),
      );
    case "approval/dispatched":
      return update(state, action.key, (session) => {
        const withCall: CaseSession = { ...session, startedCall: action.call, approval: { ...idle, stage: null } };
        return session.caseData ? applyCase(withCall, session.caseData, action.liveCapable, action.at, true) : withCall;
      });
    case "approval/failed":
      return update(state, action.key, (session) => ({
        ...session,
        approval: { busy: false, error: action.error, stage: null },
        conflict: session.conflict || action.error.kind === "revision_conflict",
      }));
    case "live/received":
      return update(state, action.key, (session) => applyLive(session, action.live, action.at));
    case "live/failed":
      return update(state, action.key, (session) =>
        session.liveError === action.error ? session : { ...session, liveError: action.error },
      );
    case "decision/answering":
      return update(state, action.key, (session) => {
        const record = session.decisions[action.decisionId];
        if (!record) return session;
        return {
          ...session,
          decisions: {
            ...session.decisions,
            [action.decisionId]: { ...record, status: "answering", chosenOptionId: action.optionId, error: null },
          },
        };
      });
    case "decision/answered":
      return update(state, action.key, (session) => {
        const record = session.decisions[action.decisionId];
        const answered: CaseSession = record
          ? {
              ...session,
              decisions: {
                ...session.decisions,
                [action.decisionId]: { ...record, status: "answered", chosenOptionId: action.optionId, error: null },
              },
            }
          : session;
        return applyLive(answered, action.live, action.at);
      });
    case "decision/failed":
      return update(state, action.key, (session) => {
        const record = session.decisions[action.decisionId];
        if (!record) return session;
        return {
          ...session,
          decisions: {
            ...session.decisions,
            [action.decisionId]: { ...record, status: "pending", chosenOptionId: null, error: action.error },
          },
        };
      });
    case "decision/closed":
      return update(state, action.key, (session) => {
        const record = session.decisions[action.decisionId];
        if (!record || record.status === "answered" || record.status === "closed") return session;
        const expired = Date.parse(record.decision.expiresAt) <= Date.parse(action.at);
        return {
          ...session,
          decisions: {
            ...session.decisions,
            [action.decisionId]: { ...record, status: "closed", chosenOptionId: null, expired, error: null },
          },
        };
      });
    case "decision/dismissed":
      return update(state, action.key, (session) => {
        const record = session.decisions[action.decisionId];
        if (!record) return session;
        return { ...session, decisions: { ...session.decisions, [action.decisionId]: { ...record, dismissed: true } } };
      });
    case "join/started":
      return update(state, action.key, (session) => ({ ...session, join: { busy: true, error: null } }));
    case "join/succeeded":
      return update(state, action.key, (session) =>
        applyLive({ ...session, join: idle, handedBack: { ...session.handedBack, [action.live.callId]: false } }, action.live, action.at),
      );
    case "join/failed":
      return update(state, action.key, (session) => ({ ...session, join: { busy: false, error: action.error } }));
    case "join/handed-back":
      return update(state, action.key, (session) => ({
        ...session,
        handedBack: { ...session.handedBack, [action.callId]: true },
        thread: [
          ...session.thread,
          { kind: "event", id: createLocalId(), at: action.at, text: "You handed the call back to the agent", tone: "neutral" },
        ],
      }));
    case "note/added":
      return update(state, action.key, (session) => ({
        ...session,
        thread: [
          ...session.thread,
          { kind: "user", id: createLocalId(), at: action.at, text: action.text, attachments: [] },
          { kind: "assistant", id: createLocalId(), at: action.at, text: action.reply },
        ],
      }));
    case "packet/started":
      return update(state, action.key, (session) => ({ ...session, packet: { busy: true, error: null } }));
    case "packet/finished":
      return update(state, action.key, (session) => ({ ...session, packet: { busy: false, error: action.error } }));
    case "active/elapsed": {
      if (action.ms <= 0) return state;
      if (state.activeKey === null) return { ...state, unassignedActiveMs: state.unassignedActiveMs + action.ms };
      return update(state, state.activeKey, (session) => ({ ...session, activeMs: session.activeMs + action.ms }));
    }
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** The decision the call screen should show: pending first, then the newest undismissed one for this call. */
export function decisionForCallScreen(session: CaseSession, callId: string | null): DecisionRecord | null {
  if (!callId) return null;
  const records = Object.values(session.decisions).filter((record) => record.callId === callId && !record.dismissed);
  const open = records.find((record) => record.status === "pending" || record.status === "answering");
  if (open) return open;
  return records.at(-1) ?? null;
}

/** The pending decision that needs the person, if any, across the active call. */
export function pendingDecision(session: CaseSession | null): DecisionRecord | null {
  if (!session) return null;
  return Object.values(session.decisions).find((record) => record.status === "pending" || record.status === "answering") ?? null;
}
