/**
 * What the views read and call. Implemented by useCaseSession, which owns
 * the CaseApi instances and every request; views never call the API.
 */

import type { CallV1, CaseChanges, CaseV1 } from "../../../contracts/case";
import type { ApiMode, CaseApiCapabilities, FixtureScenario, LiveCallV2 } from "../api/types";
import type { WorkflowController } from "../workflow/session";
import type { UiError } from "./errors";
import type { CaseSession, DecisionRecord } from "./session";

/** Fixture switches for the next case. Each fixture case keeps the settings it was created with. */
export interface FixtureSettings {
  /** Adds response latency so loading states are visible. */
  showLoading: boolean;
  /** Behaves like a backend with contract V1 only: no live call, step-in or decisions. */
  v1Only: boolean;
}

export interface CaseSessionController {
  apiMode: ApiMode;
  /** The fixture picker; null means the scenario is inferred from the first message. */
  scenario: FixtureScenario | null;
  setScenario(scenario: FixtureScenario | null): void;
  fixtureSettings: FixtureSettings;
  setFixtureSettings(settings: FixtureSettings): void;

  /** Newest first. */
  sessions: readonly CaseSession[];
  active: CaseSession | null;
  /** What the active case's backend supports; null until known. */
  capabilities: CaseApiCapabilities | null;
  /** The newest call on the active case. */
  call: CallV1 | null;
  /** Live data for that call; null when the backend has none for it. */
  live: LiveCallV2 | null;
  /** Set when live polling fails; cleared by the next good read. */
  liveError: UiError | null;
  /** The decision waiting on the person, if any. */
  pendingDecision: DecisionRecord | null;
  /** Milliseconds of the person's active attention on the active case. */
  activeMs: number;

  /** null starts a new case. */
  selectCase(key: string | null): void;
  /** Resolves false when the message was not accepted (for example while a case is being created). */
  send(text: string, files?: File[]): Promise<boolean>;
  /** Persisted conversational intake, present for real HTTP cases. */
  workflow?: WorkflowController;
  retryCreate(): void;
  /** Resolves with the saved case, or null when the save failed (the error is on the session). */
  saveFacts(changes: CaseChanges, expectedRevision: number): Promise<CaseV1 | null>;
  reloadCase(): void;
  /** Reads the active case again after a failed update, keeping any unsaved edits. */
  retryUpdates(): void;
  /** Authorizes the current revision if needed, then starts the call with a stable requestId. */
  approve(): void;
  answerDecision(decisionId: string, optionId: string): void;
  dismissDecision(decisionId: string): void;
  stepIn(): void;
  leaveCall(): void;
  downloadPacket(): void;
}
