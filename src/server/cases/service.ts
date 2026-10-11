import { randomUUID } from "node:crypto";
import { TERMINAL_CALL_STATES, type CallV1, type CaseChanges, type CaseV1, type TimelineEntry } from "@/contracts/case";
import type { CallPurpose, VoiceAdapter, VoiceSnapshot } from "@/contracts/voice";
import { CALL_PLAN_ACTIONS, isInvalidWebhookError, validateCallPlan } from "@/contracts/voice";
import { assembleCase, hasActiveCall, toCallV1 } from "@/server/cases/assemble";
import {
  applyChanges,
  buildBrief,
  buildCallPlan,
  buildDraft,
  formatAmount,
  isValidAmountMinor,
  missingFields,
  type Facts,
} from "@/server/cases/facts";
import { evaluateHistory, unavailableHistory, type HistoryCheck, type TransactionHistory } from "@/server/cases/history";
import { merchantRecordSummary, type FrozenMerchantRecord, type MerchantInsights, type MerchantInsightsResult } from "@/server/cases/insights";
import { proposeUpdates } from "@/server/cases/answers";
import { analyzeTranscript, unknownOutcome } from "@/server/cases/outcome";
import { type AppConfig, assertLiveLlmConfig, assertModeValid } from "@/server/config";
import type { ExtractedFields, Extractor } from "@/server/documents/extractor";
import { buildPacket } from "@/server/documents/packet";
import { type UploadInput, UploadStore, validateUploads } from "@/server/documents/storage";
import { ApiHttpError, notFound } from "@/server/http/errors";
import type {
  AuthorizationSnapshot,
  CallRow,
  CaseDoc,
  CaseRepository,
  CaseRow,
  EvidenceRow,
  ProvenanceRow,
} from "@/server/persistence/repository";

export interface CreateCaseInput {
  summary: string;
  files: UploadInput[];
  fields: {
    customerName?: string | null;
    customerEmail?: string | null;
    merchantName?: string | null;
    supportPhone?: string | null;
    amountMinor?: number | null;
    currency?: string | null;
  };
}

export interface ServiceDeps {
  config: AppConfig;
  repo: CaseRepository;
  uploads: UploadStore;
  extractor: Extractor;
  /** Lazily resolves the voice adapter; throws a 503 ApiHttpError when live mode is not configured. */
  voice: () => VoiceAdapter;
  /** Optional transaction-history source (Keewano or fixture); absent = no history check. */
  history?: TransactionHistory | null;
  /** Optional merchant track-record source (Keewano or fixture); absent = GET /api/insights/merchant answers available:false. */
  insights?: MerchantInsights | null;
  now?: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Adapter rejection codes that mean "this server is misconfigured", not "the provider refused". */
const CONFIG_REJECTION_CODES = new Set(["MISSING_CONFIG", "INVALID_CONFIG", "SERVER_ONLY", "INVALID_MODE"]);

export class CaseService {
  constructor(private readonly deps: ServiceDeps) {}

  private nowIso(): string {
    return (this.deps.now ?? (() => new Date()))().toISOString();
  }

  private entry(type: string, message: string): TimelineEntry {
    return { id: randomUUID(), at: this.nowIso(), type, message };
  }

  private ownedRow(ownerSession: string, id: string): CaseRow {
    const row = this.deps.repo.getOwnedCase(id, ownerSession);
    if (!row) throw notFound();
    return row;
  }

  /** A case created in one mode never dispatches through the other mode's provider (e.g. after a restart with REFUND_MODE=live). */
  private assertSameMode(row: CaseRow): void {
    if (row.mode !== this.deps.config.mode) {
      throw new ApiHttpError(
        409,
        "MODE_MISMATCH",
        `Case was created in ${row.mode} mode but the server is running in ${this.deps.config.mode} mode`,
      );
    }
  }

  private assemble(id: string): CaseV1 {
    const row = this.deps.repo.getCase(id);
    if (!row) throw notFound();
    return assembleCase(row, this.deps.repo.listEvidence(id), this.deps.repo.listCalls(id));
  }

