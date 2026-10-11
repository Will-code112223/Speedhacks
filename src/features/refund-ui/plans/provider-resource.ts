import type { InsurerLookup, InsurerSummary } from "../api/insurer-types";
import type { InsurerApi } from "../api/insurers";

export interface ProviderState {
  list: { status: "loading" | "ready" | "error"; items: InsurerSummary[]; error: string | null };
  selection: { id: string | null; status: "idle" | "loading" | "ready" | "missing" | "error"; insurer: InsurerLookup | null; error: string | null };
}

/** Read-only reference loading with stale response protection; never edits customer plans. */
export function createProviderResource(api: InsurerApi) {
  const initial: ProviderState = { list: { status: "loading", items: [], error: null }, selection: { id: null, status: "idle", insurer: null, error: null } };
  let state = initial;
  let listRequest = 0;
  let lookupRequest = 0;
  const listeners = new Set<() => void>();
  const publish = (next: ProviderState) => { state = next; listeners.forEach((listener) => listener()); };
  return {
    getSnapshot: () => state,
    getServerSnapshot: () => initial,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async load() {
      const request = ++listRequest;
      publish({ ...state, list: { status: "loading", items: state.list.items, error: null } });
      try {
        const items = await api.listInsurers();
        if (request === listRequest) publish({ ...state, list: { status: "ready", items, error: null } });
      } catch {
        if (request === listRequest) publish({ ...state, list: { status: "error", items: [], error: "Provider directory unavailable." } });
      }
    },
    async select(id: string | null) {
      const request = ++lookupRequest;
      if (!id) { publish({ ...state, selection: { id: null, status: "idle", insurer: null, error: null } }); return; }
      publish({ ...state, selection: { id, status: "loading", insurer: null, error: null } });
      try {
        const insurer = await api.lookupInsurer(id);
        if (request === lookupRequest) publish({ ...state, selection: { id, status: insurer ? "ready" : "missing", insurer, error: null } });
      } catch {
        if (request === lookupRequest) publish({ ...state, selection: { id, status: "error", insurer: null, error: "Provider details unavailable." } });
      }
    },
    dispose() { listRequest++; lookupRequest++; },
  };
}

/** Untrusted KB links are clickable only as absolute http(s) URLs. */
export function providerUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
