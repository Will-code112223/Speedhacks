import { getCaseService } from "@/server/cases/composition";
import { notFound } from "@/server/http/errors";
import { handle, json, readJson } from "@/server/http/respond";
import { readSession } from "@/server/http/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/cases/:id/summary { channel: "email" | "sms", to } -> { delivery: SummaryDelivery }.
 * Text messages go out through Dial (simulated mode uses a stub); email is composed only.
 * A repeat for the same call, channel and destination returns the stored delivery.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const session = readSession(request);
    if (!session) throw notFound();
    const { id } = await ctx.params;
    const body = await readJson(request);
    const delivery = await getCaseService().sendSummary(session, id, body);
    return json({ delivery }, 200);
  });
}
