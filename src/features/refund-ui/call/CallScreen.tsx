"use client";

/**
 * The live call, laid out like a phone's in-call view: who we are calling,
 * what is happening, the elapsed time, who answered, what the agent noted,
 * and the controls to step in or hand back.
 *
 * Without live call data (a backend with contract V1 only) it shows the V1
 * call state as the phase and the transcript once it arrives, and no timer.
 */

import { useEffect, useId, useRef } from "react";
import type { CallV1, CaseV1 } from "../../../contracts/case";
import type { CaseApiCapabilities, Counterpart, LiveCallV2 } from "../api/types";
import DecisionCard from "../ui/DecisionCard";
import { Button, Mono, MonoBlock, SourcePill } from "../ui/primitives";
import { formatClock, formatDuration, formatPhone, secondsBetween, statusWord } from "../ui/format";
import { useNow, usePrefersReducedMotion } from "../state/browser";
import { phaseHasCounterpart, phaseIsLive, phaseLabel } from "../state/call";
import type { UiError } from "../state/errors";
import type { DecisionRecord, RequestState } from "../state/session";
import styles from "./Call.module.css";

export interface CallScreenProps {
  caseData: CaseV1;
  call: CallV1;
  live: LiveCallV2 | null;
  liveError: UiError | null;
  capabilities: CaseApiCapabilities | null;
  fixture: boolean;
  decision: DecisionRecord | null;
  join: RequestState;
  handedBack: boolean;
  /** Set when the screen is a sheet; the sheet supplies its own heading. */
  headingId?: string;
  onAnswer: (decisionId: string, optionId: string) => void;
  onDismissDecision: (decisionId: string) => void;
  onStepIn: () => void;
  onLeave: () => void;
  /** Reads the call again after live updates failed. */
  onRetryUpdates: () => void;
}

type DotTone = "neutral" | "accent" | "warning" | "danger" | "live";

