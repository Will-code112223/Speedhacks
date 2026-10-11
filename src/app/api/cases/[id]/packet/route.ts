import { getCaseService } from "@/server/cases/composition";
import { notFound } from "@/server/http/errors";
import { handle } from "@/server/http/respond";
import { readSession } from "@/server/http/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/cases/:id/packet — downloadable text/plain refund request with evidence index. */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const session = readSession(request);
    if (!session) throw notFound();
    const { id } = await ctx.params;
    const text = getCaseService().packet(session, id);
    return new Response(text, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename="refund-request-${id}.txt"`,
        "cache-control": "no-store",
      },
    });
  });
}
