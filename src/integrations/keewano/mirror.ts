import type { CaseStatus } from "@/contracts/case";
import { deriveStatus } from "@/server/cases/assemble";
import type { Db } from "@/server/persistence/db";
import { CaseRepository, type CallRow, type CaseDoc, type CaseRow } from "@/server/persistence/repository";
import { MAX_UINT32, event, type KeewanoEvent } from "./events";
import type { EventSink } from "./sink";

/**
 * One-way mirror of live cases into Keewano, keyed by random case UUID: approved
 * timeline types, derived statuses, USD amounts, call states, and outcomes only.
 * Free-form text (including merchant names) and customer identifiers never leave here. Nothing here reads Keewano or changes a case. Emits are synchronous
 * and in memory, so they are safe inside SQLite transactions; the sink ships later.
 *
 * Inside a transaction, events are buffered and the derived status is computed once at
 * commit, so Keewano only ever sees states the API publishes (a call row updated before
 * its outcome is not an "awaiting_response" case) and nothing from a rolled-back write.
 */
export class MirroredCaseRepository extends CaseRepository {
  private readonly sink: EventSink;
  /** Last status emitted per case in this process, so every status change is captured once. */
  private readonly lastStatus = new Map<string, CaseStatus>();
  private depth = 0;
  private buffered: Array<{ entity: string; events: KeewanoEvent[] }> = [];
  private readonly touched = new Map<string, string>();

  constructor(db: Db, sink: EventSink) {
    super(db);
    this.sink = sink;
  }

  override transaction<T>(fn: () => T): T {
    const bufferStart = this.buffered.length;
    const touchedBefore = new Map(this.touched);
    this.depth += 1;
    let committed = false;
    try {
      const result = super.transaction(fn);
      committed = true;
      return result;
    } finally {
      this.depth -= 1;
      if (!committed) {
        // A caught nested SQLite savepoint rollback must not leak its events.
        this.buffered.length = bufferStart;
        this.touched.clear();
        for (const [id, at] of touchedBefore) this.touched.set(id, at);
      }
      if (this.depth === 0) {
        if (committed) {
          for (const b of this.buffered) this.sink.emit(b.entity, b.events);
          this.buffered = [];
          for (const [caseId, at] of this.touched) this.emitStatusNow(caseId, at);
          this.touched.clear();
        } else {
          this.buffered = [];
          this.touched.clear();
        }
      }
    }
  }

  private queue(entity: string, events: KeewanoEvent[]): void {
    if (events.length === 0 || this.getCase(entity)?.mode !== "live") return;
    if (this.depth > 0) this.buffered.push({ entity, events });
    else this.sink.emit(entity, events);
  }

  override insertCase(row: CaseRow): void {
    super.insertCase(row);
    if (row.mode !== "live") return;
    const events: KeewanoEvent[] = [event("RefundCaseMode", row.mode, row.createdAt), ...docEvents(null, row.doc, row.createdAt)];
    this.queue(row.id, events);
    this.emitStatus(row.id, row.createdAt);
  }

  override updateCase(id: string, patch: { doc: CaseDoc; revision?: number; updatedAt: string }): void {
    const before = this.getCase(id);
    super.updateCase(id, patch);
    if (!before || before.mode !== "live") return;
    this.queue(id, docEvents(before.doc, patch.doc, patch.updatedAt));
    this.emitStatus(id, patch.updatedAt);
  }

  override insertCall(row: CallRow): void {
    super.insertCall(row);
    if (row.mode !== "live" || !CALL_STATES.has(row.state)) return;
    this.queue(row.caseId, [event("RefundCallState", row.state, row.createdAt)]);
    this.emitStatus(row.caseId, row.createdAt);
  }

  override updateCall(
    id: string,
    patch: Partial<Pick<CallRow, "providerCallId" | "state" | "transcript" | "error" | "lastReconciledAt">> & { updatedAt: string },
  ): void {
    super.updateCall(id, patch);
    if (patch.state === undefined || !CALL_STATES.has(patch.state)) return;
    const call = this.getCall(id);
    if (!call || call.mode !== "live") return;
    this.queue(call.caseId, [event("RefundCallState", patch.state, patch.updatedAt)]);
    this.emitStatus(call.caseId, patch.updatedAt);
  }

  /** Inside a transaction the status is evaluated once at commit; outside, immediately. */
  private emitStatus(caseId: string, at: string): void {
    if (this.depth > 0) this.touched.set(caseId, at);
    else this.emitStatusNow(caseId, at);
  }

  private emitStatusNow(caseId: string, at: string): void {
    const row = this.getCase(caseId);
    if (!row || row.mode !== "live") return;
    const status = deriveStatus(row, this.listCalls(caseId));
    if (this.lastStatus.get(caseId) === status) return;
    this.lastStatus.set(caseId, status);
    this.sink.emit(caseId, [event("RefundCaseStatus", status, at)]);
  }
}

/** Events for what changed between two versions of the case document. */
export function docEvents(before: CaseDoc | null, after: CaseDoc, at: string): KeewanoEvent[] {
  const events: KeewanoEvent[] = [];
  const seen = new Set((before?.timeline ?? []).map((t) => t.id));
  for (const t of after.timeline) {
    if (!seen.has(t.id) && TIMELINE_TYPES.has(t.type) && Number.isFinite(Date.parse(t.at))) {
      events.push(event("RefundCaseEvent", t.type, t.at));
    }
  }
  if (
    after.amountMinor !== null &&
    Number.isInteger(after.amountMinor) && after.amountMinor >= 0 &&
    after.amountMinor !== before?.amountMinor &&
    after.currency === "USD" &&
    after.amountMinor <= MAX_UINT32
  ) {
    events.push(event("RefundAmount", after.amountMinor, at));
  }
  if (OUTCOMES.has(after.outcome.decision) && after.outcome.decision !== (before?.outcome.decision ?? "unknown")) {
    events.push(event("RefundOutcome", after.outcome.decision, at));
  }
  return events;
}

// Explicit allowlists prevent malformed/imported documents from turning enum fields
// into a covert free-text export. Unknown future event types are omitted until reviewed.
const CALL_STATES = new Set(["dispatch_pending", "queued", "in_progress", "completed", "failed", "cancelled", "dispatch_unknown"]);
const OUTCOMES = new Set(["unknown", "requested", "needs_information", "approved", "denied"]);
const TIMELINE_TYPES = new Set([
  "case_created", "evidence_added", "extraction_failed", "extraction_note", "facts_updated",
  "needs_information", "ready_for_approval", "authorized", "authorization_cleared", "call_requested",
  "call_dispatch_config_error", "call_dispatch_rejected", "call_dispatch_unknown", "call_dispatched",
  "call_in_progress", "call_completed", "call_ended_awaiting_transcript", "transcript_received_late",
]);
