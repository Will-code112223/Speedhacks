import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  AuthorizedCallInput,
  StartCallResult,
  VerifiedVoiceEvent,
  VoiceAdapter,
  VoiceSnapshot,
} from "@/contracts/voice";
import { VoiceWebhookError } from "@/contracts/voice";

/**
 * Teammate 2's simulated voice adapter for early integration. Explicitly
 * labeled simulated; never used as a fallback for live failures.
 *
 * It is stateless: the call lifecycle is derived from the provider call id
 * (`sim_<startMs>_<scenario>_<rand>`) and the clock, so it survives dev-server
 * reloads and works across processes.
 *
 * Scenarios are selected by the last four digits of the destination number:
 *   …0001 rejected before dispatch     …0002 dispatch_unknown (no provider id)
 *   …0003 completed, refund denied     …0004 completed, support needs information
 *   …0005 failed (no answer)           …0006 cancelled
 *   anything else: completed, refund approved with a reference number
 *
 * Webhook verification mirrors Dial's documented scheme so the real route and
 * deduplication path are exercised: header `X-Dial-Signature: t=<unix>,v1=<hex>`
 * where v1 = HMAC-SHA256(secret, `${t}.${rawBody}`), 5-minute freshness,
 * `X-Dial-Event-ID` for the event id, `X-Dial-Event-Type` for the type.
 */
export type SimulatedScenario = "approved" | "rejected" | "dispatch_unknown" | "denied" | "needs_info" | "failed" | "cancelled";

export interface SimulatedVoiceOptions {
  webhookSecret: string;
  queuedMs: number;
  inProgressMs: number;
  now?: () => number;
}

const SCENARIO_BY_SUFFIX: Record<string, SimulatedScenario> = {
  "0001": "rejected",
  "0002": "dispatch_unknown",
  "0003": "denied",
  "0004": "needs_info",
  "0005": "failed",
  "0006": "cancelled",
};

export function scenarioFor(to: string): SimulatedScenario {
  return SCENARIO_BY_SUFFIX[to.slice(-4)] ?? "approved";
}

export function parseProviderCallId(id: string): { startMs: number; scenario: SimulatedScenario; rand: string } | null {
  const m = /^sim_(\d+)_([a-z_]+)_([a-f0-9]{8})$/.exec(id);
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  return { startMs: Number.parseInt(m[1], 10), scenario: m[2] as SimulatedScenario, rand: m[3] };
}

function transcriptFor(scenario: SimulatedScenario, rand: string): string {
  const ref = `REF-${rand.slice(0, 6).toUpperCase()}`;
  switch (scenario) {
    case "denied":
      return [
        "Agent: Hi, I'm calling on behalf of a customer about a duplicate charge and would like to request a refund.",
        "Support: I see two charges, but the second one is for a separate order, so I cannot refund it.",
        "Agent: Understood. Could you note the dispute on the account?",
        "Support: I've added a note. There is nothing further we can do here.",
      ].join("\n");
    case "needs_info":
      return [
        "Agent: Hi, I'm calling on behalf of a customer about a duplicate charge and would like to request a refund.",
        "Support: I can look into that, but I need the order number and the last four digits of the card.",
        "Agent: I don't have that information available on this call.",
        "Support: Please call back with the order number so we can locate the charge.",
      ].join("\n");
    case "approved":
    default:
      return [
        "Agent: Hi, I'm calling on behalf of a customer about a duplicate charge and would like to request a refund.",
        "Support: Thanks, I can see the duplicate transaction on the account.",
        "Support: I've processed the refund for the duplicate charge. It should post in 5 to 7 business days.",
        `Support: Your reference number is ${ref}.`,
        "Agent: Thank you, I've noted the reference number.",
      ].join("\n");
  }
}

