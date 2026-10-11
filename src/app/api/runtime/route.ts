import { getRuntimeReadiness } from "@/server/config";
import { json } from "@/server/http/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Configuration presence only; never probes providers, places calls or launches a browser. */
export async function GET(): Promise<Response> {
  return json(getRuntimeReadiness(), 200, { "cache-control": "no-store" });
}
