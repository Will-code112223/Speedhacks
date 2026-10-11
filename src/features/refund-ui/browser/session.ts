import type { BrowserCommand, BrowserRun, StartBrowserRequest } from "../../../contracts/browser";
import type { BrowserApi } from "./client";

export interface BrowserSessionState { run: BrowserRun | null; request: StartBrowserRequest | null; busy: boolean; recovering: boolean; recoveryBlocked: boolean; commandNeedsRefresh: boolean; error: string | null; }
export interface BrowserStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void; }
export const browserStorageKey = (caseId: string) => `recourse:browser-run:v1:${caseId}`;

/** Recovery performs reads only. Mutation retries are explicit and reuse the frozen request ID. */
export function createBrowserSession(caseId: string, api: BrowserApi, storage: BrowserStorage) {
  const initial: BrowserSessionState = { run: null, request: null, busy: false, recovering: true, recoveryBlocked: false, commandNeedsRefresh: false, error: null };
  let state = initial;
  let generation = 0;
  let latestRead = 0;
  let recoverySequence = 0;
  let disposed = false;
  let storedRunId: string | null = null;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<BrowserSessionState>) => { if (!disposed) { state = { ...state, ...patch }; listeners.forEach((listener) => listener()); } };
  function save(request: StartBrowserRequest, runId: string | null) { storage.setItem(browserStorageKey(caseId), JSON.stringify({ caseId, request, runId })); }
  function accept(run: BrowserRun) {
    if (run.caseId !== caseId || (storedRunId && run.id !== storedRunId) || (state.request && (run.requestId !== state.request.requestId || run.caseRevision !== state.request.expectedRevision))) throw new Error("The browser response does not belong to this case request.");
    storedRunId = run.id;
    if (state.request) save(state.request, run.id);
    publish({ run, error: null, commandNeedsRefresh: false });
  }
  async function refresh(signal?: AbortSignal) {
    if (!storedRunId || state.busy) return;
    const read = ++latestRead; const current = generation;
    try { const run = await api.get(storedRunId, signal); if (!signal?.aborted && !disposed && current === generation && read === latestRead) accept(run); }
    catch (error) { if (!signal?.aborted && !disposed && current === generation && read === latestRead) publish({ error: message(error), commandNeedsRefresh: true }); }
  }
  return {
    getSnapshot: () => state,
    getServerSnapshot: () => initial,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async recover(signal?: AbortSignal) {
      disposed = false;
      const recovery = ++recoverySequence;
      const current = () => !signal?.aborted && !disposed && recovery === recoverySequence;
      publish({ recovering: true });
      try {
        const raw = storage.getItem(browserStorageKey(caseId));
        if (raw) {
          const saved: unknown = JSON.parse(raw);
          if (!isStoredRequest(saved, caseId)) throw new Error("Saved browser session is invalid. No browser task was replayed.");
          storedRunId = saved.runId;
          publish({ request: saved.request });
          if (storedRunId) await refresh(signal);
          else {
            try { const run = await api.find(caseId, saved.request.requestId, signal); if (current()) accept(run); }
            catch (error) { if (current()) publish({ error: `${message(error)} The original request is saved; no task was replayed.` }); }
          }
        }
      } catch (error) { if (current()) publish({ error: message(error), recoveryBlocked: true }); }
      finally { if (current()) publish({ recovering: false }); }
    },
    refresh,
    async start(request: StartBrowserRequest) {
      if (state.busy || state.recovering || state.recoveryBlocked || state.run) return;
      const frozen = state.request ?? request;
      if (frozen.caseId !== caseId) { publish({ error: "Browser task belongs to another case." }); return; }
      generation++; latestRead++;
      try { save(frozen, null); } catch { publish({ error: "Session storage is unavailable. Enable it before starting a recoverable browser task." }); return; }
      publish({ request: frozen, busy: true, error: null });
      try { accept(await api.start(frozen)); } catch (error) { publish({ error: message(error) }); }
      finally { publish({ busy: false }); }
    },
    async command(command: BrowserCommand) {
      if (state.busy || !state.run || (state.commandNeedsRefresh && command.command !== "cancel")) return;
      generation++; latestRead++;
      const runId = state.run.id;
      publish({ busy: true, error: null });
      try { accept(await api.command(runId, command)); }
      catch (error) { publish({ error: `${message(error)} Refresh status before trying again.`, commandNeedsRefresh: true }); }
      finally { publish({ busy: false }); }
    },
    newTask() {
      if (state.busy || !state.run || !["completed", "failed", "cancelled"].includes(state.run.status)) return;
      try { storage.removeItem(browserStorageKey(caseId)); }
      catch { publish({ error: "The saved browser session could not be cleared. No new task was started." }); return; }
      generation++; latestRead++; storedRunId = null;
      publish({ ...initial, recovering: false });
    },
    dispose() { disposed = true; generation++; latestRead++; recoverySequence++; },
  };
}

function message(error: unknown) { return error instanceof Error ? error.message : "Browser status is unavailable."; }
function isStoredRequest(value: unknown, caseId: string): value is { caseId: string; request: StartBrowserRequest; runId: string | null } {
  if (!value || typeof value !== "object") return false;
  const saved = value as { caseId?: unknown; request?: Partial<StartBrowserRequest>; runId?: unknown };
  const request = saved.request;
  return saved.caseId === caseId && (saved.runId === null || typeof saved.runId === "string") && !!request && request.caseId === caseId && typeof request.requestId === "string" && Number.isInteger(request.expectedRevision) && typeof request.task === "string" && typeof request.startUrl === "string" && Array.isArray(request.allowedHosts) && request.allowedHosts.every((host) => typeof host === "string");
}

export function browserStartUrl(merchant: string | null): string {
  return merchant && /\bamazon\b/i.test(merchant) ? "https://www.amazon.com/gp/your-account/order-history" : "";
}

export function browserHosts(startUrl: string, extraHosts: string): { url: string; hosts: string[] } | null {
  try {
    const url = new URL(startUrl);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const extras = extraHosts.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
    if (extras.some((host) => !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || host.includes(".."))) return null;
    return { url: url.href, hosts: [...new Set([url.hostname.toLowerCase(), ...extras])] };
  } catch { return null; }
}
