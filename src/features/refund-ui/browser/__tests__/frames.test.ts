import { afterEach, describe, expect, it, vi } from "vitest";
import { startBrowserFrames, type BrowserFrameState } from "../frames";
import { api, deferred } from "./support";

afterEach(() => vi.useRealTimers());
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
function setup() {
  const service = api(); const updates: BrowserFrameState[] = [];
  let count = 0;
  const urls = { createObjectURL: vi.fn((_blob: Blob) => `blob:actual-frame-${++count}`), revokeObjectURL: vi.fn() };
  return { service, updates, urls, start: () => startBrowserFrames({ runId: "run-1", api: service, urls, onChange: (update) => updates.push(update), now: () => new Date("2026-10-11T20:00:00Z") }) };
}

describe("actual browser frame lifecycle", () => {
  it("fetches a completed run's retained final frame once without pretending it keeps updating", async () => {
    vi.useFakeTimers(); const { service, updates, urls } = setup();
    const stream = startBrowserFrames({ runId: "run-1", api: service, urls, onChange: update => updates.push(update), poll: false });
    await tick(); await vi.advanceTimersByTimeAsync(10_000);
    expect(service.frame).toHaveBeenCalledTimes(1); expect(updates.at(-1)?.frame).not.toBeNull(); stream.stop();
  });
  it("fetches real bytes before showing a frame and refreshes about once a second", async () => {
    vi.useFakeTimers(); const { service, updates, urls, start } = setup(); const stream = start();
    expect(updates.at(-1)?.frame).toBeNull(); await tick();
    expect(updates.at(-1)).toEqual({ frame: { url: "blob:actual-frame-1", receivedAt: "2026-10-11T20:00:00.000Z" }, error: null });
    expect(urls.createObjectURL.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
    await vi.advanceTimersByTimeAsync(999); expect(service.frame).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(service.frame).toHaveBeenCalledTimes(2); expect(urls.revokeObjectURL).toHaveBeenCalledWith("blob:actual-frame-1"); stream.stop();
  });
  it("removes a successful old frame immediately on a failed refresh", async () => {
    vi.useFakeTimers(); const { service, updates, urls, start } = setup(); service.frame.mockRejectedValueOnce(new Error("not ready")); const stream = start(); await tick();
    expect(updates.at(-1)).toEqual({ frame: null, error: "not ready" });
    await vi.advanceTimersByTimeAsync(1000); expect(updates.at(-1)?.frame?.url).toBe("blob:actual-frame-1");
    service.frame.mockRejectedValueOnce(new Error("service unavailable")); await vi.advanceTimersByTimeAsync(1000);
    expect(updates.at(-1)).toEqual({ frame: null, error: "service unavailable" }); expect(urls.revokeObjectURL).toHaveBeenCalledWith("blob:actual-frame-1"); stream.stop();
  });
  it("aborts and stops all polling when hidden or unmounted, ignoring late fetch completion", async () => {
    vi.useFakeTimers(); const { service, updates, urls, start } = setup(); const pending = deferred<Blob>(); service.frame.mockReturnValue(pending.promise);
    const stream = start(); stream.stop(); pending.resolve(new Blob(["late"])); await tick(); await vi.advanceTimersByTimeAsync(10_000);
    expect(service.frame).toHaveBeenCalledTimes(1); expect(service.frame.mock.calls[0]?.[1]?.aborted).toBe(true);
    expect(urls.createObjectURL).not.toHaveBeenCalled(); expect(updates.at(-1)?.frame).toBeNull();
  });
  it("does not overlap slow requests or keep a broken decoded image", async () => {
    vi.useFakeTimers(); const { service, updates, urls, start } = setup(); const pending = deferred<Blob>(); service.frame.mockReturnValueOnce(pending.promise);
    const stream = start(); await vi.advanceTimersByTimeAsync(9000); expect(service.frame).toHaveBeenCalledTimes(1);
    pending.resolve(new Blob(["bytes"])); await tick(); stream.invalidate();
    expect(updates.at(-1)).toEqual({ frame: null, error: "Browser image could not be displayed." }); expect(urls.revokeObjectURL).toHaveBeenCalledWith("blob:actual-frame-1"); stream.stop();
  });
});
