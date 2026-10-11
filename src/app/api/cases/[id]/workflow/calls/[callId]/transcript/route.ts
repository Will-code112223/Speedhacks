import { getWorkflowCallService } from "@/server/workflows/call-composition";
import { owner, workflowHandle, WORKFLOW_HEADERS } from "@/server/workflows/http";
import { ApiHttpError } from "@/server/http/errors";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; callId: string }> };
export async function GET(request: Request, context: Context): Promise<Response> {
  return workflowHandle(async () => {
    const { id, callId } = await context.params;
    const call = getWorkflowCallService().get(owner(request), id, callId);
    if (!call.transcript?.trim()) throw new ApiHttpError(404, "TRANSCRIPT_UNAVAILABLE", "No transcript is available for this call yet. Refresh the existing call; do not redial.");
    return new Response(call.transcript, { headers: { ...WORKFLOW_HEADERS, "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="call-${call.id}-transcript.txt"` } });
  });
}
