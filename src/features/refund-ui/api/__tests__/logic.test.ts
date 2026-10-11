import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallState, CaseV1 } from "../../../../contracts/case";
import { ACTIVITY_WINDOW_MS, ActiveTimeMeter } from "../active-time";
import { isTransientError, shouldPollCase, shouldPollLiveCall } from "../polling";
import { browserSessionStorage, getOrCreateRequestId, type KeyValueStore } from "../request-id";
import { ApiRequestError, ApiUnreachableError } from "../types";
import { formatUuid, randomUuid, UUID_PATTERN } from "../uuid";
import { sampleCall, sampleCase, sampleLiveCall } from "./support";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shouldPollCase", () => {
  const withCall = (status: CaseV1["status"], state: CallState): CaseV1 =>
    sampleCase({ status, calls: [sampleCall({ state })] });

  it.each<[string, CaseV1, boolean]>([
    ["a case with no calls", sampleCase(), false],
    ["status calling", sampleCase({ status: "calling" }), true],
    ["a dispatch_pending call", withCall("calling", "dispatch_pending"), true],
    ["a queued call", withCall("calling", "queued"), true],
    ["an in_progress call", withCall("calling", "in_progress"), true],
    ["a dispatch_unknown call, whatever the status says", withCall("authorized", "dispatch_unknown"), true],
    ["a completed call", withCall("approved", "completed"), false],
    ["a completed call awaiting a response", withCall("awaiting_response", "completed"), false],
    ["a failed call", withCall("authorized", "failed"), false],
    ["a cancelled call", withCall("authorized", "cancelled"), false],
  ])("%s -> %s", (_label, c, expected) => {
    expect(shouldPollCase(c)).toBe(expected);
  });
});

describe("shouldPollLiveCall", () => {
  it("polls until the call ends, including before the record exists", () => {
    expect(shouldPollLiveCall(null)).toBe(true);
    expect(shouldPollLiveCall(sampleLiveCall({ phase: "waiting_for_user" }))).toBe(true);
    expect(shouldPollLiveCall(sampleLiveCall({ phase: "ended" }))).toBe(false);
  });
});

describe("isTransientError", () => {
  it.each<[string, unknown, boolean]>([
    ["unreachable", new ApiUnreachableError(), true],
    ["429", new ApiRequestError(429, "RATE_LIMITED", "Slow down"), true],
    ["500", new ApiRequestError(500, "INTERNAL", "Oops"), true],
    ["503", new ApiRequestError(503, "PROVIDER_UNAVAILABLE", "Try later"), true],
    ["501 not supported", new ApiRequestError(501, "NOT_SUPPORTED", "No"), false],
    ["404", new ApiRequestError(404, "NOT_FOUND", "Gone"), false],
    ["409", new ApiRequestError(409, "REVISION_CONFLICT", "Stale"), false],
    ["a contract violation on a 2xx", new ApiRequestError(200, "CONTRACT_VIOLATION", "Bad shape"), false],
    ["a plain Error", new Error("bug"), false],
    ["a string", "boom", false],
  ])("%s -> %s", (_label, error, expected) => {
    expect(isTransientError(error)).toBe(expected);
  });
});

