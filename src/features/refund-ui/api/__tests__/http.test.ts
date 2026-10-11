import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpCaseApi } from "../http";
import { CASE_NOT_FOUND_MESSAGE } from "../messages";
import { ApiRequestError, ApiUnreachableError, type CaseApi } from "../types";
import {
  failureOf,
  jsonBodyOf,
  jsonResponse,
  recordingFetch,
  sampleCall,
  sampleCase,
  sampleLiveCall,
  textResponse,
  unreachableOf,
  type RecordedRequest,
} from "./support";

const CASE_ID = sampleCase().id;
const CALL_ID = sampleCall().id;
const CASE_URL = `/api/cases/${CASE_ID}`;
const CALL_URL = `${CASE_URL}/calls/${CALL_ID}`;

function httpApi(...replies: (Response | Error)[]): { api: CaseApi; requests: RecordedRequest[] } {
  const { fetchImpl, requests } = recordingFetch(...replies);
  return { api: createHttpCaseApi({ fetch: fetchImpl }), requests };
}

function apiError(status: number, code: string, message: string, fields?: string[]): Response {
  return jsonResponse(status, { error: fields === undefined ? { code, message } : { code, message, fields } });
}

/** A response whose body stream fails mid-read, like a dropped connection. */
function brokenBody(status: number): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("connection reset"));
    },
  });
  return new Response(body, { status });
}

