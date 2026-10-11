import { getWorkflowService } from "@/server/workflows/composition";
import { messageRequest, owner, sameOrigin, workflowHandle, workflowJson } from "@/server/workflows/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context): Promise<Response> {
  return workflowHandle(async () => workflowJson(getWorkflowService().get(owner(request), (await context.params).id)));
}
export async function POST(request: Request, context: Context): Promise<Response> {
  return workflowHandle(async () => { sameOrigin(request); const session = owner(request);
    return workflowJson(await getWorkflowService().analyze(session, (await context.params).id, await messageRequest(request, true))); });
}
