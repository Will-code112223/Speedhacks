import { afterEach, describe, expect, it, vi } from "vitest";
import * as client from "../client";
import { createCaseApi, detectApiMode } from "../client";
import * as fixtureModule from "../fixture";
import * as types from "../types";
import type { ApiMode, CreateCaseApiOptions } from "../types";
import { jsonResponse, recordingFetch, sampleCase, unreachableOf } from "./support";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("detectApiMode", () => {
  it.each<[string, ApiMode, ApiMode]>([
    ["?api=fixture", "http", "fixture"],
    ["?api=http", "fixture", "http"],
    ["?api=HTTP", "fixture", "http"],
    ["?api=%20fixture%20", "http", "fixture"],
    ["api=http", "fixture", "http"],
    ["?case=42&api=fixture", "http", "fixture"],
    ["?api=fixture&api=http", "http", "fixture"],
    ["", "http", "http"],
    ["", "fixture", "fixture"],
    ["?api=", "fixture", "fixture"],
    ["?api", "http", "http"],
    ["?api=mock", "http", "http"],
    ["?API=fixture", "http", "http"],
  ])("reads %j with fallback %s as %s", (search, fallback, expected) => {
    expect(detectApiMode(search, fallback)).toBe(expected);
  });
});

describe("createCaseApi", () => {
  it("builds the fixture client with its options", async () => {
    const api = createCaseApi({ mode: "fixture", fixture: { scenario: "duplicate_charge" } });
    expect(api.mode).toBe("fixture");
    const c = await api.createCase({ summary: "anything at all" });
    expect(c).toMatchObject({ mode: "simulated", merchant: { name: "Ridgeline Outfitters billing" }, amountMinor: 4999 });
  });

  it("builds the fixture client without options and infers the scenario", async () => {
    const api = createCaseApi({ mode: "fixture" });
    const c = await api.createCase({ summary: "I lost the receipt for a jacket" });
    expect(c.status).toBe("needs_information");
  });

  it("builds the http client on the given base URL and the global fetch", async () => {
    const { fetchImpl, requests } = recordingFetch(jsonResponse(200, { case: sampleCase() }));
    vi.stubGlobal("fetch", fetchImpl);
    const api = createCaseApi({ mode: "http", baseUrl: "https://api.example.test" });
    expect(api.mode).toBe("http");
    expect(await api.getCase(sampleCase().id)).toEqual(sampleCase());
    expect(requests[0]?.url).toBe(`https://api.example.test/api/cases/${sampleCase().id}`);
  });

  it("never falls back to fixture data when the http backend is down", async () => {
    vi.stubGlobal("fetch", recordingFetch(new TypeError("Failed to fetch")).fetchImpl);
    const api = createCaseApi({ mode: "http" });
    await unreachableOf(api.createCase({ summary: "duplicate charge" }));
  });

  it("rejects a mode it does not know", () => {
    const options = { mode: "mock" } as unknown as CreateCaseApiOptions;
    expect(() => createCaseApi(options)).toThrow('Unexpected value: "mock"');
  });
});

describe("client exports", () => {
  it("re-exports the error classes the UI catches", () => {
    expect(client.ApiRequestError).toBe(types.ApiRequestError);
    expect(client.ApiUnreachableError).toBe(types.ApiUnreachableError);
  });

  it("documents the backend's simulated phone suffixes", () => {
    expect(client.BACKEND_SIMULATED_SUFFIXES).toBe(fixtureModule.BACKEND_SIMULATED_SUFFIXES);
    const bySuffix = Object.fromEntries(client.BACKEND_SIMULATED_SUFFIXES.map((s) => [s.suffix, s.description]));
    expect(Object.keys(bySuffix)).toEqual(["0001", "0002", "0003", "0004", "0005", "0006", "any other"]);
    expect(bySuffix["0001"]).toMatch(/rejected before dispatch/i);
    expect(bySuffix["0002"]).toMatch(/unknown/i);
    expect(bySuffix["0003"]).toMatch(/denies/i);
    expect(bySuffix["0004"]).toMatch(/more information/i);
    expect(bySuffix["0005"]).toMatch(/fails/i);
    expect(bySuffix["0006"]).toMatch(/cancelled/i);
    expect(bySuffix["any other"]).toMatch(/approves/i);
  });
});
