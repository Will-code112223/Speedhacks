import { describe, expect, it, vi } from "vitest";
import { browserArtifactUrl, createBrowserApi, isBrowserRun } from "../client";
import { request, run } from "./support";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("real browser HTTP transport", () => {
  it("uses only same-origin HTTP with uncached reads and exact command identifiers", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ run: run() })); const api = createBrowserApi(fetcher);
    await api.start(request); await api.find("case /", "request?"); await api.get("run /1");
    const command = { command: "approve" as const, pendingActionId: "p", observationId: "o" }; await api.command("run-1", command);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/browser", "/api/browser?caseId=case%20%2F&requestId=request%3F", "/api/browser/run%20%2F1", "/api/browser/run-1"]);
    for (const [, init] of fetcher.mock.calls) expect(init).toMatchObject({ credentials: "same-origin", cache: "no-store" });
    expect(fetcher.mock.calls[1]?.[1]?.method).toBe("GET"); expect(JSON.parse(String(fetcher.mock.calls[3]?.[1]?.body))).toEqual(command);
  });
  it("returns server errors and network uncertainty without a fixture fallback", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ error: { message: "Chromium is missing" } }, 503)).mockRejectedValueOnce(new Error("offline")); const api = createBrowserApi(fetcher);
    await expect(api.start(request)).rejects.toThrow("Chromium is missing"); await expect(api.start(request)).rejects.toThrow("last action may still be running"); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("preserves rejection codes so a stale request can be distinguished from uncertain dispatch", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ error: { code: "REVISION_CONFLICT", message: "Case changed" } }, 409)).mockResolvedValueOnce(json({ error: { code: "BROWSER_BUSY", message: "Busy" } }, 409));
    const api = createBrowserApi(fetcher);
    await expect(api.start(request)).rejects.toMatchObject({ status: 409, code: "REVISION_CONFLICT" });
    await expect(api.start(request)).rejects.toMatchObject({ status: 409, code: "BROWSER_BUSY" });
  });
  it.each([{ events: null }, { pendingAction: { id: "missing fields" } }, { artifacts: [{}] }, { frameAvailable: "yes" }, { status: "pretend" }])("rejects malformed response %j", async (patch) => {
    expect(isBrowserRun(run(patch as never))).toBe(false);
    await expect(createBrowserApi(vi.fn<typeof fetch>().mockResolvedValue(json({ run: run(patch as never) }))).get("run-1")).rejects.toThrow("invalid run data");
  });
  it("accepts real JPEG bytes, rejecting JSON and empty successful frame responses", async () => {
    const bytes = new Uint8Array([255, 216, 255, 217]);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(bytes, { headers: { "content-type": "image/jpeg" } })).mockResolvedValueOnce(json({ screenshot: "made up" })).mockResolvedValueOnce(new Response(null, { headers: { "content-type": "image/jpeg" } }));
    const api = createBrowserApi(fetcher); expect((await api.frame("run-1")).size).toBe(4);
    await expect(api.frame("run-1")).rejects.toThrow("valid browser frame"); await expect(api.frame("run-1")).rejects.toThrow("could not be displayed");
  });
  it("does not let an artifact redirect to external or executable URLs", () => {
    expect(browserArtifactUrl("/api/browser/run-1/artifacts/doc-1")).toBe("/api/browser/run-1/artifacts/doc-1");
    for (const url of ["https://evil.example/file", "//evil.example/file", "javascript:alert(1)", "/api/browser/../../admin", "/api/browser/\\evil.example/file"]) expect(browserArtifactUrl(url)).toBeNull();
  });
});
