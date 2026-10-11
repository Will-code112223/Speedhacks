"use client";

/**
 * What a call produced, in the chat:
 * - dispatch_unknown: an explicit warning; we never redial on our own.
 * - failed or cancelled: what happened and the stored attempt.
 * - an outcome status: the outcome, with approval and payment kept apart,
 *   because a finished call is not a refund and an approval is not money.
 */

import { useId } from "react";
import type { CallV1, CaseV1 } from "../../../contracts/case";
import { Banner, Button, Disclosure, KeyValueList, Mono, MonoBlock, Pill, SourcePill, type Tone } from "../ui/primitives";
import { DownloadIcon } from "../ui/icons";
import { formatDateTime, statusWord } from "../ui/format";
import { isOutcomeStatus } from "../state/call";
import type { RequestState } from "../state/session";
import styles from "./ResultBlock.module.css";

export interface ResultBlockProps {
  caseData: CaseV1;
  call: CallV1 | null;
  /** True for the newest call; only it can carry the case outcome. */
  latest: boolean;
  fixture: boolean;
  packet: RequestState;
  onDownloadPacket: () => void;
}

type Decision = CaseV1["outcome"]["decision"];
type PaymentStatus = CaseV1["outcome"]["paymentStatus"];

function decisionTone(decision: Decision): Tone {
  switch (decision) {
    case "approved":
      return "success";
    case "denied":
      return "danger";
    case "requested":
    case "needs_information":
      return "warning";
    case "unknown":
      return "neutral";
    default: {
      const unreachable: never = decision;
      return unreachable;
    }
  }
}

function decisionNote(decision: Decision): string {
  switch (decision) {
    case "approved":
      return "They approved it on the call.";
    case "requested":
      return "Requested on the call. Not approved yet.";
    case "denied":
      return "They turned the request down.";
    case "needs_information":
      return "They need more information first.";
    case "unknown":
      return "The call did not settle it.";
    default: {
      const unreachable: never = decision;
      return unreachable;
    }
  }
}

