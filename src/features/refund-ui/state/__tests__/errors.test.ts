import { describe, expect, it } from "vitest";
import { ApiRequestError, ApiUnreachableError } from "../../api/types";
import { toUiError } from "../errors";

describe("toUiError", () => {
  it("shows an unreachable server's message as written and allows a retry", () => {
    const error = toUiError(new ApiUnreachableError("The server answered HTTP 502 with a response that is not JSON."));
    expect(error).toMatchObject({
      kind: "unreachable",
      message: "The server answered HTTP 502 with a response that is not JSON.",
      retryable: true,
    });
  });

  it("explains a mode mismatch with the agreed sentence", () => {
    expect(toUiError(new ApiRequestError(409, "MODE_MISMATCH", "mode differs")).message).toBe(
      "This case was created in a different mode than the server is running in. Start a new case.",
    );
  });

  it("names the missing facts of a 422 by their form labels", () => {
    const error = toUiError(new ApiRequestError(422, "MISSING_REQUIRED_FACTS", "missing", ["merchant.supportPhone", "amountMinor"]));
    expect(error.fieldKeys).toEqual(["supportPhone", "amountMinor"]);
    expect(error.fieldLabels).toEqual(["Number to call", "Amount"]);
  });

  it("maps call and decision codes to their own kinds", () => {
    expect(toUiError(new ApiRequestError(409, "DECISION_RESOLVED", "x")).kind).toBe("decision_resolved");
    expect(toUiError(new ApiRequestError(409, "CALL_NOT_CONNECTED", "x")).kind).toBe("call_not_connected");
    expect(toUiError(new ApiRequestError(409, "CALL_ENDED", "x")).kind).toBe("call_ended");
    expect(toUiError(new ApiRequestError(501, "NOT_SUPPORTED", "x")).kind).toBe("not_supported");
    expect(toUiError(new ApiRequestError(200, "CONTRACT_VIOLATION", "Bad body.")).retryable).toBe(false);
    expect(toUiError(new ApiRequestError(403, "FORBIDDEN", "no")).kind).toBe("unauthorized");
    expect(toUiError(new ApiRequestError(404, "NOT_FOUND", "This case was not found for this browser session.")).message).toBe(
      "This case was not found for this browser session.",
    );
  });
});
