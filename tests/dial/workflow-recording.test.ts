import { describe, expect, it, vi } from "vitest";
import { getDialRecording, MAX_DIAL_RECORDING_BYTES } from "@/integrations/dial/recording";

const CALL = "call_offline_recording_001";
const API_KEY = "offline-private-token";
const PLAYBACK = "https://t3.storageapi.dev/recording.wav?signature=offline-signed-secret";
const metadata = (body: unknown = { url: PLAYBACK }) => Response.json(body);
function wav() {
  const bytes = Buffer.alloc(46);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(38, 4); bytes.write("WAVE", 8);
  bytes.write("fmt ", 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(2, 40);
  return bytes;
}
function transport(...responses: Array<Response | Error | (() => Promise<Response>)>) {
  return vi.fn<typeof fetch>(async () => {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (typeof response === "function") return response();
    if (!response) throw new Error("Unexpected network request");
    return response;
  });
}

describe("owner-route recording transport (offline provider responses)", () => {
  it("proxies actual RIFF/WAVE encoding despite octet-stream and never exposes signed URL or forwards the key", async () => {
    const bytes = wav();
    const fetch = transport(metadata(), new Response(bytes, { headers: { "content-type": "application/octet-stream" } }));
    const result = await getDialRecording(CALL, { apiKey: API_KEY, fetch });
    expect(result).toEqual({ state: "available", bytes: new Uint8Array(bytes), contentType: "audio/wav" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]![0]).toBe(`https://getdial.ai/api/v1/calls/${CALL}/recording`);
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(fetch.mock.calls[1]![0]).toBe(PLAYBACK);
    expect(new Headers(fetch.mock.calls[1]![1]?.headers).get("authorization")).toBeNull();
    expect(new Headers(fetch.mock.calls[1]![1]?.headers).get("cookie")).toBeNull();
    expect(fetch.mock.calls.every(([, request]) => request?.redirect === "error" && request.credentials === "omit" && request.method === "GET")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("offline-signed-secret");
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it.each([
    "http://t3.storageapi.dev/recording.wav", "https://t3.storageapi.dev.evil.example/recording.wav",
    "https://evil.example/recording.wav", "https://127.0.0.1/recording.wav", "https://169.254.169.254/latest/meta-data",
    "https://user:pass@t3.storageapi.dev/recording.wav", "https://t3.storageapi.dev:8443/recording.wav",
    "https://t3.storageapi.dev/recording.wav#fragment", "file:///etc/passwd", "not a url",
  ])("rejects unsupported playback destination %s without fetching it", async (url) => {
    const fetch = transport(metadata({ url }));
    expect(await getDialRecording(CALL, { apiKey: API_KEY, fetch })).toEqual({ state: "unavailable", reason: "invalid_response" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns unavailable for a not-yet-present recording without a media request", async () => {
    const fetch = transport(Response.json({ error: "not ready" }, { status: 404 }));
    expect(await getDialRecording(CALL, { apiKey: API_KEY, fetch })).toEqual({ state: "unavailable", reason: "not_available" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["", "..", "a/b", "sim_dial_abcdef", "bad\nname"])("rejects invalid/simulated call ID %j before network", async (id) => {
    const fetch = transport();
    expect(await getDialRecording(id, { apiKey: API_KEY, fetch })).toEqual({ state: "unavailable", reason: "invalid_response" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "a b", "bad\nkey"])("rejects invalid credential configuration without network", async (apiKey) => {
    const fetch = transport();
    expect(await getDialRecording(CALL, { apiKey, fetch })).toEqual({ state: "unavailable", reason: "configuration" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds metadata before parsing and does not fetch a claimed URL in an oversized response", async () => {
    const fetch = transport(metadata({ url: PLAYBACK, padding: "x".repeat(8192) }));
    expect(await getDialRecording(CALL, { apiKey: API_KEY, fetch })).toEqual({ state: "unavailable", reason: "invalid_response" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects missing URL, malformed JSON, and an unexpected redirect", async () => {
    for (const response of [metadata({}), new Response("not JSON"), Object.defineProperty(metadata(), "redirected", { value: true })]) {
      const fetch = transport(response);
      expect(await getDialRecording(CALL, { apiKey: API_KEY, fetch })).toEqual({ state: "unavailable", reason: "invalid_response" });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects non-audio and zero bytes even when content-type claims audio", async () => {
    for (const body of ["<html>signed storage error</html>", ""]) {
      const fetch = transport(metadata(), new Response(body, { headers: { "content-type": "audio/wav" } }));
      expect(await getDialRecording(CALL, { apiKey: API_KEY, fetch })).toEqual({ state: "unavailable", reason: "invalid_response" });
    }
  });

  it("rejects a media redirect rather than following to another host", async () => {
    const fetch = transport(metadata(), Object.defineProperty(new Response(wav()), "redirected", { value: true }));
    expect(await getDialRecording(CALL, { apiKey: API_KEY, fetch })).toEqual({ state: "unavailable", reason: "invalid_response" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("cancels oversized audio without relying on Content-Length", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(MAX_DIAL_RECORDING_BYTES)); controller.enqueue(new Uint8Array(1)); },
      cancel() { cancelled = true; },
    });
    const fetch = transport(metadata(), new Response(stream));
    expect(await getDialRecording(CALL, { apiKey: API_KEY, fetch })).toEqual({ state: "unavailable", reason: "invalid_response" });
    expect(cancelled).toBe(true);
  });

  it("rejects declared oversize audio before reading its body", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const fetch = transport(metadata(), new Response(stream, { headers: { "content-length": String(MAX_DIAL_RECORDING_BYTES + 1) } }));
    expect(await getDialRecording(CALL, { apiKey: API_KEY, fetch })).toEqual({ state: "unavailable", reason: "invalid_response" });
    expect(cancelled).toBe(true);
  });

  it("has a total timeout even when the injected transport ignores cancellation", async () => {
    const fetch = transport(metadata(), () => new Promise<Response>(() => {}));
    expect(await getDialRecording(CALL, { apiKey: API_KEY, fetch, timeoutMs: 5 })).toEqual({ state: "unavailable", reason: "provider_unavailable" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]![1]?.signal?.aborted).toBe(true);
  });

  it("times out and cancels a stalled media response body", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const fetch = transport(metadata(), new Response(stream));
    expect(await getDialRecording(CALL, { apiKey: API_KEY, fetch, timeoutMs: 5 })).toEqual({ state: "unavailable", reason: "provider_unavailable" });
    expect(cancelled).toBe(true);
  });

  it("sanitizes provider failures without leaking credentials, signed URL or raw response", async () => {
    const fetch = transport(metadata(), new Error(`Failure ${PLAYBACK} ${API_KEY}`));
    const result = await getDialRecording(CALL, { apiKey: API_KEY, fetch });
    expect(result).toEqual({ state: "unavailable", reason: "provider_unavailable" });
  });
});
