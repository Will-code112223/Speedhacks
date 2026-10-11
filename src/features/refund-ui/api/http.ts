/**
 * The real client for SHARED CONTRACT V1 (teammate 2's routes), plus feature
 * detection for the V2 live call proposal. It never fabricates data and never
 * falls back to fixtures. Failures surface as ApiRequestError when the server
 * answered (any error code passes through with its status and message) or
 * ApiUnreachableError when nothing readable came back.
 *
 * Case ownership is the server's httpOnly session cookie; same-origin
 * credentials carry it, and this client never reads or sets it.
 */

import { CASE_NOT_FOUND_MESSAGE } from "./messages";
import { CALL_NOT_COMPLETE_MESSAGE, completedCallFor, composeSummary, DESTINATION_MESSAGE, isValidDestination } from "./summary";
import {
  ApiRequestError,
  ApiUnreachableError,
  type CaseApi,
  type CaseApiCapabilities,
  type CaseV1,
  type CreateCaseInput,
} from "./types";
import { isCallV1, isCaseV1, isLiveCallV2, isRecord, readApiError, readCapabilities } from "./validate";

export interface HttpCaseApiOptions {
  /** Origin or path prefix for the API. Defaults to the page's own origin. */
  baseUrl?: string;
  /** For tests. Defaults to the global fetch, looked up on every request. */
  fetch?: typeof fetch;
}

type Method = "GET" | "POST" | "PATCH";
type RequestBody = { json: unknown } | { form: FormData } | null;

const NO_CAPABILITIES: CaseApiCapabilities = { liveCall: false, stepIn: false, decisions: false };

/** Error code the server uses when APP_ACCESS_CODE is set and the access cookie is missing or wrong. */
export const ACCESS_REQUIRED = "ACCESS_REQUIRED";

/** A 401 ACCESS_REQUIRED answer: the person has to enter the server's access code first. */
export class AccessRequiredError extends ApiRequestError {
  constructor(message: string) {
    super(401, ACCESS_REQUIRED, message);
    this.name = "AccessRequiredError";
  }
}

/**
 * Registered by the app shell: resolves once the person has entered a valid access
 * code (POST /api/access set the cookie). While one is registered, a request that
 * answers 401 ACCESS_REQUIRED waits for it and is sent again once. The server
 * rejects before doing any work, so the retry never repeats a side effect.
 */
type AccessPrompt = () => Promise<void>;
let accessPrompt: AccessPrompt | null = null;
export function setAccessPrompt(prompt: AccessPrompt | null): void {
  accessPrompt = prompt;
}

/** POST /api/access. "ok" once the cookie is set, "wrong" for a code the server refused. */
export async function submitAccessCode(code: string, baseUrl = ""): Promise<"ok" | "wrong"> {
  const res = await globalThis.fetch(`${baseUrl.replace(/\/+$/, "")}/api/access`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ code }),
    credentials: "same-origin",
    cache: "no-store",
  });
  if (res.ok) return "ok";
  if (res.status === 401 || res.status === 400) return "wrong";
  throw await failure(res);
}

async function isAccessRequired(res: Response): Promise<boolean> {
  if (res.status !== 401) return false;
  try {
    const parsed = readApiError(await res.clone().json());
    return parsed?.code === ACCESS_REQUIRED;
  } catch {
    return false;
  }
}