  // -------------------------------------------------------------------------
  // POST /api/cases
  // -------------------------------------------------------------------------
  async createCase(ownerSession: string, input: CreateCaseInput): Promise<CaseV1> {
    const { config, repo, uploads, extractor } = this.deps;
    assertModeValid(config);
    assertLiveLlmConfig(config);
    const summary = input.summary.trim();
    if (!summary && input.files.length === 0) {
      throw new ApiHttpError(400, "BAD_REQUEST", "Provide a summary or at least one file", ["summary", "files"]);
    }
    validateUploads(input.files, config.upload);

    const caseId = randomUUID();
    const now = this.nowIso();
    const timeline: TimelineEntry[] = [this.entry("case_created", `Case created in ${config.mode} mode.`)];

    const evidence: EvidenceRow[] = input.files.map((f) => {
      const stored = uploads.store(caseId, f);
      timeline.push(this.entry("evidence_added", `Attached ${stored.name} (${stored.mimeType}, ${stored.sizeBytes} bytes).`));
      return { ...stored, caseId, createdAt: now };
    });

    let extracted: ExtractedFields;
    const provenance: ProvenanceRow[] = [];
    try {
      const result = await extractor.extract({
        summary,
        documents: evidence.map((e, i) => ({
          evidenceId: e.id,
          name: e.name,
          mimeType: e.mimeType,
          bytes: input.files[i]?.bytes ?? new Uint8Array(),
        })),
      });
      extracted = result.fields;
      for (const p of result.provenance) {
        provenance.push({
          id: randomUUID(),
          caseId,
          revision: 1,
          field: p.field,
          value: p.value,
          sourceKind: p.sourceKind,
          sourceRef: p.sourceRef,
          excerpt: p.excerpt,
          createdAt: now,
        });
      }
      const found = Object.entries(extracted)
        .filter(([, v]) => v !== null)
        .map(([k]) => k);
      timeline.push(
        this.entry(
          "facts_extracted",
          found.length > 0
            ? `Extracted ${found.join(", ")} (${extractor.kind}).`
            : `No facts could be extracted (${extractor.kind}); fill them in manually.`,
        ),
      );
      for (const note of result.notes) timeline.push(this.entry("extraction_note", note));
    } catch (err) {
      // Live extraction failure is visible, not silently replaced by simulation.
      extracted = { customerName: null, customerEmail: null, merchantName: null, supportPhone: null, amountMinor: null, currency: null };
      timeline.push(
        this.entry("extraction_failed", `Fact extraction failed (${extractor.kind}): ${String((err as Error).message ?? err)}. Fill in the fields manually.`),
      );
    }

    // Explicit form fields override extraction and are recorded as user input.
    const facts: Facts = {
      customer: { name: extracted.customerName, email: extracted.customerEmail },
      merchant: { name: extracted.merchantName, supportPhone: extracted.supportPhone },
      amountMinor: extracted.amountMinor,
      currency: extracted.currency ?? "USD",
      reason: summary,
    };
    const f = input.fields;
    const userInput = (field: string, value: string | number) =>
      provenance.push({
        id: randomUUID(),
        caseId,
        revision: 1,
        field,
        value: String(value),
        sourceKind: "user_input",
        sourceRef: null,
        excerpt: null,
        createdAt: now,
      });
    if (f.customerName) (facts.customer.name = f.customerName), userInput("customerName", f.customerName);
    if (f.customerEmail) (facts.customer.email = f.customerEmail), userInput("customerEmail", f.customerEmail);
    if (f.merchantName) (facts.merchant.name = f.merchantName), userInput("merchantName", f.merchantName);
    if (f.supportPhone) (facts.merchant.supportPhone = f.supportPhone), userInput("supportPhone", f.supportPhone);
    if (typeof f.amountMinor === "number") (facts.amountMinor = f.amountMinor), userInput("amountMinor", f.amountMinor);
    if (f.currency) (facts.currency = f.currency), userInput("currency", f.currency);

    const missing = missingFields(facts);
    const evidenceList = evidence.map((e) => ({ id: e.id, name: e.name, mimeType: e.mimeType }));
    // Pre-authorization transaction-history check (Keewano or the labeled fixture). Bounded; never blocks.
    const [history, merchantRecord] = await Promise.all([this.checkHistory(facts, 1), this.checkMerchant(facts, 1)]);
    const doc: CaseDoc = {
      ...facts,
      missingFields: missing,
      draft: buildDraft(facts, evidenceList),
      authorization: null,
      outcome: { decision: "unknown", referenceNumber: null, nextAction: null, paymentStatus: "unverified", supportingQuote: null },
      timeline,
      history,
      merchantRecord,
    };
    if (history) doc.timeline.push(this.historyEntry(history));
    if (merchantRecord) doc.timeline.push(this.merchantEntry(merchantRecord));
    if (missing.length > 0) doc.timeline.push(this.entry("needs_information", `Missing: ${missing.join(", ")}.`));
    else doc.timeline.push(this.entry("ready_for_approval", "All required facts present; draft generated."));

    repo.transaction(() => {
      repo.insertCase({ id: caseId, ownerSession, revision: 1, mode: config.mode, doc, createdAt: now, updatedAt: now });
      for (const e of evidence) repo.insertEvidence(e);
      for (const p of provenance) repo.insertProvenance(p);
    });
    return this.assemble(caseId);
  }

  // -------------------------------------------------------------------------
  // GET /api/cases/:id  (bounded reconciliation of in-flight calls)
  // -------------------------------------------------------------------------
  async getCase(ownerSession: string, id: string): Promise<CaseV1> {
    this.ownedRow(ownerSession, id);
    await this.reconcileDueCalls(id);
    await this.ensurePreAuthorizationChecks(id);
    return this.assemble(id);
  }

