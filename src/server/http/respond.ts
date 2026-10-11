import { ApiHttpError } from "@/server/http/errors";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export function json(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(JSON_HEADERS);
  if (extraHeaders) new Headers(extraHeaders).forEach((v, k) => headers.append(k, v));
  return new Response(JSON.stringify(body), { status, headers });
}

/** Wrap a route handler so ApiHttpError becomes an ApiError body and anything else a 500. */
export async function handle(fn: () => Promise<Response> | Response): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiHttpError) return json(err.toBody(), err.status);
    console.error("[api] unhandled error", err);
    return json({ error: { code: "INTERNAL", message: "Internal server error" } }, 500);
  }
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiHttpError(400, "BAD_REQUEST", "Body must be valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiHttpError(400, "BAD_REQUEST", "Body must be a JSON object");
  }
  return body as Record<string, unknown>;
}
