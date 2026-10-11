"use client";

import { useId } from "react";
import type { CaseEvidence } from "../../../contracts/case";
import type { WorkflowAction } from "../../../contracts/workflow";
import { Button } from "../ui/primitives";
import { workflowBriefUrl } from "./client";
import type { WorkflowController } from "./session";
import styles from "./WorkflowPanel.module.css";

/** Only http(s) contact links are navigable; contact prose is never executable. */
export function publicContactUrl(value: string | null): string | null {
  if (!value) return null;
  try { const parsed = new URL(value); return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed.href : null; } catch { return null; }
}

export default function WorkflowPanel({ controller, evidence = [], onAction, onRetry }: { controller: WorkflowController; evidence?: CaseEvidence[]; onAction?: (action: WorkflowAction) => void; onRetry?: () => void }) {
  const workflow = controller.workflow;
  const headingId = useId();
  const packetReady = workflow?.kind === "auto_insurance" && workflow.analysisStatus === "complete" &&
    workflow.stage === "ready" && workflow.conflicts.length === 0 && !workflow.questions.some(question => question.required) &&
    evidence.length > 0 && !controller.busy && !controller.loading && !controller.error && !controller.uncertain;
  return <section className={styles.panel} aria-label="Case preparation" aria-busy={controller.busy || controller.loading}>
    {controller.loading && !workflow ? <p className={styles.note} role="status">Preparing your questions and action list…</p> : null}
    {controller.error ? <div className={styles.error} role="alert"><p>{controller.error}</p>{controller.uncertain && onRetry ? <Button size="small" variant="primary" onClick={onRetry} busy={controller.busy} busyLabel="Checking previous update">Retry previous update</Button> : null}<Button size="small" variant="secondary" onClick={() => void controller.refresh()} disabled={controller.busy}>Refresh case plan</Button></div> : null}
    {workflow?.analysisStatus === "failed" && !controller.uncertain ? <div className={styles.error} role="alert"><p>Your information is saved, but analysis did not finish.</p><Button size="small" variant="secondary" busy={controller.busy} busyLabel="Analyzing saved information" onClick={() => void controller.analyze()}>Analyze saved information again</Button></div> : null}
    {controller.busy ? <p className={styles.note} role="status">Updating your questions and case brief…</p> : null}
    {workflow ? <>
      <ol className={styles.messages} aria-label="Saved conversation">
        {workflow.messages.map(message => <li key={message.id} className={[styles.message, message.role === "user" ? styles.user : ""].join(" ")}><strong>{message.role === "user" ? "You" : "Recourse"}</strong><span>{message.content}</span></li>)}
      </ol>
      {workflow.conflicts.length ? <div className={styles.error}><strong>Details to clarify</strong><ul>{workflow.conflicts.map((conflict, index) => <li key={index}>{conflict}</li>)}</ul></div> : null}
      {workflow.questions.length ? <section className={styles.section} aria-labelledby={`${headingId}-questions`}><h3 id={`${headingId}-questions`}>Information needed</h3><ol className={styles.questions}>{workflow.questions.map(question => <li key={question.id}>{question.question}{question.required ? null : <small> · Optional</small>}</li>)}</ol></section> : null}
      <section className={styles.section} aria-labelledby={`${headingId}-brief`}>
        <div className={styles.heading}><h3 id={`${headingId}-brief`}>{workflow.kind === "auto_insurance" ? "Insurance packet" : "Case brief"}</h3><a href={workflowBriefUrl(workflow.caseId)} download>Download brief</a></div>
        <details open={workflow.stage === "ready"}><summary>{workflow.brief.title}</summary><p className={styles.brief}>{workflow.brief.body}</p></details>
        <p className={styles.note}>Revision {workflow.caseRevision} · Prepared from your saved information. Review before sharing.</p>
        {evidence.length ? <div aria-label="Saved evidence"><h4>Attached evidence</h4><ul className={styles.questions}>{evidence.map(file => <li key={file.id}>{file.name}</li>)}</ul></div> : null}
        {packetReady ? <section className={styles.section} aria-label="Provider upload review">
          <div className={styles.heading}><h4>Packet prepared{workflow.facts.insuranceProvider?.value ? ` for ${workflow.facts.insuranceProvider.value}` : " for insurer review"}</h4><span className={styles.status}>Not uploaded</span></div>
          <p>Case brief and {evidence.length} saved {evidence.length === 1 ? "attachment" : "attachments"} prepared. Review before provider upload.</p>
          <p className={styles.note}>Provider requirements still need confirmation. This packet remains in Recourse; no files have been sent to the insurer.</p>
        </section> : null}
        {workflow.kind === "auto_insurance" ? <p className={styles.note}>Add requested photos or estimates below to update this packet. Prepared for your review; not submitted to an insurer.</p> : null}
      </section>
      {workflow.contacts.length ? <section className={styles.section} aria-labelledby={`${headingId}-contacts`}><h3 id={`${headingId}-contacts`}>Contacts</h3><ul className={styles.contacts}>{workflow.contacts.map(contact => <li key={contact.id}><strong>{contact.name}</strong><span>{contact.role.replaceAll("_", " ")}{contact.phone ? ` · ${contact.phone}` : ""}</span>{publicContactUrl(contact.url) ? <a href={publicContactUrl(contact.url)!} target="_blank" rel="noopener noreferrer">Open provider website</a> : null}{publicContactUrl(contact.sourceUrl) ? <a href={publicContactUrl(contact.sourceUrl)!} target="_blank" rel="noopener noreferrer">Contact source</a> : null}{contact.requiresConfirmation ? <small className={styles.note}>Confirm this is the right contact before using it.</small> : null}</li>)}</ul></section> : null}
      <section className={styles.section} aria-labelledby={`${headingId}-actions`}><h3 id={`${headingId}-actions`}>Action list</h3><ol className={styles.actions}>{workflow.actions.map(action => <li key={action.id}><div className={styles.heading}><strong>{action.title}</strong><span className={styles.status}>{action.status === "completed" ? "Prepared" : action.status === "ready" ? "Ready for review" : "Information needed"}</span></div><p>{action.description}</p>{action.blockedBy.length ? <p>{action.blockedBy.join(" · ")}</p> : null}{action.status === "ready" && action.type === "document" ? <a href={workflowBriefUrl(workflow.caseId)} download>Download brief</a> : null}{action.call ? <details><summary>Review call plan</summary><p className={styles.brief}>{action.call.brief}</p><p>Recipient: {action.call.to ?? "Contact needed"}</p><p>Purpose: {action.call.purpose}</p><p>Review the recipient and approve one information call before placing it.</p></details> : null}{action.call && onAction ? <Button size="small" variant="secondary" onClick={() => onAction(action)} disabled={controller.busy || controller.loading || controller.uncertain}>Review call</Button> : null}{action.status === "ready" && action.type === "browser" && onAction ? <Button size="small" variant="secondary" onClick={() => onAction(action)} disabled={controller.busy || controller.loading || controller.uncertain}>Open browser task</Button> : null}</li>)}</ol></section>
    </> : null}
  </section>;
}

