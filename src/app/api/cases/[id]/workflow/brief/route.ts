import { getWorkflowService } from "@/server/workflows/composition";
import { owner, WORKFLOW_HEADERS, workflowHandle } from "@/server/workflows/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return workflowHandle(async () => {
    const { workflow } = getWorkflowService().get(owner(request), (await context.params).id);
    return new Response(workflow.brief.body, { headers: { ...WORKFLOW_HEADERS, "content-type": "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename="case-preparation-r${workflow.caseRevision}.txt"`, "content-security-policy": "sandbox" } });
  });
}