export default function CallScreen(props: CallScreenProps) {
  const { caseData, call, live, liveError, capabilities, fixture, decision, join, handedBack } = props;
  const ownHeadingId = useId();
  const headingId = props.headingId ?? ownHeadingId;

  const name = live?.calling.name ?? caseData.merchant.name ?? "Support line";
  const phone = formatPhone(live?.calling.phone ?? caseData.merchant.supportPhone);

  const joined = live !== null && (live.userJoined || live.phase === "user_joined") && !handedBack;
  const callIsLive = live ? phaseIsLive(live.phase) : call.state === "in_progress" || call.state === "queued" || call.state === "dispatch_pending";

  let status: string;
  let dot: DotTone;
  if (live) {
    status = handedBack && live.phase === "user_joined" ? "Handing back to the agent" : phaseLabel(live.phase);
    dot =
      live.phase === "ended"
        ? "neutral"
        : live.phase === "waiting_for_user"
          ? "warning"
          : live.phase === "user_joined"
            ? "accent"
            : "live";
  } else {
    status = statusWord(call.state);
    dot = call.state === "failed" || call.state === "cancelled" ? "danger" : call.state === "dispatch_unknown" ? "warning" : callIsLive ? "live" : "neutral";
  }

  // A backend with live data that has no record yet is still connecting; one without live data never reports these.
  const liveSupported = capabilities?.liveCall ?? null;
  const awaitingLive = live === null && liveSupported === true && callIsLive;
  const stepInSupported = capabilities?.stepIn ?? false;
  const hasTranscript = Boolean(call.transcript?.trim());
  const canRefreshTranscript = call.state === "completed" && !hasTranscript;
  // Joining needs someone on the line: the backend refuses while dialing or ringing.
  const connecting = live === null || live.phase === "dialing" || live.phase === "ringing";
  const stepInHint =
    capabilities === null
      ? null
      : !stepInSupported
        ? "Not available with this backend"
        : connecting
          ? "Available once someone answers"
          : null;

  return (
    <section className={styles.screen} aria-labelledby={headingId} data-testid="call-screen">
      <div className={styles.identity}>
        <div className={styles.identityTop}>
          <span className={styles.eyebrow}>Support call</span>
          <SourcePill fixture={fixture} simulated={call.mode === "simulated"} />
        </div>
        <h2 id={props.headingId ? undefined : headingId} className={styles.name}>
          {name}
        </h2>
        {phone ? (
          <div className={styles.phone}>
            <Mono>{phone}</Mono>
          </div>
        ) : null}
        <p className={styles.status} data-testid="call-phase">
          <span className={[styles.statusDot, styles[`dot_${dot}`] ?? ""].join(" ")} aria-hidden="true" />
          {status}
        </p>
        <p className={styles.updated}>
          Updated <time dateTime={call.updatedAt}>{formatClock(call.updatedAt)}</time>
        </p>
      </div>

      {/* No timer for an attempt that ended without connecting, or without live data. */}
      {live && (live.startedAt !== null || live.phase !== "ended") ? <CallClock live={live} /> : null}

      <div className={styles.counterpartRow}>
        {live ? (
          live.phase === "ended" && live.counterpart === "unknown" ? (
            // Over without anyone identified: say so plainly instead of "Identifying who answered".
            <span className={[styles.badge, styles.badgeNeutral].join(" ")} data-testid="call-counterpart">
              Counterpart not identified
            </span>
          ) : phaseHasCounterpart(live.phase) ? (
            <CounterpartBadge counterpart={live.counterpart} confidence={live.counterpartConfidence} ended={live.phase === "ended"} />
          ) : null
        ) : (
          <span className={[styles.badge, styles.badgeNeutral].join(" ")} data-testid="call-counterpart">
            {awaitingLive ? "Not connected yet" : "Counterpart not reported"}
          </span>
        )}
      </div>

      {/* Below who and how long, so the timer stays in the top half while a question waits. */}
      {decision ? (
        <div className={styles.decisionSlot}>
          <DecisionCard
            record={decision}
            variant="prominent"
            canAnswer={capabilities?.decisions ?? false}
            onAnswer={(optionId) => props.onAnswer(decision.decision.id, optionId)}
            onDismiss={() => props.onDismissDecision(decision.decision.id)}
          />
        </div>
      ) : null}

      {liveError ? (
        <div className={styles.liveError} role="status">
          <span>
            Live updates paused: {liveError.message}
            {liveError.retryable ? " Retrying." : null}
          </span>
          <Button size="small" variant="secondary" onClick={props.onRetryUpdates}>
            Retry
          </Button>
        </div>
      ) : null}

      {live ? (
        <CallNotes live={live} />
      ) : awaitingLive ? (
        <div className={styles.notes}>
          <h3 className={styles.sectionLabel}>Call activity</h3>
          <p className={styles.muted} data-testid="call-notes">
            The agent&apos;s notes appear here once the call connects.
          </p>
        </div>
      ) : (
        <div className={styles.transcript}>
          <h3 className={styles.sectionLabel}>Transcript</h3>
          {hasTranscript ? (
            <MonoBlock caption="Call transcript">{call.transcript}</MonoBlock>
          ) : (
            <p className={styles.muted}>
              {callIsLive
                ? "The transcript will appear here when it is available."
                : canRefreshTranscript
                  ? "The call ended, but its transcript is not available yet."
                  : "No transcript was returned for this call."}
            </p>
          )}
        </div>
      )}

      <div className={styles.controls}>
        {callIsLive ? (
          joined ? (
            <>
              <p className={styles.controlNote}>You are on the call. The agent is listening and takes over when you leave.</p>
              <Button variant="secondary" onClick={props.onLeave} data-testid="leave-call-button">
                Leave the call
              </Button>
            </>
          ) : stepInSupported ? (
            <>
              <Button
                variant="primary"
                onClick={props.onStepIn}
                disabled={!stepInSupported || connecting}
                busy={join.busy}
                busyLabel="Joining the call"
                aria-describedby={stepInHint ? `${headingId}-stepin-hint` : undefined}
                data-testid="step-in-button"
              >
                Step into the call
              </Button>
              {stepInHint ? (
                <p id={`${headingId}-stepin-hint`} className={styles.controlNote}>
                  {stepInHint}
                </p>
              ) : null}
            </>
          ) : (
            <div className={styles.capabilityNote}>
              <p className={styles.controlTitle}>Call monitoring</p>
              <p className={styles.controlNote}>
                {capabilities === null
                  ? "Checking available call controls."
                  : "Joining the call: Not available with this backend. You can follow its status here."}
              </p>
            </div>
          )
        ) : (
          <p className={styles.controlNote}>
            {call.state === "dispatch_unknown"
              ? "The call may have started. Verify this attempt before placing another call."
              : live?.endedAt
              ? live.startedAt
                ? `The call ended at ${formatClock(live.endedAt)}.`
                : "The call did not connect."
              : "The call is not active."}
          </p>
        )}
        {canRefreshTranscript ? (
          <>
            <p className={styles.controlNote}>A transcript can arrive after the call ends. Refreshing checks this call without placing another.</p>
            <Button variant="secondary" onClick={props.onRetryUpdates} data-testid="refresh-transcript-button">
              Refresh transcript
            </Button>
          </>
        ) : null}
        {join.error ? (
          <p className={styles.controlError} role="alert">
            {join.error.message}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function CallClock({ live }: { live: LiveCallV2 }) {
  const running = live.startedAt !== null && live.endedAt === null && phaseIsLive(live.phase);
  const now = useNow(running);
  const elapsed = secondsBetween(live.startedAt, live.endedAt, now);
  return (
    <div className={styles.clock}>
      <span className={styles.sectionLabel}>{live.startedAt ? "Call duration" : "Awaiting connection"}</span>
      <span
        className={[styles.timer, live.startedAt ? "" : styles.timerIdle].join(" ")}
        role="timer"
        aria-label={`Elapsed ${formatDuration(elapsed)}`}
        data-testid="call-timer"
      >
        {formatDuration(elapsed)}
      </span>
      {live.holdSeconds > 0 ? (
        <span className={styles.hold}>
          On hold <span className={styles.holdValue}>{formatDuration(live.holdSeconds)}</span>
        </span>
      ) : null}
    </div>
  );
}

/** One grammar for who is on the line; past tense once the call is over. */
function counterpartText(counterpart: Counterpart, ended: boolean): string {
  const verb = ended ? "Spoke with" : "Talking to";
  switch (counterpart) {
    case "human":
      return `${verb}: a person`;
    case "agent":
      return `${verb}: an automated agent`;
    case "unknown":
      return "Identifying who answered";
    default: {
      const unreachable: never = counterpart;
      return unreachable;
    }
  }
}

function CounterpartBadge({ counterpart, confidence, ended }: { counterpart: Counterpart; confidence: number; ended: boolean }) {
  const tooltipId = useId();
  const tooltip =
    counterpart === "unknown" ? "Not identified yet" : `Confidence ${Math.round(Math.max(0, Math.min(1, confidence)) * 100)}%`;
  const toneClass =
    counterpart === "agent" ? styles.badgeAgent : counterpart === "human" ? styles.badgeHuman : styles.badgeNeutral;
  return (
    <span className={styles.badgeWrap}>
      <span
        className={[styles.badge, toneClass, counterpart === "unknown" ? styles.badgePulse : ""].join(" ")}
        tabIndex={0}
        aria-describedby={tooltipId}
        data-testid="call-counterpart"
      >
        {counterpart === "unknown" ? <span className={styles.badgeDot} aria-hidden="true" /> : null}
        {counterpartText(counterpart, ended)}
      </span>
      <span id={tooltipId} role="tooltip" className={styles.tooltip}>
        {tooltip}
      </span>
    </span>
  );
}

function CallNotes({ live }: { live: LiveCallV2 }) {
  const listRef = useRef<HTMLOListElement | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const count = live.notes.length;

  // Newest at the bottom, kept in view as notes arrive.
  useEffect(() => {
    const node = listRef.current;
    if (!node || count === 0) return;
    node.scrollTo({ top: node.scrollHeight, behavior: reducedMotion ? "auto" : "smooth" });
  }, [count, reducedMotion]);

  return (
    <div className={styles.notes}>
      <h3 className={styles.sectionLabel}>Call activity</h3>
      {count === 0 ? (
        <p className={styles.muted} data-testid="call-notes">
          The agent&apos;s notes appear here as the call goes.
        </p>
      ) : (
        <ol className={styles.noteList} ref={listRef} data-testid="call-notes" aria-live="polite" aria-relevant="additions">
          {live.notes.map((note, index) => (
            <li key={`${note.at}-${index}`} className={styles.note}>
              <time dateTime={note.at} className={styles.noteTime}>
                {live.startedAt && Date.parse(note.at) >= Date.parse(live.startedAt)
                  ? formatDuration(secondsBetween(live.startedAt, note.at, Date.parse(note.at)))
                  : formatClock(note.at)}
              </time>
              <span className={styles.noteText}>{note.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
