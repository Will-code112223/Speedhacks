/**
 * The fixture CaseApi: an in-memory stand-in for the case server that enforces
 * the same rules (revisions, authorization, one dispatch per authorization,
 * no edits during a call) and plays scripted calls. Nothing is persisted; a
 * reload starts fresh. Every case and call is labelled mode "simulated".
 */

import type { CallV1, CaseOutcome, CaseV1 } from "../../../../contracts/case";
import {
  ApiRequestError,
  type CaseApi,
  type CaseApiCapabilities,
  type CaseChanges,
  type CreateCaseInput,
  type FixtureOptions,
  type FixtureScenario,
  type LiveCallV2,
  type StartCallInput,
} from "../types";
import { assertNever } from "../assert-never";
import { CASE_NOT_FOUND_MESSAGE } from "../messages";
import { UUID_PATTERN } from "../uuid";
import { buildPacket } from "./documents";
import {
  applyChanges,
  CURRENCY,
  E164,
  EMAIL,
  freeze,
  isValidAmountMinor,
  missingFields,
  nullableText,
  validateChanges,
  type Facts,
} from "./facts";
import { newId } from "./ids";
import { formatMoney } from "./money";
import { decisionIdFor, hasActiveCall, projectCall, projectCase, type ProjectedCall, type ProjectedCase } from "./project";
import type { AuthorizationRecord, CallRecord, CaseRecord } from "./records";
import { inferScenario, SCENARIOS } from "./scenarios";
import { toVirtual } from "./time";

/** Destinations ending in 0001 are refused before dispatch, matching the server's simulated adapter. */
const REJECTED_SUFFIX = "0001";
const REJECTED_ERROR =
  "FIXTURE_REJECTED: Simulated provider rejected the call before dispatch (destination ends in 0001).";

const UNKNOWN_OUTCOME: CaseOutcome = {
  decision: "unknown",
  referenceNumber: null,
  nextAction: null,
  paymentStatus: "unverified",
  supportingQuote: null,
};

function fail(status: number, code: string, message: string, fields?: string[]): never {
  throw new ApiRequestError(status, code, message, fields);
}

export function createFixtureCaseApi(options: FixtureOptions = {}): CaseApi {
  return new FixtureCaseApi(options);
}

class FixtureCaseApi implements CaseApi {
  readonly mode = "fixture";
  private readonly cases = new Map<string, CaseRecord>();
  private readonly callsByRequestId = new Map<string, CallRecord>();
  private readonly speed: number;
  private readonly now: () => number;
  private readonly latencyMs: number;
  private readonly v2: boolean;
  private readonly scenario: FixtureScenario | undefined;

  constructor(options: FixtureOptions) {
    const speed = options.speed ?? 1;
    if (!Number.isFinite(speed) || speed <= 0) throw new RangeError("Fixture speed must be a positive number.");
    this.speed = speed;
    this.now = options.now ?? Date.now;
    this.latencyMs = Math.max(0, options.latencyMs ?? 0);
    this.v2 = options.v2 ?? true;
    this.scenario = options.scenario;
  }

  readonly createCase = async (input: CreateCaseInput): Promise<CaseV1> => {
    await this.respond();
    const now = this.now();
    const summary = (typeof input.summary === "string" ? input.summary : "").trim().slice(0, 5000);
    const files = input.files ?? [];
    if (summary.length === 0 && files.length === 0) {
      fail(400, "BAD_REQUEST", "Provide a summary or at least one file", ["summary", "files"]);
    }
    const provided = readProvidedFacts(input);
    if (provided.invalid.length > 0) {
      fail(400, "BAD_REQUEST", `Invalid fields: ${provided.invalid.join(", ")}`, provided.invalid);
    }
    const scenario = SCENARIOS[this.scenario ?? inferScenario(summary)];
    const found = scenario.extracted;
    // Explicit fields override extraction, as on the server.
    const facts: Facts = {
      customer: { name: provided.customerName ?? found.customerName, email: provided.customerEmail ?? found.customerEmail },
      merchant: {
        name: provided.merchantName ?? found.merchantName,
        supportPhone: provided.supportPhone ?? found.supportPhone,
      },
      amountMinor: provided.amountMinor ?? found.amountMinor,
      currency: provided.currency ?? found.currency,
      reason: summary.length > 0 ? summary : scenario.documentReason,
    };
    const record: CaseRecord = {
      id: newId(),
      scenario,
      revision: 1,
      facts,
      evidence: files.map((f) => ({
        id: newId(),
        name: f.name || "upload",
        mimeType: f.type || "application/octet-stream",
        sizeBytes: f.size,
      })),
      authorizationId: null,
      authorizations: [],
      calls: [],
      timeline: [],
      outcome: { value: UNKNOWN_OUTCOME, atMs: now },
      createdAtMs: now,
      updatedAtMs: now,
    };
    this.log(record, now, "case_created", "Case created in simulated mode (fixture).");
    for (const e of record.evidence) {
      this.log(record, now, "evidence_added", `Attached ${e.name} (${e.mimeType}, ${e.sizeBytes} bytes).`);
    }
    const extracted = Object.entries(found)
      .filter(([, value]) => value !== null)
      .map(([field]) => field);
    this.log(
      record,
      now,
      "facts_extracted",
      `Simulated extraction (fixture scenario ${scenario.id}) found ${extracted.join(", ")}.`,
    );
    this.logReadiness(record, now);
    this.cases.set(record.id, record);
    return this.view(record, now);
  };

