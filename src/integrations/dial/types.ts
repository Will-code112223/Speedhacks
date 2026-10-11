// Temporary exact V1 mirror while teammate 2 owns/publishes src/contracts/voice.ts.
// Replace this file with type re-exports from that canonical contract after sync.
export type Mode = "simulated" | "live";
export interface AuthorizedCallInput {
  attemptId: string;
  caseId: string;
  authorizationId: string;
  to: string;
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
  verifyWebhook(rawBody: Uint8Array, headers: Headers): Promise<VerifiedVoiceEvent | null>;
}
