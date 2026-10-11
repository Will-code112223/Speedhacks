import { afterEach, describe, expect, it } from "vitest";
import { ApiHttpError } from "@/server/http/errors";
import { composeSummaryLines, messageBody, normalizeSmsNumber, SMS_BODY_LIMIT, SMS_CUT_NOTICE } from "@/server/summary/compose";
import type { FetchTransport } from "@/server/summary/llm";
import { SESSION_A, SESSION_B, authorizeAndCall, createReadyCase, makeHarness, type Harness } from "./helpers";

/** POST /api/cases/:id/summary through the service. No test ever reaches Dial or an LLM. */
let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

const LIVE_ENV = {
  LLM_MODEL: "configured-by-user",
  OPENAI_API_KEY: "synthetic-llm-key",
  OPENAI_BASE_URL: "http://llm.invalid/v1",
  DIAL_API_KEY: "synthetic-dial-key",
  DIAL_FROM_NUMBER: "+12025550100",
};

const expectApi = async (p: Promise<unknown>, status: number, code: string): Promise<ApiHttpError> => {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiHttpError);
    const e = err as ApiHttpError;
    expect([e.status, e.code]).toEqual([status, code]);
    return e;
  }
  throw new Error(`expected ${status} ${code}`);
};

interface Recorded {
  url: string;
  init: RequestInit;
}

function recorder(respond: (url: string, init: RequestInit) => Response | Promise<Response>): { calls: Recorded[]; transport: FetchTransport } {
  const calls: Recorded[] = [];
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    return respond(url, init ?? {});
  }) as FetchTransport;
  return { calls, transport };
}

async function completedCase(harness: Harness) {
  const c = await createReadyCase(harness);
  await authorizeAndCall(harness, c);
  harness.clock.advance(3500);
  const cs = await harness.service.getCase(SESSION_A, c.id);
  expect(cs.calls[0]?.state).toBe("completed");
  expect(cs.calls[0]?.transcript).toBeTruthy();
  return cs;
}

describe("post-call summary (simulated)", () => {
  it("is 409 CALL_NOT_COMPLETE until the newest call completes with a transcript, and 404 for another session", async () => {
    h = makeHarness();
    const c = await createReadyCase(h);
    await expectApi(h.service.sendSummary(SESSION_A, c.id, { channel: "sms", to: "415 555 0199" }), 409, "CALL_NOT_COMPLETE");
    await authorizeAndCall(h, c);
    const e = await expectApi(h.service.sendSummary(SESSION_A, c.id, { channel: "sms", to: "415 555 0199" }), 409, "CALL_NOT_COMPLETE");
    expect(e.message).toBe("The call has not finished yet.");
    await expectApi(h.service.sendSummary(SESSION_B, c.id, { channel: "sms", to: "415 555 0199" }), 404, "NOT_FOUND");
  });

  it("rejects a bad destination with fields [\"to\"] and an unknown channel with fields [\"channel\"]", async () => {
    h = makeHarness();
    const cs = await completedCase(h);
    let e = await expectApi(h.service.sendSummary(SESSION_A, cs.id, { channel: "sms", to: "not a number" }), 400, "BAD_REQUEST");
    expect(e.fields).toEqual(["to"]);
    e = await expectApi(h.service.sendSummary(SESSION_A, cs.id, { channel: "sms", to: "sam@example.com" }), 400, "BAD_REQUEST");
    expect(e.fields).toEqual(["to"]);
    e = await expectApi(h.service.sendSummary(SESSION_A, cs.id, { channel: "email", to: "415 555 0199" }), 400, "BAD_REQUEST");
    expect(e.fields).toEqual(["to"]);
    e = await expectApi(h.service.sendSummary(SESSION_A, cs.id, { channel: "fax", to: "415 555 0199" }), 400, "BAD_REQUEST");
    expect(e.fields).toEqual(["channel"]);
  });

  it("sends a text message once: sentAt, outcome lines, a masked summary_sent entry, and an idempotent repeat", async () => {
    h = makeHarness();
    const cs = await completedCase(h);
    const delivery = await h.service.sendSummary(SESSION_A, cs.id, { channel: "sms", to: "(415) 555-0199" });
    expect(delivery.channel).toBe("sms");
    expect(delivery.to).toBe("+14155550199");
    expect(delivery.subject).toBeNull();
    expect(delivery.sentAt).toBe("2026-10-11T20:00:03.500Z");
    expect(delivery.transcript).toBe(cs.calls[0]?.transcript);
    expect(delivery.summary.length).toBeGreaterThanOrEqual(3);
    expect(delivery.summary.length).toBeLessThanOrEqual(5);
    expect(delivery.summary[0]).toBe("Acme Streaming approved the $49.99 refund on the call.");
    expect(delivery.summary.some((l) => /^Reference number: REF-[A-F0-9]{6}\.$/.test(l))).toBe(true);
    expect(delivery.summary.at(-1)).toBe("The call with Acme Streaming lasted 2 seconds.");
    for (const line of delivery.summary) expect(line).not.toMatch(/\u2014/);

    let after = await h.service.getCase(SESSION_A, cs.id);
    const sent = after.timeline.filter((t) => t.type === "summary_sent");
    expect(sent.map((t) => t.message)).toEqual(["Summary sent by text message to +1 415 555 ••99."]);

    h.clock.advance(60_000);
    const repeat = await h.service.sendSummary(SESSION_A, cs.id, { channel: "sms", to: "+1 415.555.0199" });
    expect(repeat).toEqual(delivery);
    after = await h.service.getCase(SESSION_A, cs.id);
    expect(after.timeline.filter((t) => t.type === "summary_sent")).toHaveLength(1);
  });

  it("composes an email with a subject and sentAt null, recorded as summary_composed", async () => {
    h = makeHarness();
    const cs = await completedCase(h);
    const delivery = await h.service.sendSummary(SESSION_A, cs.id, { channel: "email", to: "sam@example.com" });
    expect(delivery.sentAt).toBeNull();
    expect(delivery.subject).toBe("Recourse: your call with Acme Streaming");
    expect(delivery.to).toBe("sam@example.com");
    const after = await h.service.getCase(SESSION_A, cs.id);
    const composed = after.timeline.filter((t) => t.type === "summary_composed");
    expect(composed).toHaveLength(1);
    expect(composed[0]?.message).toContain("s••@example.com");
    expect(after.timeline.some((t) => t.type === "summary_sent")).toBe(false);
  });
});