  // -------------------------------------------------------------------------
  // PATCH /api/cases/:id
  // -------------------------------------------------------------------------
  /**
   * V1.1: the user reviews one transcript proposal. Rejecting only records the decision.
   * Accepting a fact proposal is an ordinary user edit through patchCase (new revision,
   * authorization cleared); accepting a question answer records it without changing facts.
   */
  reviewProposedUpdate(ownerSession: string, id: string, updateId: string, decision: "accept" | "reject", expectedRevision: number): CaseV1 {
    const { repo } = this.deps;
    repo.transaction(() => {
      const row = this.ownedRow(ownerSession, id);
      this.assertSameMode(row);
      if (expectedRevision !== row.revision) {
        throw new ApiHttpError(409, "REVISION_CONFLICT", `Case is at revision ${row.revision}, not ${expectedRevision}`);
      }
      const update = row.doc.proposedUpdates?.find((u) => u.id === updateId);
      if (!update) throw notFound("Proposed update not found");
      if (update.status !== "pending") throw new ApiHttpError(400, "BAD_REQUEST", `Proposed update was already ${update.status}`);
      if (decision === "accept" && update.target.kind === "fact") {
        // Facts may only change from the revision the answer was heard against.
        if (update.revision !== row.revision) {
          throw new ApiHttpError(409, "REVISION_CONFLICT", `This answer was proposed for revision ${update.revision}; the case is at revision ${row.revision}`);
        }
        if (update.target.field !== "amountMinor") throw new ApiHttpError(400, "BAD_REQUEST", `Unsupported proposed field ${update.target.field}`);
        const amountMinor = Number(update.value);
        if (!isValidAmountMinor(amountMinor)) throw new ApiHttpError(400, "BAD_REQUEST", "Proposed amount is invalid");
        this.patchCase(ownerSession, id, expectedRevision, { amountMinor });
      }
      const current = repo.getCase(id);
      if (!current) throw notFound();
      const now = this.nowIso();
      const status = decision === "accept" ? "accepted" : "rejected";
      const doc: CaseDoc = {
        ...current.doc,
        proposedUpdates: (current.doc.proposedUpdates ?? []).map((u) => (u.id === updateId ? { ...u, status } : u)),
        timeline: [
          ...current.doc.timeline,
          this.entry(`proposed_update_${status}`, `User ${status} a proposed ${update.target.kind === "fact" ? update.target.field : `answer (${update.target.questionId})`}: "${update.quote}"`),
        ],
      };
      repo.updateCase(id, { doc, updatedAt: now });
    });
    return this.assemble(id);
  }

  patchCase(ownerSession: string, id: string, expectedRevision: number, changes: CaseChanges): CaseV1 {
    const { repo } = this.deps;
    repo.transaction(() => {
      const row = this.ownedRow(ownerSession, id);
      const calls = repo.listCalls(id);
      if (hasActiveCall(calls)) {
        throw new ApiHttpError(409, "CALL_IN_PROGRESS", "Edits are rejected while a call is active or its dispatch is unknown");
      }
      if (expectedRevision !== row.revision) {
        throw new ApiHttpError(409, "REVISION_CONFLICT", `Case is at revision ${row.revision}, not ${expectedRevision}`);
      }
      const { next, changed } = applyChanges(row.doc, changes);
      if (!changed) return;
      const now = this.nowIso();
      const revision = row.revision + 1;
      const evidenceList = repo.listEvidence(id).map((e) => ({ id: e.id, name: e.name, mimeType: e.mimeType }));
      const missing = missingFields(next);
      const doc: CaseDoc = {
        ...row.doc,
        ...next,
        missingFields: missing,
        draft: buildDraft(next, evidenceList),
        authorization: null,
        // A decision belongs to the approved facts. Historical calls and timeline
        // remain available, but their outcome must not apply to a new revision.
        outcome: { decision: "unknown", referenceNumber: null, nextAction: null, paymentStatus: "unverified", supportingQuote: null },
        timeline: [...row.doc.timeline],
      };
      doc.timeline.push(this.entry("facts_updated", `Facts updated (revision ${revision}); draft rebuilt.`));
      if (row.doc.authorization) {
        doc.timeline.push(this.entry("authorization_cleared", `Authorization ${row.doc.authorization.id} cleared by a material edit.`));
      }
      for (const [k, v] of Object.entries(changes)) {
        repo.insertProvenance({
          id: randomUUID(),
          caseId: id,
          revision,
          field: k,
          value: v === null || v === undefined ? null : JSON.stringify(v),
          sourceKind: "user_input",
          sourceRef: null,
          excerpt: null,
          createdAt: now,
        });
      }
      repo.updateCase(id, { doc, revision, updatedAt: now });
    });
    return this.assemble(id);
  }