  readonly getCase = async (caseId: string): Promise<CaseV1> => {
    await this.respond();
    return this.view(this.find(caseId), this.now());
  };

  readonly patchCase = async (caseId: string, expectedRevision: number, changes: CaseChanges): Promise<CaseV1> => {
    await this.respond();
    const now = this.now();
    requireRevision(expectedRevision);
    const validated = validateChanges(changes);
    if (validated.invalid.length > 0) {
      fail(400, "BAD_REQUEST", `Invalid changes: ${validated.invalid.join(", ")}`, validated.invalid);
    }
    const record = this.find(caseId);
    const before = this.project(record, now);
    if (hasActiveCall(before)) {
      fail(409, "CALL_IN_PROGRESS", "Edits are rejected while a call is active or its dispatch is unknown");
    }
    if (expectedRevision !== record.revision) {
      fail(409, "REVISION_CONFLICT", `Case is at revision ${record.revision}, not ${expectedRevision}`);
    }
    const { next, changed } = applyChanges(record.facts, validated.changes);
    // Only a change to the facts bumps the revision.
    if (!changed) return before.case;
    record.facts = next;
    record.revision += 1;
    this.log(record, now, "facts_updated", `Facts updated (revision ${record.revision}); draft rebuilt.`);
    if (record.authorizationId !== null) {
      this.log(record, now, "authorization_cleared", `Authorization ${record.authorizationId} cleared by a material edit.`);
      record.authorizationId = null;
    }
    const status = missingFields(next).length > 0 ? "needs_information" : "ready_for_approval";
    if (status !== before.case.status) this.logReadiness(record, now);
    return this.view(record, now);
  };

  readonly authorize = async (caseId: string, expectedRevision: number): Promise<CaseV1> => {
    await this.respond();
    const now = this.now();
    requireRevision(expectedRevision);
    const record = this.find(caseId);
    if (hasActiveCall(this.project(record, now))) {
      fail(409, "CALL_IN_PROGRESS", "A new authorization is rejected while a call is active or its dispatch is unknown");
    }
    if (expectedRevision !== record.revision) {
      fail(409, "REVISION_CONFLICT", `Case is at revision ${record.revision}, not ${expectedRevision}`);
    }
    const frozen = freeze(record.facts);
    if (frozen === null) {
      fail(422, "MISSING_REQUIRED_FACTS", "Authorization requires every required fact", missingFields(record.facts));
    }
    // Idempotent per revision: never mint a fresh id that would bypass dispatch deduplication.
    const existing = record.authorizations.find((a) => a.revision === record.revision);
    if (existing !== undefined) {
      record.authorizationId = existing.id;
      return this.view(record, now);
    }
    const authorization: AuthorizationRecord = { id: newId(), revision: record.revision, approvedAtMs: now, frozen };
    record.authorizations.push(authorization);
    record.authorizationId = authorization.id;
    this.log(
      record,
      now,
      "authorized",
      `Authorized revision ${record.revision}: call ${frozen.supportPhone} (${frozen.merchantName}) about ${formatMoney(frozen.amountMinor, frozen.currency)}.`,
    );
    return this.view(record, now);
  };

