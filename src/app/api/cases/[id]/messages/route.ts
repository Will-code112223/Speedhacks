import { getWorkflowService } from "@/server/workflows/composition";
import { messageRequest, owner, sameOrigin, workflowHandle, workflowJson } from "@/server/workflows/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return workflowHandle(async () => { sameOrigin(request); const session = owner(request);
    return workflowJson(await getWorkflowService().message(session, (await context.params).id, await messageRequest(request))); });
}