  // -------------------------------------------------------------------------
  // POST /api/cases/:id/authorize  (idempotent per revision)
  // -------------------------------------------------------------------------
  authorize(ownerSession: string, id: string, expectedRevision: number, purpose: CallPurpose = "request_refund"): CaseV1 {
    const { repo } = this.deps;
    repo.transaction(() => {
      const row = this.ownedRow(ownerSession, id);
      this.assertSameMode(row);
      const calls = repo.listCalls(id);
      if (hasActiveCall(calls)) {
        throw new ApiHttpError(409, "CALL_IN_PROGRESS", "A new authorization is rejected while a call is active or its dispatch is unknown");
      }
      if (expectedRevision !== row.revision) {
        throw new ApiHttpError(409, "REVISION_CONFLICT", `Case is at revision ${row.revision}, not ${expectedRevision}`);
      }
      const missing = missingFields(row.doc, purpose);
      if (missing.length > 0) {
        throw new ApiHttpError(422, "MISSING_REQUIRED_FACTS", "Authorization requires every required fact", missing);
      }
      const existing = repo.findAuthorization(id, row.revision);
      if (existing) {
        // One authorization per revision: a different purpose would silently reuse the other plan.
        const existingPurpose = existing.snapshot.purpose ?? "request_refund";
        if (existingPurpose !== purpose) {
          throw new ApiHttpError(
            409,
            "AUTHORIZATION_CONFLICT",
            `Revision ${row.revision} is already authorized for ${existingPurpose}; edit the case to authorize a different purpose`,
          );
        }
        if (row.doc.authorization?.id !== existing.id) {
          const doc: CaseDoc = {
            ...row.doc,
            authorization: { id: existing.id, revision: existing.revision, approvedAt: existing.approvedAt, purpose: existingPurpose },
          };
          repo.updateCase(id, { doc, updatedAt: this.nowIso() });
        }
        return; // same revision → same authorization id; never mint a fresh one
      }
      const now = this.nowIso();
      const evidence = repo.listEvidence(id).map((e) => ({ id: e.id, name: e.name, mimeType: e.mimeType }));
      const merchant = { name: row.doc.merchant.name as string, supportPhone: row.doc.merchant.supportPhone as string };
      // gather_information may authorize without an amount; request_refund passed missingFields.
      const amountMinor = isValidAmountMinor(row.doc.amountMinor) ? row.doc.amountMinor : null;
      // Only a check of this exact revision is frozen; a stale one is evidence about other facts.
      const history = row.doc.history && row.doc.history.revision === row.revision ? row.doc.history : null;
      const merchantRecord = row.doc.merchantRecord && row.doc.merchantRecord.revision === row.revision ? row.doc.merchantRecord : null;
      const snapshot: AuthorizationSnapshot = {
        caseId: id,
        revision: row.revision,
        customer: { ...row.doc.customer },
        merchant,
        amountMinor,
        currency: row.doc.currency,
        reason: row.doc.reason,
        evidence,
        brief: buildBrief({
          caseId: id,
          revision: row.revision,
          customer: row.doc.customer,
          merchant,
          amountMinor,
          currency: row.doc.currency,
          reason: row.doc.reason,
          evidence,
          history,
          merchantRecord,
          purpose,
        }),
        permittedActions: [...CALL_PLAN_ACTIONS[purpose].permitted],
        history,
        merchantRecord,
        purpose,
        plan: buildCallPlan({
          purpose,
          caseId: id,
          revision: row.revision,
          customer: row.doc.customer,
          merchantName: merchant.name,
          amountMinor,
          currency: row.doc.currency,
          reason: row.doc.reason,
          evidence,
          history,
          merchantRecord,
        }),
      };
      // Validate before freezing: an adapter-side rejection would consume the authorization.
      const planErrors = validateCallPlan(snapshot.plan);
      if (planErrors.length > 0) {
        throw new ApiHttpError(422, "MISSING_REQUIRED_FACTS", `The call plan is invalid: ${planErrors.join("; ")}`);
      }
      const authorization = { id: randomUUID(), caseId: id, revision: row.revision, approvedAt: now, snapshot };
      repo.insertAuthorization(authorization);
      const doc: CaseDoc = {
        ...row.doc,
        authorization: { id: authorization.id, revision: row.revision, approvedAt: now, purpose },
        timeline: [
          ...row.doc.timeline,
          this.entry(
            "authorized",
            purpose === "request_refund"
              ? `Authorized revision ${row.revision}: call ${merchant.supportPhone} (${merchant.name}) about ${formatAmount(amountMinor, row.doc.currency)}.`
              : `Authorized revision ${row.revision}: call ${merchant.supportPhone} (${merchant.name}) to gather information only (no refund request).`,
          ),
        ],
      };
      repo.updateCase(id, { doc, updatedAt: now });
    });
    return this.assemble(id);
  }

