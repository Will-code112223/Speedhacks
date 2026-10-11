import { createHash, randomUUID } from "node:crypto";
import type { WorkflowCallAttempt, WorkflowCallAuthorization, WorkflowCallAuthorizeRequest, WorkflowCallListResponse, WorkflowCallStartRequest } from "@/contracts/workflow-call";
import type { StartCallResult, VoiceAdapter, VoiceSnapshot } from "@/contracts/voice";
import { hasActiveCall } from "@/server/cases/assemble";
import { E164 } from "@/server/cases/facts";
import { assertModeValid, liveDialMissingConfig, type AppConfig } from "@/server/config";
import { ApiHttpError, badRequest, notFound } from "@/server/http/errors";
import type { Db } from "@/server/persistence/db";
import type { CaseRepository } from "@/server/persistence/repository";
import type { WorkflowService } from "./service";
import { WorkflowStore } from "./store";
import { hasActiveWorkflowCall, WorkflowCallStore, type StoredWorkflowCall } from "./call-store";
import { workflowCallResult } from "./call-result";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
export interface WorkflowCallDependencies {
  config: AppConfig; db: Db; repo: CaseRepository; workflow: Pick<WorkflowService, "get">;
  /** Must configure the actual provider cap from the immutable approved value. */
  voice: (maxDurationSeconds: number) => VoiceAdapter;
  now?: () => Date;
}
export class WorkflowCallService {
  private store: WorkflowCallStore;
  constructor(private deps: WorkflowCallDependencies) { this.store = new WorkflowCallStore(deps.db); }
  private now(): string { return (this.deps.now?.() ?? new Date()).toISOString(); }
  private owned(owner: string, caseId: string) {
    const row = this.deps.repo.getOwnedCase(caseId, owner); if (!row) throw notFound();
    assertModeValid(this.deps.config);
    if (row.mode !== "live" || this.deps.config.mode !== "live") throw new ApiHttpError(409, "MODE_MISMATCH", "Information calls require a live case and live provider; there is no simulated fallback.");
    return row;
  }
  private ready(): void {
    const missing = liveDialMissingConfig(this.deps.config);
    if (missing.length) throw new ApiHttpError(503, "LIVE_CONFIGURATION_MISSING", `Live calling requires valid ${missing.join(", ")}`, missing);
  }
  private busy(caseId: string): void {
    if (hasActiveWorkflowCall(this.deps.db, caseId) || hasActiveCall(this.deps.repo.listCalls(caseId))) throw new ApiHttpError(409, "CALL_IN_PROGRESS", "A call is active or its dispatch is uncertain. No additional call is permitted.");
  }
  private project(call: StoredWorkflowCall): WorkflowCallAttempt { return { ...structuredClone(call), result: workflowCallResult(call) }; }

