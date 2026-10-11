"use client";

/**
 * The case controller behind every view. It owns the CaseApi instances, makes
 * every request, and folds each answer into the session reducer; views only
 * read the controller and call its actions.
 *
 * Request order for one case:
 *   send      createCase({ summary, files }), then GET case once the id exists
 *   save      patchCase(expectedRevision); a 409 REVISION_CONFLICT keeps the
 *             conflict banner up until the person reloads, never a silent retry
 *   approve   authorize(expectedRevision) unless this revision is authorized,
 *             then startCall({ authorizationId, requestId }) with a requestId
 *             that stays the same for the authorization, then GET case
 *   call      GET case every 2.5 s while the call runs, GET live call every 1 s
 *             until it ends, one more GET case when it ends
 *   decide    answerDecision / stepIn, adopting the live call they return
 *
 * The shared contract has no chat endpoint: once the case exists, further
 * messages stay in this browser with a local acknowledgement.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { CallV1, CaseChanges, CaseV1 } from "../../../contracts/case";
import { createCaseApi } from "../api/client";
import { inferScenario } from "../api/fixture";
import { useActiveTime, useCasePolling, useLiveCall } from "../api/hooks";
import { browserSessionStorage, getOrCreateRequestId } from "../api/request-id";
import { DESTINATION_MESSAGE, inferDestination } from "../api/summary";
import {
  ApiRequestError,
  type ApiMode,
  type CaseApi,
  type CaseApiCapabilities,
  type CreateCaseInput,
  type FixtureScenario,
  type LiveCallV2,
  type SummaryDestination,
  type UiCallPurpose,
} from "../api/types";
import type { PlanRecord } from "../plans/store";
import { attachmentsFor } from "./attachments";
import { currentCall } from "./call";
import type { CaseSessionController, FixtureSettings } from "./controller";
import { toUiError } from "./errors";
import { createLocalId } from "./ids";
import { createCaseRecovery, readRecoveryIndex, recoveryIndex, writeRecoveryIndex, type CaseRecovery } from "./recovery";
import { initialSessionsState, pendingDecision, sessionsReducer, summaryAutoSend, type CaseSession } from "./session";

/**
 * The post-call transcript and summary. Kept beside CaseSessionController so
 * views built against the controller alone keep working; the chat shows the
 * summary card only when these are present.
 */
export interface SummaryController {
  /** Infers email or text message from what was typed, then sends (fixture) or composes (http). */
  sendSummary(text: string): void;
  editSummaryDestination(text: string): void;
  /** Back to the form, to send to another address. */
  resetSummary(): void;
}

export interface UseCaseSessionOptions {
  apiMode: ApiMode;
  /** The person's stored plans; the ones a message is about go with the new case. */
  plans: readonly PlanRecord[];
  /** True while the chat is on screen, so active time counts toward a case. */
  measuring: boolean;
}

const CASE_POLL_MS = 2500;
const LIVE_POLL_MS = 1000;
/** With "Show loading" on, every fixture answer waits this long so loading states stay on screen. */
const SHOW_LOADING_LATENCY_MS = 1200;
const NO_CAPABILITIES: CaseApiCapabilities = { liveCall: false, stepIn: false, decisions: false };
const DEFAULT_FIXTURE_SETTINGS: FixtureSettings = { showLoading: false, v1Only: false };

function nowIso(): string {
  return new Date().toISOString();
}

function createFixtureApi(scenario: FixtureScenario | null, settings: FixtureSettings): CaseApi {
  return createCaseApi({
    mode: "fixture",
    fixture: {
      scenario: scenario ?? undefined,
      latencyMs: settings.showLoading ? SHOW_LOADING_LATENCY_MS : 0,
      v2: !settings.v1Only,
    },
  });
}

/**
 * A call whose dispatch is unknown never gets a live record, so its live
 * polling stops. Every other call is read until its record says it ended
 * (a refused dispatch comes back as an ended record at once).
 */
function canHaveLiveRecord(call: CallV1): boolean {
  return call.state !== "dispatch_unknown";
}

/** The local acknowledgement for a message sent after the case exists. */
function noteReply(): string {
  return "Saved in this conversation. To update the call brief, edit the case facts above.";
}

