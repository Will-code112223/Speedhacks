import { handle, json } from "@/server/http/respond";
import { ApiHttpError } from "@/server/http/errors";
import { listInsurers, lookupInsurer } from "@/server/insurers";

export const runtime = "nodejs";

/**
 * Read-only insurer knowledge base.
 *   GET /api/insurers            -> { insurers: InsurerSummary[] }   (for plan onboarding pick-lists)
 *   GET /api/insurers?name=Geico -> { insurer: InsurerLookup }       (404 when unknown or ambiguous)
 * Reference data only: no customer data, so no session binding is required.
 */
export async function GET(request: Request): Promise<Response> {
  return handle(() => {
    const name = new URL(request.url).searchParams.get("name")?.trim() ?? "";
    if (!name) return json({ insurers: listInsurers() });
    if (name.length > 200) throw new ApiHttpError(400, "BAD_REQUEST", "name is too long");
    const insurer = lookupInsurer(name);
    if (!insurer) throw new ApiHttpError(404, "NOT_FOUND", `No insurer matches "${name}"`);
    return json({ insurer });
  });
}
