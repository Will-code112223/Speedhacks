import type { CaseStatus } from "@/contracts/case";
import { deriveStatus } from "@/server/cases/assemble";
import type { Db } from "@/server/persistence/db";
import { CaseRepository, type CallRow, type CaseDoc, type CaseRow } from "@/server/persistence/repository";
import { MAX_UINT32, event, type KeewanoEvent } from "./events";
import type { EventSink } from "./sink";

/**
 * One-way mirror of every case into Keewano, keyed by case id: each timeline entry (at
 * its own time), derived status changes, merchant, amount, call states, outcome and the
 * history check. Nothing here reads Keewano or changes a case. Emits are synchronous
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
    this.depth += 1;
    let committed = false;
    try {
      const result = super.transaction(fn);
      committed = true;
      return result;
    } finally {
      this.depth -= 1;
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
    if (events.length === 0) return;
    if (this.depth > 0) this.buffered.push({ entity, events });
    else this.sink.emit(entity, events);
  }

  override insertCase(row: CaseRow): void {
    super.insertCase(row);
    const events: KeewanoEvent[] = [event("RefundCaseMode", row.mode, row.createdAt), ...docEvents(null, row.doc, row.createdAt)];
    this.queue(row.id, events);
    this.emitStatus(row.id, row.createdAt);
  }

  override updateCase(id: string, patch: { doc: CaseDoc; revision?: number; updatedAt: string }): void {
    const before = this.getCase(id);
    super.updateCase(id, patch);
    if (!before) return;
    this.queue(id, docEvents(before.doc, patch.doc, patch.updatedAt));
    this.emitStatus(id, patch.updatedAt);
  }

  override insertCall(row: CallRow): void {
    super.insertCall(row);
    this.queue(row.caseId, [event("RefundCallState", row.state, row.createdAt)]);
    this.emitStatus(row.caseId, row.createdAt);
  }

  override updateCall(
    id: string,
    patch: Partial<Pick<CallRow, "providerCallId" | "state" | "transcript" | "error" | "lastReconciledAt">> & { updatedAt: string },
  ): void {
    super.updateCall(id, patch);
    if (patch.state === undefined) return;
    const call = this.getCall(id);
    if (!call) return;
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
    if (!row) return;
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
  for (const t of after.timeline) if (!seen.has(t.id)) events.push(event("RefundCaseEvent", t.type, t.at));
  if (after.merchant.name && after.merchant.name !== before?.merchant.name) {
    events.push(event("RefundMerchant", after.merchant.name, at));
  }
  if (
    after.amountMinor !== null &&
    after.amountMinor !== before?.amountMinor &&
    after.currency === "USD" &&
    after.amountMinor <= MAX_UINT32
  ) {
    events.push(event("RefundAmount", after.amountMinor, at));
  }
  if (after.outcome.decision !== (before?.outcome.decision ?? "unknown")) {
    events.push(event("RefundOutcome", after.outcome.decision, at));
  }
  if (after.history && after.history.checkedAt !== before?.history?.checkedAt) {
    events.push(event("RefundHistoryCheck", after.history.status, after.history.checkedAt));
  }
  return events;
}