export function EvidencePicker({ files, onFiles, existing, busy, onUpload }: { files: File[]; onFiles: (files: File[]) => void; existing: boolean; busy: boolean; onUpload: () => void }) {
  const id = useId();
  return <div className={styles.files}>
    <label htmlFor={`${id}-evidence`}>Evidence</label>
    <input id={`${id}-evidence`} data-evidence-input type="file" multiple accept=".pdf,.txt,.png,.jpg,.jpeg,.webp" disabled={busy} onChange={event => { const selected = Array.from(event.currentTarget.files ?? []); if (selected.length) onFiles([...files, ...selected]); event.currentTarget.value = ""; }} />
    {files.length ? <ul>{files.map((file, index) => <li key={`${file.name}-${index}`}><span>{file.name} · {Math.ceil(file.size / 1024)} KB</span><Button variant="ghost" size="small" disabled={busy} onClick={() => onFiles(files.filter((_, candidate) => candidate !== index))} aria-label={`Remove ${file.name}`}>Remove</Button></li>)}</ul> : null}
    {files.length && existing ? <Button size="small" variant="secondary" busy={busy} busyLabel="Reading evidence" onClick={onUpload}>Upload evidence</Button> : null}
    {files.length && !existing ? <span>These files will be attached when you send your request.</span> : null}
  </div>;
}
