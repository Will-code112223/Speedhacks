import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createDialAdapter, DialAdapterError } from "../index.ts";

const NOW = Date.parse("2026-10-11T19:00:00.000Z");
const WEBHOOK_SECRET = "synthetic-webhook-secret-not-a-real-secret";
const PROVIDER_ID = "call_synthetic_001";
const EVENT_ID = "evt_synthetic_001";
const INPUT = {
  attemptId: "00000000-0000-4000-8000-000000000001",
  caseId: "00000000-0000-4000-8000-000000000002",
  authorizationId: "00000000-0000-4000-8000-000000000003",
  to: "+14155550102",
  brief: "Synthetic case: request reversal of one duplicate USD 49.99 charge. Do not accept a waiver.",
};
const CONFIG = {
  apiKey: "synthetic-api-key-not-a-real-key",
  fromNumber: "+14155550101",
  webhookSecret: WEBHOOK_SECRET,
  maxCallDurationSeconds: 300,
};

type Dependencies = NonNullable<Parameters<typeof createDialAdapter>[1]>;
type CapturedRequest = { url: string; init: RequestInit | undefined };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function recordingFetch(handler: (request: CapturedRequest) => Response | Promise<Response>) {
  const calls: CapturedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = {
      url: input instanceof Request ? input.url : String(input),
      init,
    };
    calls.push(request);
    return handler(request);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function live(fetchImpl: typeof fetch, config: Partial<typeof CONFIG> = {}) {
  return createDialAdapter({ mode: "live" }, {
    config: { ...CONFIG, ...config },
    fetch: fetchImpl,
    now: () => NOW,
    readRetries: 0,
    requestTimeoutMs: 1000,
  });
}

const forbiddenFetch = (async () => {
  assert.fail("This operation must not access the network");
}) as typeof fetch;

function providerCall(overrides: Record<string, unknown> = {}) {
  return {
    call: {
      id: PROVIDER_ID,
      status: { state: "Terminated", terminationType: "completed" },
      duration: 23,
      transcript: "Support: Your request has been received. The refund has not been approved.",
      ...overrides,
    },
  };
}

function eventEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    object: "event",
    type: "call.ended",
    version: 1,
    createdAt: new Date(NOW).toISOString(),
    relatedObject: { id: PROVIDER_ID, type: "call", url: `/api/v1/calls/${PROVIDER_ID}` },
    data: endedData(),
    ...overrides,
  };
}

function endedData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    callId: PROVIDER_ID,
    from: CONFIG.fromNumber,
    to: INPUT.to,
    direction: "outbound",
    durationSeconds: 23,
    status: "completed",
    canceled: false,
    transcriptAvailable: true,
    ...overrides,
  };
}

function signedWebhook(
  body: Record<string, unknown> = eventEnvelope(),
  timestamp = Math.floor(NOW / 1000),
  secret = WEBHOOK_SECRET,
) {
  const rawBody = new TextEncoder().encode(JSON.stringify(body));
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest("hex");
  const headers = new Headers({
    "X-Dial-Signature": `t=${timestamp},v1=${signature}`,
    "X-Dial-Event-ID": String(body.id),
    "X-Dial-Event-Type": String(body.type),
  });
  return { rawBody, headers };
}

function codeIs(expected: string) {
  return (error: unknown) => {
    assert.ok(error instanceof DialAdapterError);
    assert.equal(error.code, expected);
    return true;
  };
}

test("live dispatch sends one authorized call with a stable idempotency key", async () => {
  const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ call: { id: PROVIDER_ID } }, 201));
  const result = await live(fetchImpl).startCall(INPUT);
  assert.deepEqual(result, { state: "accepted", mode: "live", providerCallId: PROVIDER_ID });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.getdial.ai/api/v1/calls");
  assert.equal(calls[0]!.init?.method, "POST");
  const headers = new Headers(calls[0]!.init?.headers);
  assert.equal(headers.get("Idempotency-Key"), INPUT.attemptId);
  assert.equal(headers.get("Authorization"), `Bearer ${CONFIG.apiKey}`);
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.fromNumber, CONFIG.fromNumber);
  assert.equal(body.to, INPUT.to);
  assert.equal(body.maxCallDurationSeconds, 300);
  assert.equal(typeof body.language, "string");
  assert.ok(body.outboundInstruction.includes(INPUT.brief));
  assert.ok(!body.outboundInstruction.includes(CONFIG.apiKey));
});