  readonly startCall = async (caseId: string, input: StartCallInput): Promise<CallV1> => {
    await this.respond();
    const now = this.now();
    if (!UUID_PATTERN.test(input.requestId)) fail(400, "BAD_REQUEST", "requestId must be a UUID", ["requestId"]);
    if (!UUID_PATTERN.test(input.authorizationId)) {
      fail(400, "BAD_REQUEST", "authorizationId must be a UUID", ["authorizationId"]);
    }
    const record = this.find(caseId);
    const authorization = record.authorizations.find((a) => a.id === input.authorizationId);
    if (authorization === undefined) fail(409, "AUTHORIZATION_CONFLICT", "Unknown authorization for this case");
    // A repeated requestId or authorizationId returns the stored attempt instead of dialing again.
    const byRequest = this.callsByRequestId.get(input.requestId);
    if (byRequest !== undefined) {
      if (byRequest.caseId === record.id && byRequest.authorizationId === authorization.id) {
        return this.projectOne(record, byRequest, now).v1;
      }
      fail(409, "AUTHORIZATION_CONFLICT", "requestId was already used for a different action");
    }
    const byAuthorization = record.calls.find((c) => c.authorizationId === authorization.id);
    if (byAuthorization !== undefined) return this.projectOne(record, byAuthorization, now).v1;
    if (record.authorizationId !== authorization.id || authorization.revision !== record.revision) {
      fail(409, "AUTHORIZATION_CONFLICT", "Authorization is stale; re-authorize the current revision");
    }

    const outcomeBefore = this.view(record, now).outcome;
    const call: CallRecord = {
      id: newId(),
      caseId: record.id,
      requestId: input.requestId,
      authorizationId: authorization.id,
      providerCallId: null,
      startedAtMs: now,
      frozen: authorization.frozen,
      rejectedError: null,
      interventions: [],
    };
    record.calls.push(call);
    this.callsByRequestId.set(call.requestId, call);
    this.log(record, now, "call_requested", `Call attempt ${call.id} persisted before dispatch (simulated).`);

    if (call.frozen.supportPhone.endsWith(REJECTED_SUFFIX)) {
      // A definitive refusal: the attempt is kept as failed and the authorization is used up.
      call.rejectedError = REJECTED_ERROR;
      this.log(record, now, "call_dispatch_rejected", `Provider rejected the call before dispatch: ${REJECTED_ERROR}`);
      record.outcome = {
        atMs: now,
        value: {
          ...outcomeBefore,
          nextAction:
            "The provider refused the call before dispatch (FIXTURE_REJECTED). Edit any case fact to re-authorize and place a new call, or send the request packet by email.",
        },
      };
      fail(503, "PROVIDER_UNAVAILABLE", "Provider rejected the call before dispatch (simulated, destination ends in 0001).");
    }
    const dispatch = record.scenario.dispatch;
    switch (dispatch.kind) {
      case "accepted":
        call.providerCallId = `fx_${call.id.replace(/-/g, "").slice(0, 16)}`;
        this.log(record, now, "call_dispatched", `Provider accepted the call (provider id ${call.providerCallId}, simulated).`);
        break;
      case "unknown":
        // Stays dispatch_pending until the provider's answer fails to arrive; see project.ts.
        break;
      default:
        assertNever(dispatch);
    }
    return this.projectOne(record, call, now).v1;
  };

  readonly downloadPacket = async (caseId: string): Promise<Blob> => {
    await this.respond();
    const now = this.now();
    const record = this.find(caseId);
    const text = buildPacket(record.scenario.kind, this.view(record, now), record.evidence, now);
    return new Blob([text], { type: "text/plain;charset=utf-8" });
  };

  readonly capabilities = async (): Promise<CaseApiCapabilities> => ({
    liveCall: this.v2,
    stepIn: this.v2,
    decisions: this.v2,
  });

  readonly getLiveCall = async (caseId: string, callId: string): Promise<LiveCallV2 | null> => {
    await this.respond();
    if (!this.v2) return null;
    const now = this.now();
    const record = this.find(caseId);
    return this.projectOne(record, this.findCall(record, callId), now).live;
  };

  readonly stepIn = async (caseId: string, callId: string): Promise<LiveCallV2> => {
    await this.respond();
    this.requireV2("Joining a live call");
    const now = this.now();
    const record = this.find(caseId);
    const call = this.findCall(record, callId);
    const live = this.projectOne(record, call, now).live;
    if (live === null) fail(409, "CALL_NOT_CONNECTED", "This call has no live connection to join.");
    switch (live.phase) {
      case "ended":
        return fail(
          409,
          "CALL_ENDED",
          live.startedAt === null ? "This call attempt ended without connecting." : "The call has ended.",
        );
      case "user_joined":
        return live;
      // The user can step in at any live phase, before the call connects too; the script pauses until they hand back.
      case "dialing":
      case "ringing":
      case "navigating_menu":
      case "on_hold":
      case "talking":
      case "waiting_for_user":
        call.interventions.push({ kind: "join", at: toVirtual(call.startedAtMs, now, this.speed) });
        return this.liveView(record, call, now);
      default:
        return assertNever(live.phase);
    }
  };

