import { CALL_PURPOSES, type CallPurpose } from "@/contracts/voice";
import { getCaseService } from "@/server/cases/composition";
import { badRequest, notFound } from "@/server/http/errors";
import { handle, json } from "@/server/http/respond";
import { readSession, requireAccess } from "@/server/http/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/cases/:id/plan?purpose=<CallPurpose> -> { plan: ResolutionPlanV1 }
 * Read-only: never freezes or authorizes anything. purpose defaults to the case's
 * suggestedPurpose; once the current revision is authorized the frozen plan is returned.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    requireAccess(request);
    const session = readSession(request);
    if (!session) throw notFound();
    const { id } = await ctx.params;
    const raw = new URL(request.url).searchParams.get("purpose");
    if (raw !== null && !(CALL_PURPOSES as readonly string[]).includes(raw)) {
      throw badRequest(`purpose must be one of ${CALL_PURPOSES.join(", ")}`, ["purpose"]);
    }
    const purpose = raw === null ? undefined : (raw as CallPurpose);
    return json({ plan: getCaseService().resolutionPlan(session, id, purpose) }, 200, { "cache-control": "no-store" });
  });
}