describe("ActiveTimeMeter", () => {
  function focusedMeter(at = 0): ActiveTimeMeter {
    const meter = new ActiveTimeMeter();
    meter.setFocused(at, true);
    return meter;
  }

  it("counts nothing until started", () => {
    const meter = focusedMeter();
    meter.recordActivity(0);
    expect(meter.read(5_000)).toEqual({ activeMs: 0, elapsedMs: 0, running: false });
  });

  it("counts focused time up to ten seconds after the last activity", () => {
    expect(ACTIVITY_WINDOW_MS).toBe(10_000);
    const meter = focusedMeter();
    meter.start(0);
    meter.recordActivity(0);
    expect(meter.read(4_000)).toEqual({ activeMs: 4_000, elapsedMs: 4_000, running: true });
    expect(meter.read(30_000)).toEqual({ activeMs: 10_000, elapsedMs: 30_000, running: true });
    meter.recordActivity(30_000);
    expect(meter.read(35_000)).toMatchObject({ activeMs: 15_000, elapsedMs: 35_000 });
  });

  it("stops counting active time while the page is blurred or hidden", () => {
    const meter = focusedMeter();
    meter.start(0);
    meter.recordActivity(0);
    meter.setFocused(3_000, false);
    meter.recordActivity(4_000);
    expect(meter.read(8_000)).toMatchObject({ activeMs: 3_000, elapsedMs: 8_000 });
    meter.setFocused(8_000, true);
    // Back in focus, the 4 s activity still counts until 14 s.
    expect(meter.read(20_000)).toMatchObject({ activeMs: 9_000, elapsedMs: 20_000 });
  });

  it("accumulates across stop and start without counting the stopped gap", () => {
    const meter = focusedMeter();
    meter.start(0);
    meter.recordActivity(0);
    meter.stop(5_000);
    meter.recordActivity(6_000);
    expect(meter.read(19_000)).toEqual({ activeMs: 5_000, elapsedMs: 5_000, running: false });
    meter.start(20_000);
    expect(meter.read(25_000)).toMatchObject({ activeMs: 5_000, elapsedMs: 10_000 });
    meter.recordActivity(25_000);
    expect(meter.read(27_000)).toMatchObject({ activeMs: 7_000, elapsedMs: 12_000 });
  });

  it("reset zeroes the totals and keeps measuring", () => {
    const meter = focusedMeter();
    meter.start(0);
    meter.recordActivity(0);
    expect(meter.read(5_000).activeMs).toBe(5_000);
    meter.reset(5_000);
    expect(meter.read(7_000)).toEqual({ activeMs: 2_000, elapsedMs: 2_000, running: true });
  });

  it("gives the same totals however often it is read, so throttled timers change nothing", () => {
    const schedule: [number, (m: ActiveTimeMeter, at: number) => void][] = [
      [0, (m, at) => m.start(at)],
      [0, (m, at) => m.recordActivity(at)],
      [12_000, (m, at) => m.recordActivity(at)],
      [13_000, (m, at) => m.recordActivity(at)],
      [20_000, (m, at) => m.setFocused(at, false)],
      [22_000, (m, at) => m.setFocused(at, true)],
      [40_000, (m, at) => m.recordActivity(at)],
      [45_000, (m, at) => m.stop(at)],
    ];
    const sparse = focusedMeter();
    const dense = focusedMeter();
    for (let t = 0; t <= 60_000; t += 250) {
      for (const [at, apply] of schedule) {
        if (at === t) {
          apply(sparse, at);
          apply(dense, at);
        }
      }
      dense.read(t);
    }
    const expected = { activeMs: 10_000 + 8_000 + 1_000 + 5_000, elapsedMs: 45_000, running: false };
    expect(sparse.read(60_000)).toEqual(expected);
    expect(dense.read(60_000)).toEqual(expected);
  });

  it("ignores a clock that goes backwards", () => {
    const meter = focusedMeter(1_000);
    meter.start(1_000);
    meter.recordActivity(1_000);
    expect(meter.read(5_000).activeMs).toBe(4_000);
    expect(meter.read(3_000).activeMs).toBe(4_000);
    expect(meter.read(6_000)).toMatchObject({ activeMs: 5_000, elapsedMs: 5_000 });
  });

  it("honours a custom activity window", () => {
    const meter = new ActiveTimeMeter(1_000);
    meter.setFocused(0, true);
    meter.start(0);
    meter.recordActivity(0);
    expect(meter.read(5_000)).toMatchObject({ activeMs: 1_000, elapsedMs: 5_000 });
  });

  it("reports measurements only, never derived figures", () => {
    expect(Object.keys(new ActiveTimeMeter().read(0)).sort()).toEqual(["activeMs", "elapsedMs", "running"]);
  });
});