test("invalid destination and missing live credentials cannot dispatch", async (t) => {
  for (const destination of ["", "911", "not-a-number", "https://example.invalid"]) {
    await t.test(`destination ${JSON.stringify(destination)}`, async () => {
      const result = await live(forbiddenFetch).startCall({ ...INPUT, to: destination });
      assert.equal(result.state, "rejected");
      assert.equal(result.mode, "live");
    });
  }
  for (const override of [{ apiKey: "" }, { fromNumber: "" }]) {
    await t.test(`missing ${Object.keys(override)[0]}`, async () => {
      const result = await live(forbiddenFetch, override).startCall(INPUT);
      assert.equal(result.state, "rejected");
      assert.equal(result.mode, "live");
    });
  }
});

test("known provider refusals are sanitized and never retried", async (t) => {
  for (const status of [400, 401, 402, 403, 404, 429]) {
    await t.test(`HTTP ${status}`, async () => {
      const { fetchImpl, calls } = recordingFetch(() => jsonResponse({
        error: { code: "synthetic_refusal", message: `sensitive-${CONFIG.apiKey}` },
      }, status));
      const result = await live(fetchImpl).startCall(INPUT);
      assert.equal(result.state, "rejected");
      assert.equal(result.mode, "live");
      assert.equal(calls.length, 1);
      assert.ok(!JSON.stringify(result).includes(CONFIG.apiKey));
      assert.ok(!JSON.stringify(result).includes("sensitive-"));
    });
  }
});

test("calling_disabled conflict is rejected while idempotency conflict stays ambiguous", async (t) => {
  for (const [code, state] of [["calling_disabled", "rejected"], ["idempotency_conflict", "dispatch_unknown"]] as const) {
    await t.test(code, async () => {
      const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ error: "Synthetic refusal", code }, 409));
      const result = await live(fetchImpl).startCall(INPUT);
      assert.equal(result.state, state);
      assert.equal(calls.length, 1);
    });
  }
});

test("ambiguous network and server outcomes cannot redial or become simulations", async (t) => {
  const responses: [string, () => Response | Promise<Response>][] = [
    ["network loss", async () => { throw new TypeError("Synthetic connection lost"); }],
    ["aborted response", async () => { throw new DOMException("Synthetic timeout", "AbortError"); }],
    ["server error", () => jsonResponse({ error: "synthetic" }, 500)],
    ["upstream unavailable", () => jsonResponse({}, 503)],
    ["empty success", () => jsonResponse({})],
    ["invalid provider id", () => jsonResponse({ call: { id: "" } })],
    ["unparseable success", () => new Response("not JSON", { status: 200 })],
  ];
  for (const [label, response] of responses) {
    await t.test(label, async () => {
      const { fetchImpl, calls } = recordingFetch(response);
      const result = await live(fetchImpl).startCall(INPUT);
      assert.equal(result.state, "dispatch_unknown");
      assert.equal(result.mode, "live");
      assert.equal(calls.length, 1);
    });
  }
});

