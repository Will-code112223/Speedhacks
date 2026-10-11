/**
 * Keewano sponsor integration (optional add-on; the refund flow works without it).
 *
 *   KEEWANO_API_KEY       → every case is mirrored into Keewano as it changes (MirroredCaseRepository)
 *   KEEWANO_ACCESS_TOKEN  → the pre-authorization duplicate-charge check queries Keewano over MCP
 *   neither, simulated    → the check reads the labeled local fixture (KEEWANO_FIXTURE_HISTORY=off disables)
 *
 * Case facts never come from Keewano; it only adds evidence to the timeline, the frozen
 * call brief and the packet. Nothing is queried during a call.
 */
import type { TransactionHistory } from "@/server/cases/history";
import type { AppConfig } from "@/server/config";
import type { Db } from "@/server/persistence/db";
import { CaseRepository } from "@/server/persistence/repository";
import { EVENTS_HASH, EVENT_TYPES } from "./events";
import { FixtureTransactionHistory, KeewanoTransactionHistory } from "./history";
import { KeewanoIngestClient } from "./ingest";
import { KeewanoMcpClient, projectIdFromApiKey } from "./mcp";
import { MirroredCaseRepository } from "./mirror";
import { KeewanoSink } from "./sink";

export { EVENTS_HASH, EVENT_TYPES, customerEntityId, event, uuidV5 } from "./events";
export { KeewanoIngestClient } from "./ingest";
export { KeewanoMcpClient } from "./mcp";
export { MirroredCaseRepository } from "./mirror";
export { KeewanoSink, type EventSink } from "./sink";
export { FixtureTransactionHistory, KeewanoTransactionHistory } from "./history";

export interface KeewanoWiring {
  /** Non-null when events are being mirrored. */
  sink: KeewanoSink | null;
  /** Non-null when a history source is available (Keewano or the fixture). */
  history: TransactionHistory | null;
  /** Plain repository, or the mirroring one when a sink exists. */
  repository(db: Db): CaseRepository;
}

export function createKeewano(config: Pick<AppConfig, "mode" | "keewano">, logger: { warn(message: string): void } = console): KeewanoWiring {
  const k = config.keewano;
  const sink = k.apiKey
    ? new KeewanoSink(new KeewanoIngestClient({ apiKey: k.apiKey, baseUrl: k.ingestUrl, eventTypes: EVENT_TYPES, eventsHash: EVENTS_HASH, timeoutMs: k.timeoutMs }), { logger })
    : null;
  let history: TransactionHistory | null = null;
  if (k.accessToken) {
    history = new KeewanoTransactionHistory(
      new KeewanoMcpClient({
        token: k.accessToken,
        url: k.mcpUrl,
        sqlTool: k.sqlTool,
        sqlArg: k.sqlArg,
        projectId: k.projectId ?? projectIdFromApiKey(k.apiKey),
        timeoutMs: k.timeoutMs,
      }),
    );
  } else if (config.mode === "simulated" && k.fixtureHistory) {
    history = new FixtureTransactionHistory();
  }
  return {
    sink,
    history,
    repository: (db) => (sink ? new MirroredCaseRepository(db, sink) : new CaseRepository(db)),
  };
}
