/**
 * Entry point for the UI. The mode is a decision made up front (server
 * default or ?api=), never a fallback: a failing http backend surfaces its
 * error and is not replaced with fixture data.
 */

import { assertNever } from "./assert-never";
import { createFixtureCaseApi } from "./fixture";
import { createHttpCaseApi } from "./http";
import type { ApiMode, CaseApi, CreateCaseApiOptions } from "./types";

export function createCaseApi(options: CreateCaseApiOptions): CaseApi {
  switch (options.mode) {
    case "fixture":
      return createFixtureCaseApi(options.fixture);
    case "http":
      return createHttpCaseApi({ baseUrl: options.baseUrl });
    default:
      return assertNever(options.mode);
  }
}

/** Reads `?api=fixture|http` from a location.search string; any other value keeps the fallback. */
export function detectApiMode(search: string, fallback: ApiMode): ApiMode {
  const value = new URLSearchParams(search).get("api")?.trim().toLowerCase();
  return value === "fixture" || value === "http" ? value : fallback;
}

export { ApiRequestError, ApiUnreachableError } from "./types";
export { BACKEND_SIMULATED_SUFFIXES, type BackendSimulatedSuffix } from "./backend-notes";
export { createInsurerApi, type InsurerApi } from "./insurers";
