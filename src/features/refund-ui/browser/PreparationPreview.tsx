"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { BrowserRun } from "../../../contracts/browser";
import { Button } from "../ui/primitives";
import { BrowserFrame } from "./BrowserPanel";
import { BrowserApiError, createBrowserApi, isBrowserRun } from "./client";
import styles from "./BrowserPanel.module.css";

export interface PreparationRequest { expectedRevision: number; requestId: string }

/** A lost response is retried with the same identity, never a new browser run. */
export async function startPreparation(caseId: string, request: PreparationRequest, fetcher: typeof fetch = (...args) => fetch(...args)): Promise<BrowserRun> {
  let response: Response;
  try {
    response = await fetcher(`/api/cases/${encodeURIComponent(caseId)}/preparation`, {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(request), signal: AbortSignal.timeout(30_000),
    });
  } catch { throw new BrowserApiError("The preparation response was interrupted. Retry the same request to check its result."); }
  let value: unknown;
  try { value = await response.json(); } catch { throw new BrowserApiError("The preparation service returned unreadable data. Retry the same request to check its result."); }
  if (!response.ok) {
    const detail = value && typeof value === "object" && "error" in value ? value.error : null;
    const message = detail && typeof detail === "object" && "message" in detail && typeof detail.message === "string" ? detail.message : "Preparation could not start. Refresh the case and try again.";
    throw new BrowserApiError(message, response.status);
  }
  const run = value && typeof value === "object" && "run" in value ? value.run : null;
  if (!isBrowserRun(run) || run.caseId !== caseId || run.caseRevision !== request.expectedRevision || run.requestId !== request.requestId) throw new BrowserApiError("The preparation service returned mismatched run data. Retry the same request to check its result.");
  return run;
}

const ended = new Set<BrowserRun["status"]>(["completed", "failed", "cancelled"]);
interface SavedPreparation { request: PreparationRequest; runId: string | null }
export function parseSavedPreparation(raw: string): SavedPreparation {
  const value = JSON.parse(raw) as SavedPreparation;
  if (!value || !value.request || !Number.isInteger(value.request.expectedRevision) || value.request.expectedRevision < 1 || typeof value.request.requestId !== "string" || !value.request.requestId || !(value.runId === null || typeof value.runId === "string" && Boolean(value.runId))) throw new Error("Saved preparation identity is invalid. Reload the case before preparing again.");
  return { request: { expectedRevision: value.request.expectedRevision, requestId: value.request.requestId }, runId: value.runId };
}

