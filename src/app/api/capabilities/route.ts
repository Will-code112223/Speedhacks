import { handle, json } from "@/server/http/respond";
import { configuredAccessCode } from "@/server/http/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/capabilities — feature probe for the frontend's V2 call screen
 * (docs/handoffs/frontend.txt "V2 PROPOSAL"). V1 has no live-call stream, no step-in and
 * no mid-call decisions, so those flags are an explicit false. No session or access cookie needed.
 */
export async function GET(): Promise<Response> {
  // accessRequired: APP_ACCESS_CODE is set, so the UI must POST /api/access before anything else.
  return handle(() => json({ liveCall: false, stepIn: false, decisions: false, accessRequired: configuredAccessCode() !== null }));
}
