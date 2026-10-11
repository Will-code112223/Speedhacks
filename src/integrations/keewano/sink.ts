import { randomUUID } from "node:crypto";
import type { KeewanoIngestClient, KeewanoIngestEvent } from "./ingest";

/** Synchronous in-memory enqueue; network shipping is best effort and never case authority. */
export interface EventSink {
  emit(entityId: string, events: readonly KeewanoIngestEvent[]): void;
  flush(): Promise<void>;
}
export interface SinkStats { sent: number; accepted: number; dropped: number; failures: number }
type Logger = { warn(message: string): void };
type Batch = { entityId: string; events: KeewanoIngestEvent[]; dataSessionId: string; attempts: number };

/**
 * Jonathan's debounced sink, with bounded registration retries and immutable batch
 * identity on ambiguous retries. Later events never get appended to a retried batch.
 * Pending work is memory-only: process exit may lose it. This is not a durable ledger.
 */
export class KeewanoSink implements EventSink {
  readonly stats: SinkStats = { sent: 0, accepted: 0, dropped: 0, failures: 0 };
  private readonly queue = new Map<string, KeewanoIngestEvent[]>();
  private retries: Batch[] = [];
  private queued = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private registered = false;
  private registrationAttempts = 0;
  private chain: Promise<void> = Promise.resolve();
  private readonly debounceMs: number;
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;
  private readonly maxQueued: number;
  private readonly logger: Logger;

  constructor(private readonly client: KeewanoIngestClient,
    opts: { debounceMs?: number; retryDelayMs?: number; maxAttempts?: number; maxQueued?: number; logger?: Logger } = {}) {
    this.debounceMs = opts.debounceMs ?? 250;
    this.retryDelayMs = opts.retryDelayMs ?? 2000;
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
    this.maxQueued = Math.max(1, opts.maxQueued ?? 5000);
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

  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.chain = this.chain.then(() => this.drain());
    return this.chain;
  }

  private schedule(delayMs = this.debounceMs): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, delayMs);
    this.timer.unref?.();
  }

  private warn(message: string): void {
    // Never log entities, credentials, response bodies, or thrown provider messages.
    if (this.stats.failures <= 3 || this.stats.failures % 50 === 0) this.logger.warn(`[keewano] ${message}`);
  }

  private async drain(): Promise<void> {
    if (this.queue.size === 0 && this.retries.length === 0) return;
    if (!this.registered) {
      try {
        await this.client.registerEventTypes();
        this.registered = true;
        this.registrationAttempts = 0;
      } catch {
        this.stats.failures += 1;
        this.registrationAttempts += 1;
        this.warn("Event registration failed; case writes remain unaffected.");
        if (this.registrationAttempts < this.maxAttempts) this.schedule(this.retryDelayMs);
        else {
          this.stats.dropped += this.queued;
          this.queue.clear(); this.retries = []; this.queued = 0;
          this.registrationAttempts = 0;
        }
        return;
      }
    }
    const batches = this.retries;
    this.retries = [];
    for (const [entityId, events] of this.queue) {
      batches.push({ entityId, events, dataSessionId: randomUUID(), attempts: 0 });
    }
    this.queue.clear();
    // Count in-flight work towards the memory bound until it settles.
    for (const batch of batches) {
      try {
        const result = await this.client.sendBatch(batch.entityId, batch.events, { dataSessionId: batch.dataSessionId, batch: 1 });
        this.queued -= batch.events.length;
        this.stats.sent += batch.events.length;
        this.stats.accepted += result.accepted;
        if (result.accepted < batch.events.length) {
          this.stats.failures += 1;
          this.stats.dropped += batch.events.length - result.accepted;
          this.warn("Ingestion partially accepted a batch; no partial resend attempted.");
        }
      } catch {
        batch.attempts += 1;
        this.stats.failures += 1;
        if (batch.attempts < this.maxAttempts) {
          this.retries.push(batch);
          this.warn("Ingestion failed; retrying the same batch identity.");
        } else {
          this.queued -= batch.events.length;
          this.stats.dropped += batch.events.length;
          this.warn("Ingestion failed after bounded retries; telemetry dropped.");
        }
      }
    }
    if (this.retries.length > 0 || this.queue.size > 0) this.schedule(this.retryDelayMs);
  }
}
