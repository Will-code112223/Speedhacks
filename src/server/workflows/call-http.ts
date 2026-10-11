import type { WorkflowCallAuthorizeRequest, WorkflowCallStartRequest } from "@/contracts/workflow-call";
import { boundedJson } from "@/server/browser/security";
import { badRequest } from "@/server/http/errors";

async function exactBody(request: Request, keys: string[]): Promise<Record<string, unknown>> {
  const body = await boundedJson(request);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key)) || keys.some(key => !(key in body))) throw badRequest("Unexpected or missing call request fields.");
  return body as Record<string, unknown>;
}
export async function callAuthorizeRequest(request: Request): Promise<WorkflowCallAuthorizeRequest> {
  const body = await exactBody(request, ["requestId", "expectedRevision", "actionId", "to", "maxDurationSeconds", "recipientConfirmed"]);
  if (typeof body.requestId !== "string" || typeof body.actionId !== "string" || typeof body.to !== "string" || typeof body.expectedRevision !== "number" || typeof body.maxDurationSeconds !== "number" || body.recipientConfirmed !== true) throw badRequest("Invalid call approval.");
  return body as unknown as WorkflowCallAuthorizeRequest;
}
export async function callStartRequest(request: Request): Promise<WorkflowCallStartRequest> {
  const body = await exactBody(request, ["requestId", "authorizationId"]);
  if (typeof body.requestId !== "string" || typeof body.authorizationId !== "string") throw badRequest("Invalid call start request.");
  return body as unknown as WorkflowCallStartRequest;
}