const allV2 = (): Response => jsonResponse(200, { capabilities: { liveCall: true, stepIn: true, decisions: true } });
/** What a V1-only Next.js backend answers for a route it does not have. */
const missingRoute = (): Response => textResponse(404, "<!DOCTYPE html><title>404: This page could not be found.</title>");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("http client: requests", () => {
  it("creates a case with a multipart body and lets fetch write the boundary", async () => {
    const created = sampleCase();
    const { api, requests } = httpApi(jsonResponse(201, { case: created }));
    const receipt = new File(["%PDF-1.7"], "receipt.pdf", { type: "application/pdf" });
    const statement = new File(["date,amount"], "statement.csv", { type: "text/csv" });

    const result = await api.createCase({
      summary: "Charged twice for the same order.",
      files: [receipt, statement],
      merchantName: "Ridgeline Outfitters billing",
      amountMinor: 4999,
      currency: "USD",
    });

    expect(result).toEqual(created);
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request).toMatchObject({ url: "/api/cases", method: "POST", credentials: "same-origin", cache: "no-store" });
    expect(request?.headers.get("accept")).toBe("application/json");
    expect(request?.headers.get("content-type")).toBeNull();
    const form = request?.body;
    if (!(form instanceof FormData)) throw new Error("Expected a FormData body.");
    expect([...form.keys()]).toEqual(["summary", "files", "files", "merchantName", "amountMinor", "currency"]);
    expect(form.get("summary")).toBe("Charged twice for the same order.");
    expect(form.getAll("files").map((f) => (f instanceof File ? `${f.name} ${f.type} ${f.size}` : f))).toEqual([
      "receipt.pdf application/pdf 8",
      "statement.csv text/csv 11",
    ]);
    expect(form.get("amountMinor")).toBe("4999");

    // The same body on the wire is multipart with a generated boundary.
    const wire = new Request("http://localhost/api/cases", { method: "POST", body: form });
    expect(wire.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
    expect(await wire.text()).toContain('name="files"; filename="statement.csv"');
  });

  it("sends a summary-only case without empty optional fields", async () => {
    const { api, requests } = httpApi(jsonResponse(201, { case: sampleCase() }));
    await api.createCase({ summary: "Refund the duplicate charge" });
    const form = requests[0]?.body;
    if (!(form instanceof FormData)) throw new Error("Expected a FormData body.");
    expect([...form.keys()]).toEqual(["summary"]);
  });

  it("sends JSON for patch, authorize and start call and unwraps each envelope", async () => {
    const patched = sampleCase({ revision: 4, amountMinor: 5000 });
    const authorized = sampleCase({
      revision: 4,
      status: "authorized",
      authorization: { id: sampleCall().authorizationId, revision: 4, approvedAt: patched.updatedAt },
    });
    const call = sampleCall();
    const { api, requests } = httpApi(
      jsonResponse(200, { case: patched }),
      jsonResponse(200, { case: authorized }),
      jsonResponse(202, { call }),
    );

    const changes = { amountMinor: 5000, merchant: { name: "Ridgeline Outfitters billing", supportPhone: "+14155550177" } };
    expect(await api.patchCase(CASE_ID, 3, changes)).toEqual(patched);
    expect(await api.authorize(CASE_ID, 4)).toEqual(authorized);
    expect(await api.startCall(CASE_ID, { authorizationId: call.authorizationId, requestId: call.requestId })).toEqual(call);

    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `PATCH ${CASE_URL}`,
      `POST ${CASE_URL}/authorize`,
      `POST ${CASE_URL}/calls`,
    ]);
    for (const r of requests) {
      expect(r.headers.get("content-type")).toBe("application/json");
      expect(r.credentials).toBe("same-origin");
    }
    expect(jsonBodyOf(requests[0])).toEqual({ expectedRevision: 3, changes });
    expect(jsonBodyOf(requests[1])).toEqual({ expectedRevision: 4 });
    expect(jsonBodyOf(requests[2])).toEqual({ authorizationId: call.authorizationId, requestId: call.requestId });
  });

  it("gets a case with an encoded id and no body", async () => {
    const { api, requests } = httpApi(jsonResponse(200, { case: sampleCase() }));
    await api.getCase("a/b c?");
    expect(requests[0]).toMatchObject({ method: "GET", url: "/api/cases/a%2Fb%20c%3F", body: undefined });
  });

  it("downloads the packet as a Blob", async () => {
    const packet = "REFUND REQUEST PACKET\nCase: 4444\n";
    const { api, requests } = httpApi(textResponse(200, packet, "text/plain; charset=utf-8"));
    const blob = await api.downloadPacket(CASE_ID);
    expect(await blob.text()).toBe(packet);
    expect(blob.type).toBe("text/plain;charset=utf-8");
    expect(requests[0]).toMatchObject({ method: "GET", url: `${CASE_URL}/packet` });
    expect(requests[0]?.headers.get("accept")).toBe("text/plain, application/json");
  });

  it("prefixes every request with baseUrl", async () => {
    const { fetchImpl, requests } = recordingFetch(jsonResponse(200, { case: sampleCase() }));
    const api = createHttpCaseApi({ baseUrl: "https://api.example.test/backend//", fetch: fetchImpl });
    await api.getCase(CASE_ID);
    expect(requests[0]?.url).toBe(`https://api.example.test/backend${CASE_URL}`);
  });

  it("looks up the global fetch on every request when none is injected", async () => {
    const api = createHttpCaseApi();
    const first = recordingFetch(jsonResponse(200, { case: sampleCase() }));
    vi.stubGlobal("fetch", first.fetchImpl);
    await api.getCase(CASE_ID);
    const second = recordingFetch(jsonResponse(200, { case: sampleCase({ revision: 2 }) }));
    vi.stubGlobal("fetch", second.fetchImpl);
    expect((await api.getCase(CASE_ID)).revision).toBe(2);
    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(1);
  });

  it("leaves the session cookie to the browser", async () => {
    const { api, requests } = httpApi(
      jsonResponse(200, { case: sampleCase() }),
      allV2(),
      jsonResponse(200, { liveCall: sampleLiveCall() }),
      jsonResponse(200, { liveCall: sampleLiveCall({ phase: "user_joined", userJoined: true }) }),
    );
    await api.getCase(CASE_ID);
    await api.getLiveCall(CASE_ID, CALL_ID);
    await api.stepIn(CASE_ID, CALL_ID);
    expect(requests).toHaveLength(4);
    for (const r of requests) {
      expect(r.credentials).toBe("same-origin");
      expect(r.cache).toBe("no-store");
      expect(r.headers.has("cookie")).toBe(false);
      expect(r.headers.has("authorization")).toBe(false);
    }
  });
});