  // -------------------------------------------------------------------------
  // POST /api/cases/:id/calls  (one persisted attempt per authorization)
  // -------------------------------------------------------------------------
  async startCall(ownerSession: string, id: string, input: { authorizationId: string; requestId: string }): Promise<CallV1> {
    const { repo, config } = this.deps;
    if (!UUID.test(input.requestId)) throw new ApiHttpError(400, "BAD_REQUEST", "requestId must be a UUID", ["requestId"]);
    if (!UUID.test(input.authorizationId)) {
      throw new ApiHttpError(400, "BAD_REQUEST", "authorizationId must be a UUID", ["authorizationId"]);
    }
    assertModeValid(config);
    // Resolves (and validates) the adapter before anything is persisted: a live
    // configuration error is a 503 with nothing recorded.
    const adapter = this.deps.voice();

    const attemptId = randomUUID();
    const now = this.nowIso();
    let snapshot: AuthorizationSnapshot | null = null;
    const stored = repo.transaction((): CallRow | null => {
      const row = this.ownedRow(ownerSession, id);
      this.assertSameMode(row);
      const auth = repo.getAuthorization(input.authorizationId);
      if (!auth || auth.caseId !== id) {
        throw new ApiHttpError(409, "AUTHORIZATION_CONFLICT", "Unknown authorization for this case");
      }
      const byRequest = repo.findCallByRequestId(input.requestId);
      if (byRequest) {
        if (byRequest.caseId === id && byRequest.authorizationId === input.authorizationId) return byRequest;
        throw new ApiHttpError(409, "AUTHORIZATION_CONFLICT", "requestId was already used for a different action");
      }
      const byAuth = repo.findCallByAuthorizationId(input.authorizationId);
      if (byAuth) return byAuth; // MVP: one dispatch attempt per authorization id
      if (row.doc.authorization?.id !== auth.id || auth.revision !== row.revision) {
        throw new ApiHttpError(409, "AUTHORIZATION_CONFLICT", "Authorization is stale; re-authorize the current revision");
      }
      snapshot = auth.snapshot;
      repo.insertCall({
        id: attemptId,
        caseId: id,
        authorizationId: auth.id,
        requestId: input.requestId,
        providerCallId: null,
        mode: config.mode,
        state: "dispatch_pending",
        transcript: null,
        error: null,
        lastReconciledAt: null,
        createdAt: now,
        updatedAt: now,
      });
      const doc: CaseDoc = {
        ...row.doc,
        timeline: [...row.doc.timeline, this.entry("call_requested", `Call attempt ${attemptId} persisted before dispatch (${config.mode}).`)],
      };
      repo.updateCase(id, { doc, updatedAt: now });
      return null;
    });
    if (stored) return toCallV1(stored);
    const frozen = snapshot as AuthorizationSnapshot | null;
    if (!frozen) throw new Error("authorization snapshot missing");

    // Only the frozen snapshot reaches the provider; nothing from the request body.
    let result: Awaited<ReturnType<VoiceAdapter["startCall"]>>;
    try {
      result = await adapter.startCall({
        attemptId,
        caseId: id,
        authorizationId: input.authorizationId,
        to: frozen.merchant.supportPhone,
        brief: frozen.brief,
        ...(frozen.plan ? { plan: frozen.plan } : {}),
      });
    } catch (err) {
      // The request may have reached the provider: never retry blindly.
      result = { state: "dispatch_unknown", mode: config.mode, message: `Provider call threw: ${String((err as Error).message ?? err)}` };
    }

    const after = this.nowIso();
    repo.transaction(() => {
      const row = repo.getCase(id);
      if (!row) throw notFound();
      const timeline = [...row.doc.timeline];
      let outcome = row.doc.outcome;
      if (result.state === "accepted") {
        repo.updateCall(attemptId, { providerCallId: result.providerCallId, state: "queued", updatedAt: after });
        timeline.push(this.entry("call_dispatched", `Provider accepted the call (provider id ${result.providerCallId}, ${result.mode}).`));
      } else if (result.state === "rejected" && CONFIG_REJECTION_CODES.has(result.code)) {
        // Server misconfiguration surfaced by the adapter: nothing reached the provider and the
        // user did nothing wrong, so the attempt is released instead of consuming the authorization.
        repo.deleteCall(attemptId);
        timeline.push(this.entry("call_dispatch_config_error", `Live configuration error before dispatch: ${result.code} ${result.message}`));
      } else if (result.state === "rejected") {
        // Definitive pre-dispatch refusal. MVP allows one attempt per authorization, so the
        // attempt is retained as failed and the authorization is consumed (audit trail kept).
        repo.updateCall(attemptId, { state: "failed", error: `${result.code}: ${result.message}`, updatedAt: after });
        timeline.push(this.entry("call_dispatch_rejected", `Provider rejected the call before dispatch: ${result.code} ${result.message}`));
        outcome = {
          ...outcome,
          nextAction: `The provider refused the call before dispatch (${result.code}). Edit any case fact to re-authorize and place a new call, or send the refund packet by email.`,
        };
      } else {
        repo.updateCall(attemptId, { state: "dispatch_unknown", error: result.message, updatedAt: after });
        timeline.push(this.entry("call_dispatch_unknown", `Dispatch result unknown: ${result.message}`));
        outcome = {
          ...outcome,
          decision: "unknown",
          nextAction: `Dispatch result for attempt ${attemptId} is unknown. Verify in the provider dashboard whether a call to ${frozen.merchant.supportPhone} was placed before any new attempt; the assistant will not redial automatically.`,
        };
      }
      repo.updateCase(id, { doc: { ...row.doc, timeline, outcome }, updatedAt: after });
    });

    if (result.state === "rejected" && CONFIG_REJECTION_CODES.has(result.code)) {
      throw new ApiHttpError(503, "LIVE_CONFIGURATION_MISSING", `${result.code}: ${result.message}`);
    }
    if (result.state === "rejected") {
      throw new ApiHttpError(503, "PROVIDER_UNAVAILABLE", `Provider rejected the call before dispatch: ${result.message}`);
    }
    if (result.state === "accepted") {
      // An early webhook may have arrived before we knew the provider id.
      const pending = repo.listUnprocessedEvents(result.providerCallId);
      if (pending.length > 0) await this.processCall(attemptId, "webhook");
    }
    const call = repo.getCall(attemptId);
    if (!call) throw new Error("call attempt vanished");
    return toCallV1(call);
  }

  // -------------------------------------------------------------------------
  // GET /api/cases/:id/packet
  // -------------------------------------------------------------------------
  packet(ownerSession: string, id: string): string {
    const row = this.ownedRow(ownerSession, id);
    const history = row.doc.history && row.doc.history.revision === row.revision ? row.doc.history : null;
    const merchantRecord = row.doc.merchantRecord && row.doc.merchantRecord.revision === row.revision ? row.doc.merchantRecord : null;
    return buildPacket(this.assemble(id), this.deps.repo.listEvidence(id), history, merchantRecord);
  }

  // -------------------------------------------------------------------------
  // GET /api/cases/:id/history (additive, not in V1)
  // -------------------------------------------------------------------------
  /** The stored check as is; `current` is false once the facts moved past it (GET /api/cases/:id re-checks). */
  history(ownerSession: string, id: string): { history: HistoryCheck | null; current: boolean } {
    const row = this.ownedRow(ownerSession, id);
    const history = row.doc.history ?? null;
    return { history, current: history !== null && history.revision === row.revision };
  }

  // -------------------------------------------------------------------------
  // GET /api/insights/merchant (additive, not in V1)
  // -------------------------------------------------------------------------
  /** Bounded by the Keewano timeout and never throws: no source or a failed query answers available:false. */
  async merchantInsights(merchant: string): Promise<MerchantInsightsResult> {
    const source = this.deps.insights;
    if (!source) return { available: false, merchant };
    try {
      const record = await withTimeout(source.merchantRecord(merchant), this.deps.config.keewano.timeoutMs, `${source.kind} merchant insights`);
      return { available: true, ...record };
    } catch (err) {
      return { available: false, merchant, error: String((err as Error).message ?? err) };
    }
  }

