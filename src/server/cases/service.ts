import { randomUUID } from "node:crypto";
import { TERMINAL_CALL_STATES, type CallV1, type CaseChanges, type CaseV1, type TimelineEntry } from "@/contracts/case";
import type { VoiceAdapter, VoiceSnapshot } from "@/contracts/voice";
import { isInvalidWebhookError } from "@/contracts/voice";
import { assembleCase, hasActiveCall, toCallV1 } from "@/server/cases/assemble";
import {
  PERMITTED_ACTIONS,
  applyChanges,
  buildBrief,
  buildDraft,
  formatAmount,
  missingFields,
  type Facts,
} from "@/server/cases/facts";
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
  now?: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    const doc: CaseDoc = {
      ...facts,
      missingFields: missing,
      draft: buildDraft(facts, evidenceList),
      authorization: null,
      outcome: { decision: "unknown", referenceNumber: null, nextAction: null, paymentStatus: "unverified", supportingQuote: null },
      timeline,
    };
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
    return this.assemble(id);
  }

  // -------------------------------------------------------------------------
  // PATCH /api/cases/:id
  // -------------------------------------------------------------------------
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
  authorize(ownerSession: string, id: string, expectedRevision: number): CaseV1 {
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
      const missing = missingFields(row.doc);
      if (missing.length > 0) {
        throw new ApiHttpError(422, "MISSING_REQUIRED_FACTS", "Authorization requires every required fact", missing);
      }
      const existing = repo.findAuthorization(id, row.revision);
      if (existing) {
        if (row.doc.authorization?.id !== existing.id) {
          const doc: CaseDoc = {
            ...row.doc,
            authorization: { id: existing.id, revision: existing.revision, approvedAt: existing.approvedAt },
          };
          repo.updateCase(id, { doc, updatedAt: this.nowIso() });
        }
        return; // same revision → same authorization id; never mint a fresh one
      }
      const now = this.nowIso();
      const evidence = repo.listEvidence(id).map((e) => ({ id: e.id, name: e.name, mimeType: e.mimeType }));
      const merchant = { name: row.doc.merchant.name as string, supportPhone: row.doc.merchant.supportPhone as string };
      const amountMinor = row.doc.amountMinor as number;
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
        }),
        permittedActions: [...PERMITTED_ACTIONS],
      };
      const authorization = { id: randomUUID(), caseId: id, revision: row.revision, approvedAt: now, snapshot };
      repo.insertAuthorization(authorization);
      const doc: CaseDoc = {
        ...row.doc,
        authorization: { id: authorization.id, revision: row.revision, approvedAt: now },
        timeline: [
          ...row.doc.timeline,
          this.entry(
            "authorized",
            `Authorized revision ${row.revision}: call ${merchant.supportPhone} (${merchant.name}) about ${formatAmount(amountMinor, row.doc.currency)}.`,
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
    this.ownedRow(ownerSession, id);
    return buildPacket(this.assemble(id), this.deps.repo.listEvidence(id));
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
      repo.updateCase(fresh.caseId, { doc: { ...row.doc, outcome, timeline }, updatedAt: now });
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
      repo.updateCase(call.caseId, { doc: { ...row.doc, outcome, timeline }, updatedAt: now });
    });
  }
}
