/**
 * Measures the user's own time in the app, separately from wall-clock waiting.
 *
 * A moment counts as active when measuring is on, the document has focus, and
 * the last pointer or keyboard event was at most `activityWindowMs` ago.
 * Totals are integrated between events, so throttled timers in a background
 * tab cannot inflate or lose time. Pure: callers pass a monotonic `now`.
 */
export const ACTIVITY_WINDOW_MS = 10_000;

export interface ActiveTimeReading {
  activeMs: number;
  elapsedMs: number;
  running: boolean;
}

export class ActiveTimeMeter {
  private running = false;
  private focused = false;
  private lastActivityAt = Number.NEGATIVE_INFINITY;
  private activeMs = 0;
  private elapsedMs = 0;
  /** Totals are accounted up to this instant. */
  private cursor = Number.NEGATIVE_INFINITY;

  constructor(private readonly activityWindowMs: number = ACTIVITY_WINDOW_MS) {}

  start(now: number): void {
    this.settle(now);
    this.running = true;
  }

  stop(now: number): void {
    this.settle(now);
    this.running = false;
  }

  reset(now: number): void {
    this.settle(now);
    this.activeMs = 0;
    this.elapsedMs = 0;
  }

  setFocused(now: number, focused: boolean): void {
    this.settle(now);
    this.focused = focused;
  }

  recordActivity(now: number): void {
    this.settle(now);
    this.lastActivityAt = this.cursor;
  }

  read(now: number): ActiveTimeReading {
    this.settle(now);
    return { activeMs: this.activeMs, elapsedMs: this.elapsedMs, running: this.running };
  }

  /** Accrue time from the cursor to `now` under the state that held in between. */
  private settle(now: number): void {
    const until = Math.max(now, this.cursor);
    if (this.running && Number.isFinite(this.cursor)) {
      this.elapsedMs += until - this.cursor;
      if (this.focused) {
        const activeUntil = Math.min(until, this.lastActivityAt + this.activityWindowMs);
        if (activeUntil > this.cursor) this.activeMs += activeUntil - this.cursor;
      }
    }
    this.cursor = until;
  }
}
