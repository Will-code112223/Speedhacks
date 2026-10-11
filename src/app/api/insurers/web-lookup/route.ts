import { requireAccess } from "@/server/http/session";
import { handle, json } from "@/server/http/respond";
import { ApiHttpError } from "@/server/http/errors";
import { isEmptyLookup, webLookupInsurerContact } from "@/server/insurers/web-lookup";

export const runtime = "nodejs";

/**
 * Web lookup for an insurer the local registry cannot answer.
 *   GET /api/insurers/web-lookup?name=Blue%20Shield%20of%20California&region=CA
 *     -> { lookup: { insurerName, claimsPhone, claimsUrl, summary, sources, retrievedAt, provider } }
 *     -> 404 WEB_LOOKUP_EMPTY when nothing citable was found
 * The answer is a candidate the user may accept; nothing is filled in or dialed here.
 */

const LIMIT_PER_HOUR = 20;
const WINDOW_MS = 60 * 60 * 1000;
/** Lookup timestamps (ms) for this process, rolling window. */
let lookups: number[] = [];

function assertLookupAllowed(nowMs: number): void {
  lookups = lookups.filter((t) => t > nowMs - WINDOW_MS);
  if (lookups.length >= LIMIT_PER_HOUR) {
    throw new ApiHttpError(429, "RATE_LIMITED", `This server has run ${LIMIT_PER_HOUR} web lookups in the last hour, the limit. Try again later.`);
  }
  lookups.push(nowMs);
}

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    requireAccess(request);
    const params = new URL(request.url).searchParams;
    const name = params.get("name")?.trim() ?? "";
    const region = params.get("region")?.trim() || null;
    if (!name) throw new ApiHttpError(400, "BAD_REQUEST", "name is required");
    if (name.length > 200) throw new ApiHttpError(400, "BAD_REQUEST", "name is too long");
    if (region !== null && region.length > 100) throw new ApiHttpError(400, "BAD_REQUEST", "region is too long");
    assertLookupAllowed(Date.now());
    const lookup = await webLookupInsurerContact({ name, region });
    if (isEmptyLookup(lookup)) {
      throw new ApiHttpError(
        404,
        "WEB_LOOKUP_EMPTY",
        `No official claims number or claims page for "${name}" could be cited from the web. Use the number on your insurance ID card.`,
      );
    }
    return json({ lookup });
  });
}
