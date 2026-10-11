import type { CallState, CaseV1, Mode } from "@/contracts/case";
import type { CallPlanV1, CallPurpose } from "@/contracts/voice";
import type { HistoryCheck } from "@/server/cases/history";
import type { FrozenMerchantRecord } from "@/server/cases/insights";
import type { Db } from "@/server/persistence/db";

/** Mutable case fields stored as one JSON document; calls/evidence live in their own tables. */
export interface CaseDoc {
  customer: CaseV1["customer"];
  merchant: CaseV1["merchant"];
  amountMinor: number | null;
  currency: string;
  reason: string;
  missingFields: string[];
  draft: CaseV1["draft"];
  authorization: CaseV1["authorization"];
  outcome: CaseV1["outcome"];
  timeline: CaseV1["timeline"];
  /** Pre-authorization transaction-history check (Keewano/fixture); absent on older rows. */
  history?: HistoryCheck | null;
  /** Pre-authorization merchant track record (Keewano/fixture); absent on older rows. */
  merchantRecord?: FrozenMerchantRecord | null;
}

export interface CaseRow {
  id: string;
  ownerSession: string;
  revision: number;
  mode: Mode;
  doc: CaseDoc;
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceRow {
  id: string;
  caseId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  storedPath: string;
  sha256: string;
  createdAt: string;
}

export interface ProvenanceRow {
  id: string;
  caseId: string;
  revision: number;
  field: string;
  value: string | null;
  sourceKind: "summary" | "document" | "user_input" | "llm";
  sourceRef: string | null;
  excerpt: string | null;
  createdAt: string;
}

/** Frozen at authorization time; never rebuilt from later edits. */
export interface AuthorizationSnapshot {
  caseId: string;
  revision: number;
  customer: CaseV1["customer"];
  merchant: { name: string; supportPhone: string };
  /** null only for a gather_information authorization (V1.1). */
  amountMinor: number | null;
  currency: string;
  reason: string;
  evidence: CaseV1["evidence"];
  brief: string;
  /** V1.1; absent on pre-V1.1 rows = request_refund. */
  purpose?: CallPurpose;
  /** V1.1 plan frozen with the brief; absent on pre-V1.1 rows (adapter then uses the brief). */
  plan?: CallPlanV1;
  permittedActions: string[];
  /** History evidence frozen with the brief (same revision only). */
  history?: HistoryCheck | null;
  /** Merchant track record frozen with the brief (same revision only). */
  merchantRecord?: FrozenMerchantRecord | null;
}

export interface AuthorizationRow {
  id: string;
  caseId: string;
  revision: number;
  approvedAt: string;
  snapshot: AuthorizationSnapshot;
}

export interface CallRow {
  id: string;
  caseId: string;
  authorizationId: string;
  requestId: string;
  providerCallId: string | null;
  mode: Mode;
  state: CallState;
  transcript: string | null;
  error: string | null;
  lastReconciledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderEventRow {
  eventId: string;
  providerCallId: string;
  type: string;
  rawBody: Uint8Array;
  receivedAt: string;
  processedAt: string | null;
  callId: string | null;
}

type RawCase = {
  id: string;
  owner_session: string;
  revision: number;
  mode: string;
  doc: string;
  created_at: string;
  updated_at: string;
};
type RawEvidence = {
  id: string;
  case_id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  stored_path: string;
  sha256: string;
  created_at: string;
};
type RawAuth = { id: string; case_id: string; revision: number; approved_at: string; snapshot: string };
type RawCall = {
  id: string;
  case_id: string;
  authorization_id: string;
  request_id: string;
  provider_call_id: string | null;
  mode: string;
  state: string;
  transcript: string | null;
  error: string | null;
  last_reconciled_at: string | null;
  created_at: string;
  updated_at: string;
};
type RawEvent = {
  event_id: string;
  provider_call_id: string;
  type: string;
  raw_body: Buffer;
  received_at: string;
  processed_at: string | null;
  call_id: string | null;
};

const toCase = (r: RawCase): CaseRow => ({
  id: r.id,
  ownerSession: r.owner_session,
  revision: r.revision,
  mode: r.mode as Mode,
  doc: JSON.parse(r.doc) as CaseDoc,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toEvidence = (r: RawEvidence): EvidenceRow => ({
  id: r.id,
  caseId: r.case_id,
  name: r.name,
  mimeType: r.mime_type,
  sizeBytes: r.size_bytes,
  storedPath: r.stored_path,
  sha256: r.sha256,
  createdAt: r.created_at,
});
const toAuth = (r: RawAuth): AuthorizationRow => ({
  id: r.id,
  caseId: r.case_id,
  revision: r.revision,
  approvedAt: r.approved_at,
  snapshot: JSON.parse(r.snapshot) as AuthorizationSnapshot,
});
const toCall = (r: RawCall): CallRow => ({
  id: r.id,
  caseId: r.case_id,
  authorizationId: r.authorization_id,
  requestId: r.request_id,
  providerCallId: r.provider_call_id,
  mode: r.mode as Mode,
  state: r.state as CallState,
  transcript: r.transcript,
  error: r.error,
  lastReconciledAt: r.last_reconciled_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toEvent = (r: RawEvent): ProviderEventRow => ({
  eventId: r.event_id,
  providerCallId: r.provider_call_id,
  type: r.type,
  rawBody: new Uint8Array(r.raw_body),
  receivedAt: r.received_at,
  processedAt: r.processed_at,
  callId: r.call_id,
});

export class CaseRepository {
  constructor(private readonly db: Db) {}

  /** Run fn atomically. better-sqlite3 transactions are synchronous; never await inside. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---- cases ----
  insertCase(row: CaseRow): void {
    this.db
      .prepare(
        `INSERT INTO cases (id, owner_session, revision, mode, doc, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.ownerSession, row.revision, row.mode, JSON.stringify(row.doc), row.createdAt, row.updatedAt);
  }

  getCase(id: string): CaseRow | null {
    const r = this.db.prepare(`SELECT * FROM cases WHERE id = ?`).get(id) as RawCase | undefined;
    return r ? toCase(r) : null;
  }

  getOwnedCase(id: string, ownerSession: string): CaseRow | null {
    const r = this.db
      .prepare(`SELECT * FROM cases WHERE id = ? AND owner_session = ?`)
      .get(id, ownerSession) as RawCase | undefined;
    return r ? toCase(r) : null;
  }

  updateCase(id: string, patch: { doc: CaseDoc; revision?: number; updatedAt: string }): void {
    if (patch.revision !== undefined) {
      this.db
        .prepare(`UPDATE cases SET doc = ?, revision = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(patch.doc), patch.revision, patch.updatedAt, id);
    } else {
      this.db
        .prepare(`UPDATE cases SET doc = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(patch.doc), patch.updatedAt, id);
    }
  }

  // ---- evidence & provenance ----
  insertEvidence(row: EvidenceRow): void {
    this.db
      .prepare(
        `INSERT INTO evidence (id, case_id, name, mime_type, size_bytes, stored_path, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.caseId, row.name, row.mimeType, row.sizeBytes, row.storedPath, row.sha256, row.createdAt);
  }

  listEvidence(caseId: string): EvidenceRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM evidence WHERE case_id = ? ORDER BY created_at, id`)
      .all(caseId) as RawEvidence[];
    return rows.map(toEvidence);
  }

  insertProvenance(row: ProvenanceRow): void {
    this.db
      .prepare(
        `INSERT INTO provenance (id, case_id, revision, field, value, source_kind, source_ref, excerpt, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.caseId,
        row.revision,
        row.field,
        row.value,
        row.sourceKind,
        row.sourceRef,
        row.excerpt,
        row.createdAt,
      );
  }

  listProvenance(caseId: string): ProvenanceRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM provenance WHERE case_id = ? ORDER BY created_at, id`)
      .all(caseId) as Array<{
      id: string;
      case_id: string;
      revision: number;
      field: string;
      value: string | null;
      source_kind: ProvenanceRow["sourceKind"];
      source_ref: string | null;
      excerpt: string | null;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      caseId: r.case_id,
      revision: r.revision,
      field: r.field,
      value: r.value,
      sourceKind: r.source_kind,
      sourceRef: r.source_ref,
      excerpt: r.excerpt,
      createdAt: r.created_at,
    }));
  }

  // ---- authorizations ----
  insertAuthorization(row: AuthorizationRow): void {
    this.db
      .prepare(
        `INSERT INTO authorizations (id, case_id, revision, approved_at, snapshot) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.caseId, row.revision, row.approvedAt, JSON.stringify(row.snapshot));
  }

  getAuthorization(id: string): AuthorizationRow | null {
    const r = this.db.prepare(`SELECT * FROM authorizations WHERE id = ?`).get(id) as RawAuth | undefined;
    return r ? toAuth(r) : null;
  }

  findAuthorization(caseId: string, revision: number): AuthorizationRow | null {
    const r = this.db
      .prepare(`SELECT * FROM authorizations WHERE case_id = ? AND revision = ?`)
      .get(caseId, revision) as RawAuth | undefined;
    return r ? toAuth(r) : null;
  }

  // ---- call attempts ----
  insertCall(row: CallRow): void {
    this.db
      .prepare(
        `INSERT INTO call_attempts
           (id, case_id, authorization_id, request_id, provider_call_id, mode, state, transcript, error, last_reconciled_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.caseId,
        row.authorizationId,
        row.requestId,
        row.providerCallId,
        row.mode,
        row.state,
        row.transcript,
        row.error,
        row.lastReconciledAt,
        row.createdAt,
        row.updatedAt,
      );
  }

  deleteCall(id: string): void {
    this.db.prepare(`DELETE FROM call_attempts WHERE id = ?`).run(id);
  }

  updateCall(
    id: string,
    patch: Partial<Pick<CallRow, "providerCallId" | "state" | "transcript" | "error" | "lastReconciledAt">> & {
      updatedAt: string;
    },
  ): void {
    const sets: string[] = ["updated_at = ?"];
    const args: unknown[] = [patch.updatedAt];
    if ("providerCallId" in patch) {
      sets.push("provider_call_id = ?");
      args.push(patch.providerCallId ?? null);
    }
    if ("state" in patch) {
      sets.push("state = ?");
      args.push(patch.state);
    }
    if ("transcript" in patch) {
      sets.push("transcript = ?");
      args.push(patch.transcript ?? null);
    }
    if ("error" in patch) {
      sets.push("error = ?");
      args.push(patch.error ?? null);
    }
    if ("lastReconciledAt" in patch) {
      sets.push("last_reconciled_at = ?");
      args.push(patch.lastReconciledAt ?? null);
    }
    args.push(id);
    this.db.prepare(`UPDATE call_attempts SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  }

  /** First time the provider reported the call ended without a transcript (bounded transcript wait). */
  getTerminalSeenAt(callId: string): string | null {
    const r = this.db.prepare(`SELECT terminal_seen_at FROM call_reconciliation WHERE call_id = ?`).get(callId) as
      | { terminal_seen_at: string }
      | undefined;
    return r?.terminal_seen_at ?? null;
  }

  setTerminalSeenAt(callId: string, at: string): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO call_reconciliation (call_id, terminal_seen_at) VALUES (?, ?)`)
      .run(callId, at);
  }

  getCall(id: string): CallRow | null {
    const r = this.db.prepare(`SELECT * FROM call_attempts WHERE id = ?`).get(id) as RawCall | undefined;
    return r ? toCall(r) : null;
  }

  listCalls(caseId: string): CallRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM call_attempts WHERE case_id = ? ORDER BY created_at, id`)
      .all(caseId) as RawCall[];
    return rows.map(toCall);
  }

  findCallByRequestId(requestId: string): CallRow | null {
    const r = this.db.prepare(`SELECT * FROM call_attempts WHERE request_id = ?`).get(requestId) as
      | RawCall
      | undefined;
    return r ? toCall(r) : null;
  }

  findCallByAuthorizationId(authorizationId: string): CallRow | null {
    const r = this.db
      .prepare(`SELECT * FROM call_attempts WHERE authorization_id = ?`)
      .get(authorizationId) as RawCall | undefined;
    return r ? toCall(r) : null;
  }

  findCallByProviderCallId(providerCallId: string): CallRow | null {
    const r = this.db
      .prepare(`SELECT * FROM call_attempts WHERE provider_call_id = ?`)
      .get(providerCallId) as RawCall | undefined;
    return r ? toCall(r) : null;
  }

  // ---- provider events (durable dedup by eventId) ----
  /** Returns true when the event was new; false when it was already durably accepted. */
  insertEventIfNew(row: ProviderEventRow): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO provider_events (event_id, provider_call_id, type, raw_body, received_at, processed_at, call_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.eventId,
        row.providerCallId,
        row.type,
        Buffer.from(row.rawBody),
        row.receivedAt,
        row.processedAt,
        row.callId,
      );
    return result.changes === 1;
  }

  markEventsProcessed(providerCallId: string, callId: string, processedAt: string): void {
    this.db
      .prepare(
        `UPDATE provider_events SET processed_at = ?, call_id = ? WHERE provider_call_id = ? AND processed_at IS NULL`,
      )
      .run(processedAt, callId, providerCallId);
  }

  listUnprocessedEvents(providerCallId: string): ProviderEventRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM provider_events WHERE provider_call_id = ? AND processed_at IS NULL ORDER BY received_at`,
      )
      .all(providerCallId) as RawEvent[];
    return rows.map(toEvent);
  }

  getEvent(eventId: string): ProviderEventRow | null {
    const r = this.db.prepare(`SELECT * FROM provider_events WHERE event_id = ?`).get(eventId) as
      | RawEvent
      | undefined;
    return r ? toEvent(r) : null;
  }
}
