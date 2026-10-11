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
import { UI_CALL_PURPOSES, type UiCallPurpose } from "../api/types";
import { Banner, Button, KeyValueList, Mono, Pill } from "../ui/primitives";
import { formatClock, formatMoney, formatPhone } from "../ui/format";
import type { UiError } from "../state/errors";
import { labelForServerField } from "../state/facts";
import { blockingMissingFields, initialPurpose, previewPlan, PURPOSE_LABELS, purposeNeedsAmount } from "../state/purpose";
import styles from "./ApprovalCard.module.css";

export interface ApprovalCardProps {
  caseData: CaseV1;
  /** The call placed under this approval, when it was placed. */
  placedCall: CallV1 | null;
  /** Whether this is the step the person can act on (the newest open one). */
  current: boolean;
  /** Approving dials a real number now (server REFUND_MODE=live over http). */
  live?: boolean;
  /** The person's own request, used to prefill what the call is for. */
  requestText?: string;
  /** Shows what the agent will say and ask, built from the facts and the chosen purpose. */
  planPreview?: boolean;
  busy: boolean;
  stage: "authorizing" | "dispatching" | null;
  error: UiError | null;
  /** Calls are blocked while the facts card has unsaved edits or a conflict. */
  blockedReason: string | null;
  onApprove: (purpose: UiCallPurpose) => void;
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

/** What the call asks for, stated from the chosen purpose and the case's amount. */
function askingFor(purpose: UiCallPurpose, amount: string | null): string | null {
  switch (purpose) {
    case "file_claim":
      return "Claim filed and a claim number";
    case "gather_information":
      return "What is needed to file, and the next step";
    case "request_refund":
      return amount ? `Refund of ${amount} and a reference number` : null;
  }
}

const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

function formatDay(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : dateFormat.format(date);
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Where the number about to be dialed came from, in one sentence. */
function provenance(source: CaseV1["merchant"]["source"]): string {
  if (source?.kind === "user") return "Entered by you.";
  if (!source || source.kind !== "insurer_registry") return "From your documents.";
  const line = source.purpose === "claims" ? "Claims line" : "Customer service line";
  const confidence = source.confidence.replace(/_/g, " ");
  const day = formatDay(source.retrievedAt);
  const host = hostOf(source.sourceUrl);
  const parts = [`${line} from the insurer registry, ${confidence}${day ? ` on ${day}` : ""}`];
  if (host) parts.push(`source ${host}`);
  return `${parts.join(", ")}. Confirm it matches the number on your ID card.`;
}

export default function ApprovalCard(props: ApprovalCardProps) {
  const { caseData, placedCall, current, live = false, requestText, planPreview = false, busy, stage, error, blockedReason, onApprove, onStartNewCase } = props;
  const checkboxId = useId();
  const headingId = useId();
  const purposeName = useId();
  const [purpose, setPurpose] = useState<UiCallPurpose>(() => initialPurpose(caseData, requestText ?? ""));
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

  const missing = blockingMissingFields(caseData, purpose);
  const noPhone = caseData.merchant.supportPhone === null || caseData.merchant.supportPhone.trim() === "";
  const needsAmount = purposeNeedsAmount(purpose);
  const verb = live ? "place" : "approve";

  if (noPhone) {
    return (
      <p className={styles.waiting} data-testid="approval-needs-phone">
        There is no number to call yet. Type any number into Number to call above, for example the one on your insurance ID card, then {verb} the call here.
      </p>
    );
  }

  const purposePicker = (
    <fieldset className={styles.purpose} disabled={busy}>
      <legend className={styles.purposeLegend}>What the call is for</legend>
      <div className={styles.purposeOptions}>
        {UI_CALL_PURPOSES.map((option) => (
          <label key={option} className={[styles.purposeOption, option === purpose ? styles.purposeChosen : ""].join(" ")}>
            <input
              type="radio"
              name={purposeName}
              value={option}
              checked={option === purpose}
              onChange={() => setPurpose(option)}
              className={styles.purposeRadio}
              data-testid={`purpose-${option}`}
            />
            {PURPOSE_LABELS[option]}
          </label>
        ))}
      </div>
    </fieldset>
  );

  if (missing.length > 0) {
    // Another purpose may be ready (no amount is needed to ask what is needed), so the choice stays offered.
    const anotherReady = UI_CALL_PURPOSES.some((option) => blockingMissingFields(caseData, option).length === 0);
    const waiting = (
      <p className={styles.waiting}>
        Fill in the missing facts above ({missing.map(labelForServerField).join(", ").toLowerCase()}), then {verb} the call here.
      </p>
    );
    if (!anotherReady) return waiting;
    return (
      <section className={styles.card} aria-labelledby={headingId}>
        <h3 id={headingId} className={styles.title}>
          What should the call to {merchant} do?
        </h3>
        {purposePicker}
        {waiting}
      </section>
    );
  }

  const authorizedForRevision = caseData.authorization !== null && caseData.authorization.revision === caseData.revision;

  return (
    <section className={styles.card} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.title}>
        {live ? "Place the call" : "Approve the call"} to {merchant}
        {phone ? (
          <>
            {" "}
            at <Mono>{phone}</Mono>
          </>
        ) : null}
      </h3>

      {purposePicker}

      <KeyValueList
        items={[
          { key: "On behalf of", value: caseData.customer.name },
          ...(needsAmount ? [{ key: "Amount", value: amount ? <Mono>{amount}</Mono> : null }] : []),
          { key: "Asking for", value: askingFor(purpose, amount) },
          { key: "Reason", value: caseData.reason },
          { key: "Facts", value: `Revision ${caseData.revision}` },
        ]}
      />

      {planPreview ? (
        <div className={styles.preview} data-testid="approval-plan">
          <h4 className={styles.previewLabel}>What the agent will say and ask</h4>
          <ol className={styles.previewList}>
            {previewPlan(caseData, purpose).map((step, index) => (
              <li key={step.title} className={styles.previewItem}>
                <span className={styles.previewNumber}>{String(index + 1).padStart(2, "0")}</span>
                <span className={styles.previewBody}>
                  <span className={styles.previewTitle}>{step.title}</span>
                  <span className={styles.previewDetail}>{step.detail}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      <p className={styles.destination} data-testid="approval-destination">
        <span className={styles.destinationNumber}>
          Calling <Mono>{phone}</Mono>
        </span>
        <span>{provenance(caseData.merchant.source)}</span>
      </p>

      {live ? (
        <p className={styles.liveNote} data-testid="approval-live-note">
          Placing the call dials <Mono>{phone}</Mono> now from our number, an AI assistant speaks for you, and the call is capped at 5 minutes.
        </p>
      ) : null}

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
        <span>
          {live
            ? "I confirm these facts are accurate and I want Recourse to dial this number now, with an AI assistant speaking for me"
            : "I confirm these facts are accurate and I authorize this call"}
        </span>
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
          onClick={() => onApprove(purpose)}
          disabled={!confirmed || blockedReason !== null}
          busy={busy}
          busyLabel={stage === "dispatching" ? "Placing the call" : "Approving"}
          data-testid="approve-button"
        >
          {error?.retryable ? "Try again" : live ? "Place the call" : "Approve this call"}
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
