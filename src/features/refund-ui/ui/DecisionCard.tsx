"use client";

/**
 * A question the agent asks while the call is live. Shared by the call
 * screen (prominent, at the top of the column) and the chat (inline record).
 * Shows a countdown to the deadline and, afterwards, what happened: the
 * person's answer, or the default the agent applied.
 */

import { useId } from "react";
import type { DecisionOption } from "../api/types";
import type { DecisionRecord } from "../state/session";
import { useNow } from "../state/browser";
import { Banner, Button } from "./primitives";
import { CheckIcon } from "./icons";
import { formatClock, formatDuration } from "./format";
import styles from "./DecisionCard.module.css";

export interface DecisionCardProps {
  record: DecisionRecord;
  variant: "prominent" | "inline";
  /** False when the backend cannot take answers; options render disabled with a hint. */
  canAnswer: boolean;
  onAnswer: (optionId: string) => void;
  onDismiss?: () => void;
}

function optionLabel(options: readonly DecisionOption[], id: string | null): string {
  if (!id) return "";
  return options.find((option) => option.id === id)?.label ?? id;
}

function buttonVariant(option: DecisionOption): "primary" | "secondary" | "danger" {
  if (option.tone === "primary") return "primary";
  if (option.tone === "danger") return "danger";
  return "secondary";
}

export default function DecisionCard({ record, variant, canAnswer, onAnswer, onDismiss }: DecisionCardProps) {
  const headingId = useId();
  const { decision, status } = record;
  const open = status === "pending" || status === "answering";
  const now = useNow(open);
  const remainingSeconds = Math.max(0, Math.ceil((Date.parse(decision.expiresAt) - now) / 1000));
  const pastDeadline = open && remainingSeconds === 0;
  const defaultLabel = optionLabel(decision.options, decision.defaultOptionId);
  const suffix = variant === "inline" ? "-inline" : "";
  const Heading = variant === "prominent" ? "h2" : "h3";

  const resolution = (() => {
    if (status === "answered") return `You chose “${optionLabel(decision.options, record.chosenOptionId)}”.`;
    if (status === "closed" && record.expired) return `No answer in time. The agent went with the default, “${defaultLabel}”.`;
    if (status === "closed") return "The agent no longer needs an answer to this.";
    if (pastDeadline && status === "pending") return `No answer in time. The agent is going with the default, “${defaultLabel}”.`;
    return null;
  })();

  const classes = [
    styles.card,
    variant === "prominent" ? styles.prominent : styles.inline,
    resolution === null ? styles.pending : styles.resolved,
  ].join(" ");

  return (
    <section className={classes} aria-labelledby={headingId} data-testid={`decision-card${suffix}`}>
      <div className={styles.top}>
        <span className={resolution === null ? styles.eyebrowPending : styles.eyebrow}>
          {resolution === null ? "Needs your answer" : "Decision"}
        </span>
        {resolution === null ? (
          <span className={styles.countdown} data-testid={`decision-countdown${suffix}`}>
            <time dateTime={decision.expiresAt} title={`Answer by ${formatClock(decision.expiresAt)}`}>
              {formatDuration(remainingSeconds)}
            </time>{" "}
            left
          </span>
        ) : null}
      </div>

      <Heading id={headingId} className={styles.question}>
        {decision.question}
      </Heading>

      {resolution === null ? (
        <>
          <div className={styles.options} role="group" aria-labelledby={headingId}>
            {decision.options.map((option) => (
              <Button
                key={option.id}
                variant={buttonVariant(option)}
                // The chosen option stays focusable while busy; only the others become unavailable.
                disabled={!canAnswer || (status === "answering" && record.chosenOptionId !== option.id)}
                busy={status === "answering" && record.chosenOptionId === option.id}
                busyLabel="Sending your answer"
                onClick={() => onAnswer(option.id)}
                data-testid={`decision-option${suffix}-${option.id}`}
              >
                {option.label}
              </Button>
            ))}
          </div>
          <p className={styles.fallback}>
            {canAnswer
              ? `If you do not answer, the agent will go with “${defaultLabel}”.`
              : `Answering is not available with this backend. The agent will go with “${defaultLabel}”.`}
          </p>
        </>
      ) : (
        <div className={styles.resolution}>
          {status === "answered" ? (
            <span className={styles.resolutionIcon}>
              <CheckIcon />
            </span>
          ) : null}
          <p className={styles.resolutionText}>{resolution}</p>
          {onDismiss && status !== "pending" ? (
            <Button variant="ghost" size="small" onClick={onDismiss}>
              Dismiss
            </Button>
          ) : null}
        </div>
      )}

      {record.error && resolution === null ? (
        <Banner tone="danger" role="alert" title={record.error.title} testId="error-banner">
          {record.error.message}
        </Banner>
      ) : null}
    </section>
  );
}