  // -------------------------------------------------------------------------
  // POST /api/webhooks/dial
  // -------------------------------------------------------------------------
  async handleWebhook(rawBody: Uint8Array, headers: Headers): Promise<{ status: 204 | 401; body?: unknown }> {
    const { repo, config } = this.deps;
    if (config.mode === "live" && !config.dial.webhookSecret) {
      // No subscription secret yet (receiver not deployed/registered): fail visibly, never accept unverified events.
      throw new ApiHttpError(503, "LIVE_CONFIGURATION_MISSING", "Live webhook verification requires DIAL_WEBHOOK_SECRET", [
        "DIAL_WEBHOOK_SECRET",
      ]);
    }
    const adapter = this.deps.voice();
    let verified;
    try {
      verified = await adapter.verifyWebhook(rawBody, headers);
    } catch (err) {
      if (isInvalidWebhookError(err)) {
        return { status: 401, body: { error: { code: "INVALID_WEBHOOK", message: String((err as Error).message) } } };
      }
      const code = (err as { code?: unknown })?.code;
      if (code === "MISSING_CONFIG") {
        // Server misconfiguration, not a forged request: fail visibly.
        throw new ApiHttpError(503, "LIVE_CONFIGURATION_MISSING", String((err as Error).message));
      }
      throw err;
    }
    if (verified === null) return { status: 204 };

    const receivedAt = this.nowIso();
    const matched = repo.findCallByProviderCallId(verified.providerCallId);
    const isNew = repo.insertEventIfNew({
      eventId: verified.eventId,
      providerCallId: verified.providerCallId,
      type: verified.type,
      rawBody,
      receivedAt,
      processedAt: null,
      callId: matched?.id ?? null,
    });
    if (!isNew) return { status: 204 }; // already durably accepted (redelivery)
    if (matched) {
      try {
        await this.processCall(matched.id, "webhook");
      } catch (err) {
        // The event is stored; reconciliation on the next poll will retry processing.
        console.error("[webhook] processing deferred", err);
      }
    }
    // Unmatched events stay queued until the call attempt learns its provider id.
    return { status: 204 };
  }

  // -------------------------------------------------------------------------
  // Transaction history (Keewano or fixture): checked before authorization, shown on
  // the timeline, frozen into the brief. Never a source of facts, never queried mid-call.
  // -------------------------------------------------------------------------
  private historyEntry(check: HistoryCheck): TimelineEntry {
    return this.entry(check.status === "unavailable" ? "history_unavailable" : "history_checked", check.summary);
  }

  /** Bounded and never throws: an unreachable source yields an explicit "unavailable" result. */
  private async checkHistory(facts: Facts, revision: number): Promise<HistoryCheck | null> {
    const source = this.deps.history;
    if (!source) return null;
    const merchantName = facts.merchant.name?.trim();
    const amountMinor = facts.amountMinor;
    if (!merchantName || !isValidAmountMinor(amountMinor)) return null;
    if (!facts.customer.email?.trim() && !facts.customer.name?.trim()) return null;
    const { keewano } = this.deps.config;
    const opts = { revision, checkedAt: this.nowIso(), source: source.kind, windowMinutes: keewano.historyWindowMinutes };
    try {
      const charges = await withTimeout(source.listCharges(facts.customer), keewano.timeoutMs, `${source.kind} history lookup`);
      return evaluateHistory(charges, { merchantName, amountMinor, currency: facts.currency }, opts);
    } catch (err) {
      return unavailableHistory(opts, String((err as Error).message ?? err));
    }
  }

  private merchantEntry(record: FrozenMerchantRecord): TimelineEntry {
    return this.entry("merchant_record", merchantRecordSummary(record));
  }

  /** Merchant track record from mirrored cases; null when there is no source or it failed. Never blocks. */
  private async checkMerchant(facts: Facts, revision: number): Promise<FrozenMerchantRecord | null> {
    const source = this.deps.insights;
    const merchantName = facts.merchant.name?.trim();
    if (!source || !merchantName) return null;
    try {
      const record = await withTimeout(source.merchantRecord(merchantName), this.deps.config.keewano.timeoutMs, `${source.kind} merchant record`);
      return { ...record, revision, checkedAt: this.nowIso() };
    } catch {
      return null;
    }
  }

  /**
   * Pre-authorization checks run once per revision (a fact edit re-triggers them): the
   * transaction-history check (an unavailable result is retried after a pause) and the
   * merchant track record. Results land on the timeline and are frozen at authorization.
   */
  private async ensurePreAuthorizationChecks(id: string): Promise<void> {
    const { repo, config } = this.deps;
    const row = repo.getCase(id);
    if (!row) return;
    const prev = row.doc.history ?? null;
    let needHistory = Boolean(this.deps.history);
    if (needHistory && prev && prev.revision === row.revision) {
      needHistory = prev.status === "unavailable" && Date.parse(this.nowIso()) - Date.parse(prev.checkedAt) >= config.keewano.retryMs;
    }
    const prevRecord = row.doc.merchantRecord ?? null;
    const needMerchant = Boolean(this.deps.insights) && (!prevRecord || prevRecord.revision !== row.revision);
    if (!needHistory && !needMerchant) return;
    const [check, record] = await Promise.all([
      needHistory ? this.checkHistory(row.doc, row.revision) : Promise.resolve(null),
      needMerchant ? this.checkMerchant(row.doc, row.revision) : Promise.resolve(null),
    ]);
    if (!check && !record) return;
    repo.transaction(() => {
      const latest = repo.getCase(id);
      if (!latest || latest.revision !== row.revision) return; // facts changed meanwhile; the next GET re-checks
      const timeline = [...latest.doc.timeline];
      const doc: CaseDoc = { ...latest.doc, timeline };
      if (check) {
        const current = latest.doc.history ?? null;
        const fresh = current && current.revision === check.revision && (current.status !== "unavailable" || current.checkedAt === check.checkedAt);
        if (!fresh) {
          doc.history = check;
          timeline.push(this.historyEntry(check));
        }
      }
      if (record) {
        const current = latest.doc.merchantRecord ?? null;
        if (!current || current.revision !== record.revision) {
          doc.merchantRecord = record;
          timeline.push(this.merchantEntry(record));
        }
      }
      if (timeline.length === latest.doc.timeline.length) return;
      repo.updateCase(id, { doc, updatedAt: this.nowIso() });
    });
  }