test("call status normalization preserves lifecycle without inventing a refund decision", async (t) => {
  const statuses = [
    ["Queued", null, "queued"],
    ["Ringing", null, "queued"],
    ["In-Progress", null, "in_progress"],
    ["Terminated", "completed", "completed"],
    ["Terminated", "canceled", "cancelled"],
    ["Terminated", "busy", "failed"],
    ["Terminated", "no-answer", "failed"],
    ["Terminated", "failed", "failed"],
  ] as const;
  for (const [state, terminationType, expected] of statuses) {
    await t.test(`${state}/${terminationType}`, async () => {
      const { fetchImpl, calls } = recordingFetch(() => jsonResponse(providerCall({ status: { state, terminationType } })));
      const snapshot = await live(fetchImpl).getCall(PROVIDER_ID);
      assert.equal(snapshot.providerCallId, PROVIDER_ID);
      assert.equal(snapshot.mode, "live");
      assert.equal(snapshot.state, expected);
      assert.equal(snapshot.durationSeconds, 23);
      assert.equal(snapshot.transcript, providerCall().call.transcript);
      assert.ok(!("decision" in snapshot));
      assert.ok(!("paymentStatus" in snapshot));
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.url, `https://api.getdial.ai/api/v1/calls/${PROVIDER_ID}`);
    });
  }
});

test("missing transcript and duration remain null", async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse(providerCall({ duration: null, transcript: null, transcriptTurns: null })));
  const snapshot = await live(fetchImpl).getCall(PROVIDER_ID);
  assert.equal(snapshot.durationSeconds, null);
  assert.equal(snapshot.transcript, null);
});

test("unknown provider state and mismatched call ID fail closed", async (t) => {
  for (const overrides of [
    { status: { state: "UnexpectedProviderState", terminationType: null } },
    { id: "different_call" },
  ]) {
    await t.test(JSON.stringify(overrides), async () => {
      const { fetchImpl } = recordingFetch(() => jsonResponse(providerCall(overrides)));
      await assert.rejects(live(fetchImpl).getCall(PROVIDER_ID), codeIs("INVALID_PROVIDER_RESPONSE"));
    });
  }
});

test("simulated calls are deterministic and never touch provider transport", async () => {
  const dependencies: Dependencies = { fetch: forbiddenFetch, now: () => NOW };
  const adapter = createDialAdapter({ mode: "simulated" }, dependencies);
  const first = await adapter.startCall(INPUT);
  const repeat = await adapter.startCall(INPUT);
  assert.deepEqual(first, repeat);
  assert.equal(first.state, "accepted");
  if (first.state !== "accepted") assert.fail("Expected simulated acceptance");
  assert.equal(first.mode, "simulated");
  assert.match(first.providerCallId, /^sim_dial_[a-f0-9]{64}$/);
  const snapshot = await adapter.getCall(first.providerCallId);
  assert.equal(snapshot.mode, "simulated");
  assert.equal(snapshot.state, "completed");
  assert.ok(snapshot.transcript);
  const reloaded = createDialAdapter({ mode: "simulated" }, dependencies);
  assert.deepEqual(await reloaded.getCall(first.providerCallId), snapshot);
});

test("live and simulated provider identifiers cannot cross modes", async () => {
  const simulated = createDialAdapter({ mode: "simulated" }, { fetch: forbiddenFetch });
  await assert.rejects(simulated.getCall(PROVIDER_ID), (error: unknown) => error instanceof DialAdapterError);
  await assert.rejects(live(forbiddenFetch).getCall(`sim_dial_${"a".repeat(64)}`), (error: unknown) => error instanceof DialAdapterError);
});

test("authenticated webhook normalizes the event and permits provider redelivery", async () => {
  const adapter = live(forbiddenFetch);
  const { rawBody, headers } = signedWebhook();
  const expected = { eventId: EVENT_ID, providerCallId: PROVIDER_ID, type: "call.ended" };
  assert.deepEqual(await adapter.verifyWebhook(rawBody, headers), expected);
  assert.deepEqual(await adapter.verifyWebhook(rawBody, headers), expected);
});

test("webhook authentication uses exact raw bytes", async () => {
  const { headers } = signedWebhook();
  const reformatted = new TextEncoder().encode(JSON.stringify(eventEnvelope(), null, 2));
  await assert.rejects(live(forbiddenFetch).verifyWebhook(reformatted, headers), codeIs("INVALID_WEBHOOK"));
});

