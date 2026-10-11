import { ApiHttpError, badRequest, notFound } from "@/server/http/errors";
import { readSession } from "@/server/http/session";
import { boundedJson, sameOrigin, UUID } from "@/server/browser/security";
import type { WorkflowMessageRequest } from "@/contracts/workflow";
export { sameOrigin };
export const WORKFLOW_HEADERS = { "cache-control": "private, no-store", vary: "Cookie", "x-content-type-options": "nosniff" };
export function owner(request: Request): string { const session = readSession(request); if (!session) throw notFound(); return session; }
export function workflowJson(data: unknown): Response { return Response.json(data, { headers: WORKFLOW_HEADERS }); }
export async function workflowHandle(fn: () => Promise<Response> | Response): Promise<Response> {
  try { return await fn(); } catch (error) {
    if (error instanceof ApiHttpError) return Response.json(error.toBody(), { status: error.status, headers: WORKFLOW_HEADERS });
    return Response.json({ error: { code: "WORKFLOW_UNAVAILABLE", message: "Interview operation unavailable; refresh the saved case before retrying." } }, { status: 503, headers: WORKFLOW_HEADERS });
  }
}
export async function messageRequest(request: Request, analyze = false): Promise<WorkflowMessageRequest> {
  const input = await boundedJson(request);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw badRequest("Expected interview request");
  const body = input as Record<string, unknown>;
  const keys = analyze ? ["requestId", "expectedRevision"] : ["requestId", "expectedRevision", "message"];
  if (Object.keys(body).some(key => !keys.includes(key)) || keys.some(key => !(key in body)) || typeof body.requestId !== "string" || !UUID.test(body.requestId) ||
    !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1 || (!analyze && (typeof body.message !== "string" || !body.message.trim() || body.message.length > 5000))) throw badRequest("Invalid interview request");
  return { requestId: body.requestId, expectedRevision: Number(body.expectedRevision), message: analyze ? "" : body.message as string };
}
/** Bound total multipart bytes before parsing, including clients omitting Content-Length. */
export async function multipart(request: Request): Promise<FormData> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data")) throw badRequest("multipart/form-data required");
  const maximum = 51 * 1024 * 1024;
  if (Number(request.headers.get("content-length")) > maximum) throw new ApiHttpError(413, "PAYLOAD_TOO_LARGE", "Evidence upload is too large");
  const reader = request.body?.getReader(); if (!reader) throw badRequest("Evidence body required");
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length;
      if (length > maximum) { await reader.cancel(); throw new ApiHttpError(413, "PAYLOAD_TOO_LARGE", "Evidence upload is too large"); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  try { return await new Response(Buffer.concat(chunks), { headers: { "content-type": request.headers.get("content-type")! } }).formData(); }
  catch { throw badRequest("Invalid evidence form"); }
}
