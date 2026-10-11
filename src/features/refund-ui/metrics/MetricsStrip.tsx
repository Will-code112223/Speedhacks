"use client";

/**
 * Two clocks kept apart on purpose: the person's own active time on this case
 * and the agent's time on the phone. No savings figure is computed or shown.
 */

import type { LiveCallV2 } from "../api/types";
import { formatDuration, secondsBetween } from "../ui/format";
import { useNow } from "../state/browser";
import { phaseIsLive } from "../state/call";
import styles from "./MetricsStrip.module.css";

export interface MetricsStripProps {
  /** Milliseconds the person was actively here for this case. */
  activeMs: number;
  /** Live call data; null when the backend does not report call timing. */
  live: LiveCallV2 | null;
}

export default function MetricsStrip({ activeMs, live }: MetricsStripProps) {
  const running = live !== null && live.startedAt !== null && live.endedAt === null && phaseIsLive(live.phase);
  const now = useNow(running);
  const agentSeconds = live?.startedAt ? secondsBetween(live.startedAt, live.endedAt, now) : null;

  return (
    <section className={styles.strip} aria-label="Time on this case">
      <div className={styles.metrics}>
        <p className={styles.metric} data-testid="metrics-active">
          <span className={styles.label}>Your active time</span>
          <span className={styles.value}>{formatDuration(activeMs / 1000)}</span>
        </p>
        <p className={styles.metric} data-testid="metrics-agent">
          <span className={styles.label}>Agent on the phone</span>
          {agentSeconds !== null ? (
            <span className={styles.value}>{formatDuration(agentSeconds)}</span>
          ) : (
            <span className={styles.unavailable}>
              {live ? (live.phase === "ended" ? "Never connected" : "Not connected yet") : "Not reported by this backend"}
            </span>
          )}
        </p>
      </div>
      <p className={styles.note}>We count only the time you were actively here. The agent&apos;s time is separate.</p>
    </section>
  );
}
