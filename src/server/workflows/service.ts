import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CaseChanges, CaseV1 } from "@/contracts/case";
import type { CaseWorkflow, WorkflowContact, WorkflowFact, WorkflowFactKey, WorkflowKind, WorkflowMessage, WorkflowMessageRequest, WorkflowResponse } from "@/contracts/workflow";
import { assembleCase, hasActiveCall } from "@/server/cases/assemble";
import { E164, MAX_AMOUNT_MINOR } from "@/server/cases/facts";
import type { CaseService } from "@/server/cases/service";
import { assertModeValid, type AppConfig } from "@/server/config";
import type { ExtractionDocument } from "@/server/documents/extractor";
import { normalizeMime, UploadStore, validateUploads, type StoredUpload, type UploadInput } from "@/server/documents/storage";
import { textFromDocument } from "@/server/documents/text";
import { ApiHttpError, badRequest, notFound } from "@/server/http/errors";
import type { Db } from "@/server/persistence/db";
import type { CaseRepository, CaseRow } from "@/server/persistence/repository";
import { workflowContacts } from "./contacts";
import { caseFacts, e164Phone, FACT_KEYS, FACT_LABELS, initialKind, isPhoneKey, refinedValue, samePhone } from "./facts";
import { parseWorkflowExtraction, WorkflowModelError, type WorkflowExtractor, type WorkflowExtraction } from "./extractor";
import { nextAssistantMessage, rebuildWorkflow } from "./planning";
import { WorkflowStore, type WorkflowOperation } from "./store";

export interface WorkflowDependencies {
  config: AppConfig; db: Db; repo: CaseRepository; cases: CaseService; extractor: WorkflowExtractor;
  contacts?: (kind: WorkflowKind, facts: CaseWorkflow["facts"]) => WorkflowContact[];
  now?: () => Date;
}
export interface EvidenceRequest { requestId: string; expectedRevision: number; message?: string; files: UploadInput[] }
type Turn = { requestId: string; expectedRevision: number; message: string; files: UploadInput[]; analyze: boolean };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const normal = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const failureMessage = (error: unknown): string => error instanceof WorkflowModelError && error.code === "MODEL_QUOTA"
  ? "The model account has no available credits. Your information was saved; fund the account, then analyze the saved information again."
  : error instanceof WorkflowModelError && error.code === "MODEL_AUTH"
  ? "The model rejected authentication. Your information was saved; check server configuration, then analyze it again."
  : "The live model could not complete this update. Your information was saved without inventing facts. Review it, then analyze the saved information again.";
