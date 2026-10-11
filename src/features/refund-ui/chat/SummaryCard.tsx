"use client";

/**
 * Sends the call's transcript and a short summary by email or text message.
 * A panel the person acts in, so it is the one bordered block under the
 * outcome. The fixture "sends" and says so with its pill; the http path has
 * no route yet, so it composes the message for the person's own Mail or
 * Messages app and never claims anything went out.
 */

import { useEffect, useId, useRef, type FormEvent } from "react";
import { channelLabel, messageUrl } from "../api/summary";
import type { SummaryDelivery } from "../api/types";
import type { SummaryState } from "../state/session";
import { formatClock } from "../ui/format";
import { Button, Disclosure, Field, Mono, MonoBlock, SourcePill } from "../ui/primitives";
import ui from "../ui/primitives.module.css";
import styles from "./SummaryCard.module.css";

export interface SummaryCardProps {
  state: SummaryState;
  /** Data from the in-browser fixture. */
  fixture: boolean;
  /** The case ran in simulated mode on the server. */
  simulated: boolean;
  onSend(text: string): void;
  onEdit(text: string): void;
  onReset(): void;
}

export default function SummaryCard({ state, fixture, simulated, onSend, onEdit, onReset }: SummaryCardProps) {
  const { status, delivery, error, destinationText } = state;
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const submitted = useRef(false);
  const fieldId = useId();

  // After a send the person started, focus moves to the line that says what happened.
  const done = (status === "sent" || status === "composed") && delivery !== null;
  useEffect(() => {
    if (done && submitted.current) {
      submitted.current = false;
      headingRef.current?.focus();
    }
  }, [done]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (status === "sending") return;
    submitted.current = true;
    onSend(destinationText);
  };

  const fieldError = status === "error" && error?.kind === "bad_request" ? error.message : null;
  const requestError = status === "error" && error !== null && error.kind !== "bad_request" ? error : null;

  return (
    <section className={styles.card} aria-label="Transcript and summary" data-testid="summary-card">
      <p className={styles.eyebrow}>Transcript and summary</p>
      {done ? (
        <Delivered
          delivery={delivery}
          sent={status === "sent"}
          fixture={fixture}
          simulated={simulated}
          headingRef={headingRef}
          onReset={onReset}
        />
      ) : (
        <>
          <form className={styles.form} onSubmit={submit} noValidate>
            <div className={styles.field}>
              <Field
                id={fieldId}
                label="Send the transcript and summary to"
                placeholder="Email or mobile number"
                inputMode="email"
                autoComplete="email tel"
                spellCheck={false}
                value={destinationText}
                onChange={(event) => onEdit(event.target.value)}
                error={fieldError}
              />
            </div>
            <Button type="submit" variant="primary" className={styles.submit} busy={status === "sending"} busyLabel="Sending the summary">
              Send the summary
            </Button>
          </form>
          {requestError ? (
            <div className={styles.errorRow} role="alert">
              <p className={styles.error}>{requestError.message}</p>
              <Button size="small" variant="secondary" onClick={() => onSend(destinationText)}>
                Try again
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function Delivered({
  delivery,
  sent,
  fixture,
  simulated,
  headingRef,
  onReset,
}: {
  delivery: SummaryDelivery;
  sent: boolean;
  fixture: boolean;
  simulated: boolean;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onReset(): void;
}) {
  const channel = channelLabel(delivery.channel);
  return (
    <div className={styles.delivered}>
      <div className={styles.sentRow}>
        <h3 className={styles.sentLine} ref={headingRef} tabIndex={-1}>
          {sent ? (
            <>
              Sent by {channel} to <Mono>{delivery.to}</Mono>
              {delivery.sentAt ? (
                <>
                  {" at "}
                  <time dateTime={delivery.sentAt} className={styles.time}>
                    {formatClock(delivery.sentAt)}
                  </time>
                </>
              ) : null}
            </>
          ) : (
            <>
              Ready to send by {channel} to <Mono>{delivery.to}</Mono>
            </>
          )}
        </h3>
        <SourcePill fixture={fixture} simulated={simulated} />
      </div>
      {sent ? null : (
        <p className={styles.note}>
          Recourse composed the message. It goes out only when you send it from your own {delivery.channel === "email" ? "Mail" : "Messages"} app.
        </p>
      )}
      <div className={styles.actions}>
        {sent ? null : (
          <a className={[ui.button, ui.primary, styles.open].join(" ")} href={messageUrl(delivery)}>
            {delivery.channel === "email" ? "Open in Mail" : "Open in Messages"}
          </a>
        )}
        <Button size="small" variant="ghost" onClick={onReset}>
          Send to another address
        </Button>
      </div>
      <Disclosure summary={sent ? "Show what was sent" : "Show the message"} testId="summary-disclosure">
        <div className={styles.message}>
          {delivery.subject ? (
            <p className={styles.subject}>
              <span className={styles.subjectLabel}>Subject</span>
              {delivery.subject}
            </p>
          ) : null}
          <ul className={styles.lines}>
            {delivery.summary.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <MonoBlock caption="Call transcript">{delivery.transcript}</MonoBlock>
        </div>
      </Disclosure>
    </div>
  );
}
