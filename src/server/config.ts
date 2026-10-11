import path from "node:path";
import type { Mode } from "@/contracts/case";
import { ApiHttpError } from "@/server/http/errors";

export interface AppConfig {
  mode: Mode;
  /** Raw REFUND_MODE value when it is neither "simulated" nor "live" (fails visibly). */
  invalidMode: string | null;
  dataDir: string;
  llm: { provider: string; model: string | null; apiKey: string | null; baseUrl: string };
  dial: { apiKey: string | null; webhookSecret: string | null; fromNumber: string | null };
  simulated: { webhookSecret: string; queuedMs: number; inProgressMs: number };
  upload: { maxFiles: number; maxBytes: number };
  reconcile: { minIntervalMs: number; transcriptWaitMs: number };
}

function str(v: string | undefined): string | null {
  const t = (v ?? "").trim();
  return t.length > 0 ? t : null;
}

function int(v: string | undefined, fallback: number): number {
  const n = Number.parseInt((v ?? "").trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export type EnvSource = Record<string, string | undefined>;

export function loadConfig(env: EnvSource = process.env): AppConfig {
  const rawMode = (env.REFUND_MODE ?? "simulated").trim();
  const mode: Mode = rawMode === "live" ? "live" : "simulated";
  const invalidMode = rawMode === "live" || rawMode === "simulated" || rawMode === "" ? null : rawMode;
  return {
    mode,
    invalidMode,
    dataDir: path.resolve(process.cwd(), env.DATA_DIR?.trim() || "./data"),
    llm: {
      provider: (env.LLM_PROVIDER ?? "openai").trim() || "openai",
      model: str(env.LLM_MODEL),
      apiKey: str(env.OPENAI_API_KEY),
      baseUrl: (env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").trim(),
    },
    dial: {
      apiKey: str(env.DIAL_API_KEY),
      webhookSecret: str(env.DIAL_WEBHOOK_SECRET),
      fromNumber: str(env.DIAL_FROM_NUMBER),
    },
    simulated: {
      webhookSecret: str(env.SIMULATED_WEBHOOK_SECRET) ?? "simulated-webhook-secret",
      queuedMs: int(env.SIMULATED_QUEUED_MS, 2000),
      inProgressMs: int(env.SIMULATED_IN_PROGRESS_MS, 6000),
    },
    upload: { maxFiles: 5, maxBytes: 10 * 1024 * 1024 },
    reconcile: {
      minIntervalMs: int(env.RECONCILE_MIN_INTERVAL_MS, 2000),
      // Dial's call.ended arrives before the transcript; keep reading for this long before publishing without one.
      transcriptWaitMs: int(env.TRANSCRIPT_WAIT_MS, 45_000),
    },
  };
}

/** Live mode must fail visibly, never fall back to simulation. */
export function assertModeValid(cfg: AppConfig): void {
  if (cfg.invalidMode !== null) {
    throw new ApiHttpError(
      503,
      "LIVE_CONFIGURATION_MISSING",
      `REFUND_MODE must be "simulated" or "live" (got "${cfg.invalidMode}")`,
    );
  }
}

export function assertLiveLlmConfig(cfg: AppConfig): void {
  if (cfg.mode !== "live") return;
  const missing: string[] = [];
  if (!cfg.llm.model) missing.push("LLM_MODEL");
  if (!cfg.llm.apiKey) missing.push("OPENAI_API_KEY");
  if (missing.length > 0) {
    throw new ApiHttpError(
      503,
      "LIVE_CONFIGURATION_MISSING",
      `Live mode requires ${missing.join(", ")}; no fallback to simulation`,
      missing,
    );
  }
}
