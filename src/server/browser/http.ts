import { ApiHttpError, notFound } from "@/server/http/errors";
import { readSession } from "@/server/http/session";
export const PRIVATE_HEADERS = { "cache-control": "private, no-store, max-age=0", pragma: "no-cache", vary: "Cookie", "x-content-type-options": "nosniff" };
export function browserOwner(request: Request): string {
  const owner = readSession(request); if (!owner) throw notFound("Browser run not found"); return owner;
}
export function browserJson(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: PRIVATE_HEADERS });
}
export async function browserHandle(fn: () => Promise<Response>): Promise<Response> {
  try { return await fn(); }
  catch (error) {
    if (error instanceof ApiHttpError) return browserJson(error.toBody(), error.status);
    // Provider bodies, URLs, uploaded text and credentials must never enter logs or error responses.
    return browserJson({ error: { code: "BROWSER_UNAVAILABLE", message: "Browser operation unavailable. No automatic retry was performed." } }, 503);
  }
}
