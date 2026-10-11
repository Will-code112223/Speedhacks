import { getBrowserService } from "@/server/browser/composition";
import { browserHandle, browserJson, browserOwner } from "@/server/browser/http";
import { boundedJson, sameOrigin } from "@/server/browser/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return browserHandle(async () => {
    sameOrigin(request);
    return browserJson({ run: await getBrowserService().startPreparation(browserOwner(request), (await context.params).id, await boundedJson(request)) }, 202);
  });
}
