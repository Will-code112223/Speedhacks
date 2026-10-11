import { getBrowserService } from "@/server/browser/composition";
import { browserHandle, browserJson, browserOwner } from "@/server/browser/http";
import { boundedJson, sameOrigin, UUID } from "@/server/browser/security";
import { badRequest } from "@/server/http/errors";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response> {
  return browserHandle(async () => {
    sameOrigin(request); const owner = browserOwner(request);
    return browserJson({ run: await getBrowserService().start(owner, await boundedJson(request)) }, 202);
  });
}
/** Recover an uncertain HTTP start response using the same immutable request ID. */
export async function GET(request: Request): Promise<Response> {
  return browserHandle(async () => {
    const owner = browserOwner(request); const url = new URL(request.url);
    const caseId = url.searchParams.get("caseId") ?? ""; const requestId = url.searchParams.get("requestId") ?? "";
    if (!UUID.test(caseId) || !UUID.test(requestId)) throw badRequest("caseId and requestId must be UUIDs");
    return browserJson({ run: getBrowserService().find(owner, caseId, requestId) });
  });
}
