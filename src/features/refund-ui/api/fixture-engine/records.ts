/**
 * What the fixture stores. Only inputs live here (facts, decisions, call
 * starts, user interventions); everything that changes with time is derived
 * on read in project.ts. Times are ms on the injected clock.
 */

import type { CaseOutcome } from "../../../../contracts/case";
import type { Intervention } from "./call-run";
import type { Facts, FrozenFacts } from "./facts";
import type { ScenarioDefinition } from "./scenarios";

export interface TimelineItem {
  id: string;
  atMs: number;
  type: string;
  message: string;
}

export interface EvidenceRecord {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export interface AuthorizationRecord {
  id: string;
  revision: number;
  approvedAtMs: number;
  frozen: FrozenFacts;
}

export interface CallRecord {
  id: string;
  caseId: string;
  requestId: string;
  authorizationId: string;
  providerCallId: string | null;
  startedAtMs: number;
  frozen: FrozenFacts;
  /** Set when the provider refused before dispatch; the attempt stays stored as failed. */
  rejectedError: string | null;
  interventions: Intervention[];
}

export interface CaseRecord {
  id: string;
  scenario: ScenarioDefinition;
  revision: number;
  facts: Facts;
  evidence: EvidenceRecord[];
  /** The authorization for the current revision, if any. */
  authorizationId: string | null;
  /** Every authorization ever issued, so repeats for a revision reuse the same id. */
  authorizations: AuthorizationRecord[];
  calls: CallRecord[];
  /** Entries written by mutations; call progress adds derived entries on read. */
  timeline: TimelineItem[];
  /** Outcome as last written by a mutation; a call that finishes later supersedes it. */
  outcome: { value: CaseOutcome; atMs: number };
  createdAtMs: number;
  updatedAtMs: number;
}
