import { ACTIVE_CALL_STATES, type CallV1, type CaseStatus, type CaseV1 } from "@/contracts/case";
import type { CallRow, CaseRow, EvidenceRow } from "@/server/persistence/repository";
import { CALL_PURPOSES } from "@/contracts/voice";
import { missingFields, suggestedPurpose } from "@/server/cases/facts";

export function toCallV1(row: CallRow): CallV1 {
  return {
    id: row.id,
    requestId: row.requestId,
    authorizationId: row.authorizationId,
    providerCallId: row.providerCallId,
    mode: row.mode,
    state: row.state,
    transcript: row.transcript,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function hasActiveCall(calls: CallRow[]): boolean {
  return calls.some((c) => ACTIVE_CALL_STATES.includes(c.state));
}

/** Status is derived, never stored, so it can't drift from the facts, authorization and calls. */
export function deriveStatus(row: CaseRow, calls: CallRow[]): CaseStatus {
  const doc = row.doc;
  if (hasActiveCall(calls)) return "calling";
  const latestTerminal = [...calls].reverse().find((c) => c.state === "completed" && c.authorizationId === doc.authorization?.id);
  if (doc.authorization && latestTerminal) {
    switch (doc.outcome.decision) {
      case "approved":
        return "approved";
      case "denied":
        return "denied";
      case "needs_information":
        return "needs_information";
      default:
        return "awaiting_response";
    }
  }
  if (doc.authorization) return "authorized";
  return doc.missingFields.length > 0 ? "needs_information" : "ready_for_approval";
}

export function assembleCase(row: CaseRow, evidence: EvidenceRow[], calls: CallRow[]): CaseV1 {
  const doc = row.doc;
  return {
    schemaVersion: 1,
    id: row.id,
    revision: row.revision,
    mode: row.mode,
    status: deriveStatus(row, calls),
    customer: { ...doc.customer },
    merchant: { name: doc.merchant.name, supportPhone: doc.merchant.supportPhone, source: doc.merchant.source ? { ...doc.merchant.source } : null },
    amountMinor: doc.amountMinor,
    currency: doc.currency,
    reason: doc.reason,
    policyNumber: doc.policyNumber ?? null,
    incidentDate: doc.incidentDate ?? null,
    lossDescription: doc.lossDescription ?? null,
    claimType: doc.claimType ?? null,
    evidence: evidence.map((e) => ({ id: e.id, name: e.name, mimeType: e.mimeType })),
    missingFields: [...doc.missingFields],
    suggestedPurpose: suggestedPurpose(doc),
    missingFieldsByPurpose: Object.fromEntries(CALL_PURPOSES.map((p) => [p, missingFields(doc, p)])),
    draft: doc.draft ? { ...doc.draft } : null,
    authorization: doc.authorization ? { ...doc.authorization } : null,
    calls: calls.map(toCallV1),
    outcome: { ...doc.outcome },
    timeline: doc.timeline.map((t) => ({ ...t })),
    ...(doc.proposedUpdates?.length ? { proposedUpdates: doc.proposedUpdates.map((u) => ({ ...u, target: { ...u.target } })) } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
