import { getWorkflowService } from "@/server/workflows/composition";
import { multipart, owner, sameOrigin, workflowHandle, workflowJson } from "@/server/workflows/http";
import { badRequest } from "@/server/http/errors";
import type { UploadInput } from "@/server/documents/storage";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return workflowHandle(async () => {
    sameOrigin(request); const session = owner(request); const id = (await context.params).id;
    // Ownership before materializing or accepting an upload.
    const service = getWorkflowService(); service.get(session, id);
    const form = await multipart(request);
    if ([...form.keys()].some(key => !["requestId", "expectedRevision", "message", "files"].includes(key)) ||
      ["requestId", "expectedRevision", "message"].some(key => form.getAll(key).length > 1)) throw badRequest("Unexpected evidence fields");
    const requestId = form.get("requestId"); const revision = form.get("expectedRevision"); const message = form.get("message");
    if (typeof requestId !== "string" || typeof revision !== "string" || !/^[1-9]\d{0,8}$/.test(revision) || (message !== null && typeof message !== "string")) throw badRequest("Invalid evidence request");
    const entries = form.getAll("files"); if (!entries.length || entries.length > 5) throw badRequest("Provide one to five evidence files", ["files"]);
    const files: UploadInput[] = [];
    for (const entry of entries) { if (typeof entry === "string") throw badRequest("files must contain file parts"); files.push({ name: entry.name, mimeType: entry.type, bytes: new Uint8Array(await entry.arrayBuffer()) }); }
    return workflowJson(await service.evidence(session, id, { requestId, expectedRevision: Number(revision), message: message ?? undefined, files }));
  });
}