test("webhook signature freshness rejects the five-minute boundary in either direction", async (t) => {
  for (const offset of [-301, -300, 300, 301]) {
    await t.test(`${offset} seconds`, async () => {
      const { rawBody, headers } = signedWebhook(eventEnvelope(), Math.floor(NOW / 1000) + offset);
      await assert.rejects(live(forbiddenFetch).verifyWebhook(rawBody, headers), codeIs("INVALID_WEBHOOK"));
    });
  }
  for (const offset of [-299, 299]) {
    await t.test(`accept ${offset} seconds`, async () => {
      const { rawBody, headers } = signedWebhook(eventEnvelope(), Math.floor(NOW / 1000) + offset);
      assert.equal((await live(forbiddenFetch).verifyWebhook(rawBody, headers))?.eventId, EVENT_ID);
    });
  }
});

test("missing, malformed and forged webhook signatures reject with the same safe code", async (t) => {
  const signatures = [null, "", "garbage", "t=abc,v1=abcd", `t=${NOW / 1000},v1=abcd`, `t=${NOW / 1000},v1=${"z".repeat(64)}`];
  for (const signature of signatures) {
    await t.test(JSON.stringify(signature), async () => {
      const { rawBody, headers } = signedWebhook();
      if (signature === null) headers.delete("X-Dial-Signature");
      else headers.set("X-Dial-Signature", signature);
      await assert.rejects(live(forbiddenFetch).verifyWebhook(rawBody, headers), codeIs("INVALID_WEBHOOK"));
    });
  }
  const forged = signedWebhook(eventEnvelope(), NOW / 1000, "wrong-synthetic-secret");
  await assert.rejects(live(forbiddenFetch).verifyWebhook(forged.rawBody, forged.headers), codeIs("INVALID_WEBHOOK"));
});

test("authenticated webhook headers must agree with signed body identity and type", async (t) => {
  for (const [header, value] of [["X-Dial-Event-ID", "different_event"], ["X-Dial-Event-Type", "other.event"]] as const) {
    await t.test(header, async () => {
      const { rawBody, headers } = signedWebhook();
      headers.set(header, value);
      await assert.rejects(live(forbiddenFetch).verifyWebhook(rawBody, headers), codeIs("INVALID_WEBHOOK"));
    });
  }
});

test("signed but malformed webhook envelopes fail validation", async (t) => {
  const malformed = [
    { version: 2 },
    { object: "call" },
    { data: null },
    { data: {} },
    { data: { callId: "" } },
    { relatedObject: { id: "another_call", type: "call" } },
  ];
  for (const change of malformed) {
    await t.test(JSON.stringify(change), async () => {
      const { rawBody, headers } = signedWebhook(eventEnvelope(change));
      await assert.rejects(live(forbiddenFetch).verifyWebhook(rawBody, headers), codeIs("INVALID_WEBHOOK"));
    });
  }
});

test("authenticated irrelevant events are ignored only after envelope validation", async () => {
  const adapter = live(forbiddenFetch);
  const valid = signedWebhook(eventEnvelope({ type: "call.started" }));
  assert.equal(await adapter.verifyWebhook(valid.rawBody, valid.headers), null);
  const invalid = signedWebhook(eventEnvelope({ type: "call.started", version: 2 }));
  await assert.rejects(adapter.verifyWebhook(invalid.rawBody, invalid.headers), codeIs("INVALID_WEBHOOK"));
});