  // -------------------------------------------------------------------------
  // Reconciliation: bounded provider polling when a webhook is missed
  // -------------------------------------------------------------------------
  private async reconcileDueCalls(caseId: string): Promise<void> {
    const { repo, config } = this.deps;
    const nowMs = Date.parse(this.nowIso());
    const sinceReconcile = (c: CallRow) => (c.lastReconciledAt ? nowMs - Date.parse(c.lastReconciledAt) : Number.POSITIVE_INFINITY);
    const calls = repo.listCalls(caseId).filter((c) => c.providerCallId !== null && c.mode === config.mode);
    const inFlight = calls.filter(
      (c) => (c.state === "queued" || c.state === "in_progress") && sinceReconcile(c) >= config.reconcile.minIntervalMs,
    );
    for (const call of inFlight) {
      try {
        await this.processCall(call.id, "poll");
      } catch (err) {
        console.error("[reconcile] provider lookup failed", err);
        repo.updateCall(call.id, { lastReconciledAt: this.nowIso(), updatedAt: this.nowIso() });
      }
    }
    // Read-only recovery of a transcript that arrived after the wait window expired. Never redials.
    const lateTranscript = calls.filter(
      (c) =>
        c.state === "completed" &&
        !c.transcript?.trim() &&
        nowMs - Date.parse(c.createdAt) <= config.reconcile.lateTranscriptWindowMs &&
        sinceReconcile(c) >= config.reconcile.lateTranscriptIntervalMs,
    );
    for (const call of lateTranscript) await this.refreshLateTranscript(call.id);
  }

  private async refreshLateTranscript(callId: string): Promise<void> {
    const { repo } = this.deps;
    const call = repo.getCall(callId);
    if (!call?.providerCallId) return;
    let snapshot: VoiceSnapshot;
    try {
      snapshot = await this.deps.voice().getCall(call.providerCallId);
    } catch (err) {
      console.error("[reconcile] late transcript lookup failed", err);
      repo.updateCall(callId, { lastReconciledAt: this.nowIso(), updatedAt: this.nowIso() });
      return;
    }
    repo.transaction(() => {
      const fresh = repo.getCall(callId);
      if (!fresh || fresh.state !== "completed" || fresh.transcript?.trim()) return;
      const now = this.nowIso();
      if (!snapshot.transcript?.trim()) {
        repo.updateCall(callId, { lastReconciledAt: now, updatedAt: now });
        return;
      }
      const row = repo.getCase(fresh.caseId);
      if (!row) return;
      const auth = repo.getAuthorization(fresh.authorizationId);
      const timeline = [...row.doc.timeline, this.entry("transcript_received_late", `Transcript for call ${callId} arrived after the wait window; attached read-only.`)];
      let outcome = row.doc.outcome;
      // Recheck ownership after the provider await, inside this transaction. A
      // completed historical call can gain a transcript without deciding new facts.
      if (auth && row.doc.authorization?.id === auth.id && auth.revision === row.revision && outcome.decision === "unknown") {
        const ctx = { amountMinor: auth.snapshot.amountMinor, currency: auth.snapshot.currency, merchantName: auth.snapshot.merchant.name };
        try {
          outcome = analyzeTranscript(snapshot.transcript, ctx);
        } catch (err) {
          outcome = unknownOutcome(`Transcript analysis failed: ${String((err as Error).message ?? err)}.`);
        }
        timeline.push(
          this.entry(
            "outcome_published",
            `Decision: ${outcome.decision}; reference: ${outcome.referenceNumber ?? "none"}; payment: ${outcome.paymentStatus}.`,
          ),
        );
      }
      // State stays completed: terminal states never regress; only the missing transcript and outcome are filled in.
      repo.updateCall(callId, { transcript: snapshot.transcript, lastReconciledAt: now, updatedAt: now });
      const proposedUpdates = this.withProposals(row, callId, auth, snapshot.transcript, timeline, now);
      repo.updateCase(fresh.caseId, { doc: { ...row.doc, outcome, timeline, proposedUpdates }, updatedAt: now });
    });
  }

  /** Fetch authenticated provider details and publish them atomically. Terminal states never regress. */
  async processCall(callId: string, source: "webhook" | "poll"): Promise<void> {
    const { repo } = this.deps;
    const call = repo.getCall(callId);
    if (!call || !call.providerCallId) return;
    if (TERMINAL_CALL_STATES.includes(call.state)) {
      repo.markEventsProcessed(call.providerCallId, call.id, this.nowIso());
      return;
    }
    if (call.mode !== this.deps.config.mode) return; // a simulated call is never looked up through the live provider
    const snapshot = await this.deps.voice().getCall(call.providerCallId);
    this.publishSnapshot(call.id, snapshot, source);
  }

