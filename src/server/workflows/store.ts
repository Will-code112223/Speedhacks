import type { Db } from "@/server/persistence/db";
import type { CaseWorkflow } from "@/contracts/workflow";

export interface WorkflowOperation {
  caseId: string; owner: string; requestId: string; hash: string;
  status: "processing" | "completed" | "failed"; acceptedRevision: number; lease: string; expiresAt: number;
}
export class WorkflowStore {
  constructor(readonly db: Db) {
    db.exec(`CREATE TABLE IF NOT EXISTS case_workflows (
      case_id TEXT PRIMARY KEY REFERENCES cases(id), owner TEXT NOT NULL, value TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS workflow_operations (
      case_id TEXT NOT NULL REFERENCES cases(id), owner TEXT NOT NULL, request_id TEXT NOT NULL,
      hash TEXT NOT NULL, status TEXT NOT NULL, accepted_revision INTEGER NOT NULL, lease TEXT NOT NULL, expires_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(case_id, request_id)
    ); CREATE UNIQUE INDEX IF NOT EXISTS workflow_one_active ON workflow_operations(case_id) WHERE status='processing';`);
    const columns = db.pragma("table_info(workflow_operations)") as Array<{ name: string }>;
    if (!columns.some(column => column.name === "expires_at")) db.exec("ALTER TABLE workflow_operations ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0");
  }
  get(owner: string, caseId: string): CaseWorkflow | null {
    const row = this.db.prepare("SELECT value FROM case_workflows WHERE owner=? AND case_id=?").get(owner, caseId) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as CaseWorkflow : null;
  }
  save(owner: string, workflow: CaseWorkflow): void {
    this.db.prepare("INSERT INTO case_workflows (case_id,owner,value) VALUES (?,?,?) ON CONFLICT(case_id) DO UPDATE SET value=excluded.value WHERE case_workflows.owner=excluded.owner")
      .run(workflow.caseId, owner, JSON.stringify(workflow));
  }
  operation(owner: string, caseId: string, requestId: string): WorkflowOperation | null {
    const row = this.db.prepare("SELECT * FROM workflow_operations WHERE owner=? AND case_id=? AND request_id=?").get(owner, caseId, requestId) as Record<string, string | number> | undefined;
    return row ? this.operationRow(row) : null;
  }
  active(owner: string, caseId: string): WorkflowOperation | null {
    const row = this.db.prepare("SELECT * FROM workflow_operations WHERE owner=? AND case_id=? AND status='processing'").get(owner, caseId) as Record<string, string | number> | undefined;
    return row ? this.operationRow(row) : null;
  }
  private operationRow(row: Record<string, string | number>): WorkflowOperation {
    return { caseId: String(row.case_id), owner: String(row.owner), requestId: String(row.request_id), hash: String(row.hash),
      status: row.status as WorkflowOperation["status"], acceptedRevision: Number(row.accepted_revision), lease: String(row.lease), expiresAt: Number(row.expires_at) };
  }
  reserve(operation: WorkflowOperation): void {
    this.db.prepare("INSERT INTO workflow_operations (case_id,owner,request_id,hash,status,accepted_revision,lease,expires_at) VALUES (?,?,?,?,?,?,?,?)").run(operation.caseId, operation.owner, operation.requestId,
      operation.hash, operation.status, operation.acceptedRevision, operation.lease, operation.expiresAt);
  }
  finish(operation: WorkflowOperation, status: "completed" | "failed"): boolean {
    return this.db.prepare("UPDATE workflow_operations SET status=? WHERE case_id=? AND owner=? AND request_id=? AND lease=? AND status='processing'")
      .run(status, operation.caseId, operation.owner, operation.requestId, operation.lease).changes === 1;
  }
}
