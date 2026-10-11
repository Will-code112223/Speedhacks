"use client";

import { useId, useState } from "react";
import type { CaseV1 } from "../../../contracts/case";
import { labelForServerField } from "../state/facts";
import type { RequestState } from "../state/session";
import { DownloadIcon, FileIcon } from "../ui/icons";
import { Banner, Button, Pill, SourcePill } from "../ui/primitives";
import styles from "./CaseDocuments.module.css";

export interface CaseDocumentsProps {
  caseData: CaseV1;
  fixture: boolean;
  packet: RequestState;
  onDownloadPacket: () => void;
}

/** Copy the actual draft, retaining its preparation-only status outside the UI. */
export function draftText(caseData: CaseV1, fixture: boolean): string | null {
  if (!caseData.draft) return null;
  return [
    "PREPARATION DRAFT — NOT SUBMITTED",
    "This is not an official insurer form.",
    ...(fixture ? ["FICTIONAL DEMO — fixture data"] : []),
    "",
    `Subject: ${caseData.draft.subject}`,
    "",
    caseData.draft.body,
  ].join("\n");
}

export default function CaseDocuments({ caseData, fixture, packet, onDownloadPacket }: CaseDocumentsProps) {
  const headingId = useId();
  const draftHeadingId = useId();
  const [copyStatus, setCopyStatus] = useState<{ text: string; message: string } | null>(null);
  const text = draftText(caseData, fixture);

  async function copyDraft() {
    if (text === null) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus({ text, message: "Draft copied." });
    } catch {
      setCopyStatus({ text, message: "Copy was unavailable. Select the draft text below, or download the packet." });
    }
  }

  return (
    <section className={styles.documents} aria-labelledby={headingId} data-testid="case-documents">
      <header className={styles.header}>
        <div>
          <h3 id={headingId} className={styles.heading}>Your documents</h3>
        </div>
        <SourcePill fixture={fixture} simulated={caseData.mode === "simulated"} />
      </header>

      <p className={styles.note}>
        Preparation draft, not an official insurer form. No claim has been submitted.
      </p>

      {fixture ? <p className={styles.fixtureNotice}>Do not submit simulated data to an insurer.</p> : null}

      {caseData.missingFields.length > 0 ? (
        <div className={styles.missing} data-testid="document-missing-fields">
          <h4>Information still needed</h4>
          <ul>
            {caseData.missingFields.map((field, index) => <li key={`${field}-${index}`}>{labelForServerField(field)}</li>)}
          </ul>
          <p>Update the facts above. Unknown details are not filled in for you.</p>
        </div>
      ) : null}

      <article className={styles.paper} aria-labelledby={draftHeadingId} data-testid="request-document">
        <div className={styles.documentHeader}>
          <span className={styles.documentType}><FileIcon /> Request draft</span>
          <Pill>Not submitted</Pill>
        </div>
        {caseData.draft ? (
          <>
            <h4 id={draftHeadingId} className={styles.subject}>{caseData.draft.subject}</h4>
            <div className={styles.body} data-testid="document-body">{caseData.draft.body}</div>
          </>
        ) : (
          <>
            <h4 id={draftHeadingId} className={styles.subject}>No draft available yet</h4>
            <p className={styles.empty}>
              {caseData.missingFields.length > 0
                ? "Complete the missing information to prepare the request. You can download the current case packet now."
                : "This case has not returned a request draft. The current facts and evidence index are still available in the packet."}
            </p>
          </>
        )}
      </article>

      <div className={styles.evidence}>
        <h4>Evidence index <span>{caseData.evidence.length}</span></h4>
        {caseData.evidence.length > 0 ? (
          <ol className={styles.evidenceList}>
            {caseData.evidence.map((file) => (
              <li key={file.id}>
                <span className={styles.fileName}>{file.name}</span>
                <span className={styles.fileType}>{file.mimeType}</span>
              </li>
            ))}
          </ol>
        ) : <p className={styles.empty}>No evidence files are attached to this case.</p>}
        <p className={styles.evidenceNote}>The packet lists evidence files; it does not bundle the original attachments.</p>
      </div>

      <div className={styles.actions}>
        <Button onClick={onDownloadPacket} busy={packet.busy} busyLabel="Preparing the case packet" data-testid="document-packet-download">
          {packet.busy ? null : <DownloadIcon />}
          Download case packet
        </Button>
        {text !== null ? <Button variant="ghost" onClick={() => void copyDraft()}>Copy draft</Button> : null}
      </div>
      <p role="status" className={styles.copyStatus}>{copyStatus?.text === text ? copyStatus?.message : ""}</p>
      {packet.error ? (
        <Banner tone="danger" role="alert" title={packet.error.title}>
          {packet.error.message}
        </Banner>
      ) : null}
    </section>
  );
}
