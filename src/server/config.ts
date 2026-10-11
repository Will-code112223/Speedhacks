import path from "node:path";
import fs from "node:fs";
import { chromium } from "playwright";
import type { Mode } from "@/contracts/case";
import type { RuntimeReadiness } from "@/contracts/browser";
import { ApiHttpError } from "@/server/http/errors";

export interface AppConfig {
  mode: Mode;
  /** Invalid or disallowed REFUND_MODE; never expose its raw value to clients. */
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
  const rawMode = str(env.REFUND_MODE) ?? "live";
  // Explicit test adapters remain available to Vitest, including its injected
  // environment objects. Ordinary dev/production servers never simulate.
  const testEnvironment = (env.NODE_ENV ?? process.env.NODE_ENV) === "test";
  const mode: Mode = rawMode === "simulated" ? "simulated" : "live";
  const invalidMode = rawMode === "live" || (rawMode === "simulated" && testEnvironment) ? null : rawMode;
  return {
    mode,
    invalidMode,
    // Runtime-owned private storage must never be traced into a deploy bundle.
    dataDir: path.resolve(/* turbopackIgnore: true */ process.cwd(), env.DATA_DIR?.trim() || "./data"),
    llm: {
      provider: (env.LLM_PROVIDER ?? "openai").trim() || "openai",
      model: str(env.LLM_MODEL),
      apiKey: str(env.OPENAI_API_KEY),
      baseUrl: (str(env.OPENAI_BASE_URL) ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
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
  };
}

/** Live mode must fail visibly, never fall back to simulation. */
export function assertModeValid(cfg: AppConfig): void {
  if (cfg.invalidMode !== null) {
    throw new ApiHttpError(
      503,
      "LIVE_CONFIGURATION_MISSING",
      'REFUND_MODE must be "live"; "simulated" is supported only with NODE_ENV=test',
      ["REFUND_MODE"],
    );
  }
}

export function assertLiveLlmConfig(cfg: AppConfig): void {
  if (cfg.mode !== "live") return;
  const missing = liveLlmMissingConfig(cfg);
  if (missing.length > 0) {
    throw new ApiHttpError(
      503,
      "LIVE_CONFIGURATION_MISSING",
      `Live extraction requires valid ${missing.join(", ")}; no fallback to simulation`,
      missing,
    );
  }
}

function bearerToken(value: string | null): boolean {
  return value !== null && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value);
}

/** Fixed environment names only; configured is not proof of account access. */
export function liveLlmMissingConfig(cfg: AppConfig): string[] {
  const missing: string[] = [];
  if (cfg.llm.provider !== "openai") missing.push("LLM_PROVIDER");
  if (!cfg.llm.model) missing.push("LLM_MODEL");
  if (!bearerToken(cfg.llm.apiKey)) missing.push("OPENAI_API_KEY");
  try {
    const url = new URL(cfg.llm.baseUrl);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      missing.push("OPENAI_BASE_URL");
    }
  } catch { missing.push("OPENAI_BASE_URL"); }
  return missing;
}

export function liveDialMissingConfig(cfg: AppConfig): string[] {
  const missing: string[] = [];
  if (!bearerToken(cfg.dial.apiKey)) missing.push("DIAL_API_KEY");
  // Dial accepts an account-owned number ID, E.164 number, or nickname.
  if (!cfg.dial.fromNumber || cfg.dial.fromNumber.length > 256 || /[\x00-\x1f\x7f]/.test(cfg.dial.fromNumber)) {
    missing.push("DIAL_FROM_NUMBER");
  }
  if (cfg.dial.maxCallDurationInvalid !== null) missing.push("DIAL_MAX_CALL_DURATION_SECONDS");
  return missing;
}

/** Read-only configuration check: no provider request, account probe or launch. */
export function getRuntimeReadiness(env: EnvSource = process.env): RuntimeReadiness {
  const cfg = loadConfig(env);
  // The runtime endpoint describes the live product even when invoked by tests.
  const modeMissing = cfg.mode !== "live" || cfg.invalidMode !== null ? ["REFUND_MODE"] : [];
  const extractionMissing = [...modeMissing, ...liveLlmMissingConfig(cfg)];
  const callMissing = [...modeMissing, ...liveDialMissingConfig(cfg)];
  const browserMissing = [...extractionMissing];
  if (env.BROWSER_ENABLED?.trim() !== "true") browserMissing.push("BROWSER_ENABLED");
  const configuredPath = str(env.BROWSER_EXECUTABLE_PATH);
  try {
    if (!fs.statSync(configuredPath ?? chromium.executablePath()).isFile()) {
      browserMissing.push(configuredPath ? "BROWSER_EXECUTABLE_PATH" : "PLAYWRIGHT_CHROMIUM");
    }
  } catch { browserMissing.push(configuredPath ? "BROWSER_EXECUTABLE_PATH" : "PLAYWRIGHT_CHROMIUM"); }
  return {
    mode: "live",
    extraction: { ready: extractionMissing.length === 0, missing: extractionMissing },
    calls: { ready: callMissing.length === 0, missing: callMissing },
    browser: { ready: browserMissing.length === 0, missing: browserMissing },
  };
}
