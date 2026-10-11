"use client";

/**
 * The approval step: a plain confirmation in the chat. It restates who will
 * be called, the amount and the reason, asks for one explicit confirmation,
 * then authorizes the current revision and starts the call.
 *
 * Once a call was placed under it, the step freezes into a short record.
 */

import { useId, useState } from "react";
import type { CallV1, CaseV1 } from "../../../contracts/case";
import { Banner, Button, KeyValueList, Mono, Pill } from "../ui/primitives";
import { formatClock, formatMoney, formatPhone } from "../ui/format";
import type { UiError } from "../state/errors";
import styles from "./ApprovalCard.module.css";

export interface ApprovalCardProps {
  caseData: CaseV1;
  /** The call placed under this approval, when it was placed. */
  placedCall: CallV1 | null;
  /** Whether this is the step the person can act on (the newest open one). */
  current: boolean;
  busy: boolean;
  stage: "authorizing" | "dispatching" | null;
  error: UiError | null;
  /** Calls are blocked while the facts card has unsaved edits or a conflict. */
  blockedReason: string | null;
  onApprove: () => void;
  /** Offered when the server says the case belongs to a different mode. */
  onStartNewCase?: () => void;
}

function errorBody(error: UiError) {
  if (error.kind === "missing_facts" && error.fieldLabels.length > 0) {
    return (
      <>
        {error.message}
        <ul className={styles.errorFields}>
          {error.fieldLabels.map((label) => (
            <li key={label}>{label}</li>
          ))}
        </ul>
      </>
    );
  }
  return error.message;
}

export default function ApprovalCard(props: ApprovalCardProps) {
  const { caseData, placedCall, current, busy, stage, error, blockedReason, onApprove, onStartNewCase } = props;
  const checkboxId = useId();
  const headingId = useId();
  // The confirmation belongs to the revision the person saw; new facts need a new confirmation.
  const [confirmedRevision, setConfirmedRevision] = useState<number | null>(null);
  const confirmed = confirmedRevision === caseData.revision;

  const merchant = caseData.merchant.name ?? "the merchant";
  const phone = formatPhone(caseData.merchant.supportPhone);
  const amount = formatMoney(caseData.amountMinor, caseData.currency);

  if (placedCall) {
    return (
      <div className={styles.record}>
        <Pill tone="success" dot>
          Approved
        </Pill>
        <span>
          You approved the call to {merchant}
          {phone ? (
            <>
              {" "}
              at <Mono>{phone}</Mono>
            </>
          ) : null}
          {caseData.authorization ? ` at ${formatClock(caseData.authorization.approvedAt)}` : ""}.
        </span>
      </div>
    );
  }

  if (!current) return null;

  if (caseData.status === "needs_information" || caseData.missingFields.length > 0) {
    return <p className={styles.waiting}>Fill in the missing facts above, then approve the call here.</p>;
  }

  const authorizedForRevision = caseData.authorization !== null && caseData.authorization.revision === caseData.revision;

  return (
    <section className={styles.card} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.title}>
        Approve the call to {merchant}
        {phone ? (
          <>
            {" "}
            at <Mono>{phone}</Mono>
          </>
        ) : null}
      </h3>

      <KeyValueList
        items={[
          { key: "Amount", value: amount ? <Mono>{amount}</Mono> : null },
          { key: "Reason", value: caseData.reason },
        ]}
      />

      {authorizedForRevision ? (
        <p className={styles.note}>
          Approved at {formatClock(caseData.authorization!.approvedAt)}. The call has not been placed yet.
        </p>
      ) : null}

      <label className={styles.confirm} htmlFor={checkboxId}>
        <input
          id={checkboxId}
          type="checkbox"
          className={styles.checkbox}
          checked={confirmed}
          disabled={busy}
          onChange={(event) => setConfirmedRevision(event.target.checked ? caseData.revision : null)}
          data-testid="approve-checkbox"
        />
        <span>I confirm these facts are accurate and I authorize this call</span>
      </label>

      {error ? (
        <Banner
          tone={error.kind === "unreachable" || error.retryable ? "warning" : "danger"}
          role="alert"
          title={error.title}
          testId="error-banner"
          actions={
            error.kind === "mode_mismatch" && onStartNewCase ? (
              <Button size="small" variant="secondary" onClick={onStartNewCase}>
                Start a new case
              </Button>
            ) : null
          }
        >
          {errorBody(error)}
        </Banner>
      ) : null}

      {blockedReason ? <p className={styles.note}>{blockedReason}</p> : null}

      <div className={styles.actions}>
        <Button
          variant="primary"
          onClick={onApprove}
          disabled={!confirmed || blockedReason !== null}
          busy={busy}
          busyLabel={stage === "dispatching" ? "Placing the call" : "Approving"}
          data-testid="approve-button"
        >
          {error?.retryable ? "Try again" : "Approve this call"}
        </Button>
        {busy ? (
          <span className={styles.stage} aria-hidden="true">
            {stage === "dispatching" ? "Placing the call" : "Approving"}
          </span>
        ) : null}
      </div>
    </section>
  );
}
