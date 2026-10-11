import type { ApiError, ApiErrorCode } from "@/contracts/case";

export class ApiHttpError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | string;
  readonly fields: string[] | undefined;

  constructor(status: number, code: ApiErrorCode | string, message: string, fields?: string[]) {
    super(message);
    this.name = "ApiHttpError";
    this.status = status;
    this.code = code;
    this.fields = fields;
  }

  toBody(): ApiError {
    const error: ApiError["error"] = { code: this.code, message: this.message };
    if (this.fields && this.fields.length > 0) error.fields = this.fields;
    return { error };
  }
}

export function badRequest(message: string, fields?: string[]): ApiHttpError {
  return new ApiHttpError(400, "BAD_REQUEST", message, fields);
}

export function notFound(message = "Case not found"): ApiHttpError {
  return new ApiHttpError(404, "NOT_FOUND", message);
}