test("call.ended accepts documented terminal states and nullable duration/failure reason", async (t) => {
  for (const status of ["completed", "busy", "no-answer", "failed", "canceled"]) {
    await t.test(status, async () => {
      const { rawBody, headers } = signedWebhook(eventEnvelope({ data: endedData({
        status,
        canceled: status === "canceled",
        durationSeconds: null,
        failureReason: status === "failed" ? "Synthetic failure" : null,
      }) }));
      assert.deepEqual(await live(forbiddenFetch).verifyWebhook(rawBody, headers), {
        eventId: EVENT_ID, providerCallId: PROVIDER_ID, type: "call.ended",
      });
    });
  }
  await t.test("missing relatedObject is rejected", async () => {
    const envelope: Record<string, unknown> = eventEnvelope();
    delete envelope.relatedObject;
    const { rawBody, headers } = signedWebhook(envelope);
    await assert.rejects(live(forbiddenFetch).verifyWebhook(rawBody, headers), codeIs("INVALID_WEBHOOK"));
  });
});

test("call.ended rejects missing required terminal fields", async (t) => {
  for (const field of ["callId", "from", "to", "direction", "durationSeconds", "status", "canceled", "transcriptAvailable"]) {
    await t.test(field, async () => {
      const data = endedData();
      delete data[field];
      const { rawBody, headers } = signedWebhook(eventEnvelope({ data }));
      await assert.rejects(live(forbiddenFetch).verifyWebhook(rawBody, headers), codeIs("INVALID_WEBHOOK"));
    });
  }
});

test("call.ended rejects malformed terminal fields without coercion", async (t) => {
  const malformed = [
    { from: "not-a-number" },
    { from: 14155550101 },
    { to: "911" },
    { to: null },
    { direction: "sideways" },
    { direction: ["outbound"] },
    { durationSeconds: -1 },
    { durationSeconds: 0.5 },
    { durationSeconds: "23" },
    { status: "in_progress" },
    { status: ["completed"] },
    { canceled: "false" },
    { canceled: null },
    { transcriptAvailable: 1 },
    { transcriptAvailable: "true" },
    { failureReason: { reason: "synthetic" } },
  ];
  for (const change of malformed) {
    await t.test(JSON.stringify(change), async () => {
      const { rawBody, headers } = signedWebhook(eventEnvelope({ data: endedData(change) }));
      await assert.rejects(live(forbiddenFetch).verifyWebhook(rawBody, headers), codeIs("INVALID_WEBHOOK"));
    });
  }
});

test("missing webhook secret and simulated mode cannot accept externally delivered events", async () => {
  const { rawBody, headers } = signedWebhook();
  await assert.rejects(live(forbiddenFetch, { webhookSecret: "" }).verifyWebhook(rawBody, headers), codeIs("MISSING_CONFIG"));
  const simulated = createDialAdapter({ mode: "simulated" }, { fetch: forbiddenFetch });
  await assert.rejects(simulated.verifyWebhook(rawBody, headers), codeIs("INVALID_WEBHOOK"));
});

test("default call duration is 300 seconds when the explicit config omits it", async () => {
  const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ call: { id: PROVIDER_ID } }, 201));
  const adapter = createDialAdapter({ mode: "live" }, {
    config: { apiKey: CONFIG.apiKey, fromNumber: CONFIG.fromNumber },
    fetch: fetchImpl,
  });
  assert.equal((await adapter.startCall(INPUT)).state, "accepted");
  assert.equal(JSON.parse(String(calls[0]!.init?.body)).maxCallDurationSeconds, 300);
});

test("invalid UUIDs and unusable approved briefs are rejected before dispatch", async (t) => {
  const invalidInputs = [
    { ...INPUT, attemptId: "not-a-uuid" },
    { ...INPUT, caseId: "" },
    { ...INPUT, authorizationId: "authorization-123" },
    { ...INPUT, brief: "  " },
    { ...INPUT, brief: "x".repeat(12_001) },
    { ...INPUT, brief: "fact\0injection" },
  ];
  for (const [index, input] of invalidInputs.entries()) {
    await t.test(`invalid input ${index + 1}`, async () => {
      const result = await live(forbiddenFetch).startCall(input);
      assert.equal(result.state, "rejected");
      if (result.state !== "rejected") assert.fail("Expected validation rejection");
      assert.equal(result.code, "INVALID_INPUT");
    });
  }
});