describe("http client: errors", () => {
  it("maps an ApiError body to ApiRequestError with status, code, message and fields", async () => {
    const { api } = httpApi(
      apiError(409, "REVISION_CONFLICT", "The case changed. Reload and try again."),
      apiError(422, "MISSING_REQUIRED_FACTS", "Add the missing facts first.", ["merchant.supportPhone", "amountMinor"]),
    );
    const conflict = await failureOf(api.patchCase(CASE_ID, 1, { amountMinor: 100 }));
    expect(conflict).toBeInstanceOf(ApiRequestError);
    expect(conflict).toMatchObject({
      name: "ApiRequestError",
      status: 409,
      code: "REVISION_CONFLICT",
      message: "The case changed. Reload and try again.",
      fields: undefined,
    });
    expect(await failureOf(api.authorize(CASE_ID, 2))).toMatchObject({
      status: 422,
      code: "MISSING_REQUIRED_FACTS",
      fields: ["merchant.supportPhone", "amountMinor"],
    });
  });

  it.each([
    [409, "MODE_MISMATCH", "This case was created in simulated mode and cannot be dialed live."],
    [413, "PAYLOAD_TOO_LARGE", "Uploads are limited to 10 MB in total."],
    [503, "PROVIDER_UNAVAILABLE", "The voice provider refused the call."],
    [429, "RATE_LIMITED", "Too many requests."],
    [418, "A_CODE_FROM_THE_FUTURE", "Something this client has never heard of."],
  ])("passes %i %s through unchanged", async (status, code, message) => {
    const { api } = httpApi(apiError(status, code, message));
    const error = await failureOf(api.createCase({ summary: "duplicate charge" }));
    expect(error).toMatchObject({ status, code, message });
  });

  it.each<[string, (api: CaseApi) => Promise<unknown>]>([
    ["getCase", (api) => api.getCase(CASE_ID)],
    ["patchCase", (api) => api.patchCase(CASE_ID, 1, { reason: "Duplicate" })],
    ["authorize", (api) => api.authorize(CASE_ID, 1)],
    ["startCall", (api) => api.startCall(CASE_ID, { authorizationId: CALL_ID, requestId: CALL_ID })],
    ["downloadPacket", (api) => api.downloadPacket(CASE_ID)],
  ])("%s says a 404 case was not found for this browser session", async (_name, run) => {
    const { api } = httpApi(apiError(404, "NOT_FOUND", "Case not found"));
    expect(await failureOf(run(api))).toMatchObject({ status: 404, code: "NOT_FOUND", message: CASE_NOT_FOUND_MESSAGE });
  });

  it("reports an error status without an ApiError body as a contract violation", async () => {
    const { api } = httpApi(
      jsonResponse(500, { message: "Internal Server Error" }),
      jsonResponse(400, { error: { code: "BAD_REQUEST", message: "Bad", fields: "summary" } }),
    );
    expect(await failureOf(api.getCase(CASE_ID))).toMatchObject({ status: 500, code: "CONTRACT_VIOLATION" });
    expect(await failureOf(api.getCase(CASE_ID))).toMatchObject({ status: 400, code: "CONTRACT_VIOLATION" });
  });

  it("rejects a 2xx whose envelope does not match the contract instead of passing it on", async () => {
    const { api } = httpApi(
      jsonResponse(200, { case: { ...sampleCase(), status: "pending" } }),
      jsonResponse(202, { case: sampleCase() }),
      jsonResponse(201, sampleCase()),
    );
    expect(await failureOf(api.getCase(CASE_ID))).toMatchObject({
      status: 200,
      code: "CONTRACT_VIOLATION",
      message: 'The server response has no valid "case".',
    });
    expect(await failureOf(api.startCall(CASE_ID, { authorizationId: CALL_ID, requestId: CALL_ID }))).toMatchObject({
      status: 202,
      code: "CONTRACT_VIOLATION",
      message: 'The server response has no valid "call".',
    });
    expect(await failureOf(api.createCase({ summary: "duplicate" }))).toMatchObject({ code: "CONTRACT_VIOLATION" });
  });

  it("throws ApiUnreachableError with the cause when fetch rejects", async () => {
    const offline = new TypeError("Failed to fetch");
    const { api } = httpApi(offline);
    const error = await unreachableOf(api.getCase(CASE_ID));
    expect(error).toBeInstanceOf(ApiUnreachableError);
    expect(error).not.toBeInstanceOf(ApiRequestError);
    expect(error.message).toBe("The server could not be reached.");
    expect(error.cause).toBe(offline);
  });

  it("throws ApiUnreachableError for a body that is not JSON, naming the status", async () => {
    const { api } = httpApi(
      textResponse(502, "<html>Bad gateway</html>"),
      textResponse(200, "<html>Sign in to the Wi-Fi</html>"),
      missingRoute(),
    );
    expect((await unreachableOf(api.getCase(CASE_ID))).message).toBe(
      "The server answered HTTP 502 with a response that is not JSON.",
    );
    expect((await unreachableOf(api.getCase(CASE_ID))).message).toContain("HTTP 200");
    expect((await unreachableOf(api.createCase({ summary: "duplicate" }))).message).toContain("HTTP 404");
  });

  it("throws ApiUnreachableError when the body cannot be read", async () => {
    const { api } = httpApi(brokenBody(200), brokenBody(200));
    expect((await unreachableOf(api.getCase(CASE_ID))).message).toBe("The response (HTTP 200) could not be read.");
    expect((await unreachableOf(api.downloadPacket(CASE_ID))).message).toBe("The packet download was interrupted.");
  });
});

