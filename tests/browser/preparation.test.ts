import { existsSync } from "node:fs";
import { chromium, type LaunchOptions } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fillPreparation } from "@/server/browser/preparation";

afterEach(() => vi.restoreAllMocks());

describe("local insurance preparation", () => {
  it("rejects cancellation and ambiguous duplicate fields before opening a browser", async () => {
    const launch = vi.spyOn(chromium, "launch");
    const controller = new AbortController(); controller.abort();
    await expect(fillPreparation({ fields: [], artifacts: [], signal: controller.signal, onFrame: vi.fn() })).rejects.toThrow("PREPARATION_CANCELLED");
    await expect(fillPreparation({ fields: [
      { key: "vehicle", label: "Vehicle", value: "Civic" }, { key: "vehicle", label: "Vehicle", value: "Accord" },
    ], artifacts: [], signal: new AbortController().signal, onFrame: vi.fn() })).rejects.toThrow("INVALID_PREPARATION_FIELDS");
    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects file paths instead of silently changing evidence names", async () => {
    const launch = vi.spyOn(chromium, "launch");
    await expect(fillPreparation({ fields: [], artifacts: [{ name: "../../claim.txt", mimeType: "text/plain", bytes: Buffer.from("claim") }],
      signal: new AbortController().signal, onFrame: vi.fn() })).rejects.toThrow("INVALID_PREPARATION_ARTIFACTS");
    expect(launch).not.toHaveBeenCalled();
  });

  it.skipIf(!existsSync(chromium.executablePath()))("cancels a running real browser before filling fields or presenting review", async () => {
    const controller = new AbortController();
    const messages: string[] = [];
    await expect(fillPreparation({ fields: [{ key: "vehicle", label: "Vehicle", value: "Honda Civic" }], artifacts: [],
      signal: controller.signal, onFrame: (_image, message) => { messages.push(message); controller.abort(); },
    })).rejects.toThrow("PREPARATION_CANCELLED");
    expect(messages).toEqual(["Preparing the reviewed case details"]);
  });

  it.skipIf(!existsSync(chromium.executablePath()))("uses actual Chromium inputs and actual file bytes, stops at local review, and makes no network request", async () => {
    const launch = chromium.launch.bind(chromium);
    const states: Array<{ values: string[]; files: Array<{ name: string; text: string }>; review: boolean; submit: number; title: string }> = [];
    const requests: string[] = [];
    let options: LaunchOptions | undefined;
    vi.spyOn(chromium, "launch").mockImplementation(async input => {
      options = input;
      const browser = await launch(input);
      const newContext = browser.newContext.bind(browser);
      vi.spyOn(browser, "newContext").mockImplementation(async settings => {
        expect(settings?.serviceWorkers).toBe("block");
        const context = await newContext(settings);
        context.on("page", page => {
          page.on("request", request => requests.push(request.url()));
          const screenshot = page.screenshot.bind(page);
          vi.spyOn(page, "screenshot").mockImplementation(async settings => {
            states.push(await page.evaluate(async () => ({
              values: [...document.querySelectorAll<HTMLTextAreaElement>("textarea")].map(field => field.value),
              files: await Promise.all(Array.from((document.getElementById("attachments") as HTMLInputElement).files ?? []).map(async file => ({ name: file.name, text: await file.text() }))),
              review: document.getElementById("review")!.style.display === "block",
              submit: document.querySelectorAll('button[type="submit"], input[type="submit"], form').length,
              title: document.body.textContent ?? "",
            })));
            return screenshot(settings);
          });
        });
        return context;
      });
      return browser;
    });
    const messages: string[] = [];
    await fillPreparation({
      fields: [
        { key: "vehicle", label: "Vehicle", value: "Silver 2022 Honda Civic" },
        { key: "incident", label: '<img src="https://evil.invalid/label">', value: '<script>fetch("https://evil.invalid/value")</script>' },
      ],
      artifacts: [{ name: "estimate.txt", mimeType: "text/plain", bytes: Buffer.from("SAMPLE estimate: USD 650") }],
      signal: new AbortController().signal,
      onFrame: (buffer, message) => { expect(buffer.subarray(0, 2).toString("hex")).toBe("ffd8"); messages.push(message); },
    });
    expect(options?.headless).toBe(true);
    expect(options?.proxy?.server).toBe("http://127.0.0.1:9");
    expect(requests).toEqual([]);
    expect(states[0]?.values).toEqual(["", ""]);
    expect(states[1]?.values).toEqual(["Silver 2022 Honda Civic", ""]);
    const final = states.at(-1)!;
    expect(final.values).toEqual(["Silver 2022 Honda Civic", '<script>fetch("https://evil.invalid/value")</script>']);
    expect(final.files).toEqual([{ name: "estimate.txt", text: "SAMPLE estimate: USD 650" }]);
    expect(final.review).toBe(true);
    expect(states.every(state => state.submit === 0)).toBe(true);
    expect(final.title).toContain("This is not the AAA website");
    expect(messages.at(-1)).toBe("Ready for review — not submitted");
  });
});
