import { getCaseService } from "@/server/cases/composition";
import { badRequest } from "@/server/http/errors";
import { handle, json } from "@/server/http/respond";

const MAX_BODY_BYTES = 1_048_576;

/** Reads at most MAX_BODY_BYTES; cancels the stream and returns null as soon as the cap is exceeded. */
async function readBounded(request: Request): Promise<Uint8Array | null> {
  const declared = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const body = request.body;
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const raw = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return raw;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/dial — exact raw bytes and headers go to the voice
 * adapter's verifyWebhook before anything is trusted. 204 only after the
 * event is durably stored (duplicates included); 401 on failed verification.
 */
export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    let rawBody: Uint8Array | null;
    try {
      rawBody = await readBounded(request);
    } catch {
      throw badRequest("Webhook body could not be read");
    }
    if (rawBody === null) {
      return json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Webhook body exceeds 1 MiB" } }, 413);
    }
    const result = await getCaseService().handleWebhook(rawBody, request.headers);
    if (result.status === 401) return json(result.body, 401);
    return new Response(null, { status: 204 });
  });
}