describe("request ids", () => {
  class MemoryStorage implements KeyValueStore {
    readonly items = new Map<string, string>();
    getItem(key: string): string | null {
      return this.items.get(key) ?? null;
    }
    setItem(key: string, value: string): void {
      this.items.set(key, value);
    }
  }

  const blocked: KeyValueStore = {
    getItem() {
      throw new DOMException("Storage is disabled", "SecurityError");
    },
    setItem() {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    },
  };

  it("creates one UUID per key and stores it in session storage", () => {
    const storage = new MemoryStorage();
    const id = getOrCreateRequestId(storage, "start-call:auth-1");
    expect(id).toMatch(UUID_PATTERN);
    expect(getOrCreateRequestId(storage, "start-call:auth-1")).toBe(id);
    expect(getOrCreateRequestId(storage, "start-call:auth-2")).not.toBe(id);
    expect(storage.items.get("recourse:request-id:start-call:auth-1")).toBe(id);
  });

  it("returns the stored id after a reload", async () => {
    const storage = new MemoryStorage();
    const before = getOrCreateRequestId(storage, "start-call:reload");
    vi.resetModules();
    const reloaded = await import("../request-id");
    expect(reloaded.getOrCreateRequestId(storage, "start-call:reload")).toBe(before);
  });

  it("replaces a corrupted stored value", () => {
    const storage = new MemoryStorage();
    storage.setItem("recourse:request-id:start-call:corrupt", "not-a-uuid");
    const id = getOrCreateRequestId(storage, "start-call:corrupt");
    expect(id).toMatch(UUID_PATTERN);
    expect(storage.items.get("recourse:request-id:start-call:corrupt")).toBe(id);
  });

  it("keeps ids stable for the page when storage is blocked or missing", () => {
    const fromBlocked = getOrCreateRequestId(blocked, "start-call:blocked");
    expect(fromBlocked).toMatch(UUID_PATTERN);
    expect(getOrCreateRequestId(blocked, "start-call:blocked")).toBe(fromBlocked);
    const fromNull = getOrCreateRequestId(null, "start-call:none");
    expect(getOrCreateRequestId(null, "start-call:none")).toBe(fromNull);
  });

  it("finds the tab's session storage only where it is allowed", () => {
    expect(browserSessionStorage()).toBeNull();
    const storage = new MemoryStorage();
    vi.stubGlobal("window", { sessionStorage: storage });
    expect(browserSessionStorage()).toBe(storage);
    vi.stubGlobal(
      "window",
      Object.defineProperty({}, "sessionStorage", {
        get() {
          throw new DOMException("Storage is disabled", "SecurityError");
        },
      }),
    );
    expect(browserSessionStorage()).toBeNull();
  });
});

describe("uuid", () => {
  it("creates RFC 4122 version 4 ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => randomUuid()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("falls back to getRandomValues where randomUUID is missing (insecure origins)", () => {
    vi.stubGlobal("crypto", { getRandomValues: <T extends ArrayBufferView>(bytes: T): T => {
      new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).fill(0xff);
      return bytes;
    } });
    expect(randomUuid()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
  });

  it("refuses to make ids without a secure random source", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => randomUuid()).toThrow("No secure random source is available to create an id.");
  });

  it("formats hex digits as 8-4-4-4-12 and matches what the server accepts", () => {
    expect(formatUuid("0123456789abcdef0123456789abcdef")).toBe("01234567-89ab-cdef-0123-456789abcdef");
    expect(UUID_PATTERN.test("01234567-89ab-4def-8123-456789abcdef")).toBe(true);
    expect(UUID_PATTERN.test("01234567-89ab-0def-8123-456789abcdef")).toBe(false);
    expect(UUID_PATTERN.test("01234567-89ab-4def-c123-456789abcdef")).toBe(false);
  });
});
