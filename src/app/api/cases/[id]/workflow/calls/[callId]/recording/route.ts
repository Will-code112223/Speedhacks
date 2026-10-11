import { getDialRecording } from "@/integrations/dial/recording";
import { loadConfig } from "@/server/config";
import { ApiHttpError } from "@/server/http/errors";
import { getWorkflowCallService } from "@/server/workflows/call-composition";
import { owner, WORKFLOW_HEADERS, workflowHandle } from "@/server/workflows/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string; callId: string }> }): Promise<Response> {
  return workflowHandle(async () => {
    const { id, callId } = await context.params;
    // Resolve the owned stored attempt first. A caller can never supply a provider ID or media URL.
    const call = getWorkflowCallService().get(owner(request), id, callId);
    if (!call.providerCallId || !["completed", "failed", "cancelled"].includes(call.state)) {
      throw new ApiHttpError(404, "RECORDING_UNAVAILABLE", "The recording is not available yet.");
    }
    const recording = await getDialRecording(call.providerCallId, { apiKey: loadConfig().dial.apiKey ?? undefined });
    if (recording.state !== "available") {
      throw new ApiHttpError(recording.reason === "not_available" ? 404 : 503, "RECORDING_UNAVAILABLE",
        "Dial has not provided a playable recording. The transcript remains available separately.");
    }
    return new Response(Buffer.from(recording.bytes), { headers: {
      ...WORKFLOW_HEADERS,
      "content-type": recording.contentType,
      "content-length": String(recording.bytes.byteLength),
      "content-disposition": "inline",
      "content-security-policy": "sandbox",
    } });
  });
}
