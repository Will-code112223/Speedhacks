/**
 * Turns API failures into what the person reads. Every request error is shown
 * by its code; nothing substitutes fixture data for a failed request.
 */

import { ApiRequestError, ApiUnreachableError } from "../api/types";
import { factKeyForServerField, labelForServerField, type FactKey } from "./facts";

export type UiErrorKind =
  | "missing_facts"
  | "revision_conflict"
  | "authorization_conflict"
  | "call_in_progress"
  | "mode_mismatch"
  | "decision_resolved"
  | "call_not_connected"
  | "call_ended"
  | "conflict"
  | "live_configuration_missing"
  | "provider_unavailable"
  | "unavailable"
  | "unauthorized"
  | "not_found"
  | "not_supported"
  | "contract_violation"
  | "bad_request"
  | "unreachable"
  | "unknown";

export interface UiError {
  kind: UiErrorKind;
  title: string;
  message: string;
  /** Readable labels for the fields a 422 names. */
  fieldLabels: string[];
  /** Form fields a 422 names, when they map to one. */
  fieldKeys: FactKey[];
  code: string | null;
  status: number | null;
  /** Whether trying the same request again can help. */
  retryable: boolean;
}

function base(kind: UiErrorKind, title: string, message: string, retryable: boolean, extra?: Partial<UiError>): UiError {
  return { kind, title, message, retryable, fieldLabels: [], fieldKeys: [], code: null, status: null, ...extra };
}

export function toUiError(error: unknown): UiError {
  if (error instanceof ApiUnreachableError) {
    // The client's message says what failed (for example the HTTP status), so it is shown as written.
    return base("unreachable", "Server unreachable", error.message || "The server could not be reached.", true);
  }
  if (error instanceof ApiRequestError) {
    const meta = { code: error.code, status: error.status };
    const fields = error.fields ?? [];
    switch (error.code) {
      case "MISSING_REQUIRED_FACTS":
        return base("missing_facts", "Missing information", "Fill in the highlighted facts before approving the call.", false, {
          ...meta,
          fieldLabels: fields.map(labelForServerField),
          fieldKeys: fields.map(factKeyForServerField).filter((key): key is FactKey => key !== null),
        });
      case "REVISION_CONFLICT":
        return base(
          "revision_conflict",
          "This case changed elsewhere",
          "Someone or something updated this case after you loaded it. Reload to see the latest facts. Your edit was not saved.",
          false,
          meta,
        );
      case "AUTHORIZATION_CONFLICT":
        return base(
          "authorization_conflict",
          "Approval no longer matches",
          "The facts changed after you approved, so the approval no longer applies. Review the facts and approve again.",
          false,
          meta,
        );
      case "CALL_IN_PROGRESS":
        return base(
          "call_in_progress",
          "A call is in progress",
          "This case cannot be changed while a call is active or its outcome is unknown.",
          false,
          meta,
        );
      case "MODE_MISMATCH":
        return base(
          "mode_mismatch",
          "Different server mode",
          "This case was created in a different mode than the server is running in. Start a new case.",
          false,
          meta,
        );
      case "LIVE_CONFIGURATION_MISSING":
        return base(
          "live_configuration_missing",
          "Live configuration is missing",
          "The server is in live mode but is not configured to place calls. Nothing was dialed.",
          false,
          meta,
        );
      case "PROVIDER_UNAVAILABLE":
        return base(
          "provider_unavailable",
          "Calling provider unavailable",
          "The calling provider turned the request down before dialing, so nothing was dialed.",
          true,
          meta,
        );
      case "DECISION_RESOLVED":
        return base("decision_resolved", "Already decided", error.message || "This decision was already resolved.", false, meta);
      case "CALL_NOT_CONNECTED":
        return base(
          "call_not_connected",
          "Not connected yet",
          error.message || "The call has not connected yet. Try again once someone answers.",
          true,
          meta,
        );
      case "CALL_ENDED":
        return base("call_ended", "The call has ended", error.message || "The call has ended.", false, meta);
      case "NOT_SUPPORTED":
        return base(
          "not_supported",
          "Not available with this backend",
          error.message || "This backend does not support that action.",
          false,
          meta,
        );
      case "CONTRACT_VIOLATION":
        // Not retried automatically: the server may have acted before answering in a shape we cannot read.
        return base(
          "contract_violation",
          "Unexpected server response",
          `${error.message || "The server answered in a shape this app does not understand."} Nothing was assumed from it.`,
          false,
          meta,
        );
      case "NOT_FOUND":
        return base("not_found", "Not found", error.message || "The server has no record of this.", false, meta);
      case "BAD_REQUEST":
        return base("bad_request", "Request rejected", error.message || "The server rejected the request as malformed.", false, meta);
      default:
        break;
    }
    if (error.status === 401 || error.status === 403) {
      return base(
        "unauthorized",
        "Not authorized",
        "This browser session is not allowed to see or change this case. Reload the page to start a new session.",
        false,
        meta,
      );
    }
    if (error.status === 409) {
      return base("conflict", "Conflicting action", error.message || "This action conflicts with the current state of the case.", false, meta);
    }
    if (error.status === 422) {
      return base("missing_facts", "Missing information", error.message || "Some required facts are missing.", false, {
        ...meta,
        fieldLabels: fields.map(labelForServerField),
        fieldKeys: fields.map(factKeyForServerField).filter((key): key is FactKey => key !== null),
      });
    }
    if (error.status === 503) {
      return base("unavailable", "Service unavailable", error.message || "The service is unavailable. Nothing was changed.", true, meta);
    }
    if (error.status === 404) {
      return base("not_found", "Not found", error.message || "The server could not find what was requested.", false, meta);
    }
    return base("unknown", "Request failed", error.message || "The request failed.", error.status >= 500, meta);
  }
  const message = error instanceof Error && error.message ? error.message : "Something went wrong.";
  return base("unknown", "Something went wrong", message, true);
}