function amountMinor(value: string | null | undefined): number | null {
  const text = value?.trim().replace(/^\$\s*/, "").replace(/,/g, "");
  if (!text || !/^\d{1,12}(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole = "", decimal = ""] = text.split("."); const result = Number(whole) * 100 + Number(decimal.padEnd(2, "0"));
  return Number.isSafeInteger(result) && result > 0 && result <= MAX_AMOUNT_MINOR ? result : null;
}

export class WorkflowService {
  private store: WorkflowStore;
  private uploads: UploadStore;
  private activeLeases = new Set<string>();
  constructor(private deps: WorkflowDependencies) { this.store = new WorkflowStore(deps.db); this.uploads = new UploadStore(deps.config.dataDir); }
  private now(): string { return (this.deps.now?.() ?? new Date()).toISOString(); }
  private row(owner: string, id: string): CaseRow {
    const c = this.deps.repo.getOwnedCase(id, owner); if (!c) throw notFound(); return c;
  }
  private assembled(c: CaseRow): CaseV1 { return assembleCase(c, this.deps.repo.listEvidence(c.id), this.deps.repo.listCalls(c.id)); }
  private contacts(workflow: CaseWorkflow): WorkflowContact[] { return (this.deps.contacts ?? ((kind, facts) => workflowContacts(kind, facts, this.deps.config.dataDir)))(workflow.kind, workflow.facts); }
  private plan(workflow: CaseWorkflow, c: CaseV1, state?: "processing" | "failed"): CaseWorkflow {
    let contacts: WorkflowContact[] = [];
    try { contacts = this.contacts(workflow); } catch {
      workflow = { ...workflow, conflicts: [...new Set([...workflow.conflicts, "Contact directory unavailable; review a sourced destination before external action."])] };
    }
    return rebuildWorkflow(workflow, c, contacts, this.now(), state);
  }
  private canonicalFacts(c: CaseRow): CaseWorkflow["facts"] {
    const facts = caseFacts(c);
    // V1 historically supplies USD even when the source never names a currency.
    // That transport default is not a supported interview fact.
    const currencySupported = this.deps.repo.listProvenance(c.id).some(p => p.field === "currency" &&
      p.value !== null && [c.doc.currency, JSON.stringify(c.doc.currency)].includes(p.value));
    if (!currencySupported && facts.currency) facts.currency.value = null;
    return facts;
  }
  private bootstrap(c: CaseRow): CaseWorkflow {
    const first: WorkflowMessage = { id: randomUUID(), role: "user", content: c.doc.reason || "Evidence attached for review.", createdAt: c.createdAt };
    const facts = this.canonicalFacts(c); if (facts.issue) facts.issue = { ...facts.issue, source: "user", sourceRefs: [first.id] };
    const genericRequest = /\b(?:help|refund request|prepare|want|need|get a refund|request a refund)\b/i.test(first.content) &&
      !/\b(?:because|arrived|wrong|broken|damaged|missing|cancelled|canceled|defective|failed|never received|not received|charged twice|double charged)\b/i.test(first.content);
    if (genericRequest && facts.issue) facts.issue.value = null;
    // Exact user phrasing only; this classifies stated intent, not eligibility or a completed model pass.
    const intent = first.content.match(/\b(?:get|request|want|need|seek)\s+(?:a\s+)?refund\b|\bprepare\s+(?:a\s+)?(?:car|auto|insurance|car insurance|auto insurance)\s+claim\b/i)?.[0];
    if (intent) facts.desiredOutcome = { label: FACT_LABELS.desiredOutcome, value: intent, source: "user", sourceRefs: [first.id] };
    const workflow: CaseWorkflow = { caseId: c.id, caseRevision: c.revision, kind: initialKind(c.doc.reason), stage: "collecting", facts,
      messages: [first], questions: [], conflicts: [], contacts: [], brief: { title: "", body: "", updatedAt: this.now() }, actions: [], updatedAt: this.now(), analysisStatus: "not_started" };
    const planned = this.plan(workflow, this.assembled(c));
    planned.messages.push({ id: randomUUID(), role: "assistant", createdAt: this.now(),
      content: "I loaded the information already in your case. The initial questions are based on known fields; the live model has not analyzed this interview yet." });
    return planned;
  }
  private syncCanonical(workflow: CaseWorkflow, c: CaseRow): void {
    const canonical = this.canonicalFacts(c);
    for (const key of ["customerName", "customerEmail", "merchantName", "supportPhone", "amount", "currency", "issue"] as const) {
      const current = canonical[key];
      if (current?.value !== workflow.facts[key]?.value) workflow.facts[key] = current;
    }
  }
  /** Read-only with respect to providers. Local bootstrap/recovery is persisted. */
  get(owner: string, id: string): WorkflowResponse {
    const c = this.row(owner, id); let workflow = this.store.get(owner, id) ?? this.bootstrap(c);
    const operation = this.store.active(owner, id);
    if (operation && operation.expiresAt <= Date.parse(this.now())) {
      this.deps.db.transaction(() => {
        this.store.finish(operation, "failed");
        workflow.analysisStatus = "failed";
        workflow.messages.push({ id: randomUUID(), role: "assistant", createdAt: this.now(), content: "The previous analysis was interrupted. Your saved answers and evidence remain available. No model request was replayed; analyze the saved information again when ready." });
        workflow = this.plan(workflow, this.assembled(c), "failed"); this.store.save(owner, workflow);
      })();
    }
    if (workflow.caseRevision !== c.revision) {
      this.syncCanonical(workflow, c);
      workflow.analysisStatus = "not_started";
      workflow.messages.push({ id: randomUUID(), role: "assistant", createdAt: this.now(), content: "The case changed outside this interview. I refreshed the canonical facts; analyze the saved information to review the preparation again." });
      workflow = this.plan(workflow, this.assembled(c));
    }
    this.store.save(owner, workflow);
    return { case: this.assembled(c), workflow: structuredClone(workflow) };
  }
  async message(owner: string, id: string, input: WorkflowMessageRequest): Promise<WorkflowResponse> {
    return this.turn(owner, id, { ...input, files: [], analyze: false });
  }
  async evidence(owner: string, id: string, input: EvidenceRequest): Promise<WorkflowResponse> {
    return this.turn(owner, id, { ...input, message: input.message?.trim() || "Evidence attached for review.", analyze: false });
  }
  async analyze(owner: string, id: string, input: { requestId: string; expectedRevision: number }): Promise<WorkflowResponse> {
    return this.turn(owner, id, { ...input, message: "", files: [], analyze: true });
  }
  private validate(turn: Turn): void {
    if (!UUID.test(turn.requestId) || !Number.isSafeInteger(turn.expectedRevision) || turn.expectedRevision < 1 ||
      typeof turn.message !== "string" || (!turn.analyze && !turn.message.trim()) || turn.message.length > 5000) throw badRequest("Invalid interview request", ["requestId", "expectedRevision", "message"]);
    validateUploads(turn.files, this.deps.config.upload);
  }
  private documents(c: CaseRow): ExtractionDocument[] {
    return this.deps.repo.listEvidence(c.id).map(e => {
      const directory = fs.realpathSync(path.join(this.deps.config.dataDir, "uploads", c.id));
      const file = fs.realpathSync(e.storedPath);
      if (path.dirname(file) !== directory || !fs.statSync(file).isFile() || fs.statSync(file).size > this.deps.config.upload.maxBytes) throw new Error("EVIDENCE_SCOPE_INVALID");
      const bytes = this.uploads.read(file);
      if (createHash("sha256").update(bytes).digest("hex") !== e.sha256) throw new Error("EVIDENCE_CHANGED");
      return { evidenceId: e.id, name: e.name, mimeType: e.mimeType, bytes };
    });
  }
  private async turn(owner: string, id: string, turn: Turn): Promise<WorkflowResponse> {
    this.row(owner, id); this.validate(turn); assertModeValid(this.deps.config);
    if (this.deps.config.mode !== "live") throw new ApiHttpError(409, "MODE_MISMATCH", "The interview requires a live case; no simulated model fallback is available");
    const hash = digest({ analyze: turn.analyze, message: turn.message.trim(), expectedRevision: turn.expectedRevision,
      files: turn.files.map(f => ({ name: f.name, mimeType: normalizeMime(f.mimeType), hash: createHash("sha256").update(f.bytes).digest("hex") })) });
    const prior = this.store.operation(owner, id, turn.requestId);
    if (prior) {
      if (prior.hash !== hash) throw new ApiHttpError(409, "REQUEST_CONFLICT", "This request ID belongs to different interview information");
      const saved = this.get(owner, id);
      if (this.store.operation(owner, id, turn.requestId)?.status === "processing") throw new ApiHttpError(409, "WORKFLOW_BUSY", "This interview update is still processing; refresh its persisted state");
      return saved;
    }
    const current = this.get(owner, id);
    if (current.case.revision !== turn.expectedRevision) throw new ApiHttpError(409, "REVISION_CONFLICT", "The case changed; review the current interview before updating it");
    if (this.store.active(owner, id)) throw new ApiHttpError(409, "WORKFLOW_BUSY", "Another interview update is already processing");
    if (hasActiveCall(this.deps.repo.listCalls(id))) throw new ApiHttpError(409, "CALL_IN_PROGRESS", "A call is active or uncertain; interview edits cannot replace its approved facts");
    if (current.workflow.messages.length >= 100) throw new ApiHttpError(413, "INTERVIEW_LIMIT", "This interview reached its message limit; finish reviewing the saved preparation");
    if (this.deps.repo.listEvidence(id).length + turn.files.length > this.deps.config.upload.maxFiles) throw badRequest(`At most ${this.deps.config.upload.maxFiles} evidence files per case`, ["files"]);
    const created: StoredUpload[] = [];
    let workflow = structuredClone(current.workflow);
    const message: WorkflowMessage = turn.analyze
      ? [...workflow.messages].reverse().find(m => m.role === "user")!
      : { id: randomUUID(), role: "user", content: turn.message.trim(), createdAt: this.now() };
    const operation: WorkflowOperation = { caseId: id, owner, requestId: turn.requestId, hash, status: "processing", acceptedRevision: current.case.revision + 1, lease: randomUUID(), expiresAt: Date.parse(this.now()) + 120_000 };
    try {
      this.deps.db.transaction(() => {
        for (const f of turn.files) created.push(this.uploads.store(id, f));
        if (!turn.analyze) workflow.messages.push(message);
        workflow.analysisStatus = "processing";
        const updated = this.deps.cases.applyWorkflowUpdate(owner, id, turn.expectedRevision, { changes: {}, evidence: created,
          draft: { subject: workflow.brief.title, body: workflow.brief.body }, message: turn.analyze ? "Analysis of saved interview information started." : "Interview information saved; analysis is pending." });
        operation.acceptedRevision = updated.revision;
        workflow = this.plan(workflow, updated, "processing");
        const accepted = this.row(owner, id);
        this.deps.repo.updateCase(id, { doc: { ...accepted.doc, draft: { subject: workflow.brief.title, body: workflow.brief.body } }, updatedAt: this.now() });
        this.store.reserve(operation); this.store.save(owner, workflow);
      })();
    } catch (error) {
      for (const f of created) fs.rmSync(f.storedPath, { force: true }); throw error;
    }
    this.activeLeases.add(operation.lease);
    try {
      const documents = this.documents(this.row(owner, id));
      const extraction = parseWorkflowExtraction(await this.deps.extractor.extract({ workflow: structuredClone(workflow), documents, message }));
      this.deps.db.transaction(() => {
        const liveOperation = this.store.operation(owner, id, operation.requestId);
        if (liveOperation?.status !== "processing" || liveOperation.lease !== operation.lease || liveOperation.expiresAt <= Date.parse(this.now())) throw new ApiHttpError(409, "REQUEST_CONFLICT", "This analysis no longer owns the pending update");
        const row = this.row(owner, id);
        if (row.revision !== operation.acceptedRevision) throw new ApiHttpError(409, "REVISION_CONFLICT", "The case changed during analysis; its newer facts were preserved");
        workflow = this.merge(workflow, extraction, documents);
        workflow.analysisStatus = "complete";
        const preview = this.plan(workflow, this.assembled(row));
        const updated = this.deps.cases.applyWorkflowUpdate(owner, id, row.revision, { changes: this.changes(preview),
          draft: { subject: preview.brief.title, body: preview.brief.body }, message: "Supported interview facts applied; preparation rebuilt.",
          provenance: Object.entries(preview.facts).filter(([, fact]) => fact?.value && fact.sourceRefs.length).map(([field, fact]) => ({
            field, value: fact!.value, sourceKind: fact!.source === "document" ? "document" as const : "user_input" as const,
            sourceRef: fact!.sourceRefs.at(-1) ?? null,
            excerpt: extraction.facts.find(candidate => candidate.key === field && fact!.sourceRefs.includes(candidate.sourceId) && candidate.value === fact!.value)?.quote ?? null,
          })) });
        workflow = this.plan(workflow, updated);
        // Keep the V1 packet draft synchronized to this final revision's neutral brief.
        const finalRow = this.row(owner, id);
        this.deps.repo.updateCase(id, { doc: { ...finalRow.doc, draft: { subject: workflow.brief.title, body: workflow.brief.body } }, updatedAt: this.now() });
        workflow.messages.push({ id: randomUUID(), role: "assistant", content: nextAssistantMessage(workflow), createdAt: this.now() });
        this.store.finish(operation, "completed"); this.store.save(owner, workflow);
      })();
      return this.get(owner, id);
    } catch (error) {
      this.deps.db.transaction(() => {
        if (!this.store.finish(operation, "failed")) return;
        const latest = this.row(owner, id);
        workflow = this.store.get(owner, id) ?? workflow;
        if (latest.revision !== operation.acceptedRevision) this.syncCanonical(workflow, latest);
        workflow.analysisStatus = "failed";
        workflow.messages.push({ id: randomUUID(), role: "assistant", createdAt: this.now(), content: error instanceof ApiHttpError && error.status === 409
          ? "The case changed during analysis. I preserved the newer facts and saved your message; review the current case before analyzing again." : failureMessage(error) });
        workflow = this.plan(workflow, this.assembled(latest), "failed"); this.store.save(owner, workflow);
      })();
      if (error instanceof ApiHttpError && error.status === 409) throw new ApiHttpError(409, "WORKFLOW_REVISION_CONFLICT", "Your information was saved, but the case changed during analysis. Refresh before analyzing the saved information again.");
      throw new ApiHttpError(503, "WORKFLOW_MODEL_FAILED", failureMessage(error));
    } finally { this.activeLeases.delete(operation.lease); }
  }
  private merge(workflow: CaseWorkflow, extraction: WorkflowExtraction, documents: ExtractionDocument[]): CaseWorkflow {
    const next = structuredClone(workflow); next.kind = extraction.kind;
    const sources = new Map<string, { source: "user" | "document"; text: string | null }>();
    for (const m of workflow.messages) if (m.role === "user") sources.set(m.id, { source: "user", text: m.content });
    for (const d of documents) sources.set(d.evidenceId, { source: "document", text: textFromDocument(d.mimeType, d.bytes) });
    const ambiguousNew = new Set<WorkflowFactKey>();
    const latestUserId = [...workflow.messages].reverse().find(message => message.role === "user")?.id;
    for (const candidate of extraction.facts) {
      if (ambiguousNew.has(candidate.key)) continue;
      const source = sources.get(candidate.sourceId);
      if (!source || (source.text !== null && !normal(source.text).includes(normal(candidate.quote))) || !normal(candidate.quote).includes(normal(candidate.value))) continue;
      const existing = next.facts[candidate.key];
      const value = isPhoneKey(candidate.key) ? e164Phone(candidate.value) : candidate.value;
      const proposed: WorkflowFact = { label: FACT_LABELS[candidate.key], value, source: source.source, sourceRefs: [candidate.sourceId] };
      if (!existing?.value) { next.facts[candidate.key] = proposed; continue; }
      const same = normal(existing.value) === normal(candidate.value) ||
        (candidate.key === "amount" && amountMinor(existing.value) !== null && amountMinor(existing.value) === amountMinor(candidate.value)) ||
        (isPhoneKey(candidate.key) && samePhone(existing.value, candidate.value));
      if (same) { existing.sourceRefs = [...new Set([...existing.sourceRefs, candidate.sourceId])]; continue; }
      const explicitIntent = candidate.key === "desiredOutcome" && source.source === "user" && candidate.sourceId === latestUserId && /\b(?:want|need|request|seek|please|help|get|prepare)\b/i.test(source.text ?? "");
      const explicitCorrection = source.source === "user" && candidate.sourceId === latestUserId && candidate.resolvesConflict &&
        (/\b(?:actually|correction|correct|instead|meant|previous|replace|not)\b/i.test(source.text ?? "") || workflow.conflicts.some(c => c.startsWith(`${candidate.key}:`)));
      if (explicitIntent || explicitCorrection) {
        next.facts[candidate.key] = proposed; next.conflicts = next.conflicts.filter(c => !c.startsWith(`${candidate.key}:`)); continue;
      }
      if ((candidate.key === "issue" || candidate.key === "incidentDescription") &&
        (normal(existing.value).includes(normal(candidate.value)) || normal(candidate.value).includes(normal(existing.value)))) {
        if (candidate.value.length > existing.value.length) existing.value = candidate.value;
        existing.sourceRefs = [...new Set([...existing.sourceRefs, candidate.sourceId])]; continue;
      }
      // One source naming the fact more fully than another is agreement, not a conflict to put back to the person.
      const refined = refinedValue(candidate.key, existing.value, candidate.value);
      if (refined !== null) {
        existing.value = refined;
        existing.sourceRefs = [...new Set([...existing.sourceRefs, candidate.sourceId])]; continue;
      }
      const conflict = `${candidate.key}: ${FACT_LABELS[candidate.key]} was recorded as “${existing.value}”, but another source says “${candidate.value}”. Which is correct?`;
      if (!next.conflicts.includes(conflict)) next.conflicts.push(conflict);
      if (!workflow.facts[candidate.key]?.value) {
        next.facts[candidate.key] = { ...existing, value: null, sourceRefs: [...new Set([...existing.sourceRefs, candidate.sourceId])] };
        ambiguousNew.add(candidate.key);
      }
    }
    return next;
  }
  private changes(workflow: CaseWorkflow): CaseChanges {
    const get = (key: WorkflowFactKey) => workflow.facts[key]?.value ?? null;
    const changes: CaseChanges = { customer: { name: get("customerName"), email: get("customerEmail") }, merchant: { name: get("merchantName") ?? get("insuranceProvider"), supportPhone: get("supportPhone") } };
    if (changes.customer?.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(changes.customer.email)) changes.customer.email = null;
    if (changes.merchant?.supportPhone && !E164.test(changes.merchant.supportPhone)) changes.merchant.supportPhone = null;
    const amount = amountMinor(get("amount")); if (amount !== null) changes.amountMinor = amount;
    const currency = get("currency"); if (currency && /^[A-Z]{3}$/.test(currency)) changes.currency = currency;
    const issue = get("issue"); if (issue) changes.reason = issue.slice(0, 5000);
    return changes;
  }
}
