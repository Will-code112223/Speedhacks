import { getWorkflowCallService } from "@/server/workflows/call-composition";
import { callAuthorizeRequest } from "@/server/workflows/call-http";
import { owner, sameOrigin, workflowHandle, workflowJson } from "@/server/workflows/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context): Promise<Response> {
  return workflowHandle(async () => { sameOrigin(request); const session = owner(request);
    return workflowJson(getWorkflowCallService().authorize(session, (await context.params).id, await callAuthorizeRequest(request))); });
}
