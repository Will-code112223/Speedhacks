import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixtureCaseApi } from "../fixture";
import { randomUuid } from "../uuid";
import { authorizationIdOf, failureOf, fixture, T0 } from "./support";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("fixture options", () => {
  it("reports every V2 capability by default", async () => {
    expect(await createFixtureCaseApi().capabilities()).toEqual({ liveCall: true, stepIn: true, decisions: true });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects speed %s", (speed) => {
    expect(() => createFixtureCaseApi({ speed })).toThrow(RangeError);
  });

  it("delays every response by latencyMs so loading states can be seen", async () => {
    vi.useFakeTimers();
    const api = createFixtureCaseApi({ scenario: "duplicate_charge", latencyMs: 300, now: () => T0 });
    let settled = false;
    const pending = api.createCase({ summary: "Charged twice" }).then((c) => {
      settled = true;
      return c;
    });
    await vi.advanceTimersByTimeAsync(299);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect((await pending).status).toBe("ready_for_approval");
  });

  it("keeps each client's cases to itself and persists nothing", async () => {
    const trap = new Proxy(
      {},
      {
        get() {
          throw new Error("The fixture must not touch browser storage.");
        },
      },
    );
    vi.stubGlobal("localStorage", trap);
    vi.stubGlobal("sessionStorage", trap);
    vi.stubGlobal("indexedDB", trap);

    const first = fixture("duplicate_charge");
    const created = await first.api.createCase({ summary: "Charged twice" });
    const authorized = await first.api.authorize(created.id, created.revision);
    await first.api.startCall(created.id, { authorizationId: authorizationIdOf(authorized), requestId: randomUuid() });

    const second = fixture("duplicate_charge");
    expect(await failureOf(second.api.getCase(created.id))).toMatchObject({ status: 404 });
  });

  it("dates records with the injected clock", async () => {
    const { api, clock } = fixture("duplicate_charge");
    clock.at(90);
    const c = await api.createCase({ summary: "Charged twice" });
    expect(c.createdAt).toBe(new Date(T0 + 90_000).toISOString());
    expect(c.timeline.every((t) => t.at === c.createdAt)).toBe(true);
  });
});
