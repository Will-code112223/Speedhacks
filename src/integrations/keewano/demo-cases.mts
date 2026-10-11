// Generate SYNTHETIC refund cases through the app's own HTTP API, so the Keewano mirror
// (KEEWANO_API_KEY) fills Keewano with realistic case data: created → authorized → one
// simulated call → polled to its outcome. The scenario mix is planned in demo-plan.ts and
// steered by the last four digits of each support number (README "Modes").
//
//   npm run keewano:demo-cases                                   # 24 cases, seed 1, 3 at a time
//   npm run keewano:demo-cases -- --count 60 --seed 7 --concurrency 4
//   BASE_URL=http://127.0.0.1:3000 npm run keewano:demo-cases    # drive a server that is already running
//
// Without BASE_URL the script starts its own `next dev` on a free port with REFUND_MODE=simulated,
// fast simulated timings and DATA_DIR=./data-demo (git-ignored), passing KEEWANO_* through so the
// mirror ships; with KEEWANO_API_KEY unset the cases only exist locally. Never dials anything real:
// the run aborts if the server reports a case in live mode.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { EXPECTED_BY_SCENARIO, MERCHANTS, SCENARIOS, planDemoCases, type DemoCasePlan, type DemoScenario } from "./demo-plan.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const POLL_MS = 700;
const CASE_DEADLINE_MS = 90_000;
const READY_TIMEOUT_MS = 120_000;
const SINK_FLUSH_MS = 4_000;
const TERMINAL_STATUSES = new Set(["approved", "denied", "needs_information", "awaiting_response"]);
const TERMINAL_CALL_STATES = new Set(["failed", "cancelled", "dispatch_unknown"]);

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------
function intOption(name: string, fallback: number, min = 1): number {
  const args = process.argv.slice(2);
  let raw: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === `--${name}`) raw = args[i + 1];
    else if (arg?.startsWith(`--${name}=`)) raw = arg.slice(name.length + 3);
  }
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be an integer ≥ ${min} (got "${raw}")`);
  return n;
}

function stringOption(name: string, env: string): string | null {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === `--${name}`) return args[i + 1] ?? null;
    if (arg?.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
  }
  const fromEnv = (process.env[env] ?? "").trim();
  return fromEnv.length > 0 ? fromEnv : null;
}

const count = intOption("count", 24);
const seed = intOption("seed", 1, 0);
const concurrency = intOption("concurrency", 3);
const externalBaseUrl = stringOption("base-url", "BASE_URL")?.replace(/\/+$/, "") ?? null;

// ---------------------------------------------------------------------------
// Local dev server
// ---------------------------------------------------------------------------
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("could not pick a free port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

interface LocalServer {
  child: ChildProcess;
  logPath: string;
}

function startServer(port: number): LocalServer {
  const dataDir = path.join(ROOT, "data-demo");
  mkdirSync(dataDir, { recursive: true });
  const logPath = path.join(dataDir, "next-dev.log");
  const fd = openSync(logPath, "a");
  const child = spawn(process.execPath, [path.join(ROOT, "node_modules/next/dist/bin/next"), "dev", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: ROOT,
    env: {
      ...process.env, // KEEWANO_* (and .env.local via --env-file-if-exists) pass through
      REFUND_MODE: "simulated",
      SIMULATED_QUEUED_MS: "300",
      SIMULATED_IN_PROGRESS_MS: "600",
      DATA_DIR: "./data-demo",
      // Provider reads are cheap here; reconcile on nearly every poll so cases settle quickly.
      RECONCILE_MIN_INTERVAL_MS: "500",
      PORT: String(port),
    },
    stdio: ["ignore", fd, fd],
    detached: true, // own process group, so stopping it also stops Next's workers
  });
  closeSync(fd);
  return { child, logPath };
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

async function stopServer(server: LocalServer): Promise<void> {
  const { child } = server;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const group = child.pid ? -child.pid : null;
  try {
    if (group) process.kill(group, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  await Promise.race([exited(child), sleep(10_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      if (group) process.kill(group, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

async function waitForServer(baseUrl: string, server: LocalServer): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null || server.child.signalCode !== null) {
      throw new Error(`next dev exited early (code ${server.child.exitCode}, signal ${server.child.signalCode}); see ${server.logPath}`);
    }
    try {
      // The first GET / compiles the page, which can take a while on a cold .next.
      const res = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(30_000) });
      if (res.status < 500) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`server did not answer GET / within ${READY_TIMEOUT_MS} ms; see ${server.logPath}`);
}

// ---------------------------------------------------------------------------
// HTTP client (one session cookie per case)
// ---------------------------------------------------------------------------
interface ApiReply {
  status: number;
  body: Record<string, unknown>;
  setCookie: string | null;
}

async function api(baseUrl: string, cookie: string | null, method: "GET" | "POST", route: string, body?: FormData | Record<string, unknown>): Promise<ApiReply> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${route}`, { method, headers, body: payload, signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: parsed, setCookie: res.headers.get("set-cookie") };
}

