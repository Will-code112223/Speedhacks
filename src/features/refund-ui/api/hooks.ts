"use client";

/**
 * React bindings for the CaseApi. Server state is authoritative: the hooks
 * keep the newest server response, drop replies that arrive out of order,
 * poll only while something can change on its own, and stop on unmount.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CaseV1 } from "../../../contracts/case";
import { ActiveTimeMeter, type ActiveTimeReading } from "./active-time";
import { isTransientError, shouldPollCase, shouldPollLiveCall } from "./polling";
import { browserSessionStorage, getOrCreateRequestId } from "./request-id";
import type { CaseApi, LiveCallV2 } from "./types";

// ---------------------------------------------------------------------------
// A server resource polled while `keepPolling` holds
// ---------------------------------------------------------------------------

type Slot<T> = { key: string | null; error: Error | null } & ({ loaded: false } | { loaded: true; value: T });

interface PolledResource<T> {
  value: T | undefined;
  error: Error | null;
  refresh: () => Promise<void>;
  replace: (next: T) => void;
  polling: boolean;
}

function usePolledResource<T>(
  key: string | null,
  load: (() => Promise<T>) | null,
  keepPolling: (value: T) => boolean,
  intervalMs: number,
): PolledResource<T> {
  const [slot, setSlot] = useState<Slot<T>>({ key, error: null, loaded: false });
  // Replies are applied in request order; one older than what is on screen is dropped.
  const order = useRef({ issued: 0, applied: 0 });

  const refresh = useCallback(async (): Promise<void> => {
    if (key === null || load === null) return;
    const ticket = ++order.current.issued;
    try {
      const value = await load();
      if (ticket <= order.current.applied) return;
      order.current.applied = ticket;
      setSlot({ key, error: null, loaded: true, value });
    } catch (err) {
      if (ticket <= order.current.applied) return;
      const error = err instanceof Error ? err : new Error(String(err));
      setSlot((prev) => (prev.key === key ? { ...prev, error } : { key, error, loaded: false }));
    }
  }, [key, load]);

  const replace = useCallback(
    (next: T): void => {
      if (key === null) return;
      order.current.applied = ++order.current.issued;
      setSlot({ key, error: null, loaded: true, value: next });
    },
    [key],
  );

  // First load per key. Replies still in flight for a previous key are dropped.
  useEffect(() => {
    const tickets = order.current;
    void refresh();
    return () => {
      tickets.applied = tickets.issued;
    };
  }, [refresh]);

  const current: Slot<T> = slot.key === key ? slot : { key, error: null, loaded: false };
  const polling =
    key !== null &&
    current.loaded &&
    keepPolling(current.value) &&
    (current.error === null || isTransientError(current.error));

  // Every new reply or error re-arms a single timer, so polls never overlap.
  useEffect(() => {
    if (!polling) return;
    const timer = setTimeout(() => void refresh(), intervalMs);
    return () => clearTimeout(timer);
  }, [polling, slot, refresh, intervalMs]);

  return {
    value: current.loaded ? current.value : undefined,
    error: current.error,
    refresh,
    replace,
    polling,
  };
}

// ---------------------------------------------------------------------------
// Case
// ---------------------------------------------------------------------------

export interface CasePollingOptions {
  /** Poll interval while a call is in flight. Default 2500 ms. */
  intervalMs?: number;
}

export interface CasePolling {
  case: CaseV1 | null;
  error: Error | null;
  /** Fetch now. Call it after startCall so polling sees the new call. */
  refresh: () => Promise<void>;
  /** Adopt a case returned by createCase, patchCase or authorize as the latest server state. */
  replace: (next: CaseV1) => void;
  /** True while a call is in flight and the hook is polling. */
  polling: boolean;
}

/**
 * Loads the case, then polls GET case only while its status is `calling` or a
 * call is active (including dispatch_unknown). Stops on terminal states, on
 * non-retryable errors and on unmount; keeps the last case on screen through
 * transient errors.
 */
export function useCasePolling(api: CaseApi, caseId: string | null, options: CasePollingOptions = {}): CasePolling {
  const load = useMemo(() => (caseId === null ? null : () => api.getCase(caseId)), [api, caseId]);
  const resource = usePolledResource(caseId, load, shouldPollCase, options.intervalMs ?? 2500);
  const replaceResource = resource.replace;
  const replace = useCallback(
    (next: CaseV1): void => {
      if (next.id === caseId) replaceResource(next);
    },
    [caseId, replaceResource],
  );
  return {
    case: resource.value ?? null,
    error: resource.error,
    refresh: resource.refresh,
    replace,
    polling: resource.polling,
  };
}

// ---------------------------------------------------------------------------
// Live call (V2 proposal)
// ---------------------------------------------------------------------------

export interface LiveCallOptions {
  /** Poll interval until the call ends. Default 1000 ms. */
  intervalMs?: number;
}

