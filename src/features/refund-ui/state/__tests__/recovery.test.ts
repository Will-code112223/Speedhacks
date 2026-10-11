import { describe, expect, it, vi } from "vitest";
import type { CaseV1 } from "../../../../contracts/case";
import { createFixtureCaseApi } from "../../api/fixture";
import { createHttpCaseApi } from "../../api/http";
import { shouldPollCase } from "../../api/polling";
import type { KeyValueStore } from "../../api/request-id";
import { ApiRequestError, ApiUnreachableError, type CaseApi } from "../../api/types";
import { RECOVERY_KEY, createCaseRecovery, readRecoveryIndex, recoverCaseSessions, recoveryIndex, writeRecoveryIndex } from "../recovery";
import { initialSessionsState, sessionsReducer } from "../session";

const ID = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const THIRD = "00000000-0000-4000-8000-000000000003";
const AT = "2026-10-11T20:00:00.000Z";
function storage(initial: string | null = null) {
  const values = new Map(initial === null ? [] : [[RECOVERY_KEY, initial]]);
  return { getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }) };
}
async function savedCase(id = ID): Promise<CaseV1> {
  const fixture = createFixtureCaseApi({ scenario: "duplicate_charge" });
  const value = await fixture.createCase({ summary: "Synthetic duplicate-charge case" });
  return { ...value, id, mode: "live", createdAt: AT, updatedAt: AT };
}
function readOnlyApi(getCase: CaseApi["getCase"]): CaseApi {
  const forbidden = vi.fn(async (): Promise<never> => { throw new Error("Recovery must never mutate server state"); });
  return { mode: "http", getCase: vi.fn(getCase), createCase: forbidden, patchCase: forbidden,
    authorize: forbidden, startCall: forbidden, downloadPacket: forbidden, capabilities: forbidden,
    getLiveCall: forbidden, stepIn: forbidden, answerDecision: forbidden, sendSummary: forbidden };
}

