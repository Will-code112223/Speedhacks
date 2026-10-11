import { getCaseService } from "@/server/cases/composition";
import type { UploadInput } from "@/server/documents/storage";
import { ApiHttpError, badRequest, notFound } from "@/server/http/errors";
import { handle, json } from "@/server/http/respond";
import { readSession, requireAccess } from "@/server/http/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 5 files x 10 MB plus 1 MB for multipart framing. */
const MAX_UPLOAD_BODY_BYTES = 5 * 10 * 1024 * 1024 + 1024 * 1024;

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/cases/:id/files — multipart/form-data: repeated "files". */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    requireAccess(request);
    const session = readSession(request);
    if (!session) throw notFound();
    const { id } = await ctx.params;
    // Reject an oversized body before buffering it.
    const declared = Number.parseInt(request.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BODY_BYTES) {
      throw new ApiHttpError(413, "PAYLOAD_TOO_LARGE", `Upload exceeds ${MAX_UPLOAD_BODY_BYTES} bytes`, ["files"]);
    }
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw badRequest("Body must be multipart/form-data");
    }
    const files: UploadInput[] = [];
    for (const entry of form.getAll("files")) {
      if (typeof entry === "string") throw badRequest("files must be file parts", ["files"]);
      files.push({ name: entry.name, mimeType: entry.type, bytes: new Uint8Array(await entry.arrayBuffer()) });
    }
    if (files.length === 0) throw badRequest("Provide at least one file", ["files"]);
    return json({ case: await getCaseService().addEvidence(session, id, files) });
  });
}
