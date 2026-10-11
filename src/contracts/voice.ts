/**
 * Canonical voice adapter contract — SHARED CONTRACT V1.
 *
 * Teammate 3 implements this in src/integrations/dial (exporting
 * createDialAdapter({mode}): VoiceAdapter). Teammate 2 consumes it from the
 * case service and the webhook route, and owns durable event deduplication
 * and all case-database writes. T3 never writes the case database.
 */

import type { Mode } from "./case";

export type { CallState, Mode } from "./case";

export interface AuthorizedCallInput {
  attemptId: string;
  caseId: string;
  authorizationId: string;
  /** E.164 destination number frozen at authorization time. */
  to: string;
  /** Server-generated immutable approved facts and allowed actions. */
  brief: string;
}

export type StartCallResult =
  | { state: "accepted"; mode: Mode; providerCallId: string }
  | { state: "rejected"; mode: Mode; code: string; message: string }
  | { state: "dispatch_unknown"; mode: Mode; message: string };

export interface VoiceSnapshot {
  providerCallId: string;
  mode: Mode;
  state: "queued" | "in_progress" | "completed" | "failed" | "cancelled";
  transcript: string | null;
  durationSeconds: number | null;
}

export interface VerifiedVoiceEvent {
  eventId: string;
  providerCallId: string;
  type: "call.ended";
}

export interface VoiceAdapter {
  startCall(input: AuthorizedCallInput): Promise<StartCallResult>;
  getCall(providerCallId: string): Promise<VoiceSnapshot>;
  /**
   * Verifies the documented provider authentication and timestamp freshness
   * against the exact raw bytes and headers received. Throws an error whose
   * `code` is "INVALID_WEBHOOK" for failed authentication or malformed events.
   * Returns null only for authenticated but irrelevant events. Legitimate
   * redeliveries pass verification; T2 deduplicates them durably by eventId.
   */
  verifyWebhook(rawBody: Uint8Array, headers: Headers): Promise<VerifiedVoiceEvent | null>;
}

// ---------------------------------------------------------------------------
// Additive helpers (convenience; the webhook route duck-types on `code`)
// ---------------------------------------------------------------------------

export type VoiceSnapshotState = VoiceSnapshot["state"];

export const INVALID_WEBHOOK = "INVALID_WEBHOOK" as const;

/** Optional error class T3 may throw; any error with code === "INVALID_WEBHOOK" is treated the same. */
export class VoiceWebhookError extends Error {
  readonly code = INVALID_WEBHOOK;
  constructor(message: string) {
    super(message);
    this.name = "VoiceWebhookError";
  }
}

export function isInvalidWebhookError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === INVALID_WEBHOOK
  );
}