describe("HTTP tab recovery", () => {
  it("stores only validated IDs and explicit selection, never supplied case details", () => {
    const target = storage();
    writeRecoveryIndex(target, "http", { ...recoveryIndex([ID, ID, OTHER], ID),
      transcript: "PRIVATE_TRANSCRIPT", credentials: "PRIVATE_CREDENTIALS", customer: { name: "PRIVATE_CUSTOMER" } } as ReturnType<typeof recoveryIndex>);
    expect(JSON.parse(target.getItem(RECOVERY_KEY)!)).toEqual({ version: 1, apiMode: "http", caseIds: [ID, OTHER], activeCaseId: ID });
    expect(target.getItem(RECOVERY_KEY)).not.toContain("PRIVATE_");
    writeRecoveryIndex(target, "http", recoveryIndex([ID], null));
    expect(readRecoveryIndex(target, "http").activeCaseId).toBeNull();
  });

  it("ignores malformed, oversized, unexpected-version and fixture storage", () => {
    for (const value of ["{", "null", "[]", "x".repeat(20_000),
      JSON.stringify({ version: 2, apiMode: "http", caseIds: [ID], activeCaseId: ID }),
      JSON.stringify({ version: 1, apiMode: "fixture", caseIds: [ID], activeCaseId: ID }),
      JSON.stringify({ version: 1, apiMode: "http", caseIds: ["../../private"], activeCaseId: null }),
      JSON.stringify({ version: 1, apiMode: "http", caseIds: Array(51).fill(ID), activeCaseId: ID }),
    ]) expect(readRecoveryIndex(storage(value), "http")).toEqual(recoveryIndex([], null));
  });

  it("retains the selected case when trimming a long history to the storage bound", () => {
    const ids = Array.from({ length: 60 }, () => crypto.randomUUID());
    const index = recoveryIndex(ids, ids[59]!);
    expect(index.caseIds).toHaveLength(50);
    expect(index.caseIds).toContain(ids[59]);
    expect(index.activeCaseId).toBe(ids[59]);
  });

  it("fixture mode never reads or changes HTTP storage and never restores into a fixture engine", async () => {
    const target = storage(JSON.stringify(recoveryIndex([ID], ID)));
    expect(readRecoveryIndex(target, "fixture").caseIds).toEqual([]);
    writeRecoveryIndex(target, "fixture", recoveryIndex([], null));
    expect(target.getItem).not.toHaveBeenCalled();
    expect(target.setItem).not.toHaveBeenCalled();
    const api = { ...readOnlyApi(async () => savedCase()), mode: "fixture" as const };
    expect(await recoverCaseSessions(api, recoveryIndex([ID], ID))).toEqual({ entries: [], activeCaseId: null });
    expect(api.getCase).not.toHaveBeenCalled();
  });

  it("unavailable browser storage does not throw or trigger reads", async () => {
    const blocked: KeyValueStore = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
    expect(() => writeRecoveryIndex(blocked, "http", recoveryIndex([ID], ID))).not.toThrow();
    const api = readOnlyApi(async () => savedCase());
    await recoverCaseSessions(api, readRecoveryIndex(blocked, "http"));
    expect(api.getCase).not.toHaveBeenCalled();
  });

  it("reload restores an active call from one authenticated server GET without authorizing or dispatching", async () => {
    const caseData = await savedCase();
    const authorizationId = crypto.randomUUID();
    caseData.authorization = { id: authorizationId, revision: caseData.revision, approvedAt: AT };
    caseData.status = "calling";
    caseData.calls = [{ id: crypto.randomUUID(), requestId: crypto.randomUUID(), authorizationId,
      providerCallId: "synthetic_provider_id", mode: "live", state: "in_progress", transcript: null,
      error: null, createdAt: AT, updatedAt: AT }];
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      expect(init?.credentials).toBe("same-origin");
      return Response.json({ case: caseData });
    });
    const api = createHttpCaseApi({ fetch });
    const result = await recoverCaseSessions(api, recoveryIndex([ID], ID));
    const state = sessionsReducer(initialSessionsState, { type: "sessions/recovered", api, ...result,
      preserveSelection: false, liveCapable: true, at: AT });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(state.sessions).toHaveLength(1);
    const active = state.sessions.find(session => session.key === state.activeKey)!;
    expect(active.caseData?.calls[0]?.id).toBe(caseData.calls[0]!.id);
    expect(active.caseData?.mode).toBe("live");
    expect(active.approval.busy).toBe(false);
    expect(active.create.busy).toBe(false);
    expect(shouldPollCase(active.caseData!)).toBe(true);
    expect(active.thread.some(item => item.kind === "approval" && item.callId === null)).toBe(false);
  });

  it("removes missing/forbidden IDs but retains transient failures for an explicit retry or reload", async () => {
    const ids = [ID, OTHER, THIRD];
    const api = readOnlyApi(async id => {
      if (id === ID) throw new ApiRequestError(404, "NOT_FOUND", "Not found");
      if (id === OTHER) throw new ApiRequestError(403, "FORBIDDEN", "Forbidden");
      throw new ApiUnreachableError("Network unavailable");
    });
    const result = await recoverCaseSessions(api, recoveryIndex(ids, THIRD));
    expect(api.getCase).toHaveBeenCalledTimes(3);
    expect(api.createCase).not.toHaveBeenCalled();
    expect(api.authorize).not.toHaveBeenCalled();
    expect(api.startCall).not.toHaveBeenCalled();
    expect(result.entries.map(entry => entry.caseId)).toEqual([THIRD]);
    expect(result.entries[0]?.error?.retryable).toBe(true);
    const state = sessionsReducer(initialSessionsState, { type: "sessions/recovered", api, ...result,
      preserveSelection: false, liveCapable: false, at: AT });
    expect(state.sessions[0]?.caseData).toBeNull();
    expect(state.sessions[0]?.caseId).toBe(THIRD);
    expect(state.sessions[0]?.pollError?.retryable).toBe(true);
    expect(state.sessions[0]?.create.busy).toBe(false);
    const saved = storage();
    writeRecoveryIndex(saved, "http", recoveryIndex(state.sessions.map(session => session.caseId!), THIRD));
    expect(readRecoveryIndex(saved, "http").caseIds).toEqual([THIRD]);
  });

  it("does not pretend an HTTP simulated case is live and rejects mismatched response IDs", async () => {
    const value = await savedCase();
    const api = readOnlyApi(async id => id === ID ? { ...value, mode: "simulated" } : value);
    const result = await recoverCaseSessions(api, recoveryIndex([ID, OTHER], ID));
    expect(result.entries[0]?.caseData?.mode).toBe("simulated");
    expect(result.entries[1]?.caseData).toBeNull();
    expect(result.entries[1]?.error?.kind).toBe("contract_violation");
  });

  it("does not overwrite a new case, duplicate hydration, or explicit New case selection during recovery", async () => {
    const value = await savedCase();
    const api = readOnlyApi(async () => value);
    const result = await recoverCaseSessions(api, recoveryIndex([ID], ID));
    const action = { type: "sessions/recovered" as const, api, ...result,
      preserveSelection: true, liveCapable: false, at: AT };
    const newState = sessionsReducer(initialSessionsState, { type: "session/started", api,
      key: "new-session", scenario: null, text: "New request", attachments: [], notice: null, at: AT });
    const hydrated = sessionsReducer(newState, action);
    expect(hydrated.activeKey).toBe("new-session");
    expect(hydrated.sessions[0]?.summary).toBe("New request");
    expect(sessionsReducer(hydrated, action).sessions).toHaveLength(2);
    const newCase = sessionsReducer(hydrated, { type: "session/selected", key: null });
    expect(sessionsReducer(newCase, action).activeKey).toBeNull();
    const deliberateBlank = sessionsReducer(initialSessionsState, { ...action, activeCaseId: null, preserveSelection: false });
    expect(deliberateBlank.activeKey).toBeNull();
    expect(deliberateBlank.sessions).toHaveLength(1);
  });

  it("limits concurrent reads to four and performs no automatic retry after server errors", async () => {
    const ids = Array.from({ length: 9 }, () => crypto.randomUUID());
    let running = 0;
    let maximum = 0;
    const api = readOnlyApi(async () => {
      running += 1;
      maximum = Math.max(maximum, running);
      await new Promise(resolve => setTimeout(resolve, 1));
      running -= 1;
      throw new ApiRequestError(503, "UNAVAILABLE", "Unavailable");
    });
    const result = await recoverCaseSessions(api, recoveryIndex(ids, ids[0]!));
    expect(maximum).toBe(4);
    expect(api.getCase).toHaveBeenCalledTimes(9);
    expect(result.entries).toHaveLength(9);
  });

  it("a hanging read becomes a retryable placeholder without blocking other recovered cases", async () => {
    const value = await savedCase(OTHER);
    const api = readOnlyApi(id => id === ID ? new Promise<CaseV1>(() => {}) : Promise.resolve(value));
    const result = await recoverCaseSessions(api, recoveryIndex([ID, OTHER], ID), 5);
    expect(result.entries[0]?.error?.retryable).toBe(true);
    expect(result.entries[1]?.caseData?.id).toBe(OTHER);
    expect(api.getCase).toHaveBeenCalledTimes(2);
  });

  it("shows saved pointers immediately and the active call before unrelated history settles", async () => {
    const active = await savedCase(THIRD);
    active.status = "calling";
    active.calls = [{ id: crypto.randomUUID(), requestId: crypto.randomUUID(), authorizationId: crypto.randomUUID(),
      providerCallId: "synthetic_active_call", mode: "live", state: "dispatch_unknown", transcript: null,
      error: null, createdAt: AT, updatedAt: AT }];
    let resolveActive!: (value: CaseV1) => void;
    const activeRead = new Promise<CaseV1>(resolve => { resolveActive = resolve; });
    const ids = [ID, OTHER, crypto.randomUUID(), crypto.randomUUID(), THIRD];
    const api = readOnlyApi(id => id === THIRD ? activeRead : new Promise<CaseV1>(() => {}));
    vi.useFakeTimers();
    try {
      const task = createCaseRecovery(api, recoveryIndex(ids, THIRD), 20);
      let finished = false;
      void task.done.then(() => { finished = true; });
      let state = initialSessionsState;
      let preserveSelection = false;
      const unsubscribe = task.subscribe(result => {
        state = sessionsReducer(state, { type: "sessions/recovered", api, ...result,
          preserveSelection, liveCapable: true, at: AT });
      });
      expect(state.sessions).toHaveLength(5);
      expect(state.activeKey).toBe(`http:${THIRD}`);
      expect(state.sessions.find(session => session.key === state.activeKey)?.recoveryPending).toBe(true);
      expect(api.getCase).toHaveBeenNthCalledWith(1, THIRD, expect.any(AbortSignal));

      resolveActive(active);
      await vi.advanceTimersByTimeAsync(0);
      const restored = state.sessions.find(session => session.key === state.activeKey)!;
      expect(restored.caseData?.calls[0]?.state).toBe("dispatch_unknown");
      expect(restored.recoveryPending).toBe(false);
      expect(shouldPollCase(restored.caseData!)).toBe(true);
      expect(finished).toBe(false);
      expect(state.sessions.filter(session => session.recoveryPending)).toHaveLength(4);

      // A deliberate New case view must survive every subsequent history result.
      preserveSelection = true;
      state = sessionsReducer(state, { type: "session/selected", key: null });
      const target = storage();
      writeRecoveryIndex(target, "http", recoveryIndex(state.sessions.map(session => session.caseId!), null));
      expect(readRecoveryIndex(target, "http").activeCaseId).toBeNull();
      await vi.advanceTimersByTimeAsync(50);
      await task.done;
      expect(state.activeKey).toBeNull();
      expect(api.getCase).toHaveBeenCalledTimes(5);
      expect(api.authorize).not.toHaveBeenCalled();
      expect(api.startCall).not.toHaveBeenCalled();
      unsubscribe();
    } finally { vi.useRealTimers(); }
  });

  it("replays progress across effect cleanup/setup without restarting reads or dispatching", async () => {
    const value = await savedCase();
    let resolve!: (value: CaseV1) => void;
    const api = readOnlyApi(() => new Promise<CaseV1>(done => { resolve = done; }));
    const task = createCaseRecovery(api, recoveryIndex([ID], ID));
    const detached = vi.fn();
    const unsubscribe = task.subscribe(detached);
    expect(detached.mock.calls[0]?.[0].entries[0]?.caseData).toBeNull();
    unsubscribe();
    resolve(value);
    await task.done;
    const mounted = vi.fn();
    const finish = task.subscribe(mounted);
    expect(detached).toHaveBeenCalledTimes(1);
    expect(mounted.mock.calls[0]?.[0].entries[0]?.caseData).toEqual(value);
    expect(api.getCase).toHaveBeenCalledTimes(1);
    expect(api.authorize).not.toHaveBeenCalled();
    expect(api.startCall).not.toHaveBeenCalled();
    finish();
  });

  it("aborts stalled HTTP reads before reusing pool slots, including the actual fetch signal", async () => {
    const ids = Array.from({ length: 9 }, () => crypto.randomUUID());
    const signals: AbortSignal[] = [];
    let running = 0;
    let maximum = 0;
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const signal = init?.signal;
      if (!signal) throw new Error("Recovery GET must carry cancellation to fetch");
      signals.push(signal);
      running += 1;
      maximum = Math.max(maximum, running);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          running -= 1;
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    });
    vi.useFakeTimers();
    try {
      const api = createHttpCaseApi({ fetch });
      const pending = recoverCaseSessions(api, recoveryIndex(ids, ids[0]!), 10);
      await vi.advanceTimersByTimeAsync(40);
      const result = await pending;
      expect(maximum).toBe(4);
      expect(running).toBe(0);
      expect(signals).toHaveLength(9);
      expect(signals.every(signal => signal.aborted)).toBe(true);
      expect(result.entries.every(entry => entry.error?.code === "UNAVAILABLE" && entry.error.retryable)).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(9);
      expect(fetch.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("retains a new case and its saved selection while recovery removes inaccessible placeholders", async () => {
    const value = await savedCase(OTHER);
    let rejectRead!: (error: Error) => void;
    const api = readOnlyApi(() => new Promise<CaseV1>((_resolve, reject) => { rejectRead = reject; }));
    const task = createCaseRecovery(api, recoveryIndex([ID], ID));
    let state = initialSessionsState;
    let preserveSelection = false;
    const unsubscribe = task.subscribe(result => {
      state = sessionsReducer(state, { type: "sessions/recovered", api, ...result,
        preserveSelection, liveCapable: true, at: AT });
    });
    preserveSelection = true;
    state = sessionsReducer(state, { type: "session/started", key: "new-case", api,
      scenario: null, text: "My new case", attachments: [], notice: null, at: AT });
    state = sessionsReducer(state, { type: "create/succeeded", key: "new-case", caseData: value, liveCapable: true, at: AT });
    const target = storage();
    writeRecoveryIndex(target, "http", recoveryIndex(state.sessions.map(session => session.caseId!), OTHER));
    expect(readRecoveryIndex(target, "http").activeCaseId).toBe(OTHER);
    expect(readRecoveryIndex(target, "http").caseIds).toContain(OTHER);
    rejectRead(new ApiRequestError(403, "FORBIDDEN", "Forbidden"));
    await task.done;
    expect(state.activeKey).toBe("new-case");
    expect(state.sessions.map(session => session.caseId)).toEqual([OTHER]);
    expect(state.sessions[0]?.caseData).toEqual(value);
    unsubscribe();
  });

  it("does not erase a newer case read or local notes when late recovery results arrive", async () => {
    const value = await savedCase();
    const api = readOnlyApi(async () => value);
    const action = { type: "sessions/recovered" as const, api,
      entries: [{ caseId: ID, caseData: null, error: null }], activeCaseId: ID,
      preserveSelection: false, liveCapable: true, at: AT };
    let state = sessionsReducer(initialSessionsState, action);
    state = sessionsReducer(state, { type: "note/added", key: `http:${ID}`, text: "Keep my note", reply: "Noted", at: AT });
    const latest = { ...value, revision: value.revision + 1 };
    state = sessionsReducer(state, { type: "case/received", key: `http:${ID}`, caseData: latest, liveCapable: true, at: AT });
    state = sessionsReducer(state, { ...action, entries: [{ caseId: ID, caseData: value, error: null }] });
    state = sessionsReducer(state, { ...action, entries: [], discardedCaseIds: [ID], preserveSelection: true });
    expect(state.sessions[0]?.caseData?.revision).toBe(latest.revision);
    expect(state.sessions[0]?.recoveryPending).toBe(false);
    expect(state.sessions[0]?.thread.some(item => item.kind === "user" && item.text === "Keep my note")).toBe(true);
    expect(state.activeKey).toBe(`http:${ID}`);
  });
});
