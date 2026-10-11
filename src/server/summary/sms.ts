import { randomBytes } from "node:crypto";
import type { AppConfig } from "@/server/config";
import { ApiHttpError } from "@/server/http/errors";
import type { FetchTransport } from "@/server/summary/llm";

/**
 * Text messages through Dial (POST /api/v1/messages, same account and sending
 * number as the voice calls). Simulated mode never touches the network.
 */

export const DIAL_MESSAGES_URL = "https://api.getdial.ai/api/v1/messages";
const TIMEOUT_MS = 20_000;

export interface SmsResult {
  providerMessageId: string | null;
  sentAt: string;
}

/** Throws 503 LIVE_CONFIGURATION_MISSING when live text messages cannot be sent. */
export function assertLiveSmsConfig(config: AppConfig): void {
  if (config.mode !== "live") return;
  const missing: string[] = [];
  if (!config.dial.apiKey) missing.push("DIAL_API_KEY");
  if (!config.dial.fromNumber) missing.push("DIAL_FROM_NUMBER");
  if (missing.length > 0) {
    throw new ApiHttpError(503, "LIVE_CONFIGURATION_MISSING", `Text summaries require ${missing.join(", ")}`, missing);
  }
}

function messageId(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (typeof record.id === "string") return record.id;
  for (const key of ["message", "data"]) {
    const inner = record[key];
    if (typeof inner === "object" && inner !== null && typeof (inner as Record<string, unknown>).id === "string") {
      return (inner as Record<string, string>).id ?? null;
    }
  }
  return null;
}

export async function sendSmsViaDial(input: {
  config: AppConfig;
  /** E.164 destination. */
  to: string;
  body: string;
  transport?: FetchTransport;
  now?: () => Date;
}): Promise<SmsResult> {
  const { config, to, body } = input;
  const now = input.now ?? (() => new Date());
  if (config.mode === "simulated") {
    return { providerMessageId: `sim_msg_${randomBytes(6).toString("hex")}`, sentAt: now().toISOString() };
  }
  assertLiveSmsConfig(config);
  const transport = input.transport ?? globalThis.fetch;
  let response: Response;
  try {
    response = await transport(DIAL_MESSAGES_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${config.dial.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ to, channel: "sms", fromNumber: config.dial.fromNumber, body }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
  } catch (err) {
    throw new ApiHttpError(502, "PROVIDER_ERROR", `Dial could not send the text message: ${(err as Error)?.name ?? "network error"}`);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 200);
    throw new ApiHttpError(
      502,
      "PROVIDER_ERROR",
      `Dial could not send the text message: HTTP ${response.status}${detail ? ` ${detail}` : ""}`,
    );
  }
  const data = (await response.json().catch(() => null)) as unknown;
  return { providerMessageId: messageId(data), sentAt: now().toISOString() };
}