describe("post-call summary (live, injected transports)", () => {
  it("posts one Dial message with the LLM lines and the transcript", async () => {
    const llm = recorder(() =>
      Response.json({
        output_text: JSON.stringify({
          lines: [
            "We asked Acme Streaming to refund a duplicate charge.",
            "Support said the refund was processed.",
            "The $49.99 refund should post in 5 to 7 business days.",
          ],
        }),
      }),
    );
    const dial = recorder(() => Response.json({ message: { id: "msg_123" } }, { status: 201 }));
    h = makeHarness({ mode: "live", env: LIVE_ENV, summary: { llmTransport: llm.transport, smsTransport: dial.transport } });
    const cs = await completedCase(h);
    const delivery = await h.service.sendSummary(SESSION_A, cs.id, { channel: "sms", to: "415 555 0199" });

    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.url).toBe("http://llm.invalid/v1/responses");
    expect(dial.calls).toHaveLength(1);
    const req = dial.calls[0]!;
    expect(req.url).toBe("https://api.getdial.ai/api/v1/messages");
    expect(req.init.method).toBe("POST");
    expect(new Headers(req.init.headers).get("authorization")).toBe("Bearer synthetic-dial-key");
    const sent = JSON.parse(String(req.init.body)) as { to: string; channel: string; fromNumber: string; body: string };
    expect(sent.channel).toBe("sms");
    expect(sent.to).toBe("+14155550199");
    expect(sent.fromNumber).toBe("+12025550100");
    expect(sent.body).toContain("Support said the refund was processed.");
    expect(sent.body).toContain("Transcript:");
    expect(sent.body).toContain(cs.calls[0]!.transcript!.split("\n")[0]!);
    expect(delivery.summary).toEqual([
      "We asked Acme Streaming to refund a duplicate charge.",
      "Support said the refund was processed.",
      "The $49.99 refund should post in 5 to 7 business days.",
    ]);
    expect(delivery.sentAt).not.toBeNull();

    await h.service.sendSummary(SESSION_A, cs.id, { channel: "sms", to: "4155550199" });
    expect(dial.calls).toHaveLength(1);
  });

  it("falls back to the composed lines when the LLM fails, and still sends", async () => {
    const llm = recorder(() => new Response("upstream error", { status: 500 }));
    const dial = recorder(() => Response.json({ message: { id: "msg_456" } }, { status: 201 }));
    h = makeHarness({ mode: "live", env: LIVE_ENV, summary: { llmTransport: llm.transport, smsTransport: dial.transport } });
    const cs = await completedCase(h);
    const delivery = await h.service.sendSummary(SESSION_A, cs.id, { channel: "sms", to: "415 555 0199" });
    expect(llm.calls).toHaveLength(1);
    expect(dial.calls).toHaveLength(1);
    expect(delivery.summary[0]).toBe("Acme Streaming approved the $49.99 refund on the call.");
    expect(JSON.parse(String(dial.calls[0]!.init.body)).body).toContain(delivery.summary[0]);
    const after = await h.service.getCase(SESSION_A, cs.id);
    const entry = after.timeline.find((t) => t.type === "summary_sent");
    expect(entry?.message).toBe(
      "Summary sent by text message to +1 415 555 ••99 (summary composed from the outcome analysis; the LLM summary was unavailable).",
    );
  });

  it("surfaces a Dial refusal as 502 PROVIDER_ERROR, records it, and stores nothing", async () => {
    const llm = recorder(() => new Response("nope", { status: 503 }));
    const dial = recorder(() => new Response('{"error":"number not sms enabled"}', { status: 400 }));
    h = makeHarness({ mode: "live", env: LIVE_ENV, summary: { llmTransport: llm.transport, smsTransport: dial.transport } });
    const cs = await completedCase(h);
    const e = await expectApi(h.service.sendSummary(SESSION_A, cs.id, { channel: "sms", to: "415 555 0199" }), 502, "PROVIDER_ERROR");
    expect(e.message).toContain("HTTP 400");
    expect(e.message).not.toContain("synthetic-dial-key");
    const after = await h.service.getCase(SESSION_A, cs.id);
    expect(after.timeline.some((t) => t.type === "summary_failed")).toBe(true);
    expect(after.timeline.some((t) => t.type === "summary_sent")).toBe(false);
  });
});

