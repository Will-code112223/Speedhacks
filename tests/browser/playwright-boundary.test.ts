import { afterEach, describe, expect, it, vi } from "vitest";
const runtime = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("playwright", () => ({ chromium: { launch: runtime.launch } }));
import { launchBrowser } from "@/server/browser/playwright";
import { BrowserPageChangedError } from "@/server/browser/types";

afterEach(() => vi.resetAllMocks());
async function fakeBrowser() {
  let label = "Continue";
  const element = { dispose: vi.fn(async () => {}), click: vi.fn(async () => {}) };
  const frame = { evaluate: vi.fn(async () => false), locator: vi.fn() };
  const page = { on: vi.fn(), frames: () => [frame], mainFrame: () => frame, goto: vi.fn(async () => {}), url: () => "https://example.com/claims",
    locator: () => ({ elementHandles: async () => [element] }), screenshot: vi.fn(async () => Buffer.from("mock-frame")),
    waitForTimeout: vi.fn(async () => {}), mouse: { wheel: vi.fn() }, bringToFront: vi.fn(),
    evaluate: vi.fn(async (_fn, args) => ({ title: "Claim form", text: label,
      elements: [{ index: 0, previous: args.old.length ? 0 : -1, tag: "button", type: "submit", label, href: null, disabled: false, options: [], privateState: { value: "", html: label, bounds: [0, 0, 20, 20] } }],
      privateState: JSON.stringify({ action: label }), hasFrames: false })),
  };
  const context = { setDefaultTimeout: vi.fn(), setDefaultNavigationTimeout: vi.fn(), routeWebSocket: vi.fn(), route: vi.fn(), newPage: async () => page, on: vi.fn() };
  const browser = { close: vi.fn(async () => {}), on: vi.fn(), newContext: async () => context };
  runtime.launch.mockResolvedValue(browser);
  const controller = new AbortController();
  const port = await launchBrowser({ startUrl: page.url(), hosts: ["example.com"], headless: false, signal: controller.signal, onLost: vi.fn(), onBlocked: vi.fn() });
  const observation = await port.observe();
  const step = { kind: "click" as const, elementId: observation.elements[0]!.id, value: null, artifactId: null, description: "Continue to review" };
  return { port, observation, step, element, controller, changeMeaning: () => { label = "Submit claim and attest facts are true"; } };
}

describe("Playwright adapter dispatch boundary with a mocked browser (no browser launched)", () => {
  it("rejects a retained node that changes meaning after the reviewed observation", async () => {
    const f = await fakeBrowser();
    f.changeMeaning();
    await expect(f.port.execute(f.step, undefined, f.observation.fingerprint)).rejects.toBeInstanceOf(BrowserPageChangedError);
    expect(f.element.click).not.toHaveBeenCalled(); await f.port.close();
  });
  it("requires an approved fingerprint and keeps the stable target ID across the last check", async () => {
    const f = await fakeBrowser();
    await expect(f.port.execute(f.step)).rejects.toThrow("ACTION_APPROVAL_REQUIRED");
    expect(f.element.click).not.toHaveBeenCalled();
    await f.port.execute(f.step, undefined, f.observation.fingerprint);
    expect(f.element.click).toHaveBeenCalledTimes(1); await f.port.close();
  });
  it("does not dispatch after a cancelled run", async () => {
    const f = await fakeBrowser(); f.controller.abort();
    await expect(f.port.execute(f.step, undefined, f.observation.fingerprint)).rejects.toThrow("BROWSER_CLOSED");
    expect(f.element.click).not.toHaveBeenCalled(); await f.port.close();
  });
});