test("request timeout aborts a hung dispatch without retry even when transport ignores abort", { timeout: 2000 }, async () => {
  let signal: AbortSignal | null | undefined;
  const { fetchImpl, calls } = recordingFetch(({ init }) => {
    signal = init?.signal;
    return new Promise<Response>(() => {});
  });
  const adapter = createDialAdapter({ mode: "live" }, {
    config: CONFIG,
    fetch: fetchImpl,
    requestTimeoutMs: 20,
    readRetries: 2,
  });
  const result = await adapter.startCall(INPUT);
  assert.equal(result.state, "dispatch_unknown");
  assert.equal(result.mode, "live");
  assert.equal(calls.length, 1);
  assert.equal(signal?.aborted, true);
});

test("dispatch timeout covers a stalled response body after headers arrive", { timeout: 2000 }, async () => {
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let signal: AbortSignal | null | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      bodyController = controller;
      controller.enqueue(new TextEncoder().encode('{"call":'));
    },
  });
  const { fetchImpl, calls } = recordingFetch(({ init }) => {
    signal = init?.signal;
    return new Response(body, { status: 201 });
  });
  const adapter = createDialAdapter({ mode: "live" }, {
    config: CONFIG,
    fetch: fetchImpl,
    requestTimeoutMs: 20,
    readRetries: 2,
  });
  try {
    assert.equal((await adapter.startCall(INPUT)).state, "dispatch_unknown");
    assert.equal(calls.length, 1);
    assert.equal(signal?.aborted, true);
  } finally {
    bodyController?.close();
  }
});

test("read retries are bounded and cannot create another phone call", async (t) => {
  for (const retries of [0, 1, 2]) {
    await t.test(`${retries} read retries`, async () => {
      const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ code: "synthetic_unavailable" }, 503));
      const adapter = createDialAdapter({ mode: "live" }, { config: CONFIG, fetch: fetchImpl, readRetries: retries });
      await assert.rejects(adapter.getCall(PROVIDER_ID), codeIs("PROVIDER_UNAVAILABLE"));
      assert.equal(calls.length, retries + 1);
      assert.ok(calls.every(({ init }) => init?.method === "GET"));
    });
  }
  await t.test("successful retry preserves the requested call", async () => {
    let attempts = 0;
    const { fetchImpl, calls } = recordingFetch(() => {
      attempts++;
      return attempts === 1 ? jsonResponse({}, 503) : jsonResponse(providerCall());
    });
    const adapter = createDialAdapter({ mode: "live" }, { config: CONFIG, fetch: fetchImpl, readRetries: 2 });
    assert.equal((await adapter.getCall(PROVIDER_ID)).providerCallId, PROVIDER_ID);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(({ init }) => init?.method === "GET"));
  });
  await t.test("a not-found read is not retried", async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({}, 404));
    const adapter = createDialAdapter({ mode: "live" }, { config: CONFIG, fetch: fetchImpl, readRetries: 2 });
    await assert.rejects(adapter.getCall(PROVIDER_ID), codeIs("CALL_NOT_FOUND"));
    assert.equal(calls.length, 1);
  });
});

test("read deadlines abort every attempt and stop at the configured retry maximum", { timeout: 2000 }, async () => {
  const signals: (AbortSignal | null | undefined)[] = [];
  const { fetchImpl, calls } = recordingFetch(({ init }) => {
    signals.push(init?.signal);
    return new Promise<Response>(() => {});
  });
  const adapter = createDialAdapter({ mode: "live" }, {
    config: CONFIG, fetch: fetchImpl, readRetries: 2, requestTimeoutMs: 15,
  });
  await assert.rejects(adapter.getCall(PROVIDER_ID), codeIs("PROVIDER_UNAVAILABLE"));
  assert.equal(calls.length, 3);
  assert.ok(signals.every(signal => signal?.aborted === true));
  assert.ok(calls.every(({ init }) => init?.method === "GET"));
});