describe("summary helpers", () => {
  it("normalizes typed mobile numbers to E.164", () => {
    expect(normalizeSmsNumber("415 555 0199")).toBe("+14155550199");
    expect(normalizeSmsNumber("1 (415) 555-0199")).toBe("+14155550199");
    expect(normalizeSmsNumber("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizeSmsNumber("555-0199")).toBeNull();
    expect(normalizeSmsNumber("not a number")).toBeNull();
  });

  it("cuts a long text message at a line boundary within 1500 characters", () => {
    const transcript = Array.from({ length: 80 }, (_, i) => `Support: line ${i} of a long transcript about the refund.`).join("\n");
    const body = messageBody({ lines: ["One.", "Two.", "Three."], transcript, channel: "sms", caseTitle: "your call with Acme" });
    expect(body.length).toBeLessThanOrEqual(SMS_BODY_LIMIT);
    expect(body.endsWith(`\n${SMS_CUT_NOTICE}`)).toBe(true);
    expect(body.split("\n").at(-2)).toMatch(/^Support: line \d+ of a long transcript about the refund\.$/);
    const email = messageBody({ lines: ["One.", "Two.", "Three."], transcript, channel: "email", caseTitle: "your call with Acme" });
    expect(email).toContain("line 79");
  });

  it("composes 3 to 5 lines from the stored outcome", () => {
    const lines = composeSummaryLines(
      {
        merchant: { name: "Northwind", supportPhone: "+14155551000" },
        amountMinor: 1200,
        currency: "USD",
        outcome: { decision: "denied", referenceNumber: null, nextAction: "Dispute the charge.", paymentStatus: "unverified", supportingQuote: null },
        timeline: [{ id: "t", at: "2026-10-11T20:00:00.000Z", type: "call_completed", message: "Call completed (65s, via poll)." }],
      },
      { transcript: "Support: no.", createdAt: "2026-10-11T20:00:00.000Z", updatedAt: "2026-10-11T20:09:00.000Z" },
    );
    expect(lines).toEqual([
      "Northwind declined the $12.00 refund on the call.",
      "Next step: Dispute the charge.",
      "The call with Northwind lasted 1 minute 5 seconds.",
    ]);
    const bare = composeSummaryLines(
      {
        merchant: { name: null, supportPhone: null },
        amountMinor: null,
        currency: "USD",
        outcome: { decision: "unknown", referenceNumber: null, nextAction: null, paymentStatus: "unverified", supportingQuote: null },
        timeline: [],
      },
      { transcript: "x", createdAt: "2026-10-11T20:00:00.000Z", updatedAt: "2026-10-11T20:00:30.000Z" },
    );
    expect(bare).toEqual([
      "The outcome of the call about the requested refund is unknown.",
      "The refund payment has not been verified yet; check your statement.",
      "The call with support lasted 30 seconds.",
    ]);
  });
});