export function createHttpCaseApi(options: HttpCaseApiOptions = {}): CaseApi {
  const base = (options.baseUrl ?? "").replace(/\/+$/, "");
  const fetchImpl: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function send(method: Method, path: string, body: RequestBody = null, accept = "application/json", signal?: AbortSignal): Promise<Response> {
    const headers = new Headers({ accept });
    let payload: BodyInit | undefined;
    if (body !== null && "json" in body) {
      headers.set("content-type", "application/json");
      payload = JSON.stringify(body.json);
    } else if (body !== null) {
      payload = body.form; // fetch writes the multipart boundary itself
    }
    const attempt = () =>
      fetchImpl(`${base}${path}`, {
        method,
        headers,
        body: payload,
        credentials: "same-origin",
        cache: "no-store",
        ...(signal ? { signal } : {}),
      });
    let res: Response;
    try {
      res = await attempt();
    } catch (cause) {
      throw unreachable("The server could not be reached.", cause);
    }
    const prompt = accessPrompt;
    if (prompt && (await isAccessRequired(res))) {
      await prompt();
      try {
        res = await attempt();
      } catch (cause) {
        throw unreachable("The server could not be reached.", cause);
      }
    }
    return res;
  }

  // Capabilities are probed once. A definitive answer (a 404 from a V1-only
  // backend, or a capabilities body) is kept; a network error or 5xx is not,
  // so a brief outage at page load does not disable live calls for the session.
  let probe: Promise<CaseApiCapabilities> | null = null;

  async function detect(): Promise<{ value: CaseApiCapabilities; final: boolean }> {
    let res: Response;
    try {
      res = await send("GET", "/api/capabilities");
    } catch {
      return { value: NO_CAPABILITIES, final: false };
    }
    if (res.status === 404) return { value: NO_CAPABILITIES, final: true };
    if (!res.ok) return { value: NO_CAPABILITIES, final: false };
    let body: unknown;
    try {
      body = await readBody(res);
    } catch {
      return { value: NO_CAPABILITIES, final: true };
    }
    return { value: (isRecord(body) ? readCapabilities(body.capabilities) : null) ?? NO_CAPABILITIES, final: true };
  }

  function capabilities(): Promise<CaseApiCapabilities> {
    if (probe === null) {
      const attempt: Promise<CaseApiCapabilities> = detect().then(({ value, final }) => {
        if (!final && probe === attempt) probe = null;
        return value;
      });
      probe = attempt;
    }
    return probe.then((value) => ({ ...value }));
  }

  const casePath = (caseId: string): string => `/api/cases/${encodeURIComponent(caseId)}`;
  const callPath = (caseId: string, callId: string): string =>
    `${casePath(caseId)}/calls/${encodeURIComponent(callId)}`;

  async function getCase(caseId: string, signal?: AbortSignal): Promise<CaseV1> {
    return envelope(await send("GET", casePath(caseId), null, "application/json", signal), "case", isCaseV1, CASE_NOT_FOUND_MESSAGE);
  }

  return {
    mode: "http",

    async createCase(input) {
      return envelope(await send("POST", "/api/cases", { form: toFormData(input) }), "case", isCaseV1);
    },

    getCase,

    async patchCase(caseId, expectedRevision, changes) {
      const res = await send("PATCH", casePath(caseId), { json: { expectedRevision, changes } });
      return envelope(res, "case", isCaseV1, CASE_NOT_FOUND_MESSAGE);
    },

    async addFiles(caseId, files) {
      const form = new FormData();
      for (const file of files) form.append("files", file, file.name);
      return envelope(await send("POST", `${casePath(caseId)}/files`, { form }), "case", isCaseV1, CASE_NOT_FOUND_MESSAGE);
    },

    async authorize(caseId, expectedRevision, purpose) {
      const json = purpose === undefined ? { expectedRevision } : { expectedRevision, purpose };
      const res = await send("POST", `${casePath(caseId)}/authorize`, { json });
      return envelope(res, "case", isCaseV1, CASE_NOT_FOUND_MESSAGE);
    },

    async startCall(caseId, input) {
      const json = { authorizationId: input.authorizationId, requestId: input.requestId };
      const res = await send("POST", `${casePath(caseId)}/calls`, { json });
      return envelope(res, "call", isCallV1, CASE_NOT_FOUND_MESSAGE);
    },

    async downloadPacket(caseId) {
      const res = await send("GET", `${casePath(caseId)}/packet`, null, "text/plain, application/json");
      if (!res.ok) throw await failure(res, CASE_NOT_FOUND_MESSAGE);
      try {
        return await res.blob();
      } catch (cause) {
        throw unreachable("The packet download was interrupted.", cause);
      }
    },

    capabilities,

    async getLiveCall(caseId, callId) {
      if (!(await capabilities()).liveCall) return null;
      const res = await send("GET", `${callPath(caseId, callId)}/live`);
      if (!res.ok) throw await failure(res);
      const body = await readBody(res);
      const value = isRecord(body) ? body.liveCall : undefined;
      if (value === null) return null;
      if (!isLiveCallV2(value)) throw contractViolation(res.status, "liveCall");
      return value;
    },

    async stepIn(caseId, callId) {
      if (!(await capabilities()).stepIn) throw notSupported("Joining a live call");
      const res = await send("POST", `${callPath(caseId, callId)}/join`, { json: {} });
      return envelope(res, "liveCall", isLiveCallV2);
    },

    // No summary route yet (proposed in docs/handoffs/frontend.txt): compose from the
    // case here and return it unsent (sentAt null), so the person sends it from their own app.
    async sendSummary(caseId, destination) {
      const caseData = await getCase(caseId);
      const call = completedCallFor(caseData);
      if (call === null) throw new ApiRequestError(409, "CALL_NOT_COMPLETE", CALL_NOT_COMPLETE_MESSAGE);
      if (!isValidDestination(destination)) {
        throw new ApiRequestError(400, "BAD_REQUEST", `${DESTINATION_MESSAGE}.`, ["to"]);
      }
      return composeSummary(caseData, call, destination);
    },
    async answerDecision(caseId, callId, decisionId, optionId) {
      if (!(await capabilities()).decisions) throw notSupported("Answering a decision");
      const path = `${callPath(caseId, callId)}/decisions/${encodeURIComponent(decisionId)}`;
      return envelope(await send("POST", path, { json: { optionId } }), "liveCall", isLiveCallV2);
    },
  };
}

