import { getCaseService } from "@/server/cases/composition";
import { badRequest } from "@/server/http/errors";
import { handle, json } from "@/server/http/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/insights/merchant?name=<merchant> — the merchant's refund track record from
 * the cases mirrored into Keewano (or the labeled fixture): { available, ...MerchantRecord }.
 * Always 200 once the name is valid: no source or a failed query answers available:false.
 * Aggregate reference data only (no customer data), so no session cookie is required.
 */
export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const name = new URL(request.url).searchParams.get("name")?.trim() ?? "";
    if (!name) throw badRequest("name is required", ["name"]);
    if (name.length > 200) throw badRequest("name is too long", ["name"]);
    return json(await getCaseService().merchantInsights(name));
  });
}
