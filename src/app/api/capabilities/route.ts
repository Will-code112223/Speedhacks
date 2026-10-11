import { handle, json } from "@/server/http/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/capabilities — feature probe for the frontend's V2 call screen
 * (docs/handoffs/frontend.txt "V2 PROPOSAL"). V1 has no live-call stream, no step-in and
 * no mid-call decisions, so every flag is an explicit false. No session needed.
 */
export async function GET(): Promise<Response> {
  return handle(() => json({ liveCall: false, stepIn: false, decisions: false }));
}