function describeError(reply: ApiReply): string {
  const error = reply.body.error as { code?: string; message?: string } | undefined;
  if (error?.code) return `${error.code}: ${error.message ?? ""}`.trim();
  return JSON.stringify(reply.body).slice(0, 200);
}

interface CaseSnapshot {
  id: string;
  revision: number;
  mode: string;
  status: string;
  missingFields: string[];
  authorization: { id: string } | null;
  calls: { state: string }[];
  outcome: { decision: string };
}

function caseOf(reply: ApiReply): CaseSnapshot {
  const c = reply.body.case as CaseSnapshot | undefined;
  if (!c || typeof c.id !== "string") throw new Error(`response had no case: ${JSON.stringify(reply.body).slice(0, 200)}`);
  return c;
}

function latestCallState(c: CaseSnapshot): string | null {
  const last = c.calls[c.calls.length - 1];
  return last ? last.state : null;
}

function settled(c: CaseSnapshot): boolean {
  if (TERMINAL_STATUSES.has(c.status)) return true;
  return c.calls.some((call) => TERMINAL_CALL_STATES.has(call.state));
}

// ---------------------------------------------------------------------------
// One case: create → authorize → call → poll
// ---------------------------------------------------------------------------
interface CaseResult {
  plan: DemoCasePlan;
  caseId: string | null;
  status: string | null;
  decision: string | null;
  callState: string | null;
  /** The scenario the API actually produced, or "timeout" / "error" / a descriptive label. */
  observed: string;
  error: string | null;
  durationMs: number;
}

function observe(c: CaseSnapshot, rejected: boolean): string {
  if (rejected) return "rejected";
  const state = latestCallState(c);
  if (state === "completed") {
    if (c.outcome.decision === "approved") return "approved";
    if (c.outcome.decision === "denied") return "denied";
    if (c.outcome.decision === "needs_information") return "needs_info";
    return `completed/${c.outcome.decision}`;
  }
  if (state === "failed" || state === "cancelled" || state === "dispatch_unknown") return state;
  return "timeout";
}

async function runCase(baseUrl: string, plan: DemoCasePlan): Promise<CaseResult> {
  const started = Date.now();
  const result: CaseResult = { plan, caseId: null, status: null, decision: null, callState: null, observed: "error", error: null, durationMs: 0 };
  try {
    const form = new FormData();
    form.set("summary", plan.summary);
    form.set("customerName", plan.customer.name);
    form.set("customerEmail", plan.customer.email);
    form.set("merchantName", plan.merchant);
    form.set("supportPhone", plan.supportPhone);
    form.set("amountMinor", String(plan.amountMinor));
    form.set("currency", plan.currency);
    const created = await api(baseUrl, null, "POST", "/api/cases", form);
    if (created.status !== 201) throw new Error(`POST /api/cases → ${created.status} ${describeError(created)}`);
    const cookie = created.setCookie?.split(";")[0] ?? null;
    if (!cookie) throw new Error("POST /api/cases set no refund_session cookie");
    let c = caseOf(created);
    result.caseId = c.id;
    if (c.mode !== "simulated") throw new Error(`case ${c.id} was created in ${c.mode} mode; refusing to authorize a non-simulated call`);
    if (c.status !== "ready_for_approval") throw new Error(`case is ${c.status} after creation (missing: ${c.missingFields.join(", ") || "none"})`);

    const authorized = await api(baseUrl, cookie, "POST", `/api/cases/${c.id}/authorize`, { expectedRevision: c.revision });
    if (authorized.status !== 200) throw new Error(`POST /authorize → ${authorized.status} ${describeError(authorized)}`);
    const authorizationId = caseOf(authorized).authorization?.id;
    if (!authorizationId) throw new Error("authorize returned no authorization id");

    const dispatched = await api(baseUrl, cookie, "POST", `/api/cases/${c.id}/calls`, { authorizationId, requestId: randomUUID() });
    const error = dispatched.body.error as { code?: string } | undefined;
    const rejected = dispatched.status === 503 && error?.code === "PROVIDER_UNAVAILABLE";
    if (!rejected && dispatched.status !== 202) throw new Error(`POST /calls → ${dispatched.status} ${describeError(dispatched)}`);

    const deadline = started + CASE_DEADLINE_MS;
    for (;;) {
      const polled = await api(baseUrl, cookie, "GET", `/api/cases/${c.id}`);
      if (polled.status !== 200) throw new Error(`GET /api/cases/${c.id} → ${polled.status} ${describeError(polled)}`);
      c = caseOf(polled);
      if (rejected || settled(c) || Date.now() >= deadline) break;
      await sleep(POLL_MS);
    }
    result.status = c.status;
    result.decision = c.outcome.decision;
    result.callState = latestCallState(c);
    result.observed = observe(c, rejected);
  } catch (err) {
    result.error = String((err as Error).message ?? err);
  }
  result.durationMs = Date.now() - started;
  return result;
}

async function runPool<T, R>(items: readonly T[], width: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(width, items.length)) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      const item = items[i];
      if (item === undefined) return;
      results[i] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
