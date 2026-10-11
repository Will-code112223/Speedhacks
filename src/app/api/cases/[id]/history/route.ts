import { getCaseService } from "@/server/cases/composition";
import { notFound } from "@/server/http/errors";
import { handle, json } from "@/server/http/respond";
import { readSession } from "@/server/http/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/cases/:id/history — the stored pre-authorization transaction-history check
 * (Keewano or fixture) as { history: HistoryCheck | null, current: boolean }. `current` is
 * false when the facts changed since the check ran; GET /api/cases/:id re-checks on read.
 * Session-bound like GET /api/cases/:id: unknown or foreign cases are 404.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const session = readSession(request);
    if (!session) throw notFound();
    const { id } = await ctx.params;
    return json(getCaseService().history(session, id));
  });
}
