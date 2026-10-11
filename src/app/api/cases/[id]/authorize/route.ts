import { CALL_PURPOSES, type CallPurpose } from "@/contracts/voice";
import { getCaseService } from "@/server/cases/composition";
import { badRequest, notFound } from "@/server/http/errors";
import { handle, json, readJson } from "@/server/http/respond";
import { readSession } from "@/server/http/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/cases/:id/authorize — {expectedRevision, purpose?}; idempotent per revision. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const session = readSession(request);
    if (!session) throw notFound();
    const { id } = await ctx.params;
    const body = await readJson(request);
    const expectedRevision = body.expectedRevision;
    if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw badRequest("expectedRevision must be a positive integer", ["expectedRevision"]);
    }
    // V1.1: absent purpose = "request_refund" (V1 behavior).
    const purpose = body.purpose === undefined ? "request_refund" : body.purpose;
    if (!CALL_PURPOSES.includes(purpose as CallPurpose)) {
      throw badRequest(`purpose must be one of ${CALL_PURPOSES.join(", ")}`, ["purpose"]);
    }
    return json({ case: getCaseService().authorize(session, id, expectedRevision, purpose as CallPurpose) });
  });
}
