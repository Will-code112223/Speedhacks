"use client";

import { useEffect, useId, useMemo, useState, useSyncExternalStore, type FormEvent } from "react";
import type { CaseV1 } from "../../../contracts/case";
import type { CaseWorkflow, WorkflowAction } from "../../../contracts/workflow";
import type { WorkflowCallAttempt, WorkflowCallAuthorization, WorkflowCallAuthorizeRequest } from "../../../contracts/workflow-call";
import { Button, Field, Pill } from "../ui/primitives";
import { createWorkflowCallApi, validCallNumber, workflowCallDownload } from "./call-client";
import { createWorkflowCallSession, hasUnresolvedCall, type WorkflowCallState } from "./call-session";
import styles from "./WorkflowCallPanel.module.css";

export default function WorkflowCallPanel({ caseData, workflow, actionId, visible, onRequestEvidence }: { caseData: CaseV1; workflow: CaseWorkflow | null; actionId?: string; visible: boolean; onRequestEvidence?: () => void }) {
  const session = useMemo(() => createWorkflowCallSession(caseData.id, createWorkflowCallApi(), {
    getItem: key => window.sessionStorage.getItem(key), setItem: (key, value) => window.sessionStorage.setItem(key, value), removeItem: key => window.sessionStorage.removeItem(key),
  }), [caseData.id]);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getServerSnapshot);
  useEffect(() => { const abort = new AbortController(); void session.recover(abort.signal); return () => abort.abort(); }, [session]);
  useEffect(() => {
    if (!visible || state.loading) return;
    const abort = new AbortController();
    const poll = () => { if (!document.hidden) void session.refresh(abort.signal); };
    const interval = setInterval(poll, hasUnresolvedCall(state.data) ? 3000 : 30_000);
    document.addEventListener("visibilitychange", poll);
    return () => { abort.abort(); clearInterval(interval); document.removeEventListener("visibilitychange", poll); };
  }, [session, visible, state.loading, hasUnresolvedCall(state.data)]);
  return <WorkflowCallPanelView caseData={caseData} workflow={workflow} actionId={actionId} state={state} onRequestEvidence={onRequestEvidence}
    onAuthorize={input => void session.authorize(input)} onStart={auth => void session.start(auth)} onSelectAuthorization={session.selectAuthorization}
    onRefresh={() => void session.refresh(undefined, true)} onRetry={() => void session.retry()} />;
}