function paymentNote(status: PaymentStatus): string {
  switch (status) {
    case "confirmed":
      return "Payment is confirmed.";
    case "unverified":
      return "No payment evidence yet. Check your account before you count on it.";
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

function PacketButton({ packet, onDownloadPacket }: Pick<ResultBlockProps, "packet" | "onDownloadPacket">) {
  return (
    <>
      <Button
        variant="secondary"
        size="small"
        onClick={onDownloadPacket}
        busy={packet.busy}
        busyLabel="Preparing the packet"
        data-testid="packet-download"
      >
        {packet.busy ? null : <DownloadIcon />}
        Download packet
      </Button>
      {packet.error ? (
        <Banner tone="danger" role="alert" title={packet.error.title} testId="error-banner">
          {packet.error.message}
        </Banner>
      ) : null}
    </>
  );
}

function AttemptIds({ call }: { call: CallV1 }) {
  return (
    <dl className={styles.ids}>
      <div>
        <dt>Attempt</dt>
        <dd>
          <Mono>{call.id}</Mono>
        </dd>
      </div>
      <div>
        <dt>Request</dt>
        <dd>
          <Mono>{call.requestId}</Mono>
        </dd>
      </div>
      <div>
        <dt>Provider call</dt>
        <dd>{call.providerCallId ? <Mono>{call.providerCallId}</Mono> : <span className={styles.muted}>None returned</span>}</dd>
      </div>
    </dl>
  );
}

export default function ResultBlock({ caseData, call, latest, fixture, packet, onDownloadPacket }: ResultBlockProps) {
  const headingId = useId();

  if (call && call.state === "dispatch_unknown") {
    return (
      <section className={styles.uncertain} role="alert" aria-labelledby={headingId} data-testid="dispatch-unknown-card">
        <div className={styles.uncertainHeader}>
          <h3 id={headingId} className={styles.uncertainTitle}>
            We cannot tell whether the call went through.
          </h3>
          <SourcePill fixture={fixture} simulated={call.mode === "simulated"} />
        </div>
        <p className={styles.uncertainText}>
          We will not redial automatically. The stored attempt is checked with the calling provider before any new
          attempt, so you are never called about the same request twice.
        </p>
        {call.error ? <p className={styles.uncertainText}>{call.error}</p> : null}
        <AttemptIds call={call} />
        <div className={styles.actions}>
          <PacketButton packet={packet} onDownloadPacket={onDownloadPacket} />
        </div>
      </section>
    );
  }

  const showOutcome = latest && isOutcomeStatus(caseData.status);

  if (call && (call.state === "failed" || call.state === "cancelled") && !showOutcome) {
    return (
      <section className={styles.failed} aria-labelledby={headingId}>
        <div className={styles.failedHeader}>
          <Pill tone="danger">{statusWord(call.state)}</Pill>
          <h3 id={headingId} className={styles.failedTitle}>
            The call did not go through.
          </h3>
        </div>
        {call.error ? <p className={styles.failedText}>{call.error}</p> : null}
        <AttemptIds call={call} />
        {latest && caseData.status === "ready_for_approval" ? (
          <p className={styles.muted}>Review the facts and approve a new call below when you are ready.</p>
        ) : latest && caseData.outcome.nextAction ? (
          <p className={styles.failedText}>
            <span className={styles.nextLabel}>Next: </span>
            {caseData.outcome.nextAction}
          </p>
        ) : null}
      </section>
    );
  }

  if (!showOutcome) return null;

  const { outcome } = caseData;
  const timeline = [...caseData.timeline].sort((a, b) => a.at.localeCompare(b.at));

  return (
    <section className={styles.outcome} aria-labelledby={headingId} data-testid="outcome-card">
      <div className={styles.outcomeHeader}>
        <h3 id={headingId} className={styles.outcomeTitle}>
          Call result
        </h3>
        <SourcePill fixture={fixture} simulated={caseData.mode === "simulated"} />
      </div>

      <dl className={styles.ledger}>
        <div className={styles.ledgerRow} data-testid="outcome-approval">
          <dt>Approval</dt>
          <dd>
            <Pill tone={decisionTone(outcome.decision)}>{statusWord(outcome.decision)}</Pill>
            <span className={styles.ledgerNote}>{decisionNote(outcome.decision)}</span>
          </dd>
        </div>
        <div className={styles.ledgerRow} data-testid="outcome-payment">
          <dt>Payment</dt>
          <dd>
            <Pill tone={outcome.paymentStatus === "confirmed" ? "success" : "warning"}>{statusWord(outcome.paymentStatus)}</Pill>
            <span className={styles.ledgerNote}>{paymentNote(outcome.paymentStatus)}</span>
          </dd>
        </div>
      </dl>

      <KeyValueList
        items={[
          { key: "Case status", value: statusWord(caseData.status) },
          {
            key: "Reference",
            value: (
              <span data-testid="outcome-reference">
                {outcome.referenceNumber ? <Mono>{outcome.referenceNumber}</Mono> : <span className={styles.muted}>Not provided</span>}
              </span>
            ),
          },
          { key: "Next action", value: outcome.nextAction },
          {
            key: "Supporting quote",
            value: outcome.supportingQuote ? <q className={styles.quote}>{outcome.supportingQuote}</q> : null,
          },
        ]}
      />

      <div className={styles.actions}>
        <PacketButton packet={packet} onDownloadPacket={onDownloadPacket} />
      </div>

      <div className={styles.disclosures}>
        <Disclosure summary="Show transcript" testId="transcript-toggle">
          {call?.transcript ? (
            <MonoBlock caption="Call transcript">{call.transcript}</MonoBlock>
          ) : (
            <p className={styles.muted}>The transcript is not available yet.</p>
          )}
        </Disclosure>
        {timeline.length > 0 ? (
          <Disclosure summary="Show case history">
            <ol className={styles.history}>
              {timeline.map((entry) => (
                <li key={entry.id}>
                  <time dateTime={entry.at} className={styles.historyTime}>
                    {formatDateTime(entry.at)}
                  </time>
                  <span>{entry.message}</span>
                </li>
              ))}
            </ol>
          </Disclosure>
        ) : null}
      </div>
    </section>
  );
}
