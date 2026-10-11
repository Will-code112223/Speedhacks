import { getBrowserService } from "@/server/browser/composition";
import { browserHandle, browserOwner, PRIVATE_HEADERS } from "@/server/browser/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return browserHandle(async () => {
    const image = await getBrowserService().frame(browserOwner(request), (await context.params).id);
    return new Response(new Uint8Array(image), { headers: { ...PRIVATE_HEADERS, "content-type": "image/jpeg" } });
  });
}
