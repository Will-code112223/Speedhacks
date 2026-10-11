import type { Mode } from "@/contracts/case";
import type { VoiceAdapter } from "@/contracts/voice";
import { createDialAdapter, type DialDependencies } from "@/integrations/dial";
import { createKeewano } from "@/integrations/keewano";
import { CaseService } from "@/server/cases/service";
import { createSimulatedVoiceAdapter } from "@/server/cases/simulated-voice";
import { type AppConfig, loadConfig } from "@/server/config";
import { type Extractor, HeuristicExtractor, OpenAIExtractor } from "@/server/documents/extractor";
import { UploadStore } from "@/server/documents/storage";
import { ApiHttpError } from "@/server/http/errors";
import { openDatabase } from "@/server/persistence/db";

/**
 * Composition root. Live voice is teammate 3's Dial adapter (src/integrations/dial,
 * handoff in docs/handoffs/dial.txt); simulated mode uses T2's own adapter so the
 * demo never depends on provider credentials.
 */
const liveVoiceFactory: ((opts: { mode: Mode }, deps?: DialDependencies) => VoiceAdapter) | null = createDialAdapter;

/** Test seam: inject the adapter's transport/clock without touching the composition logic. */
export interface CompositionOverrides {
  dialDependencies?: Omit<DialDependencies, "config">;
}

function buildExtractor(config: AppConfig): Extractor {
  if (config.mode === "live" && config.llm.model && config.llm.apiKey) {
    return new OpenAIExtractor({ model: config.llm.model, apiKey: config.llm.apiKey, baseUrl: config.llm.baseUrl });
  }
  // In live mode without LLM config, createCase fails visibly before this is used.
  return new HeuristicExtractor();
}

function buildVoiceResolver(config: AppConfig, overrides: CompositionOverrides = {}): () => VoiceAdapter {
  let simulated: VoiceAdapter | null = null;
  let live: VoiceAdapter | null = null;
  return () => {
    if (config.mode === "simulated") {
      simulated ??= createSimulatedVoiceAdapter(config.simulated);
      return simulated;
    }
    // Dispatch and provider reads need the key and sending number. The webhook signing secret is
    // only required by the webhook route (see CaseService.handleWebhook), so a live call can be
    // placed and reconciled by polling before a receiver/subscription exists.
    const missing: string[] = [];
    if (!config.dial.apiKey) missing.push("DIAL_API_KEY");
    if (!config.dial.fromNumber) missing.push("DIAL_FROM_NUMBER");
    if (missing.length > 0) {
      throw new ApiHttpError(503, "LIVE_CONFIGURATION_MISSING", `Live voice requires ${missing.join(", ")}`, missing);
    }
    if (config.dial.maxCallDurationInvalid !== null) {
      throw new ApiHttpError(
        503,
        "LIVE_CONFIGURATION_MISSING",
        `DIAL_MAX_CALL_DURATION_SECONDS must be an integer from 60 to 3600 (got "${config.dial.maxCallDurationInvalid}")`,
        ["DIAL_MAX_CALL_DURATION_SECONDS"],
      );
    }
    if (!liveVoiceFactory) {
      throw new ApiHttpError(503, "LIVE_CONFIGURATION_MISSING", "Live voice adapter is not wired yet (teammate 3 handoff pending)");
    }
    try {
      // The adapter dispatches with exactly the values validated here; it never reads process.env on its own.
      live ??= liveVoiceFactory(
        { mode: "live" },
        {
          ...overrides.dialDependencies,
          config: {
            apiKey: config.dial.apiKey as string,
            fromNumber: config.dial.fromNumber as string,
            webhookSecret: config.dial.webhookSecret ?? undefined,
            maxCallDurationSeconds: config.dial.maxCallDurationSeconds,
          },
        },
      );
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

export function buildCaseService(config: AppConfig = loadConfig(), overrides: CompositionOverrides = {}): CaseService {
  const db = openDatabase(config.dataDir);
  // Keewano (optional): mirrors cases as they change, answers the pre-authorization history check
  // and the merchant track record (GET /api/insights/merchant).
  const keewano = createKeewano(config);
  return new CaseService({
    config,
    repo: keewano.repository(db),
    history: keewano.history,
    insights: keewano.insights,
    uploads: new UploadStore(config.dataDir),
    extractor: buildExtractor(config),
    voice: buildVoiceResolver(config, overrides),
  });
}

type Cache = { key: string; service: CaseService };
const globalCache = globalThis as unknown as { __refundService?: Cache };

/** Process-wide service; survives Next dev reloads via globalThis. */
export function getCaseService(): CaseService {
  const config = loadConfig();
  const key = `${config.mode}|${config.dataDir}`;
  const cached = globalCache.__refundService;
  // A dev reload re-evaluates CaseService; an instance of the previous class would lack new methods.
  if (cached && cached.key === key && cached.service instanceof CaseService) return cached.service;
  const service = buildCaseService(config);
  globalCache.__refundService = { key, service };
  return service;
}