  readonly answerDecision = async (
    caseId: string,
    callId: string,
    decisionId: string,
    optionId: string,
  ): Promise<LiveCallV2> => {
    await this.respond();
    this.requireV2("Answering a decision");
    const now = this.now();
    const record = this.find(caseId);
    const call = this.findCall(record, callId);
    const { run, gate } = this.projectOne(record, call, now);
    const raised = run?.events.some((e) => e.kind === "decision_raised") ?? false;
    if (run === null || gate === null || !raised || decisionId !== decisionIdFor(call.id)) {
      fail(404, "NOT_FOUND", "Decision not found");
    }
    if (run.resolution !== null) fail(409, "DECISION_RESOLVED", "This decision was already resolved.");
    if (!gate.options.some((o) => o.id === optionId)) {
      fail(400, "BAD_REQUEST", "optionId is not one of the decision's options", ["optionId"]);
    }
    call.interventions.push({ kind: "answer", at: toVirtual(call.startedAtMs, now, this.speed), optionId });
    return this.liveView(record, call, now);
  };

  private find(caseId: string): CaseRecord {
    const record = this.cases.get(caseId);
    if (record === undefined) fail(404, "NOT_FOUND", CASE_NOT_FOUND_MESSAGE);
    return record;
  }

  private findCall(record: CaseRecord, callId: string): CallRecord {
    const call = record.calls.find((c) => c.id === callId);
    if (call === undefined) fail(404, "NOT_FOUND", "Call not found");
    return call;
  }

  private project(record: CaseRecord, now: number): ProjectedCase {
    return projectCase(record, now, this.speed);
  }

  private view(record: CaseRecord, now: number): CaseV1 {
    return this.project(record, now).case;
  }

  private projectOne(record: CaseRecord, call: CallRecord, now: number): ProjectedCall {
    return projectCall(record.scenario, call, now, this.speed);
  }

  private liveView(record: CaseRecord, call: CallRecord, now: number): LiveCallV2 {
    const live = this.projectOne(record, call, now).live;
    if (live === null) throw new Error("A connected call has no live record.");
    return live;
  }

  private log(record: CaseRecord, atMs: number, type: string, message: string): void {
    record.timeline.push({ id: newId(), atMs, type, message });
    record.updatedAtMs = Math.max(record.updatedAtMs, atMs);
  }

  private logReadiness(record: CaseRecord, atMs: number): void {
    const missing = missingFields(record.facts);
    if (missing.length > 0) this.log(record, atMs, "needs_information", `Missing: ${missing.join(", ")}.`);
    else this.log(record, atMs, "ready_for_approval", "All required facts present; draft generated.");
  }

  private requireV2(feature: string): void {
    if (!this.v2) fail(501, "NOT_SUPPORTED", `${feature} is not supported by this backend.`);
  }

  private async respond(): Promise<void> {
    if (this.latencyMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, this.latencyMs));
  }
}

function requireRevision(expectedRevision: number): void {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    fail(400, "BAD_REQUEST", "expectedRevision must be a positive integer", ["expectedRevision"]);
  }
}

interface ProvidedFacts {
  customerName: string | null;
  customerEmail: string | null;
  merchantName: string | null;
  supportPhone: string | null;
  amountMinor: number | null;
  currency: string | null;
  invalid: string[];
}

/** Optional create fields, validated like the server's multipart route. */
function readProvidedFacts(input: CreateCaseInput): ProvidedFacts {
  const text = (value: string | undefined, max?: number): string | null =>
    value === undefined ? null : (nullableText(value, max) ?? null);
  const invalid: string[] = [];
  const supportPhone = text(input.supportPhone, 64);
  if (supportPhone !== null && !E164.test(supportPhone)) invalid.push("supportPhone");
  const customerEmail = text(input.customerEmail);
  if (customerEmail !== null && !EMAIL.test(customerEmail)) invalid.push("customerEmail");
  const currency = text(input.currency, 16)?.toUpperCase() ?? null;
  if (currency !== null && !CURRENCY.test(currency)) invalid.push("currency");
  const amountMinor = input.amountMinor ?? null;
  if (amountMinor !== null && !isValidAmountMinor(amountMinor)) invalid.push("amountMinor");
  return {
    customerName: text(input.customerName),
    customerEmail,
    merchantName: text(input.merchantName),
    supportPhone,
    amountMinor,
    currency,
    invalid,
  };
}
