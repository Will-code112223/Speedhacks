import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import https from "node:https";
import type { BrowserCommand, StartBrowserRequest } from "@/contracts/browser";
import { ApiHttpError, badRequest } from "@/server/http/errors";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function publicAddress(ip: string): boolean {
  // Use IPv4 only. This also excludes mapped IPv6, NAT64, local and transition ranges.
  if (isIP(ip) !== 4) return false;
  const [a = 0, b = 0, c = 0] = ip.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}
export function validateHost(host: unknown): string {
  if (typeof host !== "string" || host.length > 253 || host !== host.toLowerCase() ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ||
    /\.(?:localhost|local|internal|test|invalid)$/.test(host) || isIP(host)) throw badRequest("Use exact public DNS hostnames without wildcards or ports");
  return host;
}
export function scopedUrl(raw: unknown, hosts: string[]): URL {
  if (typeof raw !== "string" || raw.length > 2048) throw badRequest("Invalid browser URL");
  let url: URL;
  try { url = new URL(raw); } catch { throw badRequest("Invalid browser URL"); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !hosts.includes(url.hostname)) {
    throw badRequest("Browser navigation must use HTTPS on an explicitly approved host");
  }
  validateHost(url.hostname);
  return url;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest("Expected an object");
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !(key in value))) throw badRequest("Unexpected or missing fields");
}
export function parseStart(value: unknown): StartBrowserRequest {
  const v = object(value);
  exact(v, ["caseId", "expectedRevision", "requestId", "task", "startUrl", "allowedHosts"]);
  if (typeof v.caseId !== "string" || !UUID.test(v.caseId) || typeof v.requestId !== "string" || !UUID.test(v.requestId) ||
    !Number.isSafeInteger(v.expectedRevision) || Number(v.expectedRevision) < 1 ||
    typeof v.task !== "string" || !v.task.trim() || v.task.length > 3000 || !Array.isArray(v.allowedHosts) ||
    v.allowedHosts.length < 1 || v.allowedHosts.length > 12) throw badRequest("Invalid browser start request");
  const hosts = [...new Set(v.allowedHosts.map(validateHost))].sort();
  return { caseId: v.caseId, expectedRevision: Number(v.expectedRevision), requestId: v.requestId,
    task: v.task.trim(), startUrl: scopedUrl(v.startUrl, hosts).href, allowedHosts: hosts };
}
export function parseCommand(value: unknown): BrowserCommand {
  const v = object(value);
  if (v.command === "approve") {
    exact(v, ["command", "pendingActionId", "observationId"]);
    if (typeof v.pendingActionId !== "string" || !UUID.test(v.pendingActionId) || typeof v.observationId !== "string" || !UUID.test(v.observationId)) throw badRequest("Invalid approval");
  } else if (v.command === "reject") {
    exact(v, ["command", "pendingActionId"]);
    if (typeof v.pendingActionId !== "string" || !UUID.test(v.pendingActionId)) throw badRequest("Invalid rejection");
  } else if (v.command === "resume" || v.command === "cancel") exact(v, ["command"]);
  else throw badRequest("Unknown browser command");
  return v as unknown as BrowserCommand;
}
export function sameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const target = new URL(request.url);
  let matches = origin === target.origin;
  // NextURL normalizes loopback IPs to localhost. The browser's Origin and
  // actual Host still agree; require that exact agreement and the same port,
  // rather than allowing localhost and 127.0.0.1 interchangeably as origins.
  if (!matches && origin && target.hostname === "localhost") {
    try {
      const source = new URL(origin);
      matches = source.origin === origin && ["127.0.0.1", "[::1]"].includes(source.hostname)
        && source.protocol === target.protocol && source.port === target.port
        && request.headers.get("host") === source.host;
    } catch { /* Invalid origins remain rejected. */ }
  }
  if (!origin || !matches || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new ApiHttpError(403, "ORIGIN_REQUIRED", "Browser mutations require a same-origin request");
  }
}
export async function boundedJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw badRequest("JSON content type required");
  const reader = request.body?.getReader();
  if (!reader) throw badRequest("JSON body required");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 16_384) { await reader.cancel(); throw new ApiHttpError(413, "PAYLOAD_TOO_LARGE", "Browser request is too large"); }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw badRequest("Invalid JSON"); }
  } finally { reader.releaseLock(); }
}
export type Resolve = (host: string) => Promise<{ address: string; family: number }[]>;
export async function resolvePublic(host: string, resolve: Resolve = h => lookup(h, { all: true, family: 4 }), signal?: AbortSignal): Promise<string> {
  const hostname = validateHost(host);
  if (signal?.aborted) throw new Error("REQUEST_ABORTED");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  // dns.lookup itself cannot be cancelled. Stop waiting and discard its eventual
  // result so cancellation can never turn a late DNS answer into an HTTP request.
  const interruption = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("REQUEST_ABORTED"));
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => reject(new Error("DNS_TIMEOUT")), 5000); timer.unref();
  });
  try {
    const addresses = await Promise.race([resolve(hostname), interruption]);
    if (signal?.aborted) throw new Error("REQUEST_ABORTED");
    if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error("NETWORK_SCOPE_BLOCKED");
    return addresses[0]!.address;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
/** Browser never connects directly: every HTTPS request is fulfilled through this pinned-IP transport. */
export async function pinnedRequest(input: { url: string; hosts: string[]; method: string; headers: Record<string, string>; body: Buffer | null; signal?: AbortSignal }): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const url = scopedUrl(input.url, input.hosts);
  const address = await resolvePublic(url.hostname, undefined, input.signal);
  // Also cover cancellation between DNS resolution and this continuation.
  if (input.signal?.aborted) throw new Error("REQUEST_ABORTED");
  const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  return new Promise((resolve, reject) => {
    const headers = { ...input.headers, host: url.host, "accept-encoding": "identity" };
    for (const key of Object.keys(headers)) if (/^(proxy-|connection$|transfer-encoding$|upgrade$)/i.test(key)) delete headers[key as keyof typeof headers];
    const req = https.request(url, { method: input.method, headers, agent: false, family: 4,
      lookup: (_host, _options, callback) => callback(null, address, 4),
      timeout: 15_000, signal,
    }, response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 15 * 1024 * 1024) req.destroy(new Error("RESOURCE_TOO_LARGE")); else chunks.push(chunk); });
      response.on("error", () => reject(new Error("RESOURCE_REQUEST_FAILED")));
      response.on("end", () => {
        const result: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers)) if (value !== undefined && !/^(transfer-encoding|connection|content-length)$/i.test(key)) result[key] = Array.isArray(value) ? value.join("\n") : String(value);
        // Redirects are not followed by Node. The browser's redirected request re-enters the same guard.
        resolve({ status: response.statusCode ?? 502, headers: result, body: Buffer.concat(chunks) });
      });
    });
    req.on("timeout", () => req.destroy(new Error("RESOURCE_TIMEOUT")));
    req.on("error", () => reject(new Error("RESOURCE_REQUEST_FAILED")));
    req.end(input.body ?? undefined);
  });
}