export default function PreparationPreview({ caseId, caseRevision, ready }: { caseId: string; caseRevision: number; ready: boolean }) {
  const api = useMemo(() => createBrowserApi(), []);
  const pending = useRef<PreparationRequest | null>(null);
  const inFlight = useRef(false);
  const [run, setRun] = useState<BrowserRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [recovering, setRecovering] = useState(true);
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const storageKey = `recourse:preparation:${caseId}`;

  useEffect(() => {
    const abort = new AbortController();
    setRecovering(true);
    async function recover() {
      try {
        const raw = window.sessionStorage.getItem(storageKey);
        if (!raw) { setRecoveryBlocked(false); return; }
        const saved = parseSavedPreparation(raw);
        pending.current = saved.runId ? null : saved.request;
        try {
          const previous = saved.runId ? await api.get(saved.runId, abort.signal) : await api.find(caseId, saved.request.requestId, abort.signal);
          if (abort.signal.aborted) return;
          if (previous.caseId !== caseId || previous.caseRevision !== saved.request.expectedRevision || previous.requestId !== saved.request.requestId || saved.runId && previous.id !== saved.runId) throw new Error("Saved preparation returned a different case or request. Refresh to check its status.");
          window.sessionStorage.setItem(storageKey, JSON.stringify({ request: saved.request, runId: previous.id }));
          setRun(previous); pending.current = null; setUncertain(false); setError(null); setRecoveryBlocked(false);
        } catch (failure) {
          if (abort.signal.aborted) return;
          if (!saved.runId) {
            setUncertain(true); setRecoveryBlocked(false); setError("A previous preparation request needs checking. Retry the same request to recover it.");
          } else throw failure;
        }
      } catch (failure) {
        if (abort.signal.aborted) return;
        setRecoveryBlocked(true); setError(failure instanceof Error ? failure.message : "Could not recover the preparation browser.");
      } finally { if (!abort.signal.aborted) setRecovering(false); }
    }
    void recover();
    return () => abort.abort();
  }, [api, caseId, storageKey, recoveryAttempt]);

  useEffect(() => {
    if (!run || ended.has(run.status) || run.status === "uncertain") return;
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const runId = run.id;
    async function poll() {
      try {
        const next = await api.get(runId, abort.signal);
        if (abort.signal.aborted) return;
        if (next.caseId !== caseId || next.id !== runId || next.caseRevision !== run!.caseRevision || next.requestId !== run!.requestId) throw new Error("The browser returned a different case or request. Refresh to check its status.");
        setRun(next); setError(null);
        if (ended.has(next.status) || next.status === "uncertain") return;
      } catch (failure) {
        if (abort.signal.aborted) return;
        setError(failure instanceof Error ? failure.message : "Could not refresh preparation status.");
      }
      timer = setTimeout(poll, 1000);
    }
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [api, caseId, run?.id, run?.status, refresh]);

  async function start() {
    if (inFlight.current || recovering || recoveryBlocked || (!ready && !pending.current) || (run && !ended.has(run.status))) return;
    inFlight.current = true; setBusy(true); setError(null);
    pending.current ??= { expectedRevision: caseRevision, requestId: crypto.randomUUID() };
    try {
      window.sessionStorage.setItem(storageKey, JSON.stringify({ request: pending.current, runId: null }));
      const prepared = await startPreparation(caseId, pending.current);
      window.sessionStorage.setItem(storageKey, JSON.stringify({ request: pending.current, runId: prepared.id }));
      setRun(prepared);
      pending.current = null; setUncertain(false);
    } catch (failure) {
      const ambiguous = !(failure instanceof BrowserApiError) || failure.status === null || failure.status >= 500;
      if (!ambiguous) { pending.current = null; window.sessionStorage.removeItem(storageKey); }
      setUncertain(ambiguous);
      setError(failure instanceof Error ? failure.message : "Preparation could not start.");
    } finally { inFlight.current = false; setBusy(false); }
  }

  const current = run?.caseRevision === caseRevision;
  if (!ready && !run && !busy && !error) return null;
  return <section aria-label="Recourse preparation browser">
    <p className={styles.note}>Recourse preparation — not an insurer website</p>
    {!run || (ended.has(run.status) && (!current || run.status === "failed")) ? <Button variant="primary" size="small" disabled={recovering || recoveryBlocked || (!ready && !uncertain)} busy={busy} busyLabel="Starting preparation browser" onClick={() => void start()}>{uncertain ? "Retry same preparation request" : run?.status === "failed" ? "Retry preparation" : "Prepare in browser"}</Button> : null}
    {recovering ? <p className={styles.note} role="status">Checking for a saved preparation browser…</p> : null}
    {recoveryBlocked ? <Button size="small" onClick={() => setRecoveryAttempt(value => value + 1)}>Recover preparation status</Button> : null}
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {run ? <>
      <BrowserFrame run={run} visible={run.status !== "uncertain"} api={api} />
      <p className={styles.message} role="status">{run.status === "completed" ? "Packet ready for review · Not submitted" : run.message}</p>
      {!current ? <p className={styles.notice}>This view uses revision {run.caseRevision}. Prepare the current revision to include newer evidence.</p> : null}
      {error && !ended.has(run.status) ? <Button size="small" onClick={() => setRefresh(value => value + 1)}>Refresh preparation status</Button> : null}
    </> : null}
  </section>;
}
