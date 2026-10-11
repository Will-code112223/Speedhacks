/**
 * Keewano REST ingestion (POST {base}/custom, POST {base}/in) with the k-token header.
 *
 * REST rather than @keewano/node-sdk because the SDK stamps "now" on every event
 * and the mirror preserves each timeline event's recorded timestamp.
 */
import { randomUUID } from "node:crypto";

export const DEFAULT_INGEST_URL = "https://api.keewano.com/event/ingress/v1/json";

export interface KeewanoEventTypeDef {
  eventTypeId: number;
  name: string;
  dataType: string;
}

export interface KeewanoIngestEvent {
  eventTypeId: number;
  dataType: string;
  /** Unix seconds, UTC. */
  timestamp: number;
  data: string | number | boolean | null;
}

export interface IngestResult {
  received: number;
  accepted: number;
}

export interface IngestOptions {
  apiKey: string;
  baseUrl?: string;
  eventTypes: readonly KeewanoEventTypeDef[];
  eventsHash: number;
  fetch?: typeof fetch;
  timeoutMs?: number;
  sdkVersion?: string;
}

export class KeewanoIngestError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "KeewanoIngestError";
    this.status = status;
    this.body = body;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class KeewanoIngestClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly eventTypes: readonly KeewanoEventTypeDef[];
  private readonly eventsHash: number;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly sdkVersion: string;

  constructor(opts: IngestOptions) {
    if (!opts.apiKey.trim()) throw new Error("Keewano API key is required");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_INGEST_URL).replace(/\/+$/, "");
    this.eventTypes = opts.eventTypes;
    this.eventsHash = opts.eventsHash;
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.sdkVersion = opts.sdkVersion ?? "speedhacks-refund/0.1";
  }

  /** Register the custom event list. Safe to repeat: an already registered list is a no-op. */
  async registerEventTypes(): Promise<unknown> {
    return this.post("custom", { customEventsHash: this.eventsHash, eventTypes: this.eventTypes });
  }

  /**
   * Send one entity's events as one batch. Each call uses a fresh dataSessionId with
   * batch 1 unless told otherwise, so nothing is ever rejected as out of sequence;
   * pass a stable (dataSessionId, batch) to make a resend idempotent instead.
   */
  async sendBatch(
    entityId: string,
    events: readonly KeewanoIngestEvent[],
    opts: { dataSessionId?: string; batch?: number; testUserName?: string } = {},
  ): Promise<IngestResult> {
    if (!UUID.test(entityId)) throw new Error("Keewano entity id must be a UUID");
    if (events.length === 0) return { received: 0, accepted: 0 };
    // Keewano reads the batch window from the first and last event: keep chronological order.
    const ordered = [...events].sort((a, b) => a.timestamp - b.timestamp);
    const body: Record<string, unknown> = {
      dataSessionId: opts.dataSessionId ?? randomUUID(),
      batch: opts.batch ?? 1,
      customEventsHash: this.eventsHash,
      installId: entityId,
      userId: entityId,
      sdkVersion: this.sdkVersion,
      events: ordered,
    };
    if (opts.testUserName) body.testUserName = opts.testUserName;
    const res = (await this.post("in", body)) as { received?: unknown; accepted?: unknown } | null;
    const received = res?.received;
    const accepted = res?.accepted;
    if (typeof received !== "number" || !Number.isSafeInteger(received) || received < 0 || received > events.length ||
        typeof accepted !== "number" || !Number.isSafeInteger(accepted) || accepted < 0 || accepted > received) {
      throw new Error("Keewano returned invalid ingestion counts");
    }
    return { received, accepted };
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/${path}`, {
        method: "POST",
        redirect: "error",
        headers: { "k-token": this.apiKey, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new KeewanoIngestError(`Keewano /${path} failed: HTTP ${res.status}`, res.status, text.slice(0, 500));
      if (!text.trim()) return {};
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return { raw: text.slice(0, 500) };
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
