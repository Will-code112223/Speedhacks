// Canonical shared contract re-exports (replaces the temporary V1 mirror, per docs/handoffs/dial.txt).
export type { Mode } from "../../contracts/case";
export type {
  AuthorizedCallInput,
  StartCallResult,
  VoiceSnapshot,
  VerifiedVoiceEvent,
  VoiceAdapter,
} from "../../contracts/voice";
