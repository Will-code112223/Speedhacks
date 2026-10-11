import { createHmac, randomBytes } from "node:crypto";
import type {
  AuthorizedCallInput,
  StartCallResult,
  VerifiedVoiceEvent,
  VoiceAdapter,
  VoiceSnapshot,
} from "@/contracts/voice";
import { createDialAdapter } from "@/integrations/dial";

/**
 * Simulated voice = teammate 3's real Dial adapter talking to a fake Dial
 * server. Explicitly labeled simulated; never used as a fallback for live
 * failures.
 *
 * The adapter runs in its live code path (request building, response
 * validation, normalizeCall, transcriptTurns parsing, signed-webhook
 * verification), so the demo exercises the same code a real call does. Only
 * the transport is fake: `fetch` is answered in-process and never reaches the
 * network. Results are relabeled `mode: "simulated"` on the way out.
 *
 * The fake server is stateless: the call lifecycle is derived from the
 * provider call id (`sim_<startMs>_<scenario>_<rand>`) and the clock, so it
 * survives dev-server reloads and works across processes.
 *
 * Scenarios are selected by the last four digits of the destination number:
 *   …0001 rejected before dispatch (HTTP 403)  …0002 dispatch_unknown (HTTP 500)
 *   …0003 completed, refund denied             …0004 completed, support needs information
 *   …0005 failed (no answer)                   …0006 cancelled
 *   anything else: completed, refund approved with a reference number
 *
 * Webhooks use Dial's documented scheme and event shape: header
 * `X-Dial-Signature: t=<unix>,v1=<hex>` where v1 = HMAC-SHA256(secret,
 * `${t}.${rawBody}`), 5-minute freshness, `X-Dial-Event-ID` and
 * `X-Dial-Event-Type` matching the body.
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

// Placeholder credentials for the fake server. They never leave the process.
const FAKE_API_KEY = "simulated-dial-key";
const FAKE_FROM_NUMBER = "+15550100000";
const FAKE_TO_NUMBER = "+15550100001";

export function scenarioFor(to: string): SimulatedScenario {
  return SCENARIO_BY_SUFFIX[to.slice(-4)] ?? "approved";
}

export function parseProviderCallId(id: string): { startMs: number; scenario: SimulatedScenario; rand: string } | null {
  const m = /^sim_(\d+)_([a-z_]+)_([a-f0-9]{8})$/.exec(id);
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  return { startMs: Number.parseInt(m[1], 10), scenario: m[2] as SimulatedScenario, rand: m[3] };
}

type Turn = { speaker: "agent" | "user"; text: string };

/** Dial labels our AI as `agent` and the person who answers (support) as `user`. */
function turnsFor(scenario: SimulatedScenario, rand: string): Turn[] {
  const ref = `REF-${rand.slice(0, 6).toUpperCase()}`;
  const opening: Turn = { speaker: "agent", text: "Hi, I'm an AI assistant calling on behalf of a customer about a duplicate charge, and I'd like to request a refund." };
  switch (scenario) {
    case "denied":
      return [
        opening,
        { speaker: "user", text: "I see two charges, but the second one is for a separate order, so I cannot refund it." },
        { speaker: "agent", text: "Understood. Could you note the dispute on the account?" },
        { speaker: "user", text: "I've added a note. There is nothing further we can do here." },
      ];
    case "needs_info":
      return [
        opening,
        { speaker: "user", text: "I can look into that, but I need the order number and the last four digits of the card." },
        { speaker: "agent", text: "I don't have that information available on this call." },
        { speaker: "user", text: "Please call back with the order number so we can locate the charge." },
      ];
    case "approved":
    default:
      return [
        opening,
        { speaker: "user", text: "Thanks, I can see the duplicate transaction on the account." },
        { speaker: "user", text: "I've processed the refund for the duplicate charge. It should post in 5 to 7 business days." },
        { speaker: "user", text: `Your reference number is ${ref}.` },
        { speaker: "agent", text: "Thank you, I've noted the reference number." },
      ];
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** In-process stand-in for Dial's REST API (`POST /calls`, `GET /calls/:id`). */
function createFakeDialFetch(opts: Required<SimulatedVoiceOptions>): typeof globalThis.fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${FAKE_API_KEY}`) {
      return json(401, { code: "unauthorized" });
    }

    if (method === "POST" && url.pathname.endsWith("/calls")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string };
      const scenario = scenarioFor(body.to ?? "");
      if (scenario === "rejected") return json(403, { code: "forbidden", message: "Simulated refusal (destination ends in 0001)." });
      // A 5xx after the request may have reached Dial: the adapter must report dispatch_unknown.
      if (scenario === "dispatch_unknown") return json(500, { code: "internal_error" });
      const id = `sim_${opts.now()}_${scenario}_${randomBytes(4).toString("hex")}`;
      return json(200, { call: { id } });
    }

    const match = /\/calls\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && match?.[1]) {
      const id = decodeURIComponent(match[1]);
      const parsed = parseProviderCallId(id);
      if (!parsed) return json(404, { code: "not_found" });
      const elapsed = opts.now() - parsed.startMs;
      const call = { id, duration: null as number | null, transcript: null, transcriptTurns: null as unknown };
      if (elapsed < opts.queuedMs) return json(200, { call: { ...call, status: { state: "Queued" } } });
      if (elapsed < opts.queuedMs + opts.inProgressMs) return json(200, { call: { ...call, status: { state: "In-Progress" } } });
      if (parsed.scenario === "failed") return json(200, { call: { ...call, duration: 0, status: { state: "Terminated", terminationType: "no-answer" } } });
      if (parsed.scenario === "cancelled") return json(200, { call: { ...call, duration: 0, status: { state: "Terminated", terminationType: "canceled" } } });
      const durationSeconds = Math.max(1, Math.round(opts.inProgressMs / 1000));
      let startMs = 0;
      const transcriptTurns = turnsFor(parsed.scenario, parsed.rand).map((turn) => {
        const t = { ...turn, startMs, endMs: startMs + 3000 };
        startMs += 3500;
        return t;
      });
      return json(200, { call: { ...call, duration: durationSeconds, transcriptTurns, status: { state: "Terminated", terminationType: "completed" } } });
    }

    return json(404, { code: "not_found" });
  };
}

export function createSimulatedVoiceAdapter(opts: SimulatedVoiceOptions): VoiceAdapter {
  const now = opts.now ?? (() => Date.now());
  // The adapter and the fake server share one clock, so call progress and
  // webhook freshness agree under test clocks.
  const dial = createDialAdapter(
    { mode: "live" },
    {
      fetch: createFakeDialFetch({ ...opts, now }),
      now,
      config: { apiKey: FAKE_API_KEY, fromNumber: FAKE_FROM_NUMBER, webhookSecret: opts.webhookSecret, maxCallDurationSeconds: 300 },
    },
  );
  return {
    async startCall(input: AuthorizedCallInput): Promise<StartCallResult> {
      return { ...(await dial.startCall(input)), mode: "simulated" };
    },
    async getCall(providerCallId: string): Promise<VoiceSnapshot> {
      return { ...(await dial.getCall(providerCallId)), mode: "simulated" };
    },
    verifyWebhook(rawBody: Uint8Array, headers: Headers): Promise<VerifiedVoiceEvent | null> {
      return dial.verifyWebhook(rawBody, headers);
    },
  };
}

export function signSimulatedPayload(secret: string, timestamp: string, rawBody: Uint8Array): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(Buffer.from(rawBody))
    .digest("hex");
}

/** Test/dev helper: a signed Dial-shaped webhook (default `call.ended`) for the given provider call id. */
export function buildSimulatedWebhook(
  secret: string,
  providerCallId: string,
  options: { eventId?: string; type?: string; timestampSeconds?: number } = {},
): { body: Uint8Array<ArrayBuffer>; headers: Headers } {
  const eventId = options.eventId ?? `evt_${randomBytes(8).toString("hex")}`;
  const type = options.type ?? "call.ended";
  const timestampSeconds = options.timestampSeconds ?? Math.floor(Date.now() / 1000);
  const scenario = parseProviderCallId(providerCallId)?.scenario;
  const status = scenario === "failed" ? "no-answer" : scenario === "cancelled" ? "canceled" : "completed";
  const event = {
    id: eventId,
    object: "event",
    version: 1,
    type,
    createdAt: new Date(timestampSeconds * 1000).toISOString(),
    data: {
      callId: providerCallId,
      from: FAKE_FROM_NUMBER,
      to: FAKE_TO_NUMBER,
      direction: "outbound",
      durationSeconds: status === "completed" ? 2 : 0,
      status,
      canceled: status === "canceled",
      transcriptAvailable: status === "completed",
      failureReason: null,
    },
    relatedObject: { type: "call", id: providerCallId },
  };
  const body = new TextEncoder().encode(JSON.stringify(event));
  const t = String(timestampSeconds);
  const headers = new Headers({
    "content-type": "application/json",
    "x-dial-event-id": eventId,
    "x-dial-event-type": type,
    "x-dial-signature": `t=${t},v1=${signSimulatedPayload(secret, t, body)}`,
  });
  return { body, headers };
}