test("changing caller-owned facts after invocation cannot alter the dispatched snapshot", async () => {
  let finish: ((response: Response) => void) | undefined;
  const { fetchImpl, calls } = recordingFetch(() => new Promise<Response>(resolve => { finish = resolve; }));
  const mutableInput = { ...INPUT };
  const result = live(fetchImpl).startCall(mutableInput);
  mutableInput.to = "+14155550999";
  mutableInput.brief = "UNAPPROVED replacement facts";
  mutableInput.attemptId = "00000000-0000-4000-8000-000000000099";
  assert.ok(finish);
  finish(jsonResponse({ call: { id: PROVIDER_ID } }, 201));
  assert.equal((await result).state, "accepted");
  const sent = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(sent.to, INPUT.to);
  assert.ok(sent.outboundInstruction.includes(INPUT.brief));
  assert.ok(!sent.outboundInstruction.includes(mutableInput.brief));
  assert.equal(new Headers(calls[0]!.init?.headers).get("Idempotency-Key"), INPUT.attemptId);
});

test("structured transcript turns preserve speakers when plain transcript is unavailable", async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse(providerCall({
    transcript: null,
    transcriptTurns: [
      { speaker: "agent", text: "I am an authorized AI assistant.", startMs: 0, endMs: 1000 },
      { speaker: "user", text: "Your request needs review.", startMs: 1000, endMs: 2000 },
      { speaker: "transfer_target", text: "The customer must complete verification.", startMs: 2000, endMs: 3000 },
    ],
  })));
  const snapshot = await live(fetchImpl).getCall(PROVIDER_ID);
  assert.equal(snapshot.transcript, "agent: I am an authorized AI assistant.\nuser: Your request needs review.\ntransfer_target: The customer must complete verification.");
});

test("structured transcript turns reject nonstring speakers instead of coercing them", async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse(providerCall({
    transcript: null,
    transcriptTurns: [{ speaker: ["agent"], text: "Synthetic text", startMs: 0, endMs: 1000 }],
  })));
  await assert.rejects(live(fetchImpl).getCall(PROVIDER_ID), codeIs("INVALID_PROVIDER_RESPONSE"));
});

test("definitive HTTP refusals remain refusals when their response body is not JSON", async (t) => {
  for (const status of [400, 401, 402, 403, 404, 429]) {
    await t.test(`HTTP ${status}`, async () => {
      const { fetchImpl, calls } = recordingFetch(() => new Response("synthetic HTML error page", { status }));
      const result = await live(fetchImpl).startCall(INPUT);
      assert.equal(result.state, "rejected");
      assert.equal(calls.length, 1);
      assert.ok(!JSON.stringify(result).includes("synthetic HTML"));
    });
  }
  await t.test("unparseable 409 remains ambiguous", async () => {
    const { fetchImpl, calls } = recordingFetch(() => new Response("Conflict", { status: 409 }));
    assert.equal((await live(fetchImpl).startCall(INPUT)).state, "dispatch_unknown");
    assert.equal(calls.length, 1);
  });
});

test("malformed credentials are known local rejections and never reach fetch", async (t) => {
  for (const apiKey of ["synthetic key", " key", "key ", "key\n", "synthetic-\u00e9", "synthetic-\u2603"]) {
    await t.test(JSON.stringify(apiKey), async () => {
      let fetched = false;
      const { fetchImpl } = recordingFetch(() => {
        fetched = true;
        return jsonResponse({ call: { id: PROVIDER_ID } }, 201);
      });
      const result = await live(fetchImpl, { apiKey }).startCall(INPUT);
      assert.equal(result.state, "rejected");
      assert.equal(fetched, false);
      assert.ok(!JSON.stringify(result).includes(apiKey));
    });
  }
});

