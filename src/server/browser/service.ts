import { createHash, randomUUID } from "node:crypto";
import type { BrowserCommand, BrowserRun, StartBrowserRequest } from "@/contracts/browser";
import type { CaseRow } from "@/server/persistence/repository";
import { ApiHttpError, notFound } from "@/server/http/errors";
import { BrowserStore } from "./store";
import { parseCommand, parseStart, scopedUrl } from "./security";
import { parseStep, PlannerError } from "./planner";
import type { BrowserPort, Observation, Planner, StoredArtifact, StoredRun } from "./types";
import { BrowserPageChangedError } from "./types";

export interface BrowserDependencies {
  store: BrowserStore; planner: Planner;
  enabled: boolean; configured: boolean;
  loadCase(owner: string, id: string): Promise<CaseRow>;
  evidence(owner: string, caseId: string): Promise<StoredArtifact[]>;
  /** Current persisted interview brief, when the additive workflow is available. */
  preparation?(owner: string, caseId: string, revision: number): Promise<string | null>;
  executionPolicy?(owner: string, caseId: string): Promise<NonNullable<BrowserRun["executionPolicy"]>>;
  launch(input: { startUrl: string; hosts: string[]; signal: AbortSignal; onLost(): void; onBlocked(host?: string): void }): Promise<BrowserPort>;
  now?: () => number;
}
interface Worker {
  row: StoredRun; port: BrowserPort | null; controller: AbortController; busy: boolean;
  frame: Buffer | null; timer: ReturnType<typeof setTimeout>; blocked: Set<string>;
}
const TERMINAL = new Set(["completed", "failed", "cancelled", "uncertain"]);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (run: BrowserRun): BrowserRun => structuredClone(run);
function safeFailure(error: unknown, fallback: string): string {
  if (error instanceof PlannerError) return ({ PLANNER_QUOTA: "The live model account has no available credits. Fund the configured account before starting another browser run.",
    PLANNER_RATE_LIMIT: "The live model provider rate-limited this run. No automatic retry was performed.",
    PLANNER_AUTH: "The live model provider rejected authentication. Check the server's model credentials.",
    PLANNER_UNAVAILABLE: "The live model provider is unavailable. No automatic retry was performed." })[error.code];
  if (error instanceof Error && error.message === "HEADED_BROWSER_REQUIRED") return "Login requires BROWSER_HEADLESS=false and a local desktop display. No login or browser visibility is available in headless mode.";
  return fallback;
}
export function preparationDocument(c: CaseRow): string {
  const known = (v: string | number | null) => v === null || v === "" ? "Unknown — clarification required" : String(v);
  return ["REQUEST PREPARATION — REVIEW BEFORE SHARING", "Not an insurer form, submission receipt, coverage determination, or payment confirmation.",
    `Case: ${c.id}; revision: ${c.revision}`, `Customer: ${known(c.doc.customer.name)}`, `Email: ${known(c.doc.customer.email)}`,
    `Provider / merchant: ${known(c.doc.merchant.name)}`, `Amount in minor units: ${known(c.doc.amountMinor)}; currency: ${known(c.doc.currency)}`,
    "User's recorded request:", c.doc.reason || "Unknown — clarification required",
    "Missing facts:", ...c.doc.missingFields.map(f => `- ${f}`),
    "Policy coverage, loss circumstances, claimant authority, signatures and provider requirements must be confirmed independently.",
  ].join("\n");
}
export class BrowserService {
  private workers = new Map<string, Worker>();
  private now: () => number;
  constructor(private deps: BrowserDependencies) { this.now = deps.now ?? Date.now; }
  private persist(row: StoredRun): void { row.run.updatedAt = new Date(this.now()).toISOString(); this.deps.store.save(row); }
  private event(row: StoredRun, message: string): void {
    row.run.message = message;
    row.run.events.push({ id: randomUUID(), at: new Date(this.now()).toISOString(), message });
    row.run.events = row.run.events.slice(-50);
  }
  private active(w: Worker): boolean { return !w.controller.signal.aborted && !TERMINAL.has(w.row.run.status); }
  private finish(w: Worker, status: BrowserRun["status"], message: string): void {
    if (!this.active(w)) return;
    w.row.run.status = status; w.row.run.pendingAction = null; w.row.pending = null;
    w.row.executing = false;
    if (status !== "completed") { w.frame = null; w.row.run.frameAvailable = false; }
    this.event(w.row, message); this.persist(w.row); clearTimeout(w.timer);
    w.controller.abort(); void w.port?.close().catch(() => undefined);
    const terminal = [...this.workers.values()].filter(worker => TERMINAL.has(worker.row.run.status));
    for (const old of terminal.slice(0, Math.max(0, terminal.length - 8))) {
      old.frame = null; old.row.run.frameAvailable = false; this.persist(old.row); this.workers.delete(old.row.run.id);
    }
  }
  private recover(owner: string, id: string): StoredRun {
    const saved = this.deps.store.get(owner, id); if (!saved) throw notFound("Browser run not found");
    const worker = this.workers.get(id);
    if (worker) return worker.row;
    if (saved.run.frameAvailable) { saved.run.frameAvailable = false; this.persist(saved); }
    if (!TERMINAL.has(saved.run.status)) {
      saved.run.status = "uncertain"; saved.run.pendingAction = null; saved.pending = null; saved.run.frameAvailable = false;
      this.event(saved, "Browser process is unavailable. Previous actions may have occurred; inspect the provider independently. This run cannot resume or replay.");
      this.persist(saved);
    }
    return saved;
  }
  get(owner: string, id: string): BrowserRun { return clone(this.recover(owner, id).run); }
  find(owner: string, caseId: string, requestId: string): BrowserRun {
    const saved = this.deps.store.byRequest(owner, requestId);
    if (!saved || saved.run.caseId !== caseId) throw notFound("Browser run not found");
    return this.get(owner, saved.run.id);
  }
  async start(owner: string, raw: unknown): Promise<BrowserRun> {
    const input = parseStart(raw); const requestHash = hash(input);
    const old = this.deps.store.byRequest(owner, input.requestId);
    if (old) {
      if (old.requestHash !== requestHash) throw new ApiHttpError(409, "REQUEST_CONFLICT", "This request ID already belongs to different browser instructions");
      return this.get(owner, old.run.id);
    }
    if (!this.deps.enabled || !this.deps.configured) throw new ApiHttpError(503, "BROWSER_CONFIGURATION_MISSING", "Real browser requires BROWSER_ENABLED=true, live mode, LLM_MODEL and OPENAI_API_KEY; no simulation is available");
    const c = await this.deps.loadCase(owner, input.caseId);
    this.caseMatches(c, input);
    const artifacts = await this.deps.evidence(owner, c.id);
    const interviewBrief = await this.deps.preparation?.(owner, c.id, input.expectedRevision);
    const executionPolicy = await this.deps.executionPolicy?.(owner, c.id) ?? "review_each_action";
    const afterRead = await this.deps.loadCase(owner, c.id); this.caseMatches(afterRead, input);
    const existing = this.deps.store.byRequest(owner, input.requestId);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new ApiHttpError(409, "REQUEST_CONFLICT", "Browser request ID conflict");
      return this.get(owner, existing.run.id);
    }
    const active = [...this.workers.values()].filter(w => this.active(w));
    const blocking = this.deps.store.blocking(owner, c.id);
    if (blocking.length) {
      for (const previous of blocking) this.recover(owner, previous.run.id);
      throw new ApiHttpError(409, "BROWSER_UNRESOLVED", "An active or uncertain browser run remains. Cancel active work; an uncertain case requires independent verification and operator reconciliation before a new run.");
    }
    if (active.length >= 4) throw new ApiHttpError(409, "BROWSER_BUSY", "Browser capacity is occupied; try after another run finishes");
    const id = randomUUID(); const now = new Date(this.now()).toISOString();
    const draft = interviewBrief ?? preparationDocument(afterRead);
    artifacts.unshift({ id: randomUUID(), name: "request.txt", mimeType: "text/plain", bytes: Buffer.from(draft) });
    const row: StoredRun = { owner, requestHash, draft, pending: null, executing: false, steps: 0,
      run: { id, caseId: c.id, caseRevision: c.revision, requestId: input.requestId, status: "starting", task: input.task, executionPolicy,
        startUrl: input.startUrl, allowedHosts: input.allowedHosts, currentUrl: null, pageTitle: null,
        message: "Starting a real isolated browser.", pendingAction: null, frameAvailable: false, events: [], createdAt: now, updatedAt: now,
        artifacts: artifacts.map(a => ({ id: a.id, name: a.name, mimeType: a.mimeType, sizeBytes: a.bytes.length, downloadUrl: `/api/browser/${id}/artifacts/${a.id}` })),
      } };
    this.deps.store.insert(row, artifacts);
    const w: Worker = { row, port: null, controller: new AbortController(), busy: true, frame: null, blocked: new Set(),
      timer: setTimeout(() => this.finish(w, row.executing ? "uncertain" : "failed", "Browser time limit reached. No additional actions will run."), 10 * 60_000) };
    w.timer.unref(); this.workers.set(id, w);
    void this.boot(w); return clone(row.run);
  }
  private caseMatches(c: CaseRow, input: Pick<StartBrowserRequest, "expectedRevision">): void {
    if (c.mode !== "live") throw new ApiHttpError(409, "MODE_MISMATCH", "Browser execution requires an owned live case; fixture and simulated cases cannot dispatch");
    if (c.revision !== input.expectedRevision) throw new ApiHttpError(409, "REVISION_CONFLICT", "Case changed; review the current case before browser execution");
  }
  private async boot(w: Worker): Promise<void> {
    try {
      w.port = await this.deps.launch({ startUrl: w.row.run.startUrl, hosts: w.row.run.allowedHosts, signal: w.controller.signal,
        onLost: () => this.finish(w, "uncertain", "The browser connection was lost. No action will be replayed; verify any previous changes independently."),
        onBlocked: host => {
          const key = host && /^[a-z0-9.-]{1,253}$/.test(host) ? host : "unsupported resource";
          if (this.active(w) && !w.blocked.has(key) && w.blocked.size < 8) {
            w.blocked.add(key); this.event(w.row, `Blocked network resource: ${key}. If required, cancel and start again with reviewed exact hosts.`); this.persist(w.row);
          }
        },
      });
      if (!this.active(w)) { await w.port.close(); return; }
      if (w.row.run.executionPolicy === "inspect_only") {
        const observed = await this.observation(w);
        if (observed.hasPassword) {
          this.finish(w, "completed", "Provider sign-in is required. The sample packet stays in Recourse; no sign-in, form filling or upload was performed.");
        } else {
          this.finish(w, "completed", "Provider page opened for reference. The sample packet stays in Recourse; no form filling, upload, or claim submission was performed.");
        }
        return;
      }
      await this.plan(w);
    } catch (error) { this.finish(w, "failed", safeFailure(error, "Real browser could not start or observe the approved page. Check Chromium installation, approved hosts, and local display setup.")); }
    finally { w.busy = false; }
  }
  private async observation(w: Worker): Promise<Observation> {
    if (!w.port) throw new Error("BROWSER_UNAVAILABLE");
    const o = await w.port.observe();
    scopedUrl(o.url, w.row.run.allowedHosts);
    if (!this.active(w)) throw new Error("CANCELLED");
    w.row.run.currentUrl = o.url; w.row.run.pageTitle = o.title;
    if (o.hasPassword) { w.frame = null; w.row.run.frameAvailable = false; }
    else { w.frame = await w.port.screenshot(); if (!this.active(w)) throw new Error("CANCELLED"); w.row.run.frameAvailable = true; }
    return o;
  }
  private async plan(w: Worker): Promise<void> {
    if (!this.active(w)) return;
    w.row.run.status = "running"; this.persist(w.row);
    for (let inspection = 0; inspection < 4; inspection++) {
      if (++w.row.steps > 30) { this.finish(w, "failed", "Browser step limit reached. Review the provider page; no more actions will run."); return; }
      const o = await this.observation(w);
      if (o.hasPassword) { await this.login(w); return; }
      const step = parseStep(await this.deps.planner.next({ run: clone(w.row.run), observation: o, draft: w.row.draft, signal: w.controller.signal }));
      if (!this.active(w)) return;
      if (step.kind === "needs_login") { await this.login(w); return; }
      if (step.kind === "done") { this.finish(w, "completed", "Browser task finished; review the provider independently. No claim submission or payment result has been verified by this application."); return; }
      if (step.kind === "blocked") { this.finish(w, "failed", `Browser needs clarification: ${step.description}`); return; }
      if (step.kind === "scroll" || step.kind === "inspect") { await w.port!.execute(step); continue; }
      let target = "";
      if (step.kind === "navigate") target = scopedUrl(step.value, w.row.run.allowedHosts).href;
      else {
        const element = o.elements.find(e => e.id === step.elementId);
        if (!element || element.disabled || element.type === "password") throw new Error("PLANNER_INVALID_TARGET");
        if (step.kind === "upload" && (element.type !== "file" || !w.row.run.artifacts.some(a => a.id === step.artifactId))) throw new Error("PLANNER_INVALID_ARTIFACT");
        if (step.kind === "select" && (element.tag !== "select" || !element.options.includes(step.value ?? ""))) throw new Error("PLANNER_INVALID_SELECTION");
        if (element.href) scopedUrl(element.href, w.row.run.allowedHosts);
        target = element.label;
      }
      const artifact = step.artifactId ? this.deps.store.artifact(w.row.run.id, step.artifactId) : null;
      const artifactLabel = artifact ? `${artifact.name} (SHA-256 ${createHash("sha256").update(artifact.bytes).digest("hex")})` : null;
      w.row.pending = { step, fingerprint: o.fingerprint };
      w.row.run.pendingAction = { id: randomUUID(), observationId: o.id, kind: step.kind, description: step.description, target,
        value: artifactLabel ?? step.value, artifactId: step.artifactId };
      w.row.run.status = "needs_approval";
      this.event(w.row, "Review the exact action and current page before approving. Uploading or submitting may disclose information to the provider.");
      this.persist(w.row); return;
    }
    this.finish(w, "failed", "Inspection limit reached without an actionable step. Review the provider page and clarify the task.");
  }
  private async login(w: Worker): Promise<void> {
    w.frame = null; w.row.run.frameAvailable = false;
    await w.port!.loginHandoff();
    if (!this.active(w)) return;
    w.row.run.status = "needs_login";
    this.event(w.row, "Complete login or verification in the local Chromium window on this server's desktop, then Resume. Screen capture and planning are paused; do not enter credentials in chat."); this.persist(w.row);
  }
  async command(owner: string, id: string, raw: unknown): Promise<BrowserRun> {
    const command: BrowserCommand = parseCommand(raw); const row = this.recover(owner, id); const w = this.workers.get(id);
    if (command.command === "cancel") {
      if (w) this.finish(w, row.executing ? "uncertain" : "cancelled", row.executing ? "Stopped during an action. Its external outcome is uncertain; it will not be replayed." : "Browser run cancelled. No further actions will run.");
      return clone(row.run);
    }
    if (!w || !this.active(w)) throw new ApiHttpError(409, "BROWSER_NOT_ACTIVE", "This browser run cannot resume or replay actions");
    if (w.busy) throw new ApiHttpError(409, "BROWSER_BUSY", "A browser operation is already in progress");
    if (command.command === "reject") {
      if (row.run.pendingAction?.id !== command.pendingActionId) throw new ApiHttpError(409, "ACTION_CONFLICT", "Pending browser action changed");
      this.finish(w, "cancelled", "Proposed action rejected. No further actions will run."); return clone(row.run);
    }
    if (command.command === "resume" && row.run.status !== "needs_login") throw new ApiHttpError(409, "ACTION_CONFLICT", "Only a login handoff can resume");
    if (command.command === "approve" && (row.run.status !== "needs_approval" || row.run.pendingAction?.id !== command.pendingActionId || row.run.pendingAction?.observationId !== command.observationId || !row.pending)) throw new ApiHttpError(409, "ACTION_CONFLICT", "Approval does not match the exact pending action and observation");
    w.busy = true;
    let consumed = false;
    try {
      const c = await this.deps.loadCase(owner, row.run.caseId);
      this.caseMatches(c, { expectedRevision: row.run.caseRevision });
      if (!this.active(w)) return clone(row.run);
      if (command.command === "approve") {
        const pending = row.pending!;
        const observation = await this.observation(w);
        if (!this.active(w)) return clone(row.run);
        const latestCase = await this.deps.loadCase(owner, row.run.caseId);
        this.caseMatches(latestCase, { expectedRevision: row.run.caseRevision });
        if (!this.active(w)) return clone(row.run);
        if (observation.fingerprint !== pending.fingerprint || observation.hasPassword) {
          row.pending = null; row.run.pendingAction = null; row.run.status = "running";
          this.event(row, "Page changed since the proposal. Previous approval was discarded; a new review is required."); this.persist(row);
          await this.plan(w);
          throw new ApiHttpError(409, "OBSERVATION_CHANGED", "Page changed; review the new action before approving");
        }
        const artifact = pending.step.artifactId ? this.deps.store.artifact(id, pending.step.artifactId) : null;
        if (pending.step.kind === "upload" && !artifact) throw new ApiHttpError(409, "ARTIFACT_MISSING", "Approved artifact is unavailable");
        row.executing = true; row.run.status = "running"; row.pending = null; row.run.pendingAction = null;
        this.event(row, "Approved action reserved for one execution. A timeout or lost connection will not cause a retry."); this.persist(row); consumed = true;
        try { await w.port!.execute(pending.step, artifact ?? undefined, pending.fingerprint); }
        catch (error) {
          if (!(error instanceof BrowserPageChangedError)) throw error;
          // The port guarantees this specific error occurs before writes/actions.
          // The consumed approval stays consumed; a changed page needs a new one.
          consumed = false; row.executing = false;
          if (!this.active(w)) return clone(row.run);
          this.event(row, "Page changed immediately before dispatch. Nothing was sent; a new approval is required."); this.persist(row);
          await this.plan(w);
          throw new ApiHttpError(409, "OBSERVATION_CHANGED", "Page changed; review the new action before approving");
        }
        if (!this.active(w)) return clone(row.run);
        row.executing = false; this.event(row, "Browser action returned. Inspecting the actual page; external success is not assumed."); this.persist(row);
      }
      await this.plan(w); return clone(row.run);
    } catch (error) {
      if (error instanceof ApiHttpError) throw error;
      this.finish(w, consumed ? "uncertain" : "failed", consumed ? "The action outcome is uncertain. It will not be replayed. Verify the provider before taking further action." : safeFailure(error, "Browser observation or planner failed. No new action was dispatched. Check live configuration and approved hosts."));
      return clone(row.run);
    } finally { w.busy = false; }
  }
  async frame(owner: string, id: string): Promise<Buffer> {
    const row = this.recover(owner, id); const w = this.workers.get(id);
    if (!w?.port || !row.run.frameAvailable || row.run.status === "needs_login") throw notFound("Browser frame unavailable");
    // Live screenshots are read-only; approval still validates the original DOM fingerprint.
    // Credentials, active mutations and terminal runs never request a new screenshot.
    if (!w.busy && !TERMINAL.has(row.run.status)) {
      try {
        const frame = await w.port.screenshot();
        if (!this.active(w) || !row.run.frameAvailable || String(row.run.status) === "needs_login") throw notFound("Browser frame unavailable");
        w.frame = frame;
      }
      catch { w.frame = null; row.run.frameAvailable = false; this.persist(row); }
    }
    if (!w.frame) throw notFound("Browser frame unavailable");
    return Buffer.from(w.frame);
  }
  artifact(owner: string, id: string, artifactId: string): StoredArtifact {
    this.recover(owner, id);
    const artifact = this.deps.store.artifact(id, artifactId); if (!artifact) throw notFound("Browser artifact not found");
    return artifact;
  }
  async dispose(): Promise<void> {
    const workers = [...this.workers.values()];
    for (const w of workers) { this.finish(w, "uncertain", "Browser worker stopped. Verify any prior effects independently; no action will be replayed."); clearTimeout(w.timer); w.controller.abort(); }
    await Promise.all(workers.map(w => w.port?.close().catch(() => undefined)));
    this.workers.clear();
  }
}
