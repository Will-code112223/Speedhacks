/**
 * The resolution plan: GET /api/cases/:id/plan?purpose=<CallPurpose> in http
 * mode. Read-only on the server; it never authorizes anything. Fixture mode
 * builds the same plan locally with the server's own pure function (no
 * insurer registry in the browser), so ?api=fixture keeps working offline.
 */

import { useCallback, useEffect, useState } from "react";
import type { CaseV1, ResolutionPlanV1 } from "../../../contracts/case";
import { buildResolutionPlan } from "../../../server/cases/resolution";
import { ApiRequestError, ApiUnreachableError, type UiCallPurpose } from "./types";
import { isRecord, readApiError } from "./validate";

export interface FetchPlanOptions {
  baseUrl?: string;
  /** For tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

function isPlan(v: unknown): v is ResolutionPlanV1 {
  if (!isRecord(v) || v.version !== 1 || typeof v.purpose !== "string" || typeof v.ready !== "boolean") return false;
  const call = v.call;
  return (
    Array.isArray(v.before) &&
    Array.isArray(v.after) &&
    Array.isArray(v.insurerTerms) &&
    Array.isArray(v.missingFields) &&
    isRecord(call) &&
    typeof call.goal === "string" &&
    Array.isArray(call.steps) &&
    Array.isArray(call.questions) &&
    Array.isArray(call.willNotDo)
  );
}

/** The server's plan for this case. purpose null = the case's suggested purpose. */
export async function fetchResolutionPlan(caseId: string, purpose: UiCallPurpose | null, options: FetchPlanOptions = {}): Promise<ResolutionPlanV1> {
  const base = (options.baseUrl ?? "").replace(/\/+$/, "");
  const query = purpose ? `?purpose=${encodeURIComponent(purpose)}` : "";
  const fetchImpl = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  let res: Response;
  try {
    res = await fetchImpl(`${base}/api/cases/${encodeURIComponent(caseId)}/plan${query}`, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (cause) {
    if ((cause as { name?: string })?.name === "AbortError") throw cause;
    throw new ApiUnreachableError("The server could not be reached.");
  }
  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch {
    throw new ApiUnreachableError(`The server answered HTTP ${res.status} with a response that is not JSON.`);
  }
  if (!res.ok) {
    const parsed = readApiError(body);
    if (!parsed) throw new ApiRequestError(res.status, "CONTRACT_VIOLATION", `The server answered HTTP ${res.status} without an error body.`);
    throw new ApiRequestError(res.status, parsed.code, parsed.message, parsed.fields);
  }
  const plan = isRecord(body) ? body.plan : undefined;
  if (!isPlan(plan)) throw new ApiRequestError(res.status, "CONTRACT_VIOLATION", "The server answered without a readable plan.");
  return plan;
}

/** Fixture mode: the same pure builder the server runs, without registry rules. */
export function localResolutionPlan(caseData: CaseV1, purpose: UiCallPurpose | null): ResolutionPlanV1 {
  return buildResolutionPlan({
    caseDoc: caseData,
    purpose: caseData.authorization?.purpose ?? purpose ?? caseData.suggestedPurpose ?? "request_refund",
    insurer: null,
  });
}

export interface ResolutionPlanState {
  plan: ResolutionPlanV1 | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

/**
 * The plan for the case on screen. Refetches when the case, its revision, its
 * authorization or the chosen purpose changes; the last good plan stays shown
 * while the next one loads.
 */
export function useResolutionPlan(caseData: CaseV1 | null, purpose: UiCallPurpose | null, fixture: boolean): ResolutionPlanState {
  const [state, setState] = useState<{ key: string; plan: ResolutionPlanV1 | null; error: string | null; loading: boolean }>({
    key: "",
    plan: null,
    error: null,
    loading: false,
  });
  const [attempt, setAttempt] = useState(0);
  const caseId = caseData?.id ?? null;
  const revision = caseData?.revision ?? 0;
  const authorizationId = caseData?.authorization?.id ?? null;
  const evidenceCount = caseData?.evidence.length ?? 0;
  const key = caseId ? `${caseId}|${revision}|${authorizationId ?? ""}|${purpose ?? ""}|${evidenceCount}|${attempt}` : "";

  // Fixture plans are computed, not fetched.
  const local = fixture && caseData ? localResolutionPlan(caseData, purpose) : null;

  useEffect(() => {
    if (fixture || !caseId) return;
    const controller = new AbortController();
    setState((current) => ({ ...current, key, loading: true, error: null }));
    fetchResolutionPlan(caseId, purpose, { signal: controller.signal }).then(
      (plan) => {
        if (!controller.signal.aborted) setState({ key, plan, error: null, loading: false });
      },
      (err: unknown) => {
        if (controller.signal.aborted) return;
        const message = err instanceof Error ? err.message : "The plan could not be loaded.";
        setState((current) => ({ ...current, key, loading: false, error: message }));
      },
    );
    return () => controller.abort();
    // key covers caseId, revision, authorization, purpose and retries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, fixture]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  if (local) return { plan: local, loading: false, error: null, retry };
  // A plan for another case is never shown under this one.
  const sameCase = state.plan !== null && caseId !== null && state.key.startsWith(`${caseId}|`);
  return { plan: sameCase ? state.plan : null, loading: state.loading, error: state.error, retry };
}
