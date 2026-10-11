import { getCaseService } from "@/server/cases/composition";
import { validateChanges } from "@/server/cases/facts";
import { CALL_PLAN_LIMITS } from "@/contracts/voice";
import { ApiHttpError, badRequest, notFound } from "@/server/http/errors";
import { handle, json, readJson } from "@/server/http/respond";
import { readSession, requireAccess } from "@/server/http/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/cases/:id */
export async function GET(request: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    requireAccess(request);
    const session = readSession(request);
    if (!session) throw notFound();
    const { id } = await ctx.params;
    return json({ case: await getCaseService().getCase(session, id) });
  });
}

/** PATCH /api/cases/:id — {expectedRevision, changes} */
export async function PATCH(request: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    requireAccess(request);
    const session = readSession(request);
    if (!session) throw notFound();
    const { id } = await ctx.params;
    const body = await readJson(request);
    const expectedRevision = body.expectedRevision;
    if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw badRequest("expectedRevision must be a positive integer", ["expectedRevision"]);
    }
    const rawReason = (body.changes as Record<string, unknown> | null | undefined)?.reason;
    if (typeof rawReason === "string" && rawReason.trim().length > CALL_PLAN_LIMITS.reasonChars) {
      throw new ApiHttpError(422, "SUMMARY_TOO_LONG", `summary must be at most ${CALL_PLAN_LIMITS.reasonChars} characters`, ["summary"]);
    }
    const { changes, invalid } = validateChanges(body.changes);
    if (invalid.length > 0) throw badRequest(`Invalid changes: ${invalid.join(", ")}`, invalid);
    return json({ case: getCaseService().patchCase(session, id, expectedRevision, changes) });
  });
}