function packetFileName(session: CaseSession): string {
  const merchant = session.caseData?.merchant.name ?? "";
  const slug =
    merchant
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "case";
  return `recourse-${slug}-${(session.caseId ?? "").slice(0, 8)}.txt`;
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking in the same task can cancel the download in some browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function useCaseSession({ apiMode, plans, measuring }: UseCaseSessionOptions): CaseSessionController & SummaryController {
  const [state, dispatch] = useReducer(sessionsReducer, initialSessionsState);
  const [scenario, setScenarioState] = useState<FixtureScenario | null>(null);
  const [fixtureSettings, setFixtureSettingsState] = useState<FixtureSettings>(DEFAULT_FIXTURE_SETTINGS);

  // http: one client for every case. fixture: each case gets its own engine, so
  // picker changes made later never change a case that already exists.
  const sharedApi = useMemo(() => (apiMode === "http" ? createCaseApi({ mode: "http" }) : null), [apiMode]);
  // Only consulted for capabilities while no case is open.
  const idleApi = useMemo(() => sharedApi ?? createFixtureApi(null, fixtureSettings), [sharedApi, fixtureSettings]);

  // The workspace normally remounts on mode changes. Keep recovery explicitly
  // keyed by its HTTP API as well, so a fixture engine can never be hydrated.
  const selectionVersion = useRef(0);
  const recovery = useRef<{ api: CaseApi; task: CaseRecovery; selectionVersion: number } | null>(null);
  const [recoveredApi, setRecoveredApi] = useState<CaseApi | null>(null);
  useEffect(() => {
    if (sharedApi === null) return;
    if (recovery.current?.api !== sharedApi) {
      recovery.current = { api: sharedApi, selectionVersion: selectionVersion.current,
        task: createCaseRecovery(sharedApi, readRecoveryIndex(browserSessionStorage(), "http")) };
    }
    const attempt = recovery.current;
    // Reuse one read pass across StrictMode cleanup/setup. Replaying its latest
    // snapshot also means no progress is lost while the subscriber is detached.
    return attempt.task.subscribe(result => {
      dispatch({ type: "sessions/recovered", api: sharedApi, ...result,
        preserveSelection: selectionVersion.current !== attempt.selectionVersion,
        liveCapable: true, at: nowIso() });
      setRecoveredApi(sharedApi);
    });
  }, [sharedApi]);

  useEffect(() => {
    // Wait only for immediate pointer hydration, not the network. New cases and
    // explicit selection remain saved even if unrelated history reads hang.
    if (sharedApi === null || recoveredApi !== sharedApi) return;
    const httpSessions = state.sessions.filter(session => session.api.mode === "http" && session.caseId !== null);
    const selected = httpSessions.find(session => session.key === state.activeKey)?.caseId ?? null;
    writeRecoveryIndex(browserSessionStorage(), "http", recoveryIndex(httpSessions.map(session => session.caseId!), selected));
  }, [sharedApi, recoveredApi, state.sessions, state.activeKey]);

  const active = state.sessions.find((session) => session.key === state.activeKey) ?? null;
  const activeKey = active?.key ?? null;
  const activeApi = active?.api ?? idleApi;
  const activeCaseId = active?.caseId ?? null;

  // ---- Capabilities, once per API instance --------------------------------
  const [capabilityMap, setCapabilityMap] = useState<ReadonlyMap<CaseApi, CaseApiCapabilities>>(() => new Map());
  const capabilities = capabilityMap.get(activeApi) ?? null;
  useEffect(() => {
    if (capabilities !== null) return;
    let alive = true;
    const remember = (value: CaseApiCapabilities) => {
      if (alive) setCapabilityMap((current) => new Map(current).set(activeApi, value));
    };
    activeApi.capabilities().then(remember, () => remember(NO_CAPABILITIES));
    return () => {
      alive = false;
    };
  }, [activeApi, capabilities]);
  // Until capabilities are known, assume live data: V1 call lines then catch up
  // if it turns out there is none, instead of both kinds of lines appearing.
  const liveCapable = capabilities?.liveCall ?? true;

  // ---- Server state for the active case ------------------------------------
  // Recovery already owns a bounded, cancellable initial GET for this pointer.
  // Start normal polling as soon as this case resolves, independently of history.
  const polled = useCasePolling(activeApi, active?.recoveryPending ? null : activeCaseId, { intervalMs: CASE_POLL_MS });
  const call = active ? currentCall(active.caseData, active.startedCall) : null;
  const liveCallId = call && canHaveLiveRecord(call) ? call.id : null;
  const liveCall = useLiveCall(activeApi, activeCaseId, liveCallId, { intervalMs: LIVE_POLL_MS });

  const polledCase = polled.case;
  useEffect(() => {
    if (activeKey === null || polledCase === null) return;
    dispatch({ type: "case/received", key: activeKey, caseData: polledCase, liveCapable, at: nowIso() });
  }, [activeKey, polledCase, liveCapable]);

  const polledError = polled.error;
  useEffect(() => {
    if (activeKey === null) return;
    // A newly mounted poller has neither data nor an error yet. Keep a failed
    // recovery's retry banner visible until an actual read succeeds or fails.
    if (polledError === null && polledCase === null) return;
    dispatch({ type: "poll/failed", key: activeKey, error: polledError ? toUiError(polledError) : null });
  }, [activeKey, polledError, polledCase]);

  const polledLive = liveCall.liveCall;
  useEffect(() => {
    if (activeKey === null || polledLive === null) return;
    dispatch({ type: "live/received", key: activeKey, live: polledLive, at: nowIso() });
  }, [activeKey, polledLive]);

  const liveFailure = liveCall.error;
  useEffect(() => {
    if (activeKey === null) return;
    dispatch({ type: "live/failed", key: activeKey, error: liveFailure ? toUiError(liveFailure) : null });
  }, [activeKey, liveFailure]);

  // The outcome lands on the case when the call ends; read it now rather than on the next tick.
  const livePhase = polledLive?.phase ?? null;
  const refreshPolledCase = polled.refresh;
  useEffect(() => {
    if (livePhase === "ended") void refreshPolledCase();
  }, [livePhase, refreshPolledCase]);

  // ---- Active time ----------------------------------------------------------
  const meter = useActiveTime();
  const startMeter = meter.start;
  useEffect(() => {
    startMeter();
  }, [startMeter]);
  const countedSeconds = useRef(0);
  const activeSeconds = meter.activeSeconds;
  useEffect(() => {
    const delta = activeSeconds - countedSeconds.current;
    countedSeconds.current = activeSeconds;
    // Time spent outside the chat (plan setup) is not time on a case.
    if (delta > 0 && measuring) dispatch({ type: "active/elapsed", ms: delta * 1000 });
  }, [activeSeconds, measuring]);

  // ---- Actions ------------------------------------------------------------------
  // Actions read the newest render through this ref, so their identities stay stable.
  const latest = useRef({ active, apiMode, sharedApi, scenario, fixtureSettings, plans, liveCapable, polled, liveCall });
  useLayoutEffect(() => {
    latest.current = { active, apiMode, sharedApi, scenario, fixtureSettings, plans, liveCapable, polled, liveCall };
  });
  const inFlight = useRef(new Set<string>());
  const createInputs = useRef(new Map<string, CreateCaseInput>());

  const claim = useCallback((guard: string): boolean => {
    if (inFlight.current.has(guard)) return false;
    inFlight.current.add(guard);
    return true;
  }, []);
  const release = useCallback((guard: string) => {
    inFlight.current.delete(guard);
  }, []);

  /** Hands a case returned by a request to the poller, if that case is still on screen. */
  const adoptCase = useCallback((key: string, caseData: CaseV1) => {
    const current = latest.current;
    if (current.active?.key === key) current.polled.replace(caseData);
  }, []);

  const adoptLive = useCallback((key: string, live: LiveCallV2) => {
    const current = latest.current;
    if (current.active?.key === key) current.liveCall.replace(live);
  }, []);

  const fetchCase = useCallback(
    async (key: string, api: CaseApi, caseId: string) => {
      try {
        const next = await api.getCase(caseId);
        dispatch({ type: "case/received", key, caseData: next, liveCapable: latest.current.liveCapable, at: nowIso() });
        adoptCase(key, next);
      } catch {
        // The poller reports read failures for the case on screen.
      }
    },
    [adoptCase],
  );

  const create = useCallback(
    async (key: string, api: CaseApi, input: CreateCaseInput) => {
      try {
        const caseData = await api.createCase(input);
        dispatch({ type: "create/succeeded", key, caseData, liveCapable: latest.current.liveCapable, at: nowIso() });
        adoptCase(key, caseData);
      } catch (error) {
        dispatch({ type: "create/failed", key, error: toUiError(error) });
      }
    },
    [adoptCase],
  );

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      const trimmed = text.trim();
      if (!trimmed) return false;
      const current = latest.current;
      const session = current.active;
      const at = nowIso();

      if (session === null) {
        selectionVersion.current += 1;
        const key = createLocalId();
        const picked = current.apiMode === "fixture" ? (current.scenario ?? inferScenario(trimmed)) : null;
        const api = current.sharedApi ?? createFixtureApi(picked, current.fixtureSettings);
        const attachments = attachmentsFor(trimmed, current.plans, current.apiMode);
        const input: CreateCaseInput = { summary: trimmed, files: attachments.files, ...attachments.prefill };
        createInputs.current.set(key, input);
        dispatch({
          type: "session/started",
          key,
          api,
          scenario: picked,
          text: trimmed,
          attachments: attachments.names,
          notice: attachments.notice,
          at,
        });
        void create(key, api, input);
        return true;
      }

      if (session.create.busy) return false;

      if (session.caseId === null) {
        // The case was never created: try again with everything said so far.
        const summary = `${session.summary}\n\n${trimmed}`;
        const input: CreateCaseInput = { ...(createInputs.current.get(session.key) ?? {}), summary };
        createInputs.current.set(session.key, input);
        dispatch({ type: "create/message", key: session.key, text: trimmed, summary, at });
        void create(session.key, session.api, input);
        return true;
      }

      // No chat endpoint exists in the contract, so the note stays in this browser.
      dispatch({ type: "note/added", key: session.key, text: trimmed, reply: noteReply(), at });
      return true;
    },
    [create],
  );

  const retryCreate = useCallback(() => {
    const session = latest.current.active;
    if (!session || session.caseId !== null || session.create.busy) return;
    const input = createInputs.current.get(session.key) ?? { summary: session.summary };
    dispatch({ type: "create/retrying", key: session.key });
    void create(session.key, session.api, input);
  }, [create]);

  const saveFacts = useCallback(
    async (changes: CaseChanges, expectedRevision: number): Promise<CaseV1 | null> => {
      const session = latest.current.active;
      if (!session || session.caseId === null) return null;
      const guard = `save:${session.key}`;
      if (!claim(guard)) return null;
      const { key, api } = session;
      const caseId = session.caseId;
      dispatch({ type: "save/started", key });
      try {
        const saved = await api.patchCase(caseId, expectedRevision, changes);
        dispatch({ type: "save/succeeded", key, caseData: saved, liveCapable: latest.current.liveCapable, at: nowIso() });
        adoptCase(key, saved);
        return saved;
      } catch (error) {
        dispatch({ type: "save/failed", key, error: toUiError(error) });
        return null;
      } finally {
        release(guard);
      }
    },
    [adoptCase, claim, release],
  );

  const reloadCase = useCallback(async () => {
    const session = latest.current.active;
    if (!session || session.caseId === null) return;
    const guard = `reload:${session.key}`;
    if (!claim(guard)) return;
    const { key, api } = session;
    const caseId = session.caseId;
    dispatch({ type: "reload/started", key });
    try {
      const next = await api.getCase(caseId);
      dispatch({ type: "reload/succeeded", key, caseData: next, liveCapable: latest.current.liveCapable, at: nowIso() });
      adoptCase(key, next);
    } catch (error) {
      dispatch({ type: "reload/failed", key, error: toUiError(error) });
    } finally {
      release(guard);
    }
  }, [adoptCase, claim, release]);

  const retryUpdates = useCallback(() => {
    const current = latest.current;
    void current.polled.refresh();
    void current.liveCall.refresh();
  }, []);

  const approve = useCallback(async (purpose?: UiCallPurpose) => {
    const session = latest.current.active;
    const caseData = session?.caseData ?? null;
    if (!session || !caseData || session.caseId === null) return;
    const guard = `approve:${session.key}`;
    if (!claim(guard)) return;
    const { key, api } = session;
    const caseId = caseData.id;
    let attemptedCall = false;
    try {
      let authorization = caseData.authorization;
      // A different purpose is a different plan, so it needs its own authorization.
      const samePurpose = (authorization?.purpose ?? "request_refund") === (purpose ?? "request_refund");
      if (authorization === null || authorization.revision !== caseData.revision || !samePurpose) {
        dispatch({ type: "approval/started", key, stage: "authorizing" });
        const authorized = await api.authorize(caseId, caseData.revision, purpose);
        dispatch({ type: "approval/authorized", key, caseData: authorized, liveCapable: latest.current.liveCapable, at: nowIso() });
        adoptCase(key, authorized);
        authorization = authorized.authorization;
        if (authorization === null) throw new Error("The server accepted the approval but returned no authorization.");
      } else {
        dispatch({ type: "approval/started", key, stage: "dispatching" });
      }
      // One requestId per authorization, kept in this tab's session storage: a retry,
      // or a reload in the middle of the request, reaches the server with the same id
      // and gets the stored attempt back instead of a second call. The id is read
      // here rather than with useStableRequestId because the authorization only
      // exists once authorize has answered inside this same click.
      const requestId = getOrCreateRequestId(browserSessionStorage(), `call:${caseId}:${authorization.id}`);
      attemptedCall = true;
      const placed = await api.startCall(caseId, { authorizationId: authorization.id, requestId });
      dispatch({ type: "approval/dispatched", key, call: placed, liveCapable: latest.current.liveCapable, at: nowIso() });
    } catch (error) {
      dispatch({ type: "approval/failed", key, error: toUiError(error) });
    } finally {
      release(guard);
    }
    // After any call attempt, read the case: a new call starts the polling, and a
    // refused dispatch can still have left a stored attempt to show.
    if (attemptedCall) await fetchCase(key, api, caseId);
  }, [adoptCase, claim, fetchCase, release]);

  const answerDecision = useCallback(
    async (decisionId: string, optionId: string) => {
      const session = latest.current.active;
      const record = session?.decisions[decisionId];
      if (!session || session.caseId === null || !record || record.status !== "pending") return;
      const guard = `decision:${decisionId}`;
      if (!claim(guard)) return;
      const { key, api } = session;
      const caseId = session.caseId;
      dispatch({ type: "decision/answering", key, decisionId, optionId });
      try {
        const live = await api.answerDecision(caseId, record.callId, decisionId, optionId);
        dispatch({ type: "decision/answered", key, decisionId, optionId, live, at: nowIso() });
        adoptLive(key, live);
      } catch (error) {
        const failure = toUiError(error);
        // The server no longer takes an answer; the card then says what happened instead.
        if (failure.kind === "decision_resolved" || failure.kind === "call_ended" || failure.kind === "not_found") {
          dispatch({ type: "decision/closed", key, decisionId, at: nowIso() });
          void latest.current.liveCall.refresh();
        } else {
          dispatch({ type: "decision/failed", key, decisionId, error: failure });
        }
      } finally {
        release(guard);
      }
    },
    [adoptLive, claim, release],
  );

  const dismissDecision = useCallback((decisionId: string) => {
    const session = latest.current.active;
    if (session) dispatch({ type: "decision/dismissed", key: session.key, decisionId });
  }, []);

  const stepIn = useCallback(async () => {
    const session = latest.current.active;
    const target = session ? currentCall(session.caseData, session.startedCall) : null;
    if (!session || session.caseId === null || !target) return;
    const guard = `join:${session.key}`;
    if (!claim(guard)) return;
    const { key, api } = session;
    const caseId = session.caseId;
    dispatch({ type: "join/started", key });
    try {
      const live = await api.stepIn(caseId, target.id);
      dispatch({ type: "join/succeeded", key, live, at: nowIso() });
      adoptLive(key, live);
    } catch (error) {
      dispatch({ type: "join/failed", key, error: toUiError(error) });
    } finally {
      release(guard);
    }
  }, [adoptLive, claim, release]);

  const leaveCall = useCallback(() => {
    const session = latest.current.active;
    const live = session?.live ?? null;
    if (!session || !live || !(live.userJoined || live.phase === "user_joined")) return;
    // Neither the contract nor the V2 proposal has a leave endpoint. The agent
    // takes the call back when the join window closes; until the server's phase
    // moves on, the call screen says it is handing back.
    dispatch({ type: "join/handed-back", key: session.key, callId: live.callId, at: nowIso() });
  }, []);

  const downloadPacket = useCallback(async () => {
    const session = latest.current.active;
    if (!session || session.caseId === null) return;
    const guard = `packet:${session.key}`;
    if (!claim(guard)) return;
    const { key, api } = session;
    const caseId = session.caseId;
    dispatch({ type: "packet/started", key });
    try {
      const blob = await api.downloadPacket(caseId);
      saveBlob(blob, packetFileName(session));
      dispatch({ type: "packet/finished", key, error: null });
    } catch (error) {
      dispatch({ type: "packet/finished", key, error: toUiError(error) });
    } finally {
      release(guard);
    }
  }, [claim, release]);

  const deliverSummary = useCallback(
    async (session: CaseSession, text: string, destination: SummaryDestination, autoCallId: string | null) => {
      if (session.caseId === null) return;
      const guard = `summary:${session.key}`;
      if (!claim(guard)) return;
      const { key, api } = session;
      dispatch({ type: "summary/sending", key, text, autoCallId });
      try {
        const delivery = await api.sendSummary(session.caseId, destination);
        dispatch({ type: "summary/sent", key, delivery });
        // The fixture logs the send on the case timeline; read it now.
        void fetchCase(key, api, session.caseId);
      } catch (error) {
        dispatch({ type: "summary/failed", key, error: toUiError(error) });
      } finally {
        release(guard);
      }
    },
    [claim, fetchCase, release],
  );

  const sendSummary = useCallback(
    (text: string) => {
      const session = latest.current.active;
      if (!session || session.caseId === null) return;
      const destination = inferDestination(text);
      if (destination === null) {
        dispatch({ type: "summary/edited", key: session.key, text });
        dispatch({
          type: "summary/failed",
          key: session.key,
          error: toUiError(new ApiRequestError(400, "BAD_REQUEST", DESTINATION_MESSAGE, ["to"])),
        });
        return;
      }
      void deliverSummary(session, text, destination, null);
    },
    [deliverSummary],
  );

  const editSummaryDestination = useCallback((text: string) => {
    const session = latest.current.active;
    if (session) dispatch({ type: "summary/edited", key: session.key, text });
  }, []);

  const resetSummary = useCallback(() => {
    const session = latest.current.active;
    if (session) dispatch({ type: "summary/reset", key: session.key });
  }, []);

  // Once the call completes with a transcript, send it to the email on file, once per call.
  const autoSend = summaryAutoSend(active);
  const autoCallId = autoSend?.callId ?? null;
  useEffect(() => {
    const session = latest.current.active;
    const target = summaryAutoSend(session);
    if (!session || !target || target.callId !== autoCallId) return;
    void deliverSummary(session, target.destination.to, target.destination, target.callId);
  }, [autoCallId, deliverSummary]);

  const selectCase = useCallback((key: string | null) => {
    selectionVersion.current += 1;
    dispatch({ type: "session/selected", key });
  }, []);

  // Picker changes apply to the next case, so the new-case view opens at once:
  // the next message then starts that case instead of becoming a note on an old one.
  const setScenario = useCallback((next: FixtureScenario | null) => {
    setScenarioState(next);
    if (latest.current.active !== null) dispatch({ type: "session/selected", key: null });
  }, []);

  const setFixtureSettings = useCallback((next: FixtureSettings) => {
    setFixtureSettingsState(next);
    if (latest.current.active !== null) dispatch({ type: "session/selected", key: null });
  }, []);

  const live = active && call && active.live?.callId === call.id ? active.live : null;

  return {
    apiMode,
    scenario,
    setScenario,
    fixtureSettings,
    setFixtureSettings,
    sessions: state.sessions,
    active,
    capabilities,
    call,
    live,
    liveError: active?.liveError ?? null,
    pendingDecision: pendingDecision(active),
    activeMs: active?.activeMs ?? state.unassignedActiveMs,
    selectCase,
    send,
    retryCreate,
    saveFacts,
    reloadCase,
    retryUpdates,
    approve,
    answerDecision,
    dismissDecision,
    stepIn,
    leaveCall,
    downloadPacket,
    sendSummary,
    editSummaryDestination,
    resetSummary,
  };
}
