/**
 * Keewano query access. Keewano exposes queries to agents over MCP (Streamable HTTP,
 * `k-token` header with a personal access token); there is no documented REST query
 * endpoint. This client connects per call, discovers the SQL tool, runs one statement
 * and normalizes the result into rows.
 *
 * Verified live on 2026-10-11: the tool is `run_sql_query({ projectId, sqlQuery, maxRows })`
 * and returns `{ columns, rows }`. Discovery is kept so a renamed tool still works:
 * KEEWANO_SQL_TOOL and KEEWANO_SQL_ARG override the guess. The project id comes from
 * KEEWANO_PROJECT_ID, else the SDK API key's `projectId` claim, else `list_projects`
 * when exactly one project is accessible.
 *
 * Only package imports here: plain `node` loads this module from the sql CLI.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const DEFAULT_MCP_URL = "https://api.keewano.com/mcp";

export type SqlRow = Record<string, unknown>;

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface ToolResultLike {
  content?: unknown;
  structuredContent?: unknown;
  isError?: unknown;
}

export class KeewanoQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeewanoQueryError";
  }
}

export interface KeewanoMcpOptions {
  token: string;
  url?: string;
  sqlTool?: string | null;
  sqlArg?: string | null;
  /** Keewano project UUID; discovered when omitted (see module notes). */
  projectId?: string | null;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface KeewanoProject {
  id: string;
  name: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The SDK API key is a JWT whose payload carries the project id; null when absent or unreadable. */
export function projectIdFromApiKey(apiKey: string | null | undefined): string | null {
  if (!apiKey) return null;
  const payload = apiKey.split(".")[1] ?? "";
  if (!payload) return null;
  try {
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const claims = JSON.parse(json) as { projectId?: unknown };
    return typeof claims.projectId === "string" && UUID.test(claims.projectId) ? claims.projectId : null;
  } catch {
    return null;
  }
}

export class KeewanoMcpClient {
  readonly url: string;
  private readonly token: string;
  private readonly sqlTool: string | null;
  private readonly sqlArg: string | null;
  private projectId: string | null;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(opts: KeewanoMcpOptions) {
    if (!opts.token.trim()) throw new Error("Keewano access token is required");
    this.token = opts.token;
    this.url = opts.url ?? DEFAULT_MCP_URL;
    this.sqlTool = opts.sqlTool ?? null;
    this.sqlArg = opts.sqlArg ?? null;
    this.projectId = opts.projectId ?? null;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetch;
  }

  private async withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: { headers: { "k-token": this.token } },
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
    });
    const client = new Client({ name: "speedhacks-refund-assistant", version: "0.1.0" });
    await client.connect(transport, { timeout: this.timeoutMs });
    try {
      return await fn(client);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  async listTools(): Promise<McpToolInfo[]> {
    return this.withClient(async (client) => {
      const { tools } = await client.listTools(undefined, { timeout: this.timeoutMs });
      return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    });
  }

  /** Projects this token can read (the `list_projects` tool). */
  async listProjects(): Promise<KeewanoProject[]> {
    return this.withClient(async (client) => projectsFromResult(await this.invoke(client, "list_projects", {})));
  }

  /** Call any tool by name; `projectId` is filled in when the tool takes one and none was given. */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResultLike> {
    return this.withClient(async (client) => {
      const { tools } = await client.listTools(undefined, { timeout: this.timeoutMs });
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new KeewanoQueryError(`Tool ${name} is not offered; tools: ${names(tools)}`);
      const merged = { ...args };
      if (takesProjectId(tool.inputSchema) && merged.projectId === undefined) merged.projectId = await this.resolveProjectId(client, tools);
      return this.invoke(client, name, merged);
    });
  }

  /** Run one statement and return the raw tool result (for debugging result shapes). */
  async runSqlRaw(sql: string): Promise<{ tool: string; arg: string; result: ToolResultLike }> {
    return this.withClient(async (client) => {
      const { tools } = await client.listTools(undefined, { timeout: this.timeoutMs });
      const pick = pickSqlTool(tools, this.sqlTool, this.sqlArg);
      const args: Record<string, unknown> = { [pick.arg]: sql };
      if (pick.needsProjectId) args.projectId = await this.resolveProjectId(client, tools);
      const result = await this.invoke(client, pick.name, args);
      return { tool: pick.name, arg: pick.arg, result };
    });
  }

  private async invoke(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResultLike> {
    return (await client.callTool({ name, arguments: args }, undefined, { timeout: this.timeoutMs })) as ToolResultLike;
  }

  private async resolveProjectId(client: Client, tools: readonly McpToolInfo[]): Promise<string> {
    if (this.projectId) return this.projectId;
    if (!tools.some((t) => t.name === "list_projects")) {
      throw new KeewanoQueryError("Keewano project id is required; set KEEWANO_PROJECT_ID (the server offers no list_projects tool)");
    }
    const projects = projectsFromResult(await this.invoke(client, "list_projects", {}));
    if (projects.length === 1 && projects[0]) {
      this.projectId = projects[0].id;
      return this.projectId;
    }
    throw new KeewanoQueryError(
      projects.length === 0
        ? "No Keewano project is accessible to this token"
        : `Several Keewano projects are accessible (${projects.map((p) => `${p.name ?? "?"}=${p.id}`).join(", ")}); set KEEWANO_PROJECT_ID`,
    );
  }

  async runSql(sql: string): Promise<SqlRow[]> {
    const { tool, result } = await this.runSqlRaw(sql);
    if (result.isError) throw new KeewanoQueryError(`Keewano tool ${tool} returned an error: ${textOf(result).slice(0, 500)}`);
    return parseRows(result);
  }
}

// ---------------------------------------------------------------------------
// Tool discovery and result normalization (pure; unit tested without a server)
// ---------------------------------------------------------------------------

export function takesProjectId(inputSchema: unknown): boolean {
  return isRecord(inputSchema) && isRecord(inputSchema.properties) && "projectId" in inputSchema.properties;
}

export function projectsFromResult(result: ToolResultLike): KeewanoProject[] {
  let rows: SqlRow[] = [];
  try {
    rows = parseRows(result);
  } catch {
    rows = [];
  }
  const out: KeewanoProject[] = [];
  for (const r of rows) {
    const id = [r.id, r.projectId, r.project_id].find((v) => typeof v === "string" && UUID.test(v));
    if (typeof id !== "string") continue;
    out.push({ id, name: typeof r.name === "string" ? r.name : null });
  }
  return out;
}

export function pickSqlTool(
  tools: readonly McpToolInfo[],
  toolOverride: string | null = null,
  argOverride: string | null = null,
): { name: string; arg: string; needsProjectId: boolean } {
  let tool: McpToolInfo | undefined;
  if (toolOverride) {
    tool = tools.find((t) => t.name === toolOverride);
    if (!tool) throw new KeewanoQueryError(`KEEWANO_SQL_TOOL "${toolOverride}" is not offered; tools: ${names(tools)}`);
  } else {
    tool =
      tools.find((t) => /sql/i.test(t.name)) ??
      tools.find((t) => /query/i.test(t.name)) ??
      tools.find((t) => /sql/i.test(t.description ?? ""));
    if (!tool) throw new KeewanoQueryError(`No SQL tool found on the Keewano MCP server; tools: ${names(tools)}`);
  }
  return { name: tool.name, arg: argOverride ?? guessSqlArg(tool.inputSchema), needsProjectId: takesProjectId(tool.inputSchema) };
}

function names(tools: readonly McpToolInfo[]): string {
  return tools.length > 0 ? tools.map((t) => t.name).join(", ") : "(none)";
}

export function guessSqlArg(inputSchema: unknown): string {
  const props = isRecord(inputSchema) && isRecord(inputSchema.properties) ? inputSchema.properties : null;
  if (!props) return "sql";
  const keys = Object.keys(props);
  const preferred = keys.find((k) => /^(sql|query|statement|sql_query|sqlQuery)$/i.test(k));
  if (preferred) return preferred;
  const firstString = keys.find((k) => {
    const p = props[k];
    return isRecord(p) && p.type === "string";
  });
  return firstString ?? keys[0] ?? "sql";
}

export function textOf(result: ToolResultLike): string {
  if (!Array.isArray(result.content)) return "";
  return result.content
    .map((c) => (isRecord(c) && c.type === "text" && typeof c.text === "string" ? c.text : ""))
    .filter((t) => t.length > 0)
    .join("\n");
}

/** Rows from structuredContent, JSON text, a markdown table or simple CSV; throws otherwise. */
export function parseRows(result: ToolResultLike): SqlRow[] {
  if (result.structuredContent !== undefined) {
    const rows = rowsFromValue(result.structuredContent);
    if (rows) return rows;
  }
  const text = textOf(result);
  if (!text.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    parsed = undefined;
  }
  if (parsed !== undefined) {
    const rows = rowsFromValue(parsed);
    if (rows) return rows;
  }
  const table = rowsFromMarkdownTable(text) ?? rowsFromCsv(text);
  if (table) return table;
  throw new KeewanoQueryError(`Unrecognized Keewano result shape: ${text.slice(0, 200)}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function columnNames(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const cols = v.map((c) => (typeof c === "string" ? c : isRecord(c) && typeof c.name === "string" ? c.name : null));
  return cols.every((c): c is string => c !== null) ? cols : null;
}

function zip(columns: string[], values: unknown[]): SqlRow {
  const row: SqlRow = {};
  columns.forEach((c, i) => {
    row[c] = values[i] ?? null;
  });
  return row;
}

function rowsFromValue(v: unknown, depth = 0): SqlRow[] | null {
  if (depth > 3) return null;
  if (Array.isArray(v)) return v.every(isRecord) ? v : null;
  if (!isRecord(v)) return null;
  const columns = columnNames(v.columns) ?? columnNames(v.fields) ?? columnNames(v.headers);
  for (const key of ["rows", "data", "results", "result", "records", "values", "projects", "items"]) {
    const inner = v[key];
    if (Array.isArray(inner)) {
      if (inner.length === 0) return [];
      if (inner.every(isRecord)) return inner;
      if (columns && inner.every(Array.isArray)) return inner.map((r) => zip(columns, r as unknown[]));
    } else if (isRecord(inner)) {
      const nested = rowsFromValue(inner, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

function rowsFromMarkdownTable(text: string): SqlRow[] | null {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"));
  if (lines.length < 2) return null;
  const cells = (l: string) =>
    l
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
  const header = cells(lines[0] ?? "");
  const body = lines.slice(1).filter((l) => !/^\|?\s*:?-{2,}/.test(l));
  return body.map((l) => zip(header, cells(l)));
}

function rowsFromCsv(text: string): SqlRow[] | null {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 2) return null;
  const sep = (lines[0] ?? "").includes("\t") ? "\t" : ",";
  const header = (lines[0] ?? "").split(sep).map((c) => c.trim());
  if (header.length < 2) return null;
  const rows = lines.slice(1).map((l) => l.split(sep).map((c) => c.trim()));
  if (!rows.every((r) => r.length === header.length)) return null;
  return rows.map((r) => zip(header, r));
}