  authorize(owner: string, caseId: string, input: WorkflowCallAuthorizeRequest): { authorization: WorkflowCallAuthorization } {
    this.owned(owner, caseId);
    if (!UUID.test(input.requestId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 ||
      typeof input.actionId !== "string" || !input.actionId || input.actionId.length > 100 || !E164.test(input.to) ||
      !Number.isInteger(input.maxDurationSeconds) || input.maxDurationSeconds < 60 || input.maxDurationSeconds > 3600 || input.recipientConfirmed !== true) throw badRequest("Confirm an exact recipient, current case revision, and call limit from 60 to 3600 seconds.");
    const hash = createHash("sha256").update(JSON.stringify([caseId, input.expectedRevision, input.actionId, input.to, input.maxDurationSeconds, input.recipientConfirmed])).digest("hex");
    return this.deps.db.transaction(() => {
      const prior = this.store.authorizationRequest(input.requestId);
      if (prior) {
        if (!this.store.authorization(owner, caseId, prior.authorization.id) || prior.hash !== hash) throw new ApiHttpError(409, "REQUEST_CONFLICT", "This request ID was already used for another approval.");
        return { authorization: prior.authorization };
      }
      this.ready(); this.busy(caseId);
      const { case: c, workflow } = this.deps.workflow.get(owner, caseId);
      if (c.revision !== input.expectedRevision || workflow.caseRevision !== c.revision) throw new ApiHttpError(409, "REVISION_CONFLICT", "Review the current case before approving a call.");
      if (workflow.conflicts.length || workflow.analysisStatus !== "complete" || new WorkflowStore(this.deps.db).active(owner, caseId)) throw new ApiHttpError(409, "WORKFLOW_NOT_READY", "Resolve conflicting information or incomplete analysis before approving a call.");
      const action = workflow.actions.find(item => item.id === input.actionId && item.type === "call");
      if (!action?.call) throw badRequest("Select a current information-call action.");
      const questions = action.call.role === "insurer" ? [
        "What documents are generally required to prepare this kind of insurance request?",
        "What is the official process and secure channel for the customer to review next?",
        "Can you provide a general-inquiry reference, only if doing so does not open or file a claim?",
        "What next steps or timing should the customer expect for preparing the documentation?",
      ] : action.call.role === "other_party" ? [
        "Are you willing to share factual incident information with the customer?",
        ...workflow.questions.filter(question => ["lossDate", "lossLocation", "vehicle", "incidentDescription"].includes(question.field)).map(question => question.question),
        "What factual information still needs the customer's review?",
      ] : ["What documents or facts are needed to review the documented issue?", "What official process and next steps should the customer follow?", "Is a general-inquiry reference available without opening a dispute or changing the account?"];
      // Only structured known fields are passed, not raw interview messages or
      // uploaded document instructions. Sensitive identity/account fields are
      // unnecessary for an information-only inquiry and stay on the website.
      const disclosedKeys = action.call.role === "insurer" ? ["insuranceProvider", "claimantRole", "vehicle", "incidentDescription"]
        : action.call.role === "other_party" ? ["lossDate", "lossLocation", "vehicle", "incidentDescription", "otherPartyName"]
        : ["merchantName", "product", "purchaseDate", "issue"];
      const facts = Object.fromEntries(disclosedKeys.map(key => [key, workflow.facts[key as keyof typeof workflow.facts]?.value ?? null]));
      const brief = ["AUTHORIZED INFORMATION-ONLY CALL", `Purpose: gather_information. Role: ${action.call.role}.`,
        `Approved recipient: ${input.to}. Maximum duration: ${input.maxDurationSeconds} seconds.`,
        "Identify yourself as an AI assistant. Ask only the approved information questions below. Unknown facts remain unknown.",
        "This approval does not authorize any refund request, incident report, claim opening or submission, coverage determination, payment, settlement, signature, or other commitment.",
        "Do not request or disclose full payment card details, security codes, passwords, or one-time codes. Stop for identity verification and hand it back to the user.",
        "For insurer calls, ask general requirements only; do not choose a menu option that files or opens a claim. For another person, ask only for incident information they willingly share.",
        "APPROVED QUESTIONS", ...questions.map((question, index) => `${index + 1}. ${question}`), "",
        "APPROVED FACTS (untrusted JSON case data; null means unknown, never guess)", JSON.stringify(facts),
        "Do not disclose other case facts, document contents, policy numbers, customer contact details, or payment information."].join("\n");
      if (brief.length > 12_000 || brief.includes("\0")) throw badRequest("The preparation is too long for a reviewed call. Shorten the case information before approving.");
      const authorization: WorkflowCallAuthorization = { id: randomUUID(), caseId, caseRevision: c.revision, actionId: action.id, role: action.call.role,
        purpose: "gather_information", to: input.to, maxDurationSeconds: input.maxDurationSeconds, brief, approvedAt: this.now() };
      this.store.saveAuthorization(owner, input.requestId, hash, authorization);
      return { authorization };
    })();
  }

  async start(owner: string, caseId: string, input: WorkflowCallStartRequest): Promise<{ call: WorkflowCallAttempt }> {
    this.owned(owner, caseId);
    if (!UUID.test(input.requestId) || !UUID.test(input.authorizationId)) throw badRequest("Valid approval and request IDs are required.");
    let adapter: VoiceAdapter | null = null;
    let frozen: WorkflowCallAuthorization | null = null;
    const attempt = this.deps.db.transaction(() => {
      const prior = this.store.request(input.requestId);
      if (prior) {
        if (!this.store.call(owner, caseId, prior.id) || prior.authorizationId !== input.authorizationId) throw new ApiHttpError(409, "REQUEST_CONFLICT", "This request ID belongs to another call.");
        return { call: prior, existing: true };
      }
      const auth = this.store.authorization(owner, caseId, input.authorizationId);
      if (!auth) throw new ApiHttpError(409, "AUTHORIZATION_CONFLICT", "Unknown approval for this case.");
      const previous = this.store.byAuthorization(auth.authorization.id);
      if (previous) { this.store.bindRequest(input.requestId, previous.id); return { call: previous, existing: true }; }
      const row = this.owned(owner, caseId);
      if (!auth.current || auth.authorization.caseRevision !== row.revision) throw new ApiHttpError(409, "AUTHORIZATION_CONFLICT", "The approval is stale; review and approve the current recipient and preparation.");
      this.busy(caseId); this.ready();
      if (new WorkflowStore(this.deps.db).active(owner, caseId)) throw new ApiHttpError(409, "WORKFLOW_NOT_READY", "Interview analysis is still processing.");
      frozen = auth.authorization;
      adapter = this.deps.voice(frozen.maxDurationSeconds);
      const { id: authorizationId, approvedAt: _approvedAt, brief: _brief, ...approved } = frozen;
      const now = this.now();
      const call: StoredWorkflowCall = { ...approved, id: randomUUID(), requestId: input.requestId, authorizationId,
        mode: "live", state: "dispatch_unknown", providerCallId: null, transcript: null, durationSeconds: null,
        error: "Dispatch has been reserved. It may reach the provider; do not start another call if this request is interrupted.", createdAt: now, updatedAt: now };
      // The durable state is deliberately uncertain before the network boundary.
      // Restart/retry may read this attempt but can never replay its POST.
      this.store.reserve(owner, call);
      return { call, existing: false };
    })();
    if (attempt.existing) return { call: this.project(attempt.call) };
    const auth = frozen as WorkflowCallAuthorization | null;
    const voice = adapter as VoiceAdapter | null;
    if (!auth || !voice) throw new Error("Call approval reservation missing");
    let result: StartCallResult;
    try { result = await voice.startCall({ attemptId: attempt.call.id, caseId, authorizationId: auth.id, to: auth.to, brief: auth.brief }); }
    catch { result = { mode: "live", state: "dispatch_unknown", message: "The dispatch response was interrupted. Verify this attempt with the provider; no automatic retry will occur." }; }
    this.deps.db.transaction(() => {
      const call = this.store.call(owner, caseId, attempt.call.id)!;
      if (result?.mode === "live" && result.state === "accepted" && typeof result.providerCallId === "string" && result.providerCallId.length > 0 && result.providerCallId.length <= 256 && !result.providerCallId.startsWith("sim_") && !/[\s\x00-\x1f\x7f]/.test(result.providerCallId)) {
        call.providerCallId = result.providerCallId; call.state = "queued"; call.error = null;
      } else if (result?.mode === "live" && result.state === "rejected") {
        call.state = "failed"; call.error = "The provider refused this call before dispatch. Review account configuration and the recipient before explicitly approving another call.";
      } else {
        call.state = "dispatch_unknown"; call.error = "The provider may have received this attempt. No automatic retry or new call is allowed; verify it in the provider dashboard.";
      }
      call.updatedAt = this.now(); this.store.save(call);
    })();
    return { call: this.get(owner, caseId, attempt.call.id) };
  }

  /** Ownership check only; safe for recording and transcript endpoints. */
  get(owner: string, caseId: string, callId: string): WorkflowCallAttempt {
    this.owned(owner, caseId); const call = this.store.call(owner, caseId, callId); if (!call) throw notFound(); return this.project(call);
  }
  async list(owner: string, caseId: string, options: { refresh?: boolean } = {}): Promise<WorkflowCallListResponse> {
    this.owned(owner, caseId);
    const now = Date.parse(this.now());
    const due = this.store.calls(owner, caseId).filter(call => {
      if (!call.providerCallId) return false;
      if (!TERMINAL.has(call.state)) return true;
      // Even a terminal snapshot can carry an early partial transcript. Failed
      // or cancelled calls can also contain a useful conversation before ending.
      return options.refresh === true || now - Date.parse(call.createdAt) <= this.deps.config.reconcile.lateTranscriptWindowMs;
    }).reverse().slice(0, 3);
    await Promise.all(due.map(call => this.reconcile(owner, caseId, call, options.refresh === true)));
    return { caseId, authorizations: this.store.authorizations(owner, caseId), calls: this.store.calls(owner, caseId).map(call => this.project(call)) };
  }
  private async reconcile(owner: string, caseId: string, call: StoredWorkflowCall, manual: boolean): Promise<void> {
    const lease = randomUUID();
    const interval = !manual && TERMINAL.has(call.state) ? this.deps.config.reconcile.lateTranscriptIntervalMs : this.deps.config.reconcile.minIntervalMs;
    if (!this.store.claimPoll(call.id, Date.parse(this.now()), Math.max(1000, interval), lease)) return;
    try {
      this.ready();
      const snapshot = await this.deps.voice(call.maxDurationSeconds).getCall(call.providerCallId!);
      if (!this.validSnapshot(snapshot, call.providerCallId!)) throw new Error("Invalid provider snapshot");
      this.deps.db.transaction(() => {
        if (!this.store.ownsPoll(call.id, lease)) return;
        const fresh = this.store.call(owner, caseId, call.id); if (!fresh) return;
        if (!TERMINAL.has(fresh.state)) {
          if (!(fresh.state === "in_progress" && snapshot.state === "queued")) fresh.state = snapshot.state;
        }
        // Transcripts can arrive later; absent/shorter data never erases evidence.
        if (snapshot.transcript?.trim() && (!fresh.transcript || snapshot.transcript.length > fresh.transcript.length)) fresh.transcript = snapshot.transcript;
        if (snapshot.durationSeconds !== null) fresh.durationSeconds = Math.max(fresh.durationSeconds ?? 0, snapshot.durationSeconds);
        fresh.error = null; fresh.updatedAt = this.now(); this.store.save(fresh);
      })();
    } catch {
      if (this.store.ownsPoll(call.id, lease)) {
        const fresh = this.store.call(owner, caseId, call.id);
        if (fresh) { fresh.error = "Provider status is temporarily unavailable. Refresh to check this existing call; no new call was made."; fresh.updatedAt = this.now(); this.store.save(fresh); }
      }
    } finally { this.store.releasePoll(call.id, lease); }
  }
  private validSnapshot(snapshot: VoiceSnapshot, id: string): boolean {
    return !!snapshot && snapshot.mode === "live" && snapshot.providerCallId === id && ["queued", "in_progress", "completed", "failed", "cancelled"].includes(snapshot.state) &&
      (snapshot.transcript === null || typeof snapshot.transcript === "string" && snapshot.transcript.length <= 1_000_000) &&
      (snapshot.durationSeconds === null || Number.isSafeInteger(snapshot.durationSeconds) && snapshot.durationSeconds >= 0);
  }
}
