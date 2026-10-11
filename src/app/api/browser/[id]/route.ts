import { getBrowserService } from "@/server/browser/composition";
import { browserHandle, browserJson, browserOwner } from "@/server/browser/http";
import { boundedJson, sameOrigin } from "@/server/browser/security";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context): Promise<Response> {
  return browserHandle(async () => browserJson({ run: getBrowserService().get(browserOwner(request), (await context.params).id) }));
}
export async function POST(request: Request, context: Context): Promise<Response> {
  return browserHandle(async () => {
    sameOrigin(request); const owner = browserOwner(request);
    return browserJson({ run: await getBrowserService().command(owner, (await context.params).id, await boundedJson(request)) });
  });
}
