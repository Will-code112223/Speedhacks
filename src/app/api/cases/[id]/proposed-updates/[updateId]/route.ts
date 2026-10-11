import { getCaseService } from "@/server/cases/composition";
import { badRequest, notFound } from "@/server/http/errors";
import { handle, json, readJson } from "@/server/http/respond";
import { readSession, requireAccess } from "@/server/http/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/cases/:id/proposed-updates/:updateId — {decision: "accept"|"reject", expectedRevision}. V1.1. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string; updateId: string }> }): Promise<Response> {
  return handle(async () => {
    requireAccess(request);
    const session = readSession(request);
    if (!session) throw notFound();
    const { id, updateId } = await ctx.params;
    const body = await readJson(request);
    const expectedRevision = body.expectedRevision;
    if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw badRequest("expectedRevision must be a positive integer", ["expectedRevision"]);
    }
    if (body.decision !== "accept" && body.decision !== "reject") {
      throw badRequest('decision must be "accept" or "reject"', ["decision"]);
    }
    return json({ case: getCaseService().reviewProposedUpdate(session, id, updateId, body.decision, expectedRevision) });
  });
}