describe("http client: capabilities", () => {
  it("probes once, shares the probe between concurrent callers and caches the answer", async () => {
    const { api, requests } = httpApi(
      jsonResponse(200, { capabilities: { liveCall: true, stepIn: true, decisions: false } }),
    );
    const [a, b] = await Promise.all([api.capabilities(), api.capabilities()]);
    const c = await api.capabilities();
    for (const value of [a, b, c]) expect(value).toEqual({ liveCall: true, stepIn: true, decisions: false });
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual(["GET /api/capabilities"]);
  });

  it("treats only an explicit true as supported", async () => {
    const { api } = httpApi(jsonResponse(200, { capabilities: { liveCall: "true", stepIn: 1, decisions: true } }));
    expect(await api.capabilities()).toEqual({ liveCall: false, stepIn: false, decisions: true });
  });

  it.each([
    ["an HTML 404 from a V1-only backend", missingRoute],
    ["a JSON 404", () => apiError(404, "NOT_FOUND", "No such route")],
    ["a 2xx that is not JSON", () => textResponse(200, "<html></html>")],
    ["a 2xx without capabilities", () => jsonResponse(200, { version: 1 })],
  ])("reads %s as no V2 support and keeps that answer", async (_label, reply) => {
    const { api, requests } = httpApi(reply());
    expect(await api.capabilities()).toEqual({ liveCall: false, stepIn: false, decisions: false });
    expect(await api.capabilities()).toEqual({ liveCall: false, stepIn: false, decisions: false });
    expect(requests).toHaveLength(1);
  });

  it("reports nothing while unreachable or failing, then probes again", async () => {
    const { api, requests } = httpApi(
      new TypeError("Failed to fetch"),
      apiError(503, "UNAVAILABLE", "Starting up"),
      allV2(),
    );
    const none = { liveCall: false, stepIn: false, decisions: false };
    expect(await api.capabilities()).toEqual(none);
    expect(await api.capabilities()).toEqual(none);
    expect(await api.capabilities()).toEqual({ liveCall: true, stepIn: true, decisions: true });
    expect(await api.capabilities()).toEqual({ liveCall: true, stepIn: true, decisions: true });
    expect(requests).toHaveLength(3);
  });

  it("hands out copies, so a caller cannot change the cached answer", async () => {
    const { api } = httpApi(allV2());
    const first = await api.capabilities();
    first.liveCall = false;
    expect((await api.capabilities()).liveCall).toBe(true);
  });
});

