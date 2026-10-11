"use client";

/**
 * React binding for InsurerApi.lookupInsurer. Only the newest lookup may set
 * state: a reply for an older name, api or refresh is dropped, and nothing is
 * set after unmount. Pass a stable api (create it once, not on every render).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { InsurerLookup } from "./insurer-types";
import { insurerQuery, type InsurerApi } from "./insurers";

export type InsurerLookupStatus = "idle" | "loading" | "found" | "not_found" | "error";

export interface InsurerLookupState {
  /** Set only when status is "found". */
  insurer: InsurerLookup | null;
  /** "idle" while api or name is null or blank; "not_found" includes names that match more than one insurer. */
  status: InsurerLookupStatus;
  /** Set only when status is "error". */
  error: Error | null;
  /** Looks the same name up again. Does nothing while idle. */
  refresh: () => void;
}

/** A finished lookup and the inputs it answered. */
interface Settled {
  api: InsurerApi;
  query: string;
  attempt: number;
  insurer: InsurerLookup | null;
  error: Error | null;
}

export function useInsurerLookup(api: InsurerApi | null, name: string | null): InsurerLookupState {
  const query = insurerQuery(name);
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<Settled | null>(null);
  // Advanced when a lookup starts and when its effect is cleaned up (new
  // input, refresh, unmount, StrictMode replay), so a reply is applied only
  // while its ticket is still the latest.
  const sequence = useRef({ latest: 0 });

  useEffect(() => {
    if (api === null || query === null) return;
    const counter = sequence.current;
    const ticket = ++counter.latest;
    const settle = (insurer: InsurerLookup | null, error: Error | null): void => {
      if (ticket === counter.latest) setSettled({ api, query, attempt, insurer, error });
    };
    api.lookupInsurer(query).then(
      (insurer) => settle(insurer, null),
      (cause: unknown) => settle(null, cause instanceof Error ? cause : new Error(String(cause))),
    );
    return () => {
      counter.latest++;
    };
  }, [api, query, attempt]);

  const refresh = useCallback(() => setAttempt((n) => n + 1), []);

  if (api === null || query === null) return { insurer: null, status: "idle", error: null, refresh };
  // A result for other inputs is never shown; until this one settles, it is loading.
  const current =
    settled !== null && settled.api === api && settled.query === query && settled.attempt === attempt ? settled : null;
  if (current === null) return { insurer: null, status: "loading", error: null, refresh };
  if (current.error !== null) return { insurer: null, status: "error", error: current.error, refresh };
  if (current.insurer === null) return { insurer: null, status: "not_found", error: null, refresh };
  return { insurer: current.insurer, status: "found", error: null, refresh };
}
