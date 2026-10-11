import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pinnedRequest } from "@/server/browser/security";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:https", () => ({ default: { request: mocks.request } }));

const publicResult = [{ address: "93.184.216.34", family: 4 }];
const input = { url: "https://example.com/claims", hosts: ["example.com"], method: "POST", headers: {}, body: Buffer.from("synthetic-test-only") };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
type MockRequest = EventEmitter & { end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
const requests: Array<{ request: MockRequest; signal: AbortSignal }> = [];
const cleanup: Array<() => void> = [];

beforeEach(() => {
  mocks.lookup.mockReset().mockResolvedValue(publicResult);
  mocks.request.mockReset().mockImplementation((_url: URL, options: { signal: AbortSignal }) => {
    const request = new EventEmitter() as MockRequest;
    request.end = vi.fn();
    request.destroy = vi.fn((error: Error) => { request.emit("error", error); return request; });
    // Model Node's ClientRequest signal handling without opening any connection.
    const aborted = () => request.destroy(new Error("synthetic transport abort"));
    options.signal.addEventListener("abort", aborted, { once: true });
    cleanup.push(() => options.signal.removeEventListener("abort", aborted));
    requests.push({ request, signal: options.signal });
    return request;
  });
});
afterEach(() => { for (const release of cleanup.splice(0)) release(); requests.length = 0; vi.restoreAllMocks(); });

describe("pinned browser transport cancellation (mock DNS/HTTPS; no network)", () => {
  it("does not resolve DNS or start HTTPS when the run was already cancelled", async () => {
    const controller = new AbortController(); controller.abort("PRIVATE_REASON");
    await expect(pinnedRequest({ ...input, signal: controller.signal })).rejects.toThrow("REQUEST_ABORTED");
    expect(mocks.lookup).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled();
  });

  it("cancels while DNS is pending and discards a later answer without dispatching a POST", async () => {
    const dns = deferred<typeof publicResult>(); mocks.lookup.mockReturnValue(dns.promise);
    const controller = new AbortController();
    const pending = pinnedRequest({ ...input, signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow("REQUEST_ABORTED");
    controller.abort("PRIVATE_REASON"); await rejected;
    expect(mocks.lookup).toHaveBeenCalledTimes(1); expect(mocks.request).not.toHaveBeenCalled();
    dns.resolve(publicResult); await Promise.resolve(); await Promise.resolve();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("checks cancellation again when DNS settles in the same turn", async () => {
    const dns = deferred<typeof publicResult>(); mocks.lookup.mockReturnValue(dns.promise);
    const controller = new AbortController(); const pending = pinnedRequest({ ...input, signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow("REQUEST_ABORTED");
    dns.resolve(publicResult); controller.abort(); await rejected;
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("propagates cancellation to an in-flight request instead of waiting for its timeout", async () => {
    const controller = new AbortController(); const pending = pinnedRequest({ ...input, signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow("RESOURCE_REQUEST_FAILED");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const outgoing = requests[0]!;
    expect(outgoing.request.end).toHaveBeenCalledWith(input.body);
    expect(outgoing.signal.aborted).toBe(false);
    controller.abort("PRIVATE_REASON"); await rejected;
    expect(outgoing.signal.aborted).toBe(true); expect(outgoing.request.destroy).toHaveBeenCalledTimes(1);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it("retains the HTTP deadline in addition to the run cancellation signal", async () => {
    const deadline = new AbortController(); const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const controller = new AbortController(); const pending = pinnedRequest({ ...input, signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow("RESOURCE_REQUEST_FAILED");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(timeout).toHaveBeenCalledWith(15_000);
    deadline.abort(); await rejected;
    expect(controller.signal.aborted).toBe(false); expect(requests[0]!.request.destroy).toHaveBeenCalledTimes(1);
  });

  it("still rejects a mixed public/private DNS answer before HTTPS", async () => {
    mocks.lookup.mockResolvedValue([...publicResult, { address: "127.0.0.1", family: 4 }]);
    await expect(pinnedRequest(input)).rejects.toThrow("NETWORK_SCOPE_BLOCKED");
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