/** multipart/form-data as POST /api/cases expects: summary, repeated files, optional text fields. */
function toFormData(input: CreateCaseInput): FormData {
  const form = new FormData();
  form.append("summary", input.summary);
  for (const file of input.files ?? []) form.append("files", file, file.name);
  const optional: [string, string | number | undefined][] = [
    ["customerName", input.customerName],
    ["customerEmail", input.customerEmail],
    ["merchantName", input.merchantName],
    ["supportPhone", input.supportPhone],
    ["amountMinor", input.amountMinor],
    ["currency", input.currency],
  ];
  for (const [name, value] of optional) if (value !== undefined) form.append(name, String(value));
  return form;
}

/** The `key` member of a 2xx JSON envelope, checked against the contract. */
async function envelope<T>(
  res: Response,
  key: string,
  guard: (value: unknown) => value is T,
  notFoundMessage?: string,
): Promise<T> {
  if (!res.ok) throw await failure(res, notFoundMessage);
  const body = await readBody(res);
  const value = isRecord(body) ? body[key] : undefined;
  if (!guard(value)) throw contractViolation(res.status, key);
  return value;
}

/** The error for a non-2xx response. Codes pass through unchanged, including ones this client does not know. */
async function failure(res: Response, notFoundMessage?: string): Promise<Error> {
  const parsed = readApiError(await readBody(res));
  if (parsed === null) {
    return new ApiRequestError(res.status, "CONTRACT_VIOLATION", `The server answered HTTP ${res.status} without an error body.`);
  }
  if (res.status === 401 && parsed.code === ACCESS_REQUIRED) return new AccessRequiredError(parsed.message);
  const message = res.status === 404 && notFoundMessage !== undefined ? notFoundMessage : parsed.message;
  return new ApiRequestError(res.status, parsed.code, message, parsed.fields);
}

/** JSON body; anything unreadable means nothing usable came back. */
async function readBody(res: Response): Promise<unknown> {
  let text: string;
  try {
    text = await res.text();
  } catch (cause) {
    throw unreachable(`The response (HTTP ${res.status}) could not be read.`, cause);
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw unreachable(`The server answered HTTP ${res.status} with a response that is not JSON.`, cause);
  }
}

function contractViolation(status: number, key: string): ApiRequestError {
  return new ApiRequestError(status, "CONTRACT_VIOLATION", `The server response has no valid "${key}".`);
}

function notSupported(feature: string): ApiRequestError {
  return new ApiRequestError(501, "NOT_SUPPORTED", `${feature} is not supported by this backend.`);
}

function unreachable(message: string, cause: unknown): ApiUnreachableError {
  const error = new ApiUnreachableError(message);
  error.cause = cause;
  return error;
}