export interface WorkflowCallPanelViewProps {
  caseData: CaseV1; workflow: CaseWorkflow | null; actionId?: string; state: WorkflowCallState;
  onAuthorize: (input: Omit<WorkflowCallAuthorizeRequest, "requestId">) => void;
  onStart: (authorization: WorkflowCallAuthorization) => void; onSelectAuthorization: (id: string | null) => void;
  onRefresh: () => void; onRetry: () => void;
  onRequestEvidence?: () => void;
}
export function WorkflowCallPanelView({ caseData, workflow, actionId, state, onAuthorize, onStart, onSelectAuthorization, onRefresh, onRetry, onRequestEvidence }: WorkflowCallPanelViewProps) {
  const id = useId();
  const actions = workflow?.actions.filter(action => action.type === "call" && action.call) ?? [];
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => setChosen(null), [actionId]);
  const action = actions.find(item => item.id === (chosen ?? actionId)) ?? actions.find(item => item.call?.role === "insurer") ?? actions[0];
  const authorization = state.data?.authorizations.find(item => item.id === state.selectedAuthorizationId);
  const used = !!authorization && !!state.data?.calls.some(call => call.authorizationId === authorization.id);
  const calls = [...state.data?.calls ?? []].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const available = state.data?.authorizations.filter(auth => auth.caseRevision === caseData.revision && !state.data?.calls.some(call => call.authorizationId === auth.id)) ?? [];
  const blocked = state.loading || state.busy || state.readFailed || state.recoveryBlocked || !!state.pending || hasUnresolvedCall(state.data);
  const ready = caseData.mode === "live" && !!workflow && workflow.caseRevision === caseData.revision && workflow.analysisStatus === "complete" && workflow.conflicts.length === 0;
  return <section className={styles.panel} aria-labelledby={`${id}-title`}>
    <header className={styles.header}><h2 id={`${id}-title`}>Call support</h2><Button variant="ghost" size="small" onClick={onRefresh} disabled={state.loading || state.busy}>Refresh</Button></header>
    <div className={styles.body}>
      {state.loading ? <p className={styles.note} role="status">Checking saved calls…</p> : null}
      {state.error ? <div role="alert" className={styles.error}><p>{state.error}</p>{state.pending ? <Button size="small" onClick={onRetry} busy={state.busy} busyLabel="Checking original request" disabled={state.loading || state.readFailed || state.recoveryBlocked}>{state.pending.kind === "authorize" ? "Retry same approval" : "Retry same call request"}</Button> : null}</div> : null}
      {state.pending?.kind === "start" ? <p className={styles.note}>The call may have started. Refresh or retry only the saved request.</p> : null}
      {calls.length ? <section className={styles.section} aria-label="Saved call results"><h3>Call results</h3>{calls.map((call, index) => <CallOutput key={call.id} call={call} latest={index === 0} onRequestEvidence={workflow?.kind === "auto_insurance" ? onRequestEvidence : undefined} />)}</section> : null}
      {!ready ? <p className={styles.note}>Finish reviewing the current case details before approving a call.</p> : null}
      {authorization && !used ? <section className={styles.section} aria-label="Approved call">
        <div className={styles.heading}><h3>Approved call</h3><Pill>Ready to place</Pill></div>
        <dl className={styles.facts}><dt>Recipient</dt><dd>{authorization.to}</dd><dt>Purpose</dt><dd>Gather information</dd><dt>Maximum duration</dt><dd>{authorization.maxDurationSeconds} seconds</dd></dl>
        <details open><summary>Approved brief</summary><p className={styles.brief}>{authorization.brief}</p></details>
        {authorization.caseRevision !== caseData.revision ? <p className={styles.error}>The case changed after approval. Review and authorize its current brief.</p> : null}
        <p className={styles.note}>This places one real call using Dial credits. The agent identifies itself as AI and asks for information; it does not file a claim.</p>
        <div className={styles.buttons}><Button variant="primary" onClick={() => onStart(authorization)} busy={state.busy} busyLabel="Placing call" disabled={blocked || !ready || authorization.caseRevision !== caseData.revision}>Place live call</Button><Button variant="ghost" onClick={() => onSelectAuthorization(null)} disabled={blocked}>Change call details</Button></div>
      </section> : <>
        {available.length ? <details className={styles.section}><summary>Saved approvals</summary><ul className={styles.approvals}>{available.map(auth => <li key={auth.id}><span>{auth.to} · {auth.maxDurationSeconds} seconds</span><Button size="small" onClick={() => onSelectAuthorization(auth.id)} disabled={blocked}>Review approval</Button></li>)}</ul></details> : null}
        {actions.length ? <section className={styles.section} aria-label="Review a call">
          <h3>Review a call</h3>
          {actions.length > 1 ? <><label htmlFor={`${id}-action`}>Call purpose</label><select id={`${id}-action`} className={styles.select} value={action?.id ?? ""} onChange={event => setChosen(event.target.value)} disabled={blocked}>{actions.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></> : <p className={styles.actionTitle}>{action?.title}</p>}
          {action?.call ? <CallReviewForm key={`${caseData.revision}-${action.id}-${state.pending?.kind === "authorize" ? state.pending.request.requestId : "new"}`} action={action} workflow={workflow!} pending={state.pending?.kind === "authorize" ? state.pending.request : null} disabled={blocked || !ready} busy={state.busy} onAuthorize={onAuthorize} /> : null}
        </section> : !state.loading ? <p className={styles.note}>Prepare a call action in chat to choose a recipient.</p> : null}
      </>}
      {hasUnresolvedCall(state.data) ? <p className={styles.note}>A call is active or its dispatch is unresolved. Check its status before approving another.</p> : null}
    </div>
  </section>;
}
function CallReviewForm({ action, workflow, pending, disabled, busy, onAuthorize }: { action: WorkflowAction; workflow: CaseWorkflow; pending: WorkflowCallAuthorizeRequest | null; disabled: boolean; busy: boolean; onAuthorize: WorkflowCallPanelViewProps["onAuthorize"] }) {
  const id = useId();
  const [phone, setPhone] = useState(pending?.to ?? action.call?.to ?? "");
  const [duration, setDuration] = useState(String(pending?.maxDurationSeconds ?? 300));
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const contacts = workflow.contacts.filter(contact => contact.role === action.call?.role && contact.phone);
  function submit(event: FormEvent) {
    event.preventDefault(); if (disabled) return;
    const seconds = Number(duration);
    if (!validCallNumber(phone.trim()) || !Number.isInteger(seconds) || seconds < 60 || seconds > 3600 || !confirmed) { setError("Confirm a phone number with country code and a duration from 60 to 3600 seconds."); return; }
    setError(null); onAuthorize({ expectedRevision: workflow.caseRevision, actionId: action.id, to: phone.trim(), maxDurationSeconds: seconds, recipientConfirmed: true });
  }
  return <form className={styles.form} onSubmit={submit}>
    <p>{action.call?.purpose}</p>
    <details><summary>Review case brief</summary><p className={styles.brief}>{action.call?.brief}</p></details>
    {contacts.length ? <div className={styles.contacts}><span className={styles.note}>Suggested contacts · confirm before calling</span>{contacts.map(contact => <Button key={contact.id} variant="ghost" size="small" disabled={disabled} onClick={() => { setPhone(contact.phone!); setConfirmed(false); }}>{contact.name} · {contact.phone}</Button>)}</div> : null}
    <Field id={`${id}-recipient`} label="Recipient phone" type="tel" placeholder="+1…" value={phone} autoComplete="off" disabled={disabled} onChange={event => { setPhone(event.target.value); setConfirmed(false); }} hint="Use the provider or a willing participant’s number, including country code." />
    <Field id={`${id}-duration`} label="Maximum duration (seconds)" type="number" min={60} max={3600} step={1} value={duration} disabled={disabled} onChange={event => { setDuration(event.target.value); setConfirmed(false); }} />
    <label className={styles.confirm}><input type="checkbox" checked={confirmed} disabled={disabled} onChange={event => setConfirmed(event.target.checked)} /><span>I confirm this recipient and authorize one information call, up to {Number(duration) || 0} seconds, using Dial credits.</span></label>
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    <Button type="submit" variant="primary" busy={busy} busyLabel="Saving call approval" disabled={disabled || !confirmed}>Authorize call</Button>
    <p className={styles.note}>You’ll review the approved brief before placing the call.</p>
  </form>;
}
const labels: Record<WorkflowCallAttempt["state"], string> = { dispatch_pending: "Preparing call", queued: "Queued", in_progress: "In progress", completed: "Call ended", failed: "Failed", cancelled: "Cancelled", dispatch_unknown: "Dispatch unconfirmed" };
export function CallOutput({ call, latest, onRequestEvidence }: { call: WorkflowCallAttempt; latest: boolean; onRequestEvidence?: () => void }) {
  const [recording, setRecording] = useState(false);
  const [audioError, setAudioError] = useState(false);
  const terminal = ["completed", "failed", "cancelled"].includes(call.state);
  return <details open={latest} className={styles.result}><summary>{call.to} · {labels[call.state]}</summary>
    <div className={styles.resultBody}>
      <div className={styles.heading}><Pill tone={call.state === "failed" || call.state === "dispatch_unknown" ? "warning" : "neutral"}>{labels[call.state]}</Pill>{call.durationSeconds !== null ? <span className={styles.note}>{call.durationSeconds} seconds</span> : null}</div>
      <p className={styles.note}>Started {new Date(call.createdAt).toLocaleString()}</p>
      {call.error ? <p className={styles.error}>{call.error}</p> : null}
      <p className={styles.summary} role={latest ? "status" : undefined}>{call.result.summary}</p>
      {call.result.status === "transcript_pending" ? <p className={styles.note}>The call ended. Its transcript is still being checked.</p> : null}
      {call.result.highlights.length ? <section><h4>From the conversation</h4>{call.result.highlights.map((item, index) => <blockquote key={index}><span className={styles.note}>{item.kind.replaceAll("_", " ")}</span><p>{item.quote}</p></blockquote>)}</section> : null}
      {call.result.nextSteps.length ? <section><h4>Next actions</h4><ul>{call.result.nextSteps.map((step, index) => <li key={index}>{step}</li>)}</ul></section> : null}
      {latest && terminal && call.result.highlights.some(item => item.kind === "documents") && onRequestEvidence ? <Button size="small" variant="primary" onClick={onRequestEvidence}>Add requested documents</Button> : null}
      {call.transcript?.trim() ? <details><summary>Transcript</summary><p className={styles.brief}>{call.transcript}</p><a href={workflowCallDownload(call.caseId, call.id, "transcript")} download>Download transcript</a></details> : <p className={styles.note}>No transcript available yet.</p>}
      {terminal ? <div>{recording ? <><audio className={styles.audio} controls preload="none" src={workflowCallDownload(call.caseId, call.id, "recording")} onError={() => setAudioError(true)} />{audioError ? <p className={styles.note} role="status">No recording is available from Dial yet.</p> : null}</> : <Button size="small" variant="secondary" onClick={() => setRecording(true)}>Load call recording</Button>}</div> : null}
    </div>
  </details>;
}
