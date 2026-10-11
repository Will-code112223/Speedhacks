import type { Db } from "@/server/persistence/db";
import { CaseRepository } from "@/server/persistence/repository";
import { EVENT_TYPES, EVENTS_HASH } from "./events";
import { KeewanoIngestClient } from "./ingest";
import { MirroredCaseRepository } from "./mirror";
import { KeewanoSink } from "./sink";

/** Optional one-way telemetry; never a case authority, history source, or fixture fallback. */
export function createProductCaseRepository(
  db: Db,
  options: { env?: Readonly<Record<string, string | undefined>>; fetch?: typeof fetch } = {},
): CaseRepository {
  const env = options.env ?? process.env;
  const key = env.KEEWANO_API_KEY?.trim() ?? "";
  // Explicit confirmation means the operator selected a fresh, live-only project.
  // It cannot prove the remote project's contents; no read/MCP credential is consumed.
  if (env.KEEWANO_LIVE_PROJECT_CONFIRMED?.trim() !== "true" || !/^[\x21-\x7e]{1,4096}$/.test(key)) {
    return new CaseRepository(db);
  }
  const client = new KeewanoIngestClient({ apiKey: key, eventTypes: EVENT_TYPES, eventsHash: EVENTS_HASH, fetch: options.fetch });
  return new MirroredCaseRepository(db, new KeewanoSink(client));
}
