import { getCaseService } from "@/server/cases/composition";
import { notFound } from "@/server/http/errors";
import { handle, json } from "@/server/http/respond";
import { readSession, requireAccess } from "@/server/http/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/cases/:id/calls/:callId/reconcile - resolves a dispatch_unknown attempt by an
 * idempotent replay (same Idempotency-Key, same frozen body) or, past the replay window,
 * by marking it failed without contacting the provider. Any other state is returned as is.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string; callId: string }> }): Promise<Response> {
  return handle(async () => {
    requireAccess(request);
    const session = readSession(request);
    if (!session) throw notFound();
    const { id, callId } = await ctx.params;
    const call = await getCaseService().reconcileUnknownCall(session, id, callId);
    return json({ call });
  });
}
