/** When the hooks poll, and which failures are worth another try. */

import { ACTIVE_CALL_STATES, type CaseV1 } from "../../../contracts/case";
import { ApiRequestError, ApiUnreachableError, type LiveCallV2 } from "./types";

/**
 * A case changes on its own only while a call is in flight: status `calling`,
 * or any call still active. `dispatch_unknown` counts as active because it
 * stays open until someone reconciles it.
 */
export function shouldPollCase(c: CaseV1): boolean {
  return c.status === "calling" || c.calls.some((call) => ACTIVE_CALL_STATES.includes(call.state));
}

/** A live call is polled until it ends; null means the record does not exist yet. */
export function shouldPollLiveCall(live: LiveCallV2 | null): boolean {
  return live === null || live.phase !== "ended";
}

/** The network or the server failed rather than the request itself, so the next tick may succeed. */
export function isTransientError(error: unknown): boolean {
  if (error instanceof ApiUnreachableError) return true;
  if (error instanceof ApiRequestError) {
    return error.status === 429 || (error.status >= 500 && error.status !== 501);
  }
  return false;
}
