import path from "node:path";
import type { Mode } from "@/contracts/case";
import { ApiHttpError } from "@/server/http/errors";

export interface AppConfig {
  mode: Mode;
  /** Raw REFUND_MODE value when it is neither "simulated" nor "live" (fails visibly). */
  invalidMode: string | null;
  dataDir: string;
  llm: { provider: string; model: string | null; apiKey: string | null; baseUrl: string };
  dial: {
    apiKey: string | null;
    webhookSecret: string | null;
    fromNumber: string | null;
    /** Validated 60..3600; absent or blank defaults to 300. */
    maxCallDurationSeconds: number;
    /** Raw DIAL_MAX_CALL_DURATION_SECONDS when it is set but invalid (fails visibly). */
    maxCallDurationInvalid: string | null;
  };
  simulated: { webhookSecret: string; queuedMs: number; inProgressMs: number };
  upload: { maxFiles: number; maxBytes: number };
  reconcile: {
    minIntervalMs: number;
    transcriptWaitMs: number;
    /** After a completed call was published without a transcript, re-read the provider at most this often. */
    lateTranscriptIntervalMs: number;
    /** Stop looking for a late transcript this long after the attempt was created. */
    lateTranscriptWindowMs: number;
  };
  /** Optional Keewano sponsor integration (src/integrations/keewano). Nothing is required. */
  keewano: {
    apiKey: string | null;
    accessToken: string | null;
    ingestUrl: string;
    mcpUrl: string;
    sqlTool: string | null;
    sqlArg: string | null;
    /** Explicit project UUID; otherwise read from the API key, else discovered via list_projects. */
    projectId: string | null;
    historyWindowMinutes: number;
    timeoutMs: number;
    retryMs: number;
    fixtureHistory: boolean;
  };
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

function parseDuration(raw: string | undefined): { maxCallDurationSeconds: number; maxCallDurationInvalid: string | null } {
  const t = (raw ?? "").trim();
  if (t === "") return { maxCallDurationSeconds: 300, maxCallDurationInvalid: null };
  const n = /^\d+$/.test(t) ? Number.parseInt(t, 10) : Number.NaN;
  if (Number.isInteger(n) && n >= 60 && n <= 3600) return { maxCallDurationSeconds: n, maxCallDurationInvalid: null };
  return { maxCallDurationSeconds: 300, maxCallDurationInvalid: t };
}

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
      ...parseDuration(env.DIAL_MAX_CALL_DURATION_SECONDS),
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
      lateTranscriptIntervalMs: int(env.LATE_TRANSCRIPT_INTERVAL_MS, 30_000),
      lateTranscriptWindowMs: int(env.LATE_TRANSCRIPT_WINDOW_MS, 24 * 60 * 60 * 1000),
    },
    keewano: {
      apiKey: str(env.KEEWANO_API_KEY),
      accessToken: str(env.KEEWANO_ACCESS_TOKEN),
      ingestUrl: str(env.KEEWANO_INGEST_URL) ?? "https://api.keewano.com/event/ingress/v1/json",
      mcpUrl: str(env.KEEWANO_MCP_URL) ?? "https://api.keewano.com/mcp",
      sqlTool: str(env.KEEWANO_SQL_TOOL),
      sqlArg: str(env.KEEWANO_SQL_ARG),
      projectId: str(env.KEEWANO_PROJECT_ID),
      historyWindowMinutes: int(env.KEEWANO_HISTORY_WINDOW_MINUTES, 24 * 60) || 24 * 60,
      timeoutMs: int(env.KEEWANO_TIMEOUT_MS, 6000) || 6000,
      retryMs: int(env.KEEWANO_RETRY_MS, 30_000),
      // In simulated mode without a token the check reads the labeled local fixture.
      fixtureHistory: (env.KEEWANO_FIXTURE_HISTORY ?? "").trim().toLowerCase() !== "off",
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
