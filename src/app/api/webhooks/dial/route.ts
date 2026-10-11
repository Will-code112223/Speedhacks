import { getCaseService } from "@/server/cases/composition";
import { badRequest } from "@/server/http/errors";
import { handle, json } from "@/server/http/respond";

const MAX_BODY_BYTES = 1_048_576;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/dial — exact raw bytes and headers go to the voice
 * adapter's verifyWebhook before anything is trusted. 204 only after the
 * event is durably stored (duplicates included); 401 on failed verification.
 */
export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const declared = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw badRequest("Webhook body exceeds 1 MiB");
    const rawBody = new Uint8Array(await request.arrayBuffer());
    if (rawBody.byteLength > MAX_BODY_BYTES) throw badRequest("Webhook body exceeds 1 MiB");
    const result = await getCaseService().handleWebhook(rawBody, request.headers);
    if (result.status === 401) return json(result.body, 401);
    return new Response(null, { status: 204 });
  });
}
