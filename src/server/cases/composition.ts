import type { Mode } from "@/contracts/case";
import type { VoiceAdapter } from "@/contracts/voice";
import { CaseService } from "@/server/cases/service";
import { createSimulatedVoiceAdapter } from "@/server/cases/simulated-voice";
import { type AppConfig, loadConfig } from "@/server/config";
import { type Extractor, HeuristicExtractor, OpenAIExtractor } from "@/server/documents/extractor";
import { UploadStore } from "@/server/documents/storage";
import { ApiHttpError } from "@/server/http/errors";
import { openDatabase } from "@/server/persistence/db";
import { CaseRepository } from "@/server/persistence/repository";

/**
 * Composition root. Live voice is wired here once teammate 3 hands off
 * src/integrations/dial: replace `liveVoiceFactory` with
 *   import { createDialAdapter } from "@/integrations/dial";
 *   const liveVoiceFactory = createDialAdapter;
 */
const liveVoiceFactory: ((opts: { mode: Mode }) => VoiceAdapter) | null = null;

function buildExtractor(config: AppConfig): Extractor {
  if (config.mode === "live" && config.llm.model && config.llm.apiKey) {
    return new OpenAIExtractor({ model: config.llm.model, apiKey: config.llm.apiKey, baseUrl: config.llm.baseUrl });
  }
  // In live mode without LLM config, createCase fails visibly before this is used.
  return new HeuristicExtractor();
}

function buildVoiceResolver(config: AppConfig): () => VoiceAdapter {
  let simulated: VoiceAdapter | null = null;
  let live: VoiceAdapter | null = null;
  return () => {
    if (config.mode === "simulated") {
      simulated ??= createSimulatedVoiceAdapter(config.simulated);
      return simulated;
    }
    const missing: string[] = [];
    if (!config.dial.apiKey) missing.push("DIAL_API_KEY");
    if (!config.dial.fromNumber) missing.push("DIAL_FROM_NUMBER");
    if (!config.dial.webhookSecret) missing.push("DIAL_WEBHOOK_SECRET");
    if (missing.length > 0) {
      throw new ApiHttpError(503, "LIVE_CONFIGURATION_MISSING", `Live voice requires ${missing.join(", ")}`, missing);
    }
    if (!liveVoiceFactory) {
      throw new ApiHttpError(503, "LIVE_CONFIGURATION_MISSING", "Live voice adapter is not wired yet (teammate 3 handoff pending)");
    }
    try {
      live ??= liveVoiceFactory({ mode: "live" });
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      if (code === "MISSING_CONFIG" || code === "INVALID_CONFIG") {
        throw new ApiHttpError(503, "LIVE_CONFIGURATION_MISSING", String((err as Error).message));
      }
      throw err;
    }
    return live;
  };
}

export function buildCaseService(config: AppConfig = loadConfig()): CaseService {
  const db = openDatabase(config.dataDir);
  return new CaseService({
    config,
    repo: new CaseRepository(db),
    uploads: new UploadStore(config.dataDir),
    extractor: buildExtractor(config),
    voice: buildVoiceResolver(config),
  });
}

type Cache = { key: string; service: CaseService };
const globalCache = globalThis as unknown as { __refundService?: Cache };

/** Process-wide service; survives Next dev reloads via globalThis. */
export function getCaseService(): CaseService {
  const config = loadConfig();
  const key = `${config.mode}|${config.dataDir}`;
  const cached = globalCache.__refundService;
  if (cached && cached.key === key) return cached.service;
  const service = buildCaseService(config);
  globalCache.__refundService = { key, service };
  return service;
}
