/**
 * Client-generated request ids that survive retries and reloads within a tab,
 * so a repeated "start call" reaches the server with the same requestId and
 * gets the stored attempt back instead of a second dispatch.
 */

import { randomUuid, UUID_PATTERN } from "./uuid";

const PREFIX = "recourse:request-id:";

/** The part of Storage this module uses. */
export type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

/** Fallback when sessionStorage is missing or blocked; lives as long as the page. */
const memory = new Map<string, string>();

/** The tab's sessionStorage, or null on the server and where storage is blocked. */
export function browserSessionStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** The id stored for `key`, created and stored on first use. */
export function getOrCreateRequestId(storage: KeyValueStore | null, key: string): string {
  const slot = PREFIX + key;
  const stored = read(storage, slot) ?? memory.get(slot) ?? null;
  const id = stored !== null && UUID_PATTERN.test(stored) ? stored : randomUuid();
  memory.set(slot, id);
  write(storage, slot, id);
  return id;
}

function read(storage: KeyValueStore | null, slot: string): string | null {
  try {
    return storage?.getItem(slot) ?? null;
  } catch {
    return null;
  }
}

function write(storage: KeyValueStore | null, slot: string, value: string): void {
  try {
    storage?.setItem(slot, value);
  } catch {
    // Quota or privacy mode: the in-memory copy still covers retries on this page.
  }
}