describe("http client: V2 live call routes", () => {
  it("on a V1-only backend returns no live call and rejects step-in and decisions with 501", async () => {
    const { api, requests } = httpApi(missingRoute());
    expect(await api.getLiveCall(CASE_ID, CALL_ID)).toBeNull();
    expect(await failureOf(api.stepIn(CASE_ID, CALL_ID))).toMatchObject({ status: 501, code: "NOT_SUPPORTED" });
    expect(await failureOf(api.answerDecision(CASE_ID, CALL_ID, "d1", "accept"))).toMatchObject({
      status: 501,
      code: "NOT_SUPPORTED",
    });
    expect(requests.map((r) => r.url)).toEqual(["/api/capabilities"]);
  });

  it("reads the live call record when supported", async () => {
    const live = sampleLiveCall();
    const { api, requests } = httpApi(allV2(), jsonResponse(200, { liveCall: live }), jsonResponse(200, { liveCall: null }));
    expect(await api.getLiveCall(CASE_ID, CALL_ID)).toEqual(live);
    expect(await api.getLiveCall(CASE_ID, CALL_ID)).toBeNull();
    expect(requests.slice(1).map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${CALL_URL}/live`, `GET ${CALL_URL}/live`]);
  });

  it("rejects a live record that does not match the proposal", async () => {
    const { api } = httpApi(allV2(), jsonResponse(200, { liveCall: { ...sampleLiveCall(), phase: "connecting" } }));
    expect(await failureOf(api.getLiveCall(CASE_ID, CALL_ID))).toMatchObject({
      status: 200,
      code: "CONTRACT_VIOLATION",
      message: 'The server response has no valid "liveCall".',
    });
  });

  it("joins with POST .../join and answers with POST .../decisions/:decisionId", async () => {
    const joined = sampleLiveCall({ phase: "user_joined", userJoined: true });
    const answered = sampleLiveCall({ phase: "talking" });
    const { api, requests } = httpApi(allV2(), jsonResponse(200, { liveCall: joined }), jsonResponse(200, { liveCall: answered }));
    expect(await api.stepIn(CASE_ID, CALL_ID)).toEqual(joined);
    expect(await api.answerDecision(CASE_ID, CALL_ID, "decision/1", "accept")).toEqual(answered);
    expect(requests.slice(1).map((r) => `${r.method} ${r.url}`)).toEqual([
      `POST ${CALL_URL}/join`,
      `POST ${CALL_URL}/decisions/decision%2F1`,
    ]);
    expect(jsonBodyOf(requests[1])).toEqual({});
    expect(jsonBodyOf(requests[2])).toEqual({ optionId: "accept" });
  });

  it("keeps the server's message for V2 errors", async () => {
    const { api } = httpApi(
      allV2(),
      apiError(404, "NOT_FOUND", "Call not found"),
      apiError(409, "CALL_ENDED", "The call has ended."),
      apiError(409, "DECISION_RESOLVED", "This decision was already answered."),
    );
    expect(await failureOf(api.getLiveCall(CASE_ID, CALL_ID))).toMatchObject({ status: 404, message: "Call not found" });
    expect(await failureOf(api.stepIn(CASE_ID, CALL_ID))).toMatchObject({ status: 409, code: "CALL_ENDED" });
    expect(await failureOf(api.answerDecision(CASE_ID, CALL_ID, "d1", "accept"))).toMatchObject({
      status: 409,
      code: "DECISION_RESOLVED",
    });
  });

  it("checks each capability on its own", async () => {
    const { api, requests } = httpApi(
      jsonResponse(200, { capabilities: { liveCall: true, stepIn: false, decisions: false } }),
      jsonResponse(200, { liveCall: sampleLiveCall() }),
    );
    expect(await api.getLiveCall(CASE_ID, CALL_ID)).not.toBeNull();
    expect(await failureOf(api.stepIn(CASE_ID, CALL_ID))).toMatchObject({ status: 501, code: "NOT_SUPPORTED" });
    expect(requests).toHaveLength(2);
  });
});

describe("http client: post-call summary", () => {
  const sms = { channel: "sms" as const, to: "415 555 0199" };
  const delivery = {
    channel: "sms",
    to: "+14155550199",
    subject: null,
    summary: ["The refund of $49.99 was approved.", "Reference RO-77102."],
    transcript: "Agent: Hello.\nSupport: Approved.",
    sentAt: "2026-10-11T22:40:00.000Z",
  };
  const completedCase = () =>
    sampleCase({ calls: [sampleCall({ state: "completed", transcript: "Agent: Hello.\nSupport: Approved." })] });

  it("posts the destination to .../summary and returns the server's delivery", async () => {
    const { api, requests } = httpApi(jsonResponse(200, { delivery }));
    expect(await api.sendSummary(CASE_ID, sms)).toEqual(delivery);
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([`POST ${CASE_URL}/summary`]);
    expect(jsonBodyOf(requests[0])).toEqual(sms);
  });

  it("composes in the browser with sentAt null when the backend has no summary route", async () => {
    const { api, requests } = httpApi(missingRoute(), jsonResponse(200, { case: completedCase() }));
    const composed = await api.sendSummary(CASE_ID, sms);
    expect(composed).toMatchObject({ channel: "sms", to: sms.to, sentAt: null });
    expect(composed.transcript).toContain("Support: Approved.");
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([`POST ${CASE_URL}/summary`, `GET ${CASE_URL}`]);
  });

  it("keeps the server's answer for a case error, and rejects a bad destination before any request", async () => {
    const { api, requests } = httpApi(apiError(409, "CALL_NOT_COMPLETE", "The call has not finished yet."));
    expect(await failureOf(api.sendSummary(CASE_ID, sms))).toMatchObject({ status: 409, code: "CALL_NOT_COMPLETE" });
    expect(await failureOf(api.sendSummary(CASE_ID, { channel: "sms", to: "soon" }))).toMatchObject({
      status: 400,
      code: "BAD_REQUEST",
      fields: ["to"],
    });
    expect(requests).toHaveLength(1);
  });

  it("rejects a delivery that does not match the contract", async () => {
    const { api } = httpApi(jsonResponse(200, { delivery: { ...delivery, summary: "not a list" } }));
    expect(await failureOf(api.sendSummary(CASE_ID, sms))).toMatchObject({ status: 200, code: "CONTRACT_VIOLATION" });
  });
});