test("provider durations must be nonnegative safe integer seconds or null", async (t) => {
  for (const duration of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "23"]) {
    await t.test(JSON.stringify(duration), async () => {
      const { fetchImpl } = recordingFetch(() => jsonResponse(providerCall({ duration })));
      await assert.rejects(live(fetchImpl).getCall(PROVIDER_ID), codeIs("INVALID_PROVIDER_RESPONSE"));
    });
  }
  const { fetchImpl } = recordingFetch(() => jsonResponse(providerCall({ duration: 0 })));
  assert.equal((await live(fetchImpl).getCall(PROVIDER_ID)).durationSeconds, 0);
});

test("transcript fallback rejects unusable timing", async (t) => {
  const turn = { speaker: "agent", text: "Synthetic transcript", startMs: 0, endMs: 1000 };
  const invalidTurns = [
    [{ speaker: "agent", text: "Missing timing" }],
    [{ ...turn, startMs: -1 }],
    [{ ...turn, startMs: "0" }],
    [{ ...turn, endMs: 0.5 }],
    [{ ...turn, endMs: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...turn, startMs: 1001 }],
  ];
  for (const [index, transcriptTurns] of invalidTurns.entries()) {
    await t.test(`bad timing ${index + 1}`, async () => {
      const { fetchImpl } = recordingFetch(() => jsonResponse(providerCall({ transcript: null, transcriptTurns })));
      await assert.rejects(live(fetchImpl).getCall(PROVIDER_ID), codeIs("INVALID_PROVIDER_RESPONSE"));
    });
  }
  await t.test("plain transcript wins over an unusable optional fallback", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(providerCall({ transcriptTurns: invalidTurns[0] })));
    assert.equal((await live(fetchImpl).getCall(PROVIDER_ID)).transcript, providerCall().call.transcript);
  });
});

test("opaque provider IDs cannot escape the call path or cause untyped URI failures", async (t) => {
  for (const providerCallId of [".", "..", "\ud800", "\udfff"]) {
    await t.test(JSON.stringify(providerCallId), async () => {
      await assert.rejects(live(forbiddenFetch).getCall(providerCallId), codeIs("INVALID_CALL_ID"));
      const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ call: { id: providerCallId } }, 201));
      assert.equal((await live(fetchImpl).startCall(INPUT)).state, "dispatch_unknown");
      assert.equal(calls.length, 1);
    });
  }
});

test("late transcripts can be retrieved after a completed call without starting another call", async () => {
  let read = 0;
  const { fetchImpl, calls } = recordingFetch(() => jsonResponse(providerCall({
    transcript: read++ === 0 ? null : "Support: Synthetic reference LATE-001. Request pending review.",
    transcriptTurns: null,
  })));
  const adapter = live(fetchImpl);
  const ended = await adapter.getCall(PROVIDER_ID);
  assert.equal(ended.state, "completed");
  assert.equal(ended.transcript, null);
  const later = await adapter.getCall(PROVIDER_ID);
  assert.equal(later.state, "completed");
  assert.match(later.transcript ?? "", /LATE-001/);
  assert.ok(calls.every(({ init }) => init?.method === "GET"));
  assert.equal(calls.length, 2);
});

test("redelivery freshness is checked against the delivery signature rather than event creation", async () => {
  const sixMinutesLater = NOW + 360_000;
  const adapter = createDialAdapter({ mode: "live" }, {
    config: CONFIG, fetch: forbiddenFetch, now: () => sixMinutesLater,
  });
  const { rawBody, headers } = signedWebhook(eventEnvelope(), sixMinutesLater / 1000);
  assert.equal((await adapter.verifyWebhook(rawBody, headers))?.eventId, EVENT_ID);
  assert.equal((await adapter.verifyWebhook(rawBody, headers))?.eventId, EVENT_ID);
});

test("V1 deliberately ignores authenticated call.transcribed without fabricating an ended event", async () => {
  const { rawBody, headers } = signedWebhook(eventEnvelope({ type: "call.transcribed" }));
  assert.equal(await live(forbiddenFetch).verifyWebhook(rawBody, headers), null);
});
