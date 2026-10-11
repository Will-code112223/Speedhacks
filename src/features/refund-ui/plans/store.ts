/**
 * Insurance plans are stored only in this browser.
 *
 * The shared contract has no plan endpoint on the backend, so plan metadata
 * and the original file blobs live in IndexedDB and are attached to a case as
 * ordinary files when the case is created (POST /api/cases, repeated `files`).
 * When IndexedDB is unavailable (some private windows), the store falls back
 * to memory for the life of the tab and reports `persistent: false`.
 */

import { formatBytes } from "../ui/format";

export interface PlanFields {
  name: string;
  insurer: string;
  policyNumber: string;
  supportPhone: string;
}

export interface PlanRecord extends PlanFields {
  id: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  /** File.lastModified, used to spot the same file added twice. */
  fileLastModified: number;
  addedAt: string;
  file: Blob;
}

export interface PlanStore {
  readonly persistent: boolean;
  list(): Promise<PlanRecord[]>;
  put(plan: PlanRecord): Promise<void>;
  remove(id: string): Promise<void>;
  getFlag(key: string): Promise<boolean>;
  setFlag(key: string, value: boolean): Promise<void>;
}

export const PLAN_MAX_BYTES = 10 * 1024 * 1024;
export const PLAN_ACCEPT =
  ".pdf,.png,.jpg,.jpeg,.heic,.heif,application/pdf,image/png,image/jpeg,image/heic,image/heif";

const ACCEPTED_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/heic", "image/heif"]);
const ACCEPTED_EXTENSIONS = new Set(["pdf", "png", "jpg", "jpeg", "heic", "heif"]);

/** Returns a sentence explaining why the file cannot be a plan, or null when it can. */
export function validatePlanFile(file: File): string | null {
  const extension = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
  // Some browsers report HEIC with an empty type, so the extension also counts.
  if (!ACCEPTED_TYPES.has(file.type) && !ACCEPTED_EXTENSIONS.has(extension)) {
    return `${file.name} was not added. Use a PDF, PNG, JPG or HEIC file.`;
  }
  if (file.size === 0) return `${file.name} was not added because it is empty.`;
  if (file.size > PLAN_MAX_BYTES) {
    return `${file.name} was not added. It is ${formatBytes(file.size)} and the limit is 10 MB per file.`;
  }
  return null;
}

/** The plan's file as a File, ready for multipart upload. */
export function planToFile(plan: PlanRecord): File {
  if (typeof File !== "undefined" && plan.file instanceof File) return plan.file;
  return new File([plan.file], plan.fileName, { type: plan.fileType, lastModified: plan.fileLastModified });
}

// ---------------------------------------------------------------------------
// IndexedDB implementation
// ---------------------------------------------------------------------------

const DB_NAME = "recourse";
const DB_VERSION = 1;
const PLANS = "plans";
const META = "meta";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available in this browser."));
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(error instanceof Error ? error : new Error("IndexedDB could not be opened."));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PLANS)) db.createObjectStore(PLANS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "key" });
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab upgrading the schema should not be blocked by this one.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("IndexedDB could not be opened."));
    request.onblocked = () => reject(new Error("IndexedDB is blocked by another tab."));
  });
}

function runRequest<T>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = operation(transaction.objectStore(storeName));
    let result: T;
    request.onsuccess = () => {
      result = request.result;
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error ?? request.error ?? new Error("IndexedDB request failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction was aborted."));
  });
}

function createIndexedDbStore(db: IDBDatabase): PlanStore {
  return {
    persistent: true,
    async list() {
      const plans = await runRequest<PlanRecord[]>(db, PLANS, "readonly", (store) => store.getAll());
      return plans.sort((a, b) => a.addedAt.localeCompare(b.addedAt));
    },
    async put(plan) {
      await runRequest(db, PLANS, "readwrite", (store) => store.put(plan));
    },
    async remove(id) {
      await runRequest(db, PLANS, "readwrite", (store) => store.delete(id));
    },
    async getFlag(key) {
      const row = await runRequest<{ key: string; value: boolean } | undefined>(db, META, "readonly", (store) =>
        store.get(key),
      );
      return row?.value === true;
    },
    async setFlag(key, value) {
      await runRequest(db, META, "readwrite", (store) => store.put({ key, value }));
    },
  };
}

function createMemoryStore(): PlanStore {
  const plans = new Map<string, PlanRecord>();
  const flags = new Map<string, boolean>();
  return {
    persistent: false,
    async list() {
      return [...plans.values()].sort((a, b) => a.addedAt.localeCompare(b.addedAt));
    },
    async put(plan) {
      plans.set(plan.id, plan);
    },
    async remove(id) {
      plans.delete(id);
    },
    async getFlag(key) {
      return flags.get(key) === true;
    },
    async setFlag(key, value) {
      flags.set(key, value);
    },
  };
}

let storePromise: Promise<PlanStore> | null = null;

/** One shared store per tab. Never rejects: falls back to memory instead. */
export function openPlanStore(): Promise<PlanStore> {
  if (!storePromise) {
    storePromise = openDatabase().then(createIndexedDbStore, () => createMemoryStore());
  }
  return storePromise;
}
