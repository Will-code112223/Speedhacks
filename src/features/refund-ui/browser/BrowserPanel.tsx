"use client";

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import type { BrowserCommand, BrowserRun, RuntimeReadiness } from "../../../contracts/browser";
import type { CaseV1 } from "../../../contracts/case";
import { Button, Field, Pill } from "../ui/primitives";
import { browserArtifactUrl, createBrowserApi, type BrowserApi } from "./client";
import { startBrowserFrames, type BrowserFrameState } from "./frames";
import { browserHosts, browserStartUrl, createBrowserSession, type BrowserSessionState } from "./session";
import styles from "./BrowserPanel.module.css";

export interface BrowserPanelProps { caseData: CaseV1; visible: boolean; api?: BrowserApi; }

export default function BrowserPanel({ caseData, visible, api: suppliedApi }: BrowserPanelProps) {
  const api = useMemo(() => suppliedApi ?? createBrowserApi(), [suppliedApi]);
  const session = useMemo(() => createBrowserSession(caseData.id, api, { getItem: (key) => window.sessionStorage.getItem(key), setItem: (key, value) => window.sessionStorage.setItem(key, value), removeItem: (key) => window.sessionStorage.removeItem(key) }), [caseData.id, api]);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getServerSnapshot);
  const [runtime, setRuntime] = useState<RuntimeReadiness | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [retryRuntime, setRetryRuntime] = useState(0);
  const [pageVisible, setPageVisible] = useState(true);
  const watching = visible && pageVisible;

  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState !== "hidden");
    update(); document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  useEffect(() => {
    const abort = new AbortController(); void session.recover(abort.signal);
    return () => { abort.abort(); session.dispose(); };
  }, [session]);
  useEffect(() => {
    const abort = new AbortController();
    setRuntimeError(null);
    setRuntime(null);
    void api.readiness(abort.signal).then((value) => { if (!abort.signal.aborted) setRuntime(value); }).catch((error: unknown) => { if (!abort.signal.aborted) setRuntimeError(error instanceof Error ? error.message : "Browser configuration is unavailable."); });
    return () => abort.abort();
  }, [api, retryRuntime]);
  useEffect(() => {
    if (!watching || !state.run) return;
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => { await session.refresh(abort.signal); if (!abort.signal.aborted) timer = setTimeout(poll, 1500); };
    void poll(); return () => { abort.abort(); clearTimeout(timer); };
  }, [watching, state.run?.id, session]);

  const canStart = caseData.mode === "live" && runtime?.browser.ready === true && !state.recoveryBlocked;
  return <BrowserPanelView caseData={caseData} state={state} runtime={runtime} runtimeError={runtimeError} canStart={canStart} watching={watching} api={api} onRetryRuntime={() => setRetryRuntime((value) => value + 1)} onStart={async (task, url, hosts) => {
    await session.start({ caseId: caseData.id, expectedRevision: caseData.revision, requestId: state.request?.requestId ?? crypto.randomUUID(), task, startUrl: url, allowedHosts: hosts });
  }} onCommand={(command) => void session.command(command)} onRefresh={() => void session.refresh()} onNewTask={() => session.newTask()} />;
}

interface BrowserPanelViewProps {
  caseData: CaseV1;
  state: BrowserSessionState;
  runtime: RuntimeReadiness | null;
  runtimeError: string | null;
  canStart: boolean;
  watching: boolean;
  api: BrowserApi;
  onRetryRuntime: () => void;
  onStart: (task: string, url: string, hosts: string[]) => Promise<void>;
  onCommand: (command: BrowserCommand) => void;
  onRefresh: () => void;
  onNewTask: () => void;
}

const statusLabels: Record<BrowserRun["status"], string> = { starting: "Starting browser", running: "Running", needs_approval: "Approval required", needs_login: "Sign-in needed", completed: "Completed", failed: "Failed", cancelled: "Stopped", uncertain: "Action outcome unknown" };
const terminal = new Set<BrowserRun["status"]>(["completed", "failed", "cancelled"]);

