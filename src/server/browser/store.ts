import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { StoredArtifact, StoredRun } from "./types";

/** Separate durable journal: never alters teammate 2's schema. FULL sync precedes browser execution. */
export class BrowserStore {
  private db: Database.Database;
  constructor(directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "browser.sqlite");
    this.db = new Database(file);
    fs.chmodSync(file, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS browser_runs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_id TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(owner, request_id));
      CREATE TABLE IF NOT EXISTS browser_artifacts (run_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, mime_type TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(run_id,id));`);
  }
  get(owner: string, id: string): StoredRun | null {
    const row = this.db.prepare("SELECT value FROM browser_runs WHERE owner=? AND id=?").get(owner, id) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as StoredRun : null;
  }
  byRequest(owner: string, requestId: string): StoredRun | null {
    const row = this.db.prepare("SELECT value FROM browser_runs WHERE owner=? AND request_id=?").get(owner, requestId) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as StoredRun : null;
  }
  blocking(owner: string, caseId: string): StoredRun[] {
    const rows = this.db.prepare(`SELECT value FROM browser_runs WHERE owner=? AND
      (json_extract(value,'$.run.status') IN ('starting','running','needs_approval','needs_login') OR
       (json_extract(value,'$.run.caseId')=? AND json_extract(value,'$.run.status')='uncertain'))`).all(owner, caseId) as { value: string }[];
    return rows.map(row => JSON.parse(row.value) as StoredRun);
  }
  insert(row: StoredRun, artifacts: StoredArtifact[]): void {
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO browser_runs VALUES (?,?,?,?)").run(row.run.id, row.owner, row.run.requestId, JSON.stringify(row));
      const stmt = this.db.prepare("INSERT INTO browser_artifacts VALUES (?,?,?,?,?)");
      for (const a of artifacts) stmt.run(row.run.id, a.id, a.name, a.mimeType, a.bytes);
    })();
  }
  save(row: StoredRun): void { this.db.prepare("UPDATE browser_runs SET value=? WHERE id=? AND owner=?").run(JSON.stringify(row), row.run.id, row.owner); }
  artifact(runId: string, id: string): StoredArtifact | null {
    const row = this.db.prepare("SELECT id,name,mime_type,bytes FROM browser_artifacts WHERE run_id=? AND id=?").get(runId, id) as { id: string; name: string; mime_type: string; bytes: Buffer } | undefined;
    return row ? { ...row, mimeType: row.mime_type } : null;
  }
  close(): void { this.db.close(); }
}
