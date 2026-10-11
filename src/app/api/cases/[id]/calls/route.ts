import { getCaseService } from "@/server/cases/composition";
import { badRequest, notFound } from "@/server/http/errors";
import { handle, json, readJson } from "@/server/http/respond";
import { readSession } from "@/server/http/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/cases/:id/calls — {authorizationId, requestId}; 202 with the stored attempt. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const session = readSession(request);
    if (!session) throw notFound();
    const { id } = await ctx.params;
    const body = await readJson(request);
    const { authorizationId, requestId } = body;
    if (typeof authorizationId !== "string") throw badRequest("authorizationId is required", ["authorizationId"]);
    if (typeof requestId !== "string") throw badRequest("requestId is required", ["requestId"]);
    const call = await getCaseService().startCall(session, id, { authorizationId, requestId });
    return json({ call }, 202);
  });
}