export function BrowserPanelView(props: BrowserPanelViewProps) {
  const { caseData, state, runtime, runtimeError, watching, api, onCommand, onRefresh } = props;
  const id = useId();
  const run = state.run;
  const pending = run?.pendingAction;
  return <section className={styles.panel} aria-label="Browser task">
    <header className={styles.header}><h2>Browser</h2>{run ? <Pill tone={run.status === "failed" || run.status === "uncertain" ? "danger" : run.status === "needs_approval" || run.status === "needs_login" ? "warning" : "neutral"}>{statusLabels[run.status]}</Pill> : null}</header>
    <div className={styles.body}>
      {state.recovering ? <p className={styles.note} role="status">Checking for a saved browser task…</p> : null}
      {!run && !state.recovering ? <>
        {runtimeError ? <div className={styles.error} role="alert"><p>{runtimeError}</p><Button size="small" onClick={props.onRetryRuntime}>Check configuration</Button></div> : null}
        {runtime && !runtime.browser.ready ? <div className={styles.notice}><strong>Browser setup needed</strong><p>{runtime.browser.missing.join(", ") || "The browser service is not configured."}</p><Button size="small" variant="ghost" onClick={props.onRetryRuntime}>Check again</Button></div> : null}
        {!runtime && !runtimeError ? <p className={styles.note}>Checking browser configuration…</p> : null}
        {caseData.mode !== "live" ? <p className={styles.notice}>Start a new live case to use the browser.</p> : null}
        <StartForm caseData={caseData} state={state} canStart={props.canStart} onStart={props.onStart} />
      </> : null}
      {state.error ? <div className={styles.error} role="alert"><p>{state.error}</p>{run ? <Button size="small" onClick={onRefresh} disabled={state.busy}>Refresh status</Button> : null}</div> : null}
      {run ? <>
        <div className={styles.location}><span>{run.pageTitle || "Browser window"}</span><span title={run.currentUrl ?? run.startUrl}>{run.currentUrl ?? run.startUrl}</span></div>
        <BrowserFrame run={run} visible={watching} api={api} />
        <p className={styles.message} role="status">{run.message}</p>
        {run.status === "needs_login" ? <div className={styles.notice}><strong>Sign in in the browser window</strong><p>Use the browser opened on this computer. Return here when sign-in is complete.</p><Button onClick={() => onCommand({ command: "resume" })} busy={state.busy} busyLabel="Resuming browser" disabled={state.commandNeedsRefresh}>Resume after sign-in</Button></div> : null}
        {run.status === "needs_approval" && pending ? <section className={styles.approval} aria-labelledby={`${id}-approval`}>
          <h3 id={`${id}-approval`}>Approve the next action</h3><p>{pending.description}</p>
          <dl><dt>Action</dt><dd>{pending.kind}</dd><dt>Target</dt><dd>{pending.target}</dd>{pending.value !== null ? <><dt>Value</dt><dd className={styles.actionValue}>{pending.value}</dd></> : null}{pending.artifactId ? <><dt>Document</dt><dd>{run.artifacts.find((artifact) => artifact.id === pending.artifactId)?.name ?? pending.artifactId}</dd></> : null}</dl>
          <div className={styles.actions}><Button variant="primary" onClick={() => onCommand({ command: "approve", pendingActionId: pending.id, observationId: pending.observationId })} busy={state.busy} busyLabel="Sending approval" disabled={state.commandNeedsRefresh}>Approve action</Button><Button onClick={() => onCommand({ command: "reject", pendingActionId: pending.id })} disabled={state.busy || state.commandNeedsRefresh}>Reject</Button></div>
        </section> : null}
        {run.status === "uncertain" ? <div className={styles.notice}><strong>Check the browser before continuing.</strong><p>The previous action may have completed. No automatic retry will be made.</p></div> : null}
        <div className={styles.actions}><Button variant="ghost" size="small" onClick={onRefresh} disabled={state.busy}>Refresh status</Button>{terminal.has(run.status) ? <Button size="small" onClick={props.onNewTask} disabled={state.busy}>New browser task</Button> : <Button variant="secondary" size="small" onClick={() => onCommand({ command: "cancel" })} disabled={state.busy}>Stop browser task</Button>}</div>
        {run.artifacts.length ? <section className={styles.artifacts} aria-label="Browser documents"><h3>Documents</h3><ul>{run.artifacts.map((artifact) => <li key={artifact.id}>{browserArtifactUrl(artifact.downloadUrl) ? <a href={browserArtifactUrl(artifact.downloadUrl)!} download={artifact.name}>{artifact.name}</a> : <span>{artifact.name} · download unavailable</span>}<span>{Math.ceil(artifact.sizeBytes / 1024)} KB</span></li>)}</ul></section> : null}
        <details className={styles.history}><summary>Action history · {run.events.length}</summary>{run.events.length ? <ol>{run.events.map((event) => <li key={event.id}><time dateTime={event.at}>{event.at.replace("T", " ").replace(/\.\d{3}Z$/, " UTC")}</time><p>{event.message}</p></li>)}</ol> : <p className={styles.note}>No actions recorded yet.</p>}</details>
      </> : null}
    </div>
  </section>;
}

