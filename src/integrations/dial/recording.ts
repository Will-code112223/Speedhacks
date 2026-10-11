/**
 * Server-only playback proxy for an already authorized, owner-scoped call.
 * The caller must enforce case ownership before using this transport helper.
 * Dial's official dashboard uses this metadata endpoint (its public OpenAPI
 * does not document it yet). On 2026-10-11 an authenticated recording response
 * used t3.storageapi.dev; other media hosts remain unsupported until verified.
 */
const RECORDING_API = "https://getdial.ai/api/v1/calls";
const RECORDING_HOST = "t3.storageapi.dev";
const MAX_METADATA_BYTES = 8192;
export const MAX_DIAL_RECORDING_BYTES = 32 * 1024 * 1024;
export type DialRecordingContentType = "audio/wav" | "audio/mpeg" | "audio/ogg";
export type DialRecordingUnavailableReason = "not_available" | "configuration" | "provider_unavailable" | "invalid_response";
export type DialRecordingResult =
  | { state: "available"; bytes: Uint8Array; contentType: DialRecordingContentType }
  | { state: "unavailable"; reason: DialRecordingUnavailableReason };
export interface DialRecordingDependencies {
  apiKey: string | undefined;
  fetch?: typeof globalThis.fetch;
  /** Total deadline for metadata and audio, including response bodies. Default 15 seconds. */
  timeoutMs?: number;
}
class RecordingReadError extends Error {
  readonly reason: DialRecordingUnavailableReason;
  constructor(reason: DialRecordingUnavailableReason) { super(reason); this.reason = reason; }
}
const unavailable = (reason: DialRecordingUnavailableReason): DialRecordingResult => ({ state: "unavailable", reason });

function mediaUrl(value: unknown): URL {
  if (typeof value !== "string" || value.length > MAX_METADATA_BYTES) throw new RecordingReadError("invalid_response");
  let url: URL;
  try { url = new URL(value); } catch { throw new RecordingReadError("invalid_response"); }
  if (url.protocol !== "https:" || url.hostname !== RECORDING_HOST || url.port || url.username || url.password || url.hash) {
    throw new RecordingReadError("invalid_response");
  }
  return url;
}
async function boundedBody(response: Response, maximum: number, signal: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maximum) {
    await response.body?.cancel(); throw new RecordingReadError("invalid_response");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new RecordingReadError("invalid_response");
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new RecordingReadError("invalid_response"); }
      chunks.push(value);
    }
  } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
  return new Uint8Array(Buffer.concat(chunks, size));
}
function audioType(bytes: Uint8Array): DialRecordingContentType | null {
  const ascii = (offset: number, value: string) => [...value].every((letter, i) => bytes[offset + i] === letter.charCodeAt(0));
  // Actual Dial playback returned RIFF/WAVE bytes with application/octet-stream.
  // Never rely on the remote Content-Type alone or serve arbitrary HTML/XML.
  if (bytes.length >= 44 && ascii(0, "RIFF") && ascii(8, "WAVE")) return "audio/wav";
  if (bytes.length >= 10 && ascii(0, "ID3") && bytes[3]! >= 2 && bytes[3]! <= 4 && bytes[4] !== 255 &&
    [6, 7, 8, 9].every(index => bytes[index]! < 128)) return "audio/mpeg";
  if (bytes.length >= 4 && bytes[0] === 255 && (bytes[1]! & 224) === 224 && (bytes[1]! & 6) !== 0 &&
    (bytes[2]! & 240) !== 240 && (bytes[2]! & 12) !== 12) return "audio/mpeg";
  if (bytes.length >= 27 && ascii(0, "OggS") && bytes[4] === 0) return "audio/ogg";
  return null;
}

/** Returns audio bytes, never a bearer credential or a signed playback URL. */
export async function getDialRecording(providerCallId: string, deps: DialRecordingDependencies): Promise<DialRecordingResult> {
  if (typeof window !== "undefined") return unavailable("configuration");
  if (typeof providerCallId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(providerCallId) || providerCallId.startsWith("sim_dial_")) return unavailable("invalid_response");
  const apiKey = deps.apiKey;
  const timeoutMs = deps.timeoutMs ?? 15_000;
  if (typeof apiKey !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(apiKey) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) return unavailable("configuration");
  const transport = deps.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const perform = async (): Promise<DialRecordingResult> => {
    const response = await transport(`${RECORDING_API}/${encodeURIComponent(providerCallId)}/recording`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      method: "GET", redirect: "error", credentials: "omit", signal: controller.signal,
    });
    controller.signal.throwIfAborted();
    if (response.redirected) { await response.body?.cancel(); throw new RecordingReadError("invalid_response"); }
    if (!response.ok) {
      await response.body?.cancel();
      return unavailable(response.status === 404 ? "not_available" : "provider_unavailable");
    }
    let metadata: unknown;
    try { metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await boundedBody(response, MAX_METADATA_BYTES, controller.signal))); }
    catch (error) { if (error instanceof RecordingReadError) throw error; throw new RecordingReadError("invalid_response"); }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new RecordingReadError("invalid_response");
    const url = mediaUrl((metadata as Record<string, unknown>).url);
    controller.signal.throwIfAborted();
    const recording = await transport(url.href, {
      method: "GET", headers: { Accept: "audio/wav, audio/mpeg, audio/ogg, application/octet-stream" },
      redirect: "error", credentials: "omit", signal: controller.signal,
    });
    controller.signal.throwIfAborted();
    if (recording.redirected) { await recording.body?.cancel(); throw new RecordingReadError("invalid_response"); }
    if (!recording.ok) { await recording.body?.cancel(); return unavailable("provider_unavailable"); }
    const bytes = await boundedBody(recording, MAX_DIAL_RECORDING_BYTES, controller.signal);
    const contentType = audioType(bytes);
    if (!contentType) return unavailable("invalid_response");
    return { state: "available", bytes, contentType };
  };
  try {
    return await Promise.race([perform(), new Promise<DialRecordingResult>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(unavailable("provider_unavailable")); }, timeoutMs);
    })]);
  } catch (error) {
    return unavailable(error instanceof RecordingReadError ? error.reason : "provider_unavailable");
  } finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
}
