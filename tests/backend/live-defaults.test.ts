import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chromium } from "playwright";
import { GET } from "@/app/api/runtime/route";
import { buildCaseService, getCaseService } from "@/server/cases/composition";
import { assertLiveLlmConfig, assertModeValid, getRuntimeReadiness, loadConfig, type EnvSource } from "@/server/config";
import { HeuristicExtractor } from "@/server/documents/extractor";
import { ApiHttpError } from "@/server/http/errors";
import { closeDatabase } from "@/server/persistence/db";
import { SESSION_A } from "./helpers";

const dirs: string[] = [];
function directory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-defaults-"));
  dirs.push(dir);
  return dir;
}
function configured(extra: EnvSource = {}): EnvSource {
  return { NODE_ENV: "production", LLM_MODEL: "synthetic-private-model", OPENAI_API_KEY: "synthetic-private-llm-key",
    DIAL_API_KEY: "synthetic-private-dial-key", DIAL_FROM_NUMBER: "synthetic-number-nickname", ...extra };
}
function binaryFixture() {
  const target = path.join(directory(), "private-browser-path");
  // Readiness checks file presence only, never launches this fixture.
  fs.writeFileSync(target, "not an executable browser");
  return target;
}
function cache() { return globalThis as unknown as { __refundService?: { key: string; service: unknown } }; }

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  cache().__refundService = undefined;
  closeDatabase();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("live product configuration", () => {
  it.each([undefined, "", "   ", "live"])("defaults to live for REFUND_MODE=%j, including tests", mode => {
    for (const nodeEnv of ["production", "development", "test"]) {
      const config = loadConfig({ NODE_ENV: nodeEnv, REFUND_MODE: mode });
      expect(config.mode).toBe("live");
      expect(config.invalidMode).toBeNull();
      expect(() => assertModeValid(config)).not.toThrow();
    }
  });

  it.each(["production", "development"])("rejects simulated %s before opening storage", nodeEnv => {
    const dataDir = path.join(directory(), "not-created");
    const config = loadConfig({ NODE_ENV: nodeEnv, REFUND_MODE: "simulated", DATA_DIR: dataDir });
    expect(() => buildCaseService(config)).toThrowError(ApiHttpError);
    try { assertModeValid(config); } catch (error) {
      expect(error).toMatchObject({ status: 503, code: "LIVE_CONFIGURATION_MISSING", fields: ["REFUND_MODE"] });
    }
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it("retains explicit simulated mode only for the test environment, including injected test configs", () => {
    vi.stubEnv("NODE_ENV", "test");
    for (const env of [{ REFUND_MODE: "simulated" }, { NODE_ENV: "test", REFUND_MODE: "simulated" }]) {
      const cfg = loadConfig(env);
      expect(cfg.mode).toBe("simulated");
      expect(() => assertModeValid(cfg)).not.toThrow();
    }
    expect(() => assertModeValid(loadConfig({ NODE_ENV: "production", REFUND_MODE: "simulated" }))).toThrow();
  });

  it("does not echo an invalid mode or configuration value in a public error", () => {
    const config = loadConfig({ REFUND_MODE: "private-accidental-secret" });
    try { assertModeValid(config); throw new Error("expected configuration error"); } catch (error) {
      expect(error).toBeInstanceOf(ApiHttpError);
      expect(JSON.stringify((error as ApiHttpError).toBody())).not.toContain("private-accidental-secret");
    }
  });

  it("rejects missing live extraction settings before extraction or uploaded evidence is stored", async () => {
    const dataDir = directory();
    const heuristic = vi.spyOn(HeuristicExtractor.prototype, "extract");
    const transport = vi.fn(); vi.stubGlobal("fetch", transport);
    const service = buildCaseService(loadConfig({ NODE_ENV: "production", DATA_DIR: dataDir }));
    await expect(service.createCase(SESSION_A, { summary: "Charged twice by Example Company for $100.",
      files: [{ name: "synthetic.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("Total: $100") }], fields: {} }))
      .rejects.toMatchObject({ status: 503, code: "LIVE_CONFIGURATION_MISSING", fields: ["LLM_MODEL", "OPENAI_API_KEY"] });
    expect(heuristic).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dataDir, "uploads"))).toBe(false);
  });

  it("does not silently use OpenAI when an unsupported provider is configured", () => {
    expect(() => assertLiveLlmConfig(loadConfig(configured({ LLM_PROVIDER: "unsupported-provider" }))))
      .toThrowError(ApiHttpError);
    expect(getRuntimeReadiness(configured({ LLM_PROVIDER: "unsupported-provider" })).extraction)
      .toEqual({ ready: false, missing: ["LLM_PROVIDER"] });
  });

  it("does not fall back to heuristic facts when the real LLM request fails", async () => {
    const transport = vi.fn(async () => { throw new Error("synthetic network failure"); });
    vi.stubGlobal("fetch", transport);
    const heuristic = vi.spyOn(HeuristicExtractor.prototype, "extract");
    const config = loadConfig(configured({ DATA_DIR: directory(), OPENAI_BASE_URL: "http://127.0.0.1:9/v1" }));
    const service = buildCaseService(config);
    const result = await service.createCase(SESSION_A, { summary: "Charged twice by Example Company for $100. My name is Sam Rivera.", files: [], fields: {} });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(heuristic).not.toHaveBeenCalled();
    expect(result.mode).toBe("live");
    expect(result.amountMinor).toBeNull();
    expect(result.customer.name).toBeNull();
    expect(result.merchant.name).toBeNull();
    expect(result.timeline.some(entry => entry.type === "extraction_failed")).toBe(true);
    expect(result.timeline.some(entry => entry.message.includes("heuristic"))).toBe(false);
  });

  it("refreshes the service when live settings change instead of keeping stale credentials", () => {
    vi.stubEnv("REFUND_MODE", "live");
    vi.stubEnv("DATA_DIR", directory());
    vi.stubEnv("LLM_MODEL", "synthetic-model-a");
    vi.stubEnv("OPENAI_API_KEY", "synthetic-key-a");
    cache().__refundService = undefined;
    const first = getCaseService();
    expect(getCaseService()).toBe(first);
    vi.stubEnv("OPENAI_API_KEY", "synthetic-key-b");
    expect(getCaseService()).not.toBe(first);
    expect(cache().__refundService?.key).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("sanitized runtime readiness", () => {
  it("reports independent extraction/call readiness; a webhook secret is not required for polling", () => {
    const readiness = getRuntimeReadiness(configured({ BROWSER_ENABLED: "false", BROWSER_EXECUTABLE_PATH: binaryFixture() }));
    expect(readiness.extraction).toEqual({ ready: true, missing: [] });
    expect(readiness.calls).toEqual({ ready: true, missing: [] });
    expect(readiness.browser).toEqual({ ready: false, missing: ["BROWSER_ENABLED"] });
    expect(JSON.stringify(readiness)).not.toContain("DIAL_WEBHOOK_SECRET");
  });

  it("reports invalid configured fields by name without exposing their values", () => {
    const result = getRuntimeReadiness(configured({ OPENAI_BASE_URL: "https://private:secret@example.test/v1",
      DIAL_API_KEY: "private\ntoken", DIAL_FROM_NUMBER: "private\rnumber", DIAL_MAX_CALL_DURATION_SECONDS: "private-bad-cap" }));
    expect(result.extraction.missing).toEqual(["OPENAI_BASE_URL"]);
    expect(result.calls.missing).toEqual(["DIAL_API_KEY", "DIAL_FROM_NUMBER", "DIAL_MAX_CALL_DURATION_SECONDS"]);
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("requires explicit browser opt-in and a real file path without claiming launch verification", () => {
    const executablePath = binaryFixture();
    expect(getRuntimeReadiness(configured({ BROWSER_ENABLED: "true", BROWSER_EXECUTABLE_PATH: executablePath })).browser)
      .toEqual({ ready: true, missing: [] });
    expect(getRuntimeReadiness(configured({ BROWSER_ENABLED: "true", BROWSER_EXECUTABLE_PATH: path.dirname(executablePath) })).browser)
      .toEqual({ ready: false, missing: ["BROWSER_EXECUTABLE_PATH"] });
    expect(getRuntimeReadiness(configured({ BROWSER_ENABLED: "true", BROWSER_EXECUTABLE_PATH: `${executablePath}.missing` })).browser)
      .toEqual({ ready: false, missing: ["BROWSER_EXECUTABLE_PATH"] });
  });

  it("uses a fixed installation marker for a missing default Chromium binary", () => {
    vi.spyOn(chromium, "executablePath").mockReturnValue(path.join(directory(), "private-missing-chromium"));
    const result = getRuntimeReadiness(configured({ BROWSER_ENABLED: "true" }));
    expect(result.browser).toEqual({ ready: false, missing: ["PLAYWRIGHT_CHROMIUM"] });
    expect(JSON.stringify(result)).not.toContain("private-missing-chromium");
  });

  it("never reports the simulated test engine as live-ready", () => {
    const result = getRuntimeReadiness(configured({ NODE_ENV: "test", REFUND_MODE: "simulated", BROWSER_ENABLED: "true", BROWSER_EXECUTABLE_PATH: binaryFixture() }));
    for (const part of [result.extraction, result.calls, result.browser]) {
      expect(part.ready).toBe(false);
      expect(part.missing).toContain("REFUND_MODE");
    }
  });

  it("GET returns only the agreed shape, uncached, without network requests or browser launch", async () => {
    for (const [name, value] of Object.entries(configured({ REFUND_MODE: "live", BROWSER_ENABLED: "true", BROWSER_EXECUTABLE_PATH: binaryFixture() }))) {
      vi.stubEnv(name, value);
    }
    const transport = vi.fn(); vi.stubGlobal("fetch", transport);
    const launch = vi.spyOn(chromium, "launch");
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ mode: "live", extraction: { ready: true, missing: [] },
      calls: { ready: true, missing: [] }, browser: { ready: true, missing: [] } });
    expect(transport).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });
});
