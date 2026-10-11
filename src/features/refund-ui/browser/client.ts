import type { BrowserCommand, BrowserRun, RuntimeReadiness, StartBrowserRequest } from "../../../contracts/browser";

export class BrowserApiError extends Error {
  constructor(message: string, readonly status: number | null = null) { super(message); this.name = "BrowserApiError"; }
}

export interface BrowserApi {
  readiness(signal?: AbortSignal): Promise<RuntimeReadiness>;
  start(request: StartBrowserRequest, signal?: AbortSignal): Promise<BrowserRun>;
  get(id: string, signal?: AbortSignal): Promise<BrowserRun>;
  find(caseId: string, requestId: string, signal?: AbortSignal): Promise<BrowserRun>;
  command(id: string, command: BrowserCommand, signal?: AbortSignal): Promise<BrowserRun>;
  frame(id: string, signal?: AbortSignal): Promise<Blob>;
}

export function createBrowserApi(fetcher: typeof fetch = (...args) => fetch(...args)): BrowserApi {
  async function send(path: string, body?: unknown, signal?: AbortSignal, accept = "application/json") {
    let response: Response;
    const timeout = AbortSignal.timeout(30_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      response = await fetcher(path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", headers: { accept, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: requestSignal });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timeout.aborted) throw new BrowserApiError("The browser request timed out. Its last action may still be running; refresh its status before continuing.");
      throw new BrowserApiError("The browser service could not be reached. Its last action may still be running.");
    }
    if (!response.ok) {
      let message = `Browser service returned HTTP ${response.status}.`;
      try { const value = await response.json(); if (record(value) && record(value.error) && typeof value.error.message === "string") message = value.error.message; } catch { /* Preserve status when the server returns non-JSON. */ }
      throw new BrowserApiError(message, response.status);
    }
    return response;
  }
  async function run(path: string, body?: unknown, signal?: AbortSignal) {
    const response = await send(path, body, signal);
    let value: unknown;
    try { value = await response.json(); } catch { throw new BrowserApiError("The browser service returned unreadable run data."); }
    if (!record(value) || !isBrowserRun(value.run)) throw new BrowserApiError("The browser service returned invalid run data.");
    return value.run;
  }
  return {
    async readiness(signal) {
      const response = await send("/api/runtime", undefined, signal);
      const value: unknown = await response.json();
      if (!record(value) || value.mode !== "live" || ![value.extraction, value.calls, value.browser].every((part) => record(part) && typeof part.ready === "boolean" && stringArray(part.missing))) throw new BrowserApiError("Runtime configuration status is unavailable.");
      return value as unknown as RuntimeReadiness;
    },
    start: (request, signal) => run("/api/browser", request, signal),
    get: (id, signal) => run(`/api/browser/${encodeURIComponent(id)}`, undefined, signal),
    find: (caseId, requestId, signal) => run(`/api/browser?caseId=${encodeURIComponent(caseId)}&requestId=${encodeURIComponent(requestId)}`, undefined, signal),
    command: (id, command, signal) => run(`/api/browser/${encodeURIComponent(id)}`, command, signal),
    async frame(id, signal) {
      const response = await send(`/api/browser/${encodeURIComponent(id)}/frame`, undefined, signal, "image/jpeg");
      if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "image/jpeg") throw new BrowserApiError("No valid browser frame was returned.");
      const blob = await response.blob();
      if (!blob.size || blob.size > 15_000_000) throw new BrowserApiError("The browser frame could not be displayed.");
      return blob;
    },
  };
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((entry) => typeof entry === "string"); }
function nullableString(value: unknown) { return value === null || typeof value === "string"; }
const statuses = new Set(["starting", "running", "needs_approval", "needs_login", "completed", "failed", "cancelled", "uncertain"]);
const actions = new Set(["navigate", "click", "fill", "select", "upload"]);

export function isBrowserRun(value: unknown): value is BrowserRun {
  if (!record(value)) return false;
  if (!["id", "caseId", "requestId", "task", "startUrl", "message", "updatedAt", "createdAt"].every((key) => typeof value[key] === "string")) return false;
  if (!Number.isInteger(value.caseRevision) || !statuses.has(String(value.status)) || !stringArray(value.allowedHosts) || !nullableString(value.currentUrl) || !nullableString(value.pageTitle) || typeof value.frameAvailable !== "boolean") return false;
  const pending = value.pendingAction;
  if (pending !== null && (!record(pending) || !["id", "observationId", "description", "target"].every((key) => typeof pending[key] === "string") || !actions.has(String(pending.kind)) || !nullableString(pending.value) || !nullableString(pending.artifactId))) return false;
  if (!Array.isArray(value.events) || !value.events.every((event) => record(event) && ["id", "at", "message"].every((key) => typeof event[key] === "string"))) return false;
  return Array.isArray(value.artifacts) && value.artifacts.every((artifact) => record(artifact) && ["id", "name", "mimeType", "downloadUrl"].every((key) => typeof artifact[key] === "string") && Number.isInteger(artifact.sizeBytes) && Number(artifact.sizeBytes) >= 0);
}

/** Server artifacts stay on the authenticated same-origin browser route. */
export function browserArtifactUrl(value: string): string | null {
  if (!value.startsWith("/api/browser/") || value.startsWith("//") || value.includes("\\")) return null;
  try { const url = new URL(value, "https://recourse.invalid"); return url.origin === "https://recourse.invalid" && url.pathname.startsWith("/api/browser/") ? `${url.pathname}${url.search}` : null; } catch { return null; }
}
