import { getWorkflowCallService } from "@/server/workflows/call-composition";
import { callStartRequest } from "@/server/workflows/call-http";
import { owner, sameOrigin, workflowHandle, workflowJson } from "@/server/workflows/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context): Promise<Response> {
  return workflowHandle(async () => workflowJson(await getWorkflowCallService().list(owner(request), (await context.params).id, { refresh: new URL(request.url).searchParams.get("refresh") === "1" })));
}
export async function POST(request: Request, context: Context): Promise<Response> {
  return workflowHandle(async () => { sameOrigin(request); const session = owner(request);
    return workflowJson(await getWorkflowCallService().start(session, (await context.params).id, await callStartRequest(request))); });
}
