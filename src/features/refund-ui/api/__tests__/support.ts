/** Shared test helpers: a controllable clock, fixture flows, wire samples and a recording fetch. */

import type { CallV1, CaseV1 } from "../../../../contracts/case";
import { createFixtureCaseApi } from "../fixture";
import {
  ApiRequestError,
  ApiUnreachableError,
  type CaseApi,
  type FixtureOptions,
  type FixtureScenario,
  type LiveCallV2,
} from "../types";
import { randomUuid } from "../uuid";

export const T0 = Date.parse("2026-10-11T19:00:00.000Z");

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export interface TestClock {
  now: () => number;
  /** Moves the clock to T0 plus `seconds`. Reads are pure, so moving back works too. */
  at: (seconds: number) => void;
}

export function testClock(): TestClock {
  let now = T0;
  return {
    now: () => now,
    at: (seconds) => {
      now = T0 + seconds * 1000;
    },
  };
}

type EngineOptions = Omit<FixtureOptions, "now" | "scenario">;

export function fixture(scenario?: FixtureScenario, options: EngineOptions = {}): { api: CaseApi; clock: TestClock } {
  const clock = testClock();
  return { api: createFixtureCaseApi({ ...options, scenario, now: clock.now }), clock };
}

export function authorizationIdOf(c: CaseV1): string {
  if (c.authorization === null) throw new Error("The case has no authorization.");
  return c.authorization.id;
}

/** Creates, authorizes and dials at T0. `live(s)` reads the live call at T0 + s seconds. */
export async function startedCall(scenario: FixtureScenario, options: EngineOptions = {}) {
  const { api, clock } = fixture(scenario, options);
  const created = await api.createCase({ summary: `Fixture run for ${scenario}` });
  const authorizationId = authorizationIdOf(await api.authorize(created.id, created.revision));
  const call = await api.startCall(created.id, { authorizationId, requestId: randomUuid() });
  const live = async (seconds: number): Promise<LiveCallV2> => {
    clock.at(seconds);
    const value = await api.getLiveCall(created.id, call.id);
    if (value === null) throw new Error("Expected a live call record.");
    return value;
  };
  const caseAt = async (seconds: number): Promise<CaseV1> => {
    clock.at(seconds);
    return api.getCase(created.id);
  };
  return { api, clock, caseId: created.id, callId: call.id, authorizationId, call, live, caseAt };
}

export async function failureOf(promise: Promise<unknown>): Promise<ApiRequestError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiRequestError) return error;
    throw error;
  }
  throw new Error("Expected the request to fail with an ApiRequestError.");
}

export async function unreachableOf(promise: Promise<unknown>): Promise<ApiUnreachableError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiUnreachableError) return error;
    throw error;
  }
  throw new Error("Expected the request to fail with an ApiUnreachableError.");
}

export function noteTexts(live: LiveCallV2): string[] {
  return live.notes.map((n) => n.text);
}

// ---------------------------------------------------------------------------
// Wire samples for the http client
// ---------------------------------------------------------------------------

export function sampleCall(overrides: Partial<CallV1> = {}): CallV1 {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    requestId: "22222222-2222-4222-8222-222222222222",
    authorizationId: "33333333-3333-4333-8333-333333333333",
    providerCallId: "provider-1",
    mode: "simulated",
    state: "queued",
    transcript: null,
    error: null,
    createdAt: iso(T0),
    updatedAt: iso(T0),
    ...overrides,
  };
}

export function sampleCase(overrides: Partial<CaseV1> = {}): CaseV1 {
  return {
    schemaVersion: 1,
    id: "44444444-4444-4444-8444-444444444444",
    revision: 1,
    mode: "simulated",
    status: "ready_for_approval",
    customer: { name: "Jordan Avery", email: null },
    merchant: { name: "Ridgeline Outfitters billing", supportPhone: "+14155550177" },
    amountMinor: 4999,
    currency: "USD",
    reason: "Charged twice for the same order.",
    evidence: [{ id: "66666666-6666-4666-8666-666666666666", name: "receipt.pdf", mimeType: "application/pdf" }],
    missingFields: [],
    draft: { subject: "Refund request", body: "Hello" },
    authorization: null,
    calls: [],
    outcome: {
      decision: "unknown",
      referenceNumber: null,
      nextAction: null,
      paymentStatus: "unverified",
      supportingQuote: null,
    },
    timeline: [{ id: "55555555-5555-4555-8555-555555555555", at: iso(T0), type: "case_created", message: "Case created." }],
    createdAt: iso(T0),
    updatedAt: iso(T0),
    ...overrides,
  };
}

export function sampleLiveCall(overrides: Partial<LiveCallV2> = {}): LiveCallV2 {
  return {
    callId: "11111111-1111-4111-8111-111111111111",
    caseId: "44444444-4444-4444-8444-444444444444",
    calling: { name: "Ridgeline Outfitters billing", phone: "+14155550177" },
    phase: "talking",
    counterpart: "human",
    counterpartConfidence: 0.8,
    startedAt: iso(T0),
    endedAt: null,
    holdSeconds: 6,
    notes: [{ at: iso(T0), text: "A person answered." }],
    pendingDecision: null,
    userJoined: false,
    updatedAt: iso(T0),
    ...overrides,
  };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function textResponse(status: number, body: string, contentType = "text/html"): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: RequestInit["body"];
  credentials: RequestInit["credentials"];
  cache: RequestInit["cache"];
}

/** A fetch that records each request and answers with the queued replies in order. */
export function recordingFetch(...replies: (Response | Error)[]): {
  fetchImpl: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body,
      credentials: init?.credentials,
      cache: init?.cache,
    });
    const reply = replies.shift();
    if (reply === undefined) throw new Error(`No reply queued for ${url}.`);
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { fetchImpl, requests };
}

export function jsonBodyOf(request: RecordedRequest | undefined): unknown {
  if (request === undefined || typeof request.body !== "string") throw new Error("Expected a JSON string body.");
  return JSON.parse(request.body);
}