export interface LiveCallState {
  /** Null until loaded, when unsupported, or while the call has no live record. */
  liveCall: LiveCallV2 | null;
  error: Error | null;
  /** Null until capabilities resolve; false when the backend has no live call record. */
  supported: boolean | null;
  refresh: () => Promise<void>;
  /** Adopt the live call returned by stepIn or answerDecision. */
  replace: (next: LiveCallV2) => void;
  polling: boolean;
}

/**
 * Polls the live call record while its phase is not `ended`. A null record
 * means the call has none yet (dispatch pending or unknown) and keeps polling,
 * like the case does for dispatch_unknown. Pass a null callId to stop.
 */
export function useLiveCall(
  api: CaseApi,
  caseId: string | null,
  callId: string | null,
  options: LiveCallOptions = {},
): LiveCallState {
  const [capability, setCapability] = useState<{ api: CaseApi; liveCall: boolean } | null>(null);
  useEffect(() => {
    let alive = true;
    api.capabilities().then(
      (c) => {
        if (alive) setCapability({ api, liveCall: c.liveCall });
      },
      () => {
        if (alive) setCapability({ api, liveCall: false });
      },
    );
    return () => {
      alive = false;
    };
  }, [api]);
  const supported = capability !== null && capability.api === api ? capability.liveCall : null;

  const key = supported === true && caseId !== null && callId !== null ? `${caseId}/${callId}` : null;
  const load = useMemo(
    () => (key === null || caseId === null || callId === null ? null : () => api.getLiveCall(caseId, callId)),
    [api, key, caseId, callId],
  );
  const resource = usePolledResource<LiveCallV2 | null>(key, load, shouldPollLiveCall, options.intervalMs ?? 1000);
  const replaceResource = resource.replace;
  const replace = useCallback(
    (next: LiveCallV2): void => {
      if (next.callId === callId) replaceResource(next);
    },
    [callId, replaceResource],
  );
  return {
    liveCall: resource.value ?? null,
    error: resource.error,
    supported,
    refresh: resource.refresh,
    replace,
    polling: resource.polling,
  };
}

// ---------------------------------------------------------------------------
// Active user time
// ---------------------------------------------------------------------------

const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;

export interface ActiveTime {
  /** Seconds measured while the page had focus and the user acted in the last 10 s. */
  activeSeconds: number;
  /** Wall-clock seconds measured, waiting included. */
  elapsedSeconds: number;
  running: boolean;
  /** Starts or resumes measuring; totals accumulate across start/stop pairs. */
  start: () => void;
  stop: () => void;
  reset: () => void;
}

/**
 * The honest "user minutes" metric: time the user actually spent, measured
 * separately from elapsed waiting. It reports measurements only; it never
 * derives savings figures.
 */
export function useActiveTime(): ActiveTime {
  const [meter] = useState(() => new ActiveTimeMeter());
  const [reading, setReading] = useState<ActiveTimeReading>({ activeMs: 0, elapsedMs: 0, running: false });
  const sync = useCallback(() => setReading(meter.read(performance.now())), [meter]);

  useEffect(() => {
    const visible = (): boolean => document.visibilityState === "visible";
    const onFocus = (): void => meter.setFocused(performance.now(), visible());
    const onBlur = (): void => meter.setFocused(performance.now(), false);
    const onVisibility = (): void => meter.setFocused(performance.now(), visible() && document.hasFocus());
    const onActivity = (): void => meter.recordActivity(performance.now());
    const listen = { capture: true, passive: true } as const;
    onVisibility();
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, onActivity, listen);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, onActivity, listen);
    };
  }, [meter]);

  useEffect(() => {
    if (!reading.running) return;
    const timer = setInterval(sync, 1000);
    return () => clearInterval(timer);
  }, [reading.running, sync]);

  const start = useCallback(() => {
    meter.start(performance.now());
    sync();
  }, [meter, sync]);
  const stop = useCallback(() => {
    meter.stop(performance.now());
    sync();
  }, [meter, sync]);
  const reset = useCallback(() => {
    meter.reset(performance.now());
    sync();
  }, [meter, sync]);

  return {
    activeSeconds: Math.floor(reading.activeMs / 1000),
    elapsedSeconds: Math.floor(reading.elapsedMs / 1000),
    running: reading.running,
    start,
    stop,
    reset,
  };
}

// ---------------------------------------------------------------------------
// Request ids
// ---------------------------------------------------------------------------

/**
 * A UUID for `key` that stays the same across retries and reloads in this
 * tab, so a repeated action reaches the server with the same requestId. Scope
 * the key to the action, for example `start-call:${authorizationId}`.
 */
export function useStableRequestId(key: string): string {
  return useMemo(() => getOrCreateRequestId(browserSessionStorage(), key), [key]);
}
