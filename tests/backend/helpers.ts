import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CaseV1 } from "@/contracts/case";
import { CaseService } from "@/server/cases/service";
import { createSimulatedVoiceAdapter } from "@/server/cases/simulated-voice";
import { loadConfig, type AppConfig } from "@/server/config";
import { HeuristicExtractor } from "@/server/documents/extractor";
import { UploadStore } from "@/server/documents/storage";
import { openDatabase, closeDatabase } from "@/server/persistence/db";
import { CaseRepository } from "@/server/persistence/repository";
import type { VoiceAdapter } from "@/contracts/voice";

export const TEST_SECRET = "test-webhook-secret";

export interface Harness {
  config: AppConfig;
  repo: CaseRepository;
  service: CaseService;
  voice: VoiceAdapter;
  clock: { now: number; advance(ms: number): void };
  cleanup(): void;
}

/** Fresh SQLite + uploads dir per harness; fake clock drives the simulated call lifecycle. */
export function makeHarness(overrides: { voice?: VoiceAdapter; mode?: "simulated" | "live"; env?: Record<string, string> } = {}): Harness {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "refund-test-"));
  closeDatabase();
  const config = loadConfig({
    REFUND_MODE: overrides.mode ?? "simulated",
    DATA_DIR: dataDir,
    SIMULATED_WEBHOOK_SECRET: TEST_SECRET,
    SIMULATED_QUEUED_MS: "1000",
    SIMULATED_IN_PROGRESS_MS: "2000",
    RECONCILE_MIN_INTERVAL_MS: "0",
    ...(overrides.env ?? {}),
  });
  const clock = {
    now: Date.parse("2026-10-11T20:00:00.000Z"),
    advance(ms: number) {
      this.now += ms;
    },
  };
  const voice =
    overrides.voice ?? createSimulatedVoiceAdapter({ ...config.simulated, now: () => clock.now });
  const db = openDatabase(config.dataDir);
  const repo = new CaseRepository(db);
  const service = new CaseService({
    config,
    repo,
    uploads: new UploadStore(config.dataDir),
    extractor: new HeuristicExtractor(),
    voice: () => voice,
    now: () => new Date(clock.now),
  });
  return {
    config,
    repo,
    service,
    voice,
    clock,
    cleanup() {
      closeDatabase();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export const SESSION_A = "a".repeat(48);
export const SESSION_B = "b".repeat(48);

export const COMPLETE_FIELDS = {
  customerName: "Sam Rivera",
  customerEmail: "sam@example.com",
  merchantName: "Acme Streaming",
  supportPhone: "+14155551000",
  amountMinor: 4999,
  currency: "USD",
};

export async function createReadyCase(h: Harness, session = SESSION_A, fields = COMPLETE_FIELDS): Promise<CaseV1> {
  return h.service.createCase(session, {
    summary: "I was charged twice for my monthly subscription on October 3.",
    files: [{ name: "receipt.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("Receipt\nTotal: $49.99\n") }],
    fields,
  });
}

/** Authorize + dispatch; returns the case, authorization id and call. */
export async function authorizeAndCall(h: Harness, c: CaseV1, session = SESSION_A) {
  const authorized = h.service.authorize(session, c.id, c.revision);
  const authorizationId = authorized.authorization!.id;
  const call = await h.service.startCall(session, c.id, { authorizationId, requestId: randomUUID() });
  return { authorized, authorizationId, call };
}