function StartForm({ caseData, state, canStart, onStart }: Pick<BrowserPanelViewProps, "caseData" | "state" | "canStart" | "onStart">) {
  const id = useId();
  const [task, setTask] = useState(caseData.reason);
  const [url, setUrl] = useState(browserStartUrl(caseData.merchant.name));
  const [extraHosts, setExtraHosts] = useState("");
  const [error, setError] = useState<string | null>(null);
  const request = state.request;
  async function submit(event: FormEvent) {
    event.preventDefault(); if (state.busy || !canStart) return;
    if (request) { await onStart(request.task, request.startUrl, request.allowedHosts); return; }
    const target = browserHosts(url, extraHosts);
    if (!task.trim() || !target) { setError("Enter a task, a valid HTTPS URL, and domain names without paths."); return; }
    setError(null); await onStart(task.trim(), target.url, target.hosts);
  }
  return <form className={styles.form} onSubmit={(event) => void submit(event)}>
    <label htmlFor={`${id}-task`}>Task</label><textarea id={`${id}-task`} value={request?.task ?? task} onChange={(event) => setTask(event.target.value)} disabled={Boolean(request) || state.busy} rows={3} maxLength={3000} />
    <Field id={`${id}-url`} label="Starting website" type="url" value={request?.startUrl ?? url} placeholder="https://" onChange={(event) => setUrl(event.target.value)} disabled={Boolean(request) || state.busy} autoComplete="off" />
    <details className={styles.hosts}><summary>Additional allowed domains</summary><Field id={`${id}-hosts`} label="Domains, separated by commas" value={request?.allowedHosts.join(", ") ?? extraHosts} onChange={(event) => setExtraHosts(event.target.value)} disabled={Boolean(request) || state.busy} placeholder="accounts.example.com" autoComplete="off" /></details>
    <p className={styles.note}>Confirm the website before starting. Sign-in and actions that send information pause for your review.</p>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    <Button type="submit" variant="primary" busy={state.busy} busyLabel="Starting browser" disabled={!canStart}>{request ? "Retry same browser request" : "Start browser task"}</Button>
  </form>;
}

export function BrowserFrame({ run, visible, api }: { run: BrowserRun; visible: boolean; api: BrowserApi }) {
  const [{ frame, error }, setFrameState] = useState<BrowserFrameState>({ frame: null, error: null });
  const stream = useRef<ReturnType<typeof startBrowserFrames> | null>(null);
  useEffect(() => {
    if (!visible || !run.frameAvailable || run.status === "needs_login") { setFrameState({ frame: null, error: null }); return; }
    const active = startBrowserFrames({ runId: run.id, api, onChange: setFrameState, poll: run.status !== "completed" });
    stream.current = active;
    return () => { active.stop(); stream.current = null; };
  }, [api, run.id, run.frameAvailable, run.status === "needs_login", run.status === "completed", visible]);
  return <figure className={styles.frame}>
    {frame && visible ? <img src={frame.url} alt={`Browser page: ${run.pageTitle || run.currentUrl || "current page"}`} onError={() => stream.current?.invalidate()} /> : <div className={styles.frameEmpty}>{!visible || run.status === "needs_login" ? "View paused" : error ? "View paused" : run.frameAvailable ? "Loading browser view…" : "No browser frame yet"}</div>}
    <figcaption>{run.status === "needs_login" ? "Screen capture is paused during sign-in." : !visible ? "View paused" : error ? error : frame ? `${run.status === "completed" ? "Final" : "Latest"} browser frame · read-only` : "Waiting for a real browser screenshot."}</figcaption>
  </figure>;
}
