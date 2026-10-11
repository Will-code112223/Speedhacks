import { ApiHttpError, badRequest } from "@/server/http/errors";
import { handle, readJson } from "@/server/http/respond";
import { accessCodeMatches, accessCookieHeader, configuredAccessCode } from "@/server/http/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/access - {code}. When APP_ACCESS_CODE is set and the code matches, sets the
 * httpOnly recourse_access cookie and answers 204; a wrong code is 401 ACCESS_REQUIRED.
 * With no code configured there is nothing to unlock, so it answers 204 without a cookie.
 */
export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const code = configuredAccessCode();
    if (code === null) return new Response(null, { status: 204 });
    const body = await readJson(request);
    if (typeof body.code !== "string" || body.code.length === 0 || body.code.length > 256) {
      throw badRequest("code is required", ["code"]);
    }
    if (!accessCodeMatches(body.code, code)) {
      throw new ApiHttpError(401, "ACCESS_REQUIRED", "That access code is not correct", ["code"]);
    }
    return new Response(null, { status: 204, headers: { "set-cookie": accessCookieHeader(code) } });
  });
}