const money = (amountMinor: number) => `$${(amountMinor / 100).toFixed(2)}`;
const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const padLeft = (s: string, n: number) => (s.length >= n ? s : " ".repeat(n - s.length) + s);

function caseLine(r: CaseResult): string {
  const head = `#${padLeft(String(r.plan.index), 3)}  ${pad(r.plan.merchant, 18)} ${padLeft(money(r.plan.amountMinor), 8)}  ${pad(r.plan.scenario, 16)}`;
  const secs = `${(r.durationMs / 1000).toFixed(1)}s`;
  if (r.error) return `${head} → ERROR ${r.error}  case ${r.caseId ?? "-"}  (${secs})`;
  const ok = r.observed === r.plan.scenario ? "" : "  [unexpected]";
  return `${head} → status ${r.status}, decision ${r.decision}, call ${r.callState ?? "none"}${ok}  case ${r.caseId}  (${secs})`;
}

function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows.map((row) => row.map((cell, i) => (i === 0 ? pad(cell, widths[i] ?? 0) : padLeft(cell, widths[i] ?? 0))).join("  ")).join("\n");
}

function summary(results: CaseResult[]): string {
  const columns: string[] = [...SCENARIOS, "other"];
  const header = ["merchant", "total", ...columns, "approval"];
  const rows: string[][] = [header];
  const countRow = (label: string, subset: CaseResult[]) => {
    const counts = new Map<string, number>();
    for (const r of subset) {
      const key = (SCENARIOS as readonly string[]).includes(r.observed) ? r.observed : "other";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const approved = counts.get("approved") ?? 0;
    const rate = subset.length > 0 ? `${Math.round((approved / subset.length) * 100)}%` : "-";
    rows.push([label, String(subset.length), ...columns.map((c) => String(counts.get(c) ?? 0)), rate]);
  };
  for (const merchant of MERCHANTS) {
    const subset = results.filter((r) => r.plan.merchant === merchant);
    if (subset.length > 0) countRow(merchant, subset);
  }
  countRow("total", results);
  return table(rows);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const plans = planDemoCases({ count, seed });
const mirror = (process.env.KEEWANO_API_KEY ?? "").trim() ? "on (KEEWANO_API_KEY set)" : "off (KEEWANO_API_KEY unset; cases stay local)";
console.log(`planning ${plans.length} synthetic cases (seed ${seed}, concurrency ${concurrency}); keewano mirror: ${mirror}`);

let server: LocalServer | null = null;
let baseUrl = externalBaseUrl;
const shutdown = async () => {
  if (server) await stopServer(server);
};
process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(130));
});

try {
  if (!baseUrl) {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = startServer(port);
    console.log(`starting next dev at ${baseUrl} (REFUND_MODE=simulated, DATA_DIR=./data-demo, log ${path.relative(ROOT, server.logPath)})`);
    await waitForServer(baseUrl, server);
    console.log("server is answering GET /");
  } else {
    console.log(`using ${baseUrl}`);
  }

  const results = await runPool(plans, concurrency, async (plan) => {
    const r = await runCase(baseUrl as string, plan);
    console.log(caseLine(r));
    return r;
  });

  console.log("\nOutcomes per merchant (observed):");
  console.log(summary(results));
  const matched = results.filter((r) => !r.error && r.observed === r.plan.scenario).length;
  const errors = results.filter((r) => r.error);
  console.log(`\n${matched}/${results.length} cases ended in the planned scenario${errors.length > 0 ? `; ${errors.length} errored` : ""}.`);
  for (const r of results) {
    if (r.error) console.log(`  #${r.plan.index} ${r.plan.merchant}: ${r.error}`);
    else if (r.observed !== r.plan.scenario) console.log(`  #${r.plan.index} ${r.plan.merchant}: planned ${r.plan.scenario}, observed ${r.observed}`);
  }
  const expectedMismatch = results.filter(
    (r) => !r.error && r.observed === r.plan.scenario && (r.status !== EXPECTED_BY_SCENARIO[r.plan.scenario as DemoScenario].status || r.decision !== EXPECTED_BY_SCENARIO[r.plan.scenario as DemoScenario].decision),
  );
  for (const r of expectedMismatch) {
    console.log(`  #${r.plan.index} ${r.plan.merchant}: ${r.plan.scenario} published status ${r.status}/decision ${r.decision}, expected ${EXPECTED_BY_SCENARIO[r.plan.scenario as DemoScenario].status}/${EXPECTED_BY_SCENARIO[r.plan.scenario as DemoScenario].decision}`);
  }
  if (matched !== results.length || expectedMismatch.length > 0) process.exitCode = 1;
  if (server) {
    console.log(`waiting ${SINK_FLUSH_MS / 1000}s for the keewano sink to flush, then stopping the server`);
    await sleep(SINK_FLUSH_MS);
  } else if (mirror.startsWith("on")) {
    console.log("mirrored events ship from the server you pointed BASE_URL at; they become queryable in Keewano 5–15 minutes later.");
  }
} finally {
  await shutdown();
}
