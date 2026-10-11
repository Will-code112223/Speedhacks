import type { KeewanoIngestClient, KeewanoIngestEvent } from "./ingest";

/** Where the mirror writes. Emits are synchronous; shipping happens later, best effort. */
export interface EventSink {
  emit(entityId: string, events: readonly KeewanoIngestEvent[]): void;
  flush(): Promise<void>;
}

export interface SinkStats {
  sent: number;
  accepted: number;
  dropped: number;
  failures: number;
}

type Logger = { warn(message: string): void };

/**
 * In-memory queue per entity, shipped as one batch per entity after a short debounce.
 * Nothing here can throw into the case flow: failures are counted and logged (sparsely).
 * Registration of the custom event list happens once per process before the first batch.
 */
export class KeewanoSink implements EventSink {
  readonly stats: SinkStats = { sent: 0, accepted: 0, dropped: 0, failures: 0 };
  private readonly queue = new Map<string, KeewanoIngestEvent[]>();
  private queued = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private registered = false;
  private chain: Promise<void> = Promise.resolve();
  private readonly client: KeewanoIngestClient;
  private readonly debounceMs: number;
  private readonly maxQueued: number;
  private readonly logger: Logger;

  constructor(client: KeewanoIngestClient, opts: { debounceMs?: number; maxQueued?: number; logger?: Logger } = {}) {
    this.client = client;
    this.debounceMs = opts.debounceMs ?? 250;
    this.maxQueued = opts.maxQueued ?? 5000;
    this.logger = opts.logger ?? console;
  }

  emit(entityId: string, events: readonly KeewanoIngestEvent[]): void {
    if (events.length === 0) return;
    const list = this.queue.get(entityId) ?? [];
    list.push(...events);
    this.queue.set(entityId, list);
    this.queued += events.length;
    while (this.queued > this.maxQueued) {
      const oldest = this.queue.keys().next().value;
      if (oldest === undefined) break;
      const dropped = this.queue.get(oldest)?.length ?? 0;
      this.queue.delete(oldest);
      this.queued -= dropped;
      this.stats.dropped += dropped;
    }
    this.schedule();
  }

  /** Ship everything queued so far (serialized with any flush already running). */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.chain = this.chain.then(() => this.drain());
    return this.chain;
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  private warn(message: string): void {
    // First few failures verbosely, then every 50th, so a dead endpoint cannot flood the log.
    if (this.stats.failures <= 3 || this.stats.failures % 50 === 0) this.logger.warn(`[keewano] ${message}`);
  }

  private async drain(): Promise<void> {
    while (this.queue.size > 0) {
      if (!this.registered) {
        try {
          await this.client.registerEventTypes();
          this.registered = true;
        } catch (err) {
          this.stats.failures += 1;
          this.warn(`event registration failed; ${this.queued} events stay queued: ${String((err as Error).message ?? err)}`);
          return;
        }
      }
      const batches = [...this.queue.entries()];
      this.queue.clear();
      this.queued = 0;
      for (const [entityId, events] of batches) {
        try {
          const result = await this.client.sendBatch(entityId, events);
          this.stats.sent += events.length;
          this.stats.accepted += result.accepted;
          if (result.accepted < events.length) {
            this.stats.failures += 1;
            this.warn(`accepted ${result.accepted}/${events.length} events for ${entityId}`);
          }
        } catch (err) {
          this.stats.failures += 1;
          this.stats.dropped += events.length;
          this.warn(`batch of ${events.length} dropped for ${entityId}: ${String((err as Error).message ?? err)}`);
        }
      }
    }
  }
}
