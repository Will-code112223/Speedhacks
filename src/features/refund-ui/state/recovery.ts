/** Only server-owned case IDs belong in tab storage, never case contents. */
import type { CaseV1 } from "../../../contracts/case";
import type { KeyValueStore } from "../api/request-id";
import { ApiRequestError, type ApiMode, type CaseApi } from "../api/types";
import { UUID_PATTERN } from "../api/uuid";
import { toUiError, type UiError } from "./errors";

export const RECOVERY_KEY = "recourse:case-sessions:http:v1";
const MAX_CASES = 50;
const READ_TIMEOUT_MS = 10_000;
export interface RecoveryIndex {
  version: 1;
  apiMode: "http";
  caseIds: string[];
  /** null deliberately preserves the New case view. */
  activeCaseId: string | null;
}
export interface RecoveredCase {
  caseId: string;
  caseData: CaseV1 | null;
  error: UiError | null;
}
export interface RecoveryResult {
  entries: RecoveredCase[];
  activeCaseId: string | null;
  /** Only definitive ownership/not-found responses remove a saved pointer. */
  discardedCaseIds?: string[];
}

export interface CaseRecovery {
  done: Promise<RecoveryResult>;
  /** Replays the latest snapshot, including placeholders before any read ends. */
  subscribe(listener: (result: RecoveryResult) => void): () => void;
}

export function recoveryIndex(caseIds: readonly string[], activeCaseId: string | null): RecoveryIndex {
  const all = [...new Set(caseIds.filter(id => UUID_PATTERN.test(id)))];
  const ids = all.slice(0, MAX_CASES);
  if (activeCaseId !== null && all.includes(activeCaseId) && !ids.includes(activeCaseId)) {
    ids[ids.length - 1] = activeCaseId;
  }
  return { version: 1, apiMode: "http", caseIds: ids,
    activeCaseId: activeCaseId !== null && ids.includes(activeCaseId) ? activeCaseId : null };
}

export function readRecoveryIndex(storage: KeyValueStore | null, apiMode: ApiMode): RecoveryIndex {
  const empty = recoveryIndex([], null);
  if (apiMode !== "http") return empty;
  try {
    const text = storage?.getItem(RECOVERY_KEY);
    if (!text || text.length > 16_384) return empty;
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return empty;
    const index = value as Record<string, unknown>;
    if (index.version !== 1 || index.apiMode !== "http" || !Array.isArray(index.caseIds)
      || index.caseIds.length > MAX_CASES
      || !index.caseIds.every(id => typeof id === "string" && UUID_PATTERN.test(id))
      || !(index.activeCaseId === null || (typeof index.activeCaseId === "string" && UUID_PATTERN.test(index.activeCaseId)))) return empty;
    return recoveryIndex(index.caseIds, index.activeCaseId as string | null);
  } catch {
    // Disabled/quota-limited storage cannot prevent using the current workspace.
    return empty;
  }
}

export function writeRecoveryIndex(storage: KeyValueStore | null, apiMode: ApiMode, index: RecoveryIndex): void {
  if (apiMode !== "http") return;
  // Rebuild from the allowlist even if a caller supplies extra object properties.
  const value = JSON.stringify(recoveryIndex(index.caseIds, index.activeCaseId));
  try {
    if (storage?.getItem(RECOVERY_KEY) !== value) storage?.setItem(RECOVERY_KEY, value);
  } catch { /* Recovery is best effort when browser storage is unavailable. */ }
}

/** One shared read pass, with replay for React's effect cleanup/setup cycle. */
export function createCaseRecovery(api: CaseApi, index: RecoveryIndex, timeoutMs = READ_TIMEOUT_MS): CaseRecovery {
  let latest: RecoveryResult = { entries: [], activeCaseId: null };
  const listeners = new Set<(result: RecoveryResult) => void>();
  const done = recoverCaseSessions(api, index, timeoutMs, result => {
    latest = result;
    for (const listener of listeners) listener(result);
  });
  return { done, subscribe(listener) {
    listeners.add(listener);
    listener(latest);
    return () => { listeners.delete(listener); };
  } };
}

/** One read per stored ID; never authorize, dispatch, patch, or create a case. */
export async function recoverCaseSessions(api: CaseApi, index: RecoveryIndex, timeoutMs = READ_TIMEOUT_MS,
  onProgress?: (result: RecoveryResult) => void): Promise<RecoveryResult> {
  if (api.mode !== "http" || index.apiMode !== "http") return { entries: [], activeCaseId: null };
  const safe = recoveryIndex(index.caseIds, index.activeCaseId);
  const entries: (RecoveredCase | null)[] = safe.caseIds.map(caseId => ({ caseId, caseData: null, error: null }));
  const discardedCaseIds: string[] = [];
  const snapshot = (): RecoveryResult => {
    const restored = entries.filter((entry): entry is RecoveredCase => entry !== null);
    return { entries: restored,
      activeCaseId: restored.some(entry => entry.caseId === safe.activeCaseId) ? safe.activeCaseId : null,
      ...(discardedCaseIds.length ? { discardedCaseIds: [...discardedCaseIds] } : {}),
    };
  };
  // Navigation and selection are available immediately, even while offline.
  onProgress?.(snapshot());
  const positions = safe.caseIds.map((_, position) => position);
  const selected = safe.caseIds.indexOf(safe.activeCaseId ?? "");
  if (selected > 0) positions.unshift(...positions.splice(selected, 1));
  let cursor = 0;
  // Prioritize the selected case and publish each result independently. A slow
  // history read must never hold up an already available active call.
  async function worker(): Promise<void> {
    while (cursor < positions.length) {
      const position = positions[cursor++]!;
      const caseId = safe.caseIds[position]!;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Existing HttpCaseApi sends the httpOnly ownership cookie. Stored IDs
        // are navigation pointers and grant no access by themselves.
        const caseData = await Promise.race([
          api.getCase(caseId, controller.signal),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              // Reject with the useful retry message before fetch's AbortError.
              reject(new ApiRequestError(504, "UNAVAILABLE", "The saved case could not be loaded in time. Try again."));
              controller.abort();
            }, timeoutMs);
          }),
        ]);
        if (caseData.id !== caseId) throw new ApiRequestError(200, "CONTRACT_VIOLATION", "The server returned a different case.");
        entries[position] = { caseId, caseData, error: null };
      } catch (error) {
        if (error instanceof ApiRequestError && [401, 403, 404].includes(error.status)) {
          entries[position] = null;
          discardedCaseIds.push(caseId);
        } else entries[position] = { caseId, caseData: null, error: toUiError(error) };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      onProgress?.(snapshot());
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, safe.caseIds.length) }, worker));
  return snapshot();
}