  private publishSnapshot(callId: string, snapshot: VoiceSnapshot, source: "webhook" | "poll"): void {
    const { repo } = this.deps;
    repo.transaction(() => {
      const call = repo.getCall(callId);
      if (!call || !call.providerCallId) return;
      const now = this.nowIso();
      if (TERMINAL_CALL_STATES.includes(call.state)) {
        repo.markEventsProcessed(call.providerCallId, call.id, now);
        return;
      }
      const row = repo.getCase(call.caseId);
      if (!row) return;
      const timeline = [...row.doc.timeline];

      if (snapshot.state === "queued" || snapshot.state === "in_progress") {
        const forward = snapshot.state === "in_progress" && call.state !== "in_progress";
        repo.updateCall(callId, {
          state: forward ? "in_progress" : call.state,
          lastReconciledAt: now,
          updatedAt: now,
        });
        if (forward) {
          timeline.push(this.entry("call_in_progress", `Call in progress (via ${source}).`));
          repo.updateCase(call.caseId, { doc: { ...row.doc, timeline }, updatedAt: now });
        }
        return;
      }

      // Dial's call.ended precedes call.transcribed: keep the call non-terminal and keep
      // reading (bounded) until the transcript arrives, then publish everything at once.
      if (snapshot.state === "completed" && !snapshot.transcript?.trim()) {
        const seenAt = repo.getTerminalSeenAt(callId);
        const waited = seenAt ? Date.parse(now) - Date.parse(seenAt) : 0;
        if (!seenAt || waited < this.deps.config.reconcile.transcriptWaitMs) {
          repo.updateCall(callId, {
            state: call.state === "queued" ? "in_progress" : call.state,
            lastReconciledAt: now,
            updatedAt: now,
          });
          if (!seenAt) {
            repo.setTerminalSeenAt(callId, now);
            timeline.push(this.entry("call_ended_awaiting_transcript", `Provider reports the call ended; waiting for the transcript (via ${source}).`));
            repo.updateCase(call.caseId, { doc: { ...row.doc, timeline }, updatedAt: now });
          }
          return;
        }
      }

      const auth = repo.getAuthorization(call.authorizationId);
      const ctx = auth
        ? { amountMinor: auth.snapshot.amountMinor, currency: auth.snapshot.currency, merchantName: auth.snapshot.merchant.name }
        : { amountMinor: row.doc.amountMinor ?? 0, currency: row.doc.currency, merchantName: row.doc.merchant.name ?? "the merchant" };

      let outcome = row.doc.outcome;
      if (snapshot.state === "completed") {
        if (!snapshot.transcript?.trim()) {
          outcome = unknownOutcome("The call ended but no transcript arrived within the wait window.");
        } else {
          try {
            outcome = analyzeTranscript(snapshot.transcript, ctx);
          } catch (err) {
            outcome = unknownOutcome(`Transcript analysis failed: ${String((err as Error).message ?? err)}.`);
          }
        }
        timeline.push(this.entry("call_completed", `Call completed (${snapshot.durationSeconds ?? "?"}s, via ${source}).`));
      } else {
        outcome = {
          decision: "unknown",
          referenceNumber: null,
          nextAction: `The call ended as ${snapshot.state} before a decision. Edit any case fact to re-authorize and place a new call, or send the refund packet by email.`,
          paymentStatus: "unverified",
          supportingQuote: null,
        };
        timeline.push(this.entry(`call_${snapshot.state}`, `Call ${snapshot.state} (via ${source}).`));
      }
      timeline.push(
        this.entry(
          "outcome_published",
          `Decision: ${outcome.decision}; reference: ${outcome.referenceNumber ?? "none"}; payment: ${outcome.paymentStatus}.`,
        ),
      );
      repo.updateCall(callId, {
        state: snapshot.state,
        transcript: snapshot.transcript,
        lastReconciledAt: now,
        updatedAt: now,
      });
      repo.markEventsProcessed(call.providerCallId, call.id, now);
      const proposedUpdates = this.withProposals(row, call.id, auth, snapshot.transcript, timeline, now);
      repo.updateCase(call.caseId, { doc: { ...row.doc, outcome, timeline, proposedUpdates }, updatedAt: now });
    });
  }

  /**
   * V1.1: proposals from a transcript, only for the call of the CURRENT authorization and
   * revision (a late transcript can never populate a newer plan), once per call, never applied.
   */
  private withProposals(
    row: CaseRow,
    callId: string,
    auth: ReturnType<CaseRepository["getAuthorization"]>,
    transcript: string | null,
    timeline: TimelineEntry[],
    now: string,
  ): CaseDoc["proposedUpdates"] {
    const existing = row.doc.proposedUpdates;
    const plan = auth?.snapshot.plan;
    if (!auth || !plan || !transcript?.trim()) return existing;
    if (row.doc.authorization?.id !== auth.id || auth.revision !== row.revision) return existing;
    if (existing?.some((u) => u.callId === callId)) return existing;
    const fresh = proposeUpdates({ transcript, plan, callId, authorizationId: auth.id, revision: auth.revision, now });
    if (fresh.length === 0) return existing;
    timeline.push(this.entry("updates_proposed", `${fresh.length} answer(s) from call ${callId} proposed for review; nothing was changed.`));
    return [...(existing ?? []), ...fresh];
  }
}