export function createSimulatedVoiceAdapter(opts: SimulatedVoiceOptions): VoiceAdapter {
  const now = opts.now ?? (() => Date.now());
  return {
    async startCall(input: AuthorizedCallInput): Promise<StartCallResult> {
      const scenario = scenarioFor(input.to);
      if (scenario === "rejected") {
        return {
          state: "rejected",
          mode: "simulated",
          code: "SIM_REJECTED",
          message: "Simulated provider rejected the call before dispatch (destination ends in 0001).",
        };
      }
      if (scenario === "dispatch_unknown") {
        return {
          state: "dispatch_unknown",
          mode: "simulated",
          message: "Simulated timeout after the request may have reached the provider (destination ends in 0002).",
        };
      }
      const rand = randomBytes(4).toString("hex");
      return { state: "accepted", mode: "simulated", providerCallId: `sim_${now()}_${scenario}_${rand}` };
    },

    async getCall(providerCallId: string): Promise<VoiceSnapshot> {
      const parsed = parseProviderCallId(providerCallId);
      if (!parsed) throw new Error(`Unknown simulated call id: ${providerCallId}`);
      const elapsed = now() - parsed.startMs;
      const base = { providerCallId, mode: "simulated" as const, transcript: null, durationSeconds: null };
      if (elapsed < opts.queuedMs) return { ...base, state: "queued" };
      if (elapsed < opts.queuedMs + opts.inProgressMs) return { ...base, state: "in_progress" };
      const durationSeconds = Math.max(1, Math.round(opts.inProgressMs / 1000));
      if (parsed.scenario === "failed") return { ...base, state: "failed", durationSeconds: 0 };
      if (parsed.scenario === "cancelled") return { ...base, state: "cancelled", durationSeconds: 0 };
      return { ...base, state: "completed", transcript: transcriptFor(parsed.scenario, parsed.rand), durationSeconds };
    },

    async verifyWebhook(rawBody: Uint8Array, headers: Headers): Promise<VerifiedVoiceEvent | null> {
      const signature = headers.get("x-dial-signature");
      if (!signature) throw new VoiceWebhookError("Missing X-Dial-Signature header");
      const parts = Object.fromEntries(
        signature.split(",").map((kv) => {
          const [k, ...rest] = kv.trim().split("=");
          return [k ?? "", rest.join("=")];
        }),
      ) as Record<string, string>;
      const t = parts.t;
      const v1 = parts.v1;
      if (!t || !v1 || !/^\d+$/.test(t)) throw new VoiceWebhookError("Malformed X-Dial-Signature header");
      const ageSeconds = Math.abs(Math.floor(now() / 1000) - Number.parseInt(t, 10));
      if (ageSeconds > 5 * 60) throw new VoiceWebhookError("Webhook timestamp outside the 5 minute tolerance");
      const expected = signSimulatedPayload(opts.webhookSecret, t, rawBody);
      const a = Buffer.from(expected, "utf8");
      const b = Buffer.from(v1, "utf8");
      if (a.length !== b.length || !timingSafeEqual(a, b)) throw new VoiceWebhookError("Webhook signature mismatch");

      let body: { id?: unknown; type?: unknown; data?: { callId?: unknown; id?: unknown }; callId?: unknown };
      try {
        body = JSON.parse(Buffer.from(rawBody).toString("utf8")) as typeof body;
      } catch {
        throw new VoiceWebhookError("Webhook body is not valid JSON");
      }
      const eventId = headers.get("x-dial-event-id") ?? (typeof body.id === "string" ? body.id : null);
      const type = headers.get("x-dial-event-type") ?? (typeof body.type === "string" ? body.type : null);
      if (!eventId || !type) throw new VoiceWebhookError("Webhook event is missing id or type");
      if (type !== "call.ended") return null; // authenticated but irrelevant (e.g. webhook.ping)
      const callId = body.data?.callId ?? body.data?.id ?? body.callId;
      if (typeof callId !== "string" || callId.length === 0) throw new VoiceWebhookError("call.ended event has no call id");
      return { eventId, providerCallId: callId, type: "call.ended" };
    },
  };
}

export function signSimulatedPayload(secret: string, timestamp: string, rawBody: Uint8Array): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(Buffer.from(rawBody))
    .digest("hex");
}

/** Test/dev helper: a signed simulated call.ended webhook for the given provider call id. */
export function buildSimulatedWebhook(
  secret: string,
  providerCallId: string,
  options: { eventId?: string; type?: string; timestampSeconds?: number } = {},
): { body: Uint8Array<ArrayBuffer>; headers: Headers } {
  const eventId = options.eventId ?? `evt_${randomBytes(8).toString("hex")}`;
  const type = options.type ?? "call.ended";
  const body = new TextEncoder().encode(JSON.stringify({ id: eventId, type, data: { callId: providerCallId } }));
  const t = String(options.timestampSeconds ?? Math.floor(Date.now() / 1000));
  const headers = new Headers({
    "content-type": "application/json",
    "x-dial-event-id": eventId,
    "x-dial-event-type": type,
    "x-dial-signature": `t=${t},v1=${signSimulatedPayload(secret, t, body)}`,
  });
  return { body, headers };
}
