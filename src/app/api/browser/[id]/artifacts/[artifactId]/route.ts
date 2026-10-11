import { getBrowserService } from "@/server/browser/composition";
import { browserHandle, browserOwner, PRIVATE_HEADERS } from "@/server/browser/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string; artifactId: string }> }): Promise<Response> {
  return browserHandle(async () => {
    const owner = browserOwner(request); const { id, artifactId } = await context.params;
    const artifact = getBrowserService().artifact(owner, id, artifactId);
    const name = artifact.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "document";
    return new Response(new Uint8Array(artifact.bytes), { headers: { ...PRIVATE_HEADERS, "content-type": artifact.mimeType,
      "content-disposition": `attachment; filename="${name}"`, "content-security-policy": "sandbox" } });
  });
}
