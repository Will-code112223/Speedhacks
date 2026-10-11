"use client";

/**
 * React binding for InsurerApi.lookupInsurer. Only the newest lookup may set
 * state: a reply for an older name, api or refresh is dropped, and nothing is
 * set after unmount. Pass a stable api (create it once, not on every render).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { InsurerLookup } from "./insurer-types";
import { insurerQuery, type InsurerApi, type InsurerWebLookup, type InsurerWebLookupApi } from "./insurers";

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

// ---------------------------------------------------------------------------
// Web lookup, on demand
// ---------------------------------------------------------------------------

export type InsurerWebLookupStatus = "idle" | "loading" | "found" | "empty" | "error";

export interface InsurerWebLookupState {
  status: InsurerWebLookupStatus;
  /** Set only when status is "found". */
  lookup: InsurerWebLookup | null;
  /** Set only when status is "error". */
  error: Error | null;
  /** Starts a lookup for the current name. Does nothing while api or name is blank. */
  run: () => void;
}

interface WebSettled {
  key: string;
  lookup: InsurerWebLookup | null;
  error: Error | null;
}

/**
 * React binding for InsurerWebLookupApi.webLookupInsurer. Runs only when asked
 * (it searches the web). A result belongs to the name and region it answered:
 * when either changes, the state returns to idle. Pass a stable api.
 */
export function useInsurerWebLookup(
  api: InsurerWebLookupApi | null,
  name: string | null,
  region: string | null = null,
): InsurerWebLookupState {
  const query = insurerQuery(name);
  const key = `${query ?? ""}|${region?.trim() ?? ""}`;
  const [pending, setPending] = useState<string | null>(null);
  const [settled, setSettled] = useState<WebSettled | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(() => {
    if (api === null || query === null) return;
    const ticket = ++sequence.current;
    setPending(key);
    const settle = (lookup: InsurerWebLookup | null, error: Error | null): void => {
      if (!mounted.current || ticket !== sequence.current) return;
      setPending(null);
      setSettled({ key, lookup, error });
    };
    api.webLookupInsurer(query, region).then(
      (lookup) => settle(lookup, null),
      (cause: unknown) => settle(null, cause instanceof Error ? cause : new Error(String(cause))),
    );
  }, [api, query, region, key]);

  if (api === null || query === null) return { status: "idle", lookup: null, error: null, run };
  if (pending === key) return { status: "loading", lookup: null, error: null, run };
  if (settled === null || settled.key !== key) return { status: "idle", lookup: null, error: null, run };
  if (settled.error !== null) return { status: "error", lookup: null, error: settled.error, run };
  if (settled.lookup === null) return { status: "empty", lookup: null, error: null, run };
  return { status: "found", lookup: settled.lookup, error: null, run };
}
