import type { WorkflowCallAttempt, WorkflowCallAuthorization } from "@/contracts/workflow-call";
import type { Db } from "@/server/persistence/db";

export type StoredWorkflowCall = Omit<WorkflowCallAttempt, "result">;
interface AuthorizationRecord { authorization: WorkflowCallAuthorization; requestId: string; hash: string; current: boolean }
const ACTIVE = "('dispatch_pending','dispatch_unknown','queued','in_progress')";

/** Also used by the V1 call/edit guards; absent additive tables mean no workflow call exists. */
export function hasActiveWorkflowCall(db: Db, caseId: string): boolean {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_call_attempts'").get()) return false;
  return !!db.prepare(`SELECT 1 FROM workflow_call_attempts WHERE case_id=? AND state IN ${ACTIVE} LIMIT 1`).get(caseId);
}

export class WorkflowCallStore {
  constructor(private db: Db) {
    db.exec(`CREATE TABLE IF NOT EXISTS workflow_call_authorizations (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), owner TEXT NOT NULL,
      action_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, hash TEXT NOT NULL,
      current INTEGER NOT NULL, value TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS workflow_call_attempts (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), owner TEXT NOT NULL,
      authorization_id TEXT NOT NULL UNIQUE REFERENCES workflow_call_authorizations(id), request_id TEXT NOT NULL UNIQUE,
      provider_call_id TEXT UNIQUE, state TEXT NOT NULL, value TEXT NOT NULL,
      last_polled_at INTEGER, poll_lease TEXT, poll_lease_until INTEGER NOT NULL DEFAULT 0
    ); CREATE UNIQUE INDEX IF NOT EXISTS workflow_call_one_active ON workflow_call_attempts(case_id)
      WHERE state IN ('dispatch_pending','dispatch_unknown','queued','in_progress');
    CREATE TABLE IF NOT EXISTS workflow_call_requests (
      request_id TEXT PRIMARY KEY, call_id TEXT NOT NULL REFERENCES workflow_call_attempts(id)
    );`);
  }
  authorization(owner: string, caseId: string, id: string): AuthorizationRecord | null {
    return this.authRow(this.db.prepare("SELECT * FROM workflow_call_authorizations WHERE owner=? AND case_id=? AND id=?").get(owner, caseId, id));
  }
  authorizationRequest(requestId: string): AuthorizationRecord | null {
    return this.authRow(this.db.prepare("SELECT * FROM workflow_call_authorizations WHERE request_id=?").get(requestId));
  }
  private authRow(raw: unknown): AuthorizationRecord | null {
    const row = raw as { value: string; request_id: string; hash: string; current: number } | undefined;
    return row ? { authorization: JSON.parse(row.value), requestId: row.request_id, hash: row.hash, current: !!row.current } : null;
  }
  saveAuthorization(owner: string, requestId: string, hash: string, authorization: WorkflowCallAuthorization): void {
    this.db.prepare("UPDATE workflow_call_authorizations SET current=0 WHERE case_id=? AND action_id=?").run(authorization.caseId, authorization.actionId);
    this.db.prepare("INSERT INTO workflow_call_authorizations (id,case_id,owner,action_id,request_id,hash,current,value) VALUES (?,?,?,?,?,?,1,?)")
      .run(authorization.id, authorization.caseId, owner, authorization.actionId, requestId, hash, JSON.stringify(authorization));
  }
  authorizations(owner: string, caseId: string): WorkflowCallAuthorization[] {
    return (this.db.prepare("SELECT value FROM workflow_call_authorizations WHERE owner=? AND case_id=? ORDER BY rowid").all(owner, caseId) as Array<{ value: string }>).map(row => JSON.parse(row.value));
  }
  call(owner: string, caseId: string, id: string): StoredWorkflowCall | null {
    return this.callRow(this.db.prepare("SELECT value FROM workflow_call_attempts WHERE owner=? AND case_id=? AND id=?").get(owner, caseId, id));
  }
  request(requestId: string): StoredWorkflowCall | null {
    return this.callRow(this.db.prepare("SELECT a.value FROM workflow_call_attempts a LEFT JOIN workflow_call_requests r ON r.call_id=a.id WHERE a.request_id=? OR r.request_id=? LIMIT 1").get(requestId, requestId));
  }
  bindRequest(requestId: string, callId: string): void { this.db.prepare("INSERT INTO workflow_call_requests (request_id,call_id) VALUES (?,?)").run(requestId, callId); }
  byAuthorization(authorizationId: string): StoredWorkflowCall | null { return this.callRow(this.db.prepare("SELECT value FROM workflow_call_attempts WHERE authorization_id=?").get(authorizationId)); }
  private callRow(raw: unknown): StoredWorkflowCall | null { const row = raw as { value: string } | undefined; return row ? JSON.parse(row.value) : null; }
  calls(owner: string, caseId: string): StoredWorkflowCall[] {
    return (this.db.prepare("SELECT value FROM workflow_call_attempts WHERE owner=? AND case_id=? ORDER BY rowid").all(owner, caseId) as Array<{ value: string }>).map(row => JSON.parse(row.value));
  }
  reserve(owner: string, call: StoredWorkflowCall): void {
    this.db.prepare("INSERT INTO workflow_call_attempts (id,case_id,owner,authorization_id,request_id,provider_call_id,state,value) VALUES (?,?,?,?,?,?,?,?)")
      .run(call.id, call.caseId, owner, call.authorizationId, call.requestId, call.providerCallId, call.state, JSON.stringify(call));
    this.bindRequest(call.requestId, call.id);
  }
  save(call: StoredWorkflowCall): void {
    this.db.prepare("UPDATE workflow_call_attempts SET provider_call_id=?,state=?,value=? WHERE id=?").run(call.providerCallId, call.state, JSON.stringify(call), call.id);
  }
  claimPoll(callId: string, now: number, minimumInterval: number, lease: string): boolean {
    return this.db.prepare(`UPDATE workflow_call_attempts SET poll_lease=?,poll_lease_until=?,last_polled_at=?
      WHERE id=? AND poll_lease_until<=? AND (last_polled_at IS NULL OR last_polled_at<=?)`)
      .run(lease, now + 60_000, now, callId, now, now - minimumInterval).changes === 1;
  }
  ownsPoll(callId: string, lease: string): boolean { return !!this.db.prepare("SELECT 1 FROM workflow_call_attempts WHERE id=? AND poll_lease=?").get(callId, lease); }
  releasePoll(callId: string, lease: string): void { this.db.prepare("UPDATE workflow_call_attempts SET poll_lease=NULL,poll_lease_until=0 WHERE id=? AND poll_lease=?").run(callId, lease); }
}
