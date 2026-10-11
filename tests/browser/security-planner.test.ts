import { describe, expect, it, vi } from "vitest";
import { boundedJson, parseCommand, publicAddress, resolvePublic, sameOrigin, scopedUrl } from "@/server/browser/security";
import { OpenAIPlanner, parseStep } from "@/server/browser/planner";
import type { Planner } from "@/server/browser/types";

describe("browser network and HTTP boundaries (no network)", () => {
  it.each(["127.0.0.1", "10.8.0.1", "172.31.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "198.19.1.1", "0.0.0.0", "224.0.0.1", "::1", "::ffff:8.8.8.8"])("denies private, reserved, or unsupported destination %s", ip => {
    expect(publicAddress(ip)).toBe(false);
  });
  it("rejects mixed public/private DNS answers, including a private secondary answer", async () => {
    const mixed = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]);
    await expect(resolvePublic("example.com", mixed)).rejects.toThrow("NETWORK_SCOPE_BLOCKED");
    await expect(resolvePublic("example.com", async () => [])).rejects.toThrow("NETWORK_SCOPE_BLOCKED");
    await expect(resolvePublic("example.com", async () => [{ address: "8.8.8.8", family: 4 }])).resolves.toBe("8.8.8.8");
  });
  it.each(["http://example.com", "https://example.com.evil.com", "https://example.com@evil.com", "https://user:password@example.com", "https://example.com:8443", "https://127.0.0.1", "file:///etc/passwd"])("does not expand approved hosts for %s", url => {
    expect(() => scopedUrl(url, ["example.com"])).toThrow();
  });
  it("requires same-origin mutations even when cookies would be sent", () => {
    for (const headers of [{}, { origin: "https://evil.com" }, { origin: "https://recourse.example", "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
      expect(() => sameOrigin(new Request("https://recourse.example/api/browser", { method: "POST", headers }))).toThrow();
    }
    expect(() => sameOrigin(new Request("https://recourse.example/api/browser", { method: "POST", headers: { origin: "https://recourse.example" } }))).not.toThrow();
  });
  it("bounds streamed bodies without trusting Content-Length", async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(9000)); controller.enqueue(new Uint8Array(9000)); controller.close(); } });
    const request = new Request("https://recourse.example", { method: "POST", headers: { "content-type": "application/json", "content-length": "2" }, body, duplex: "half" } as RequestInit);
    await expect(boundedJson(request)).rejects.toMatchObject({ status: 413 });
    await expect(boundedJson(new Request("https://recourse.example", { method: "POST", headers: { "content-type": "application/json" }, body: "{broken" }))).rejects.toMatchObject({ status: 400 });
  });
  it("cannot smuggle executable instructions or an action override in a command", () => {
    expect(() => parseCommand({ command: "resume", script: "fetch('https://evil.com')" })).toThrow();
    expect(() => parseCommand({ command: "evaluate", value: "alert(1)" })).toThrow();
  });
});

const input = { run: { task: "Read requirements", allowedHosts: ["example.com"], artifacts: [], events: [] }, draft: "Known facts only",
  observation: { url: "https://example.com", title: "Requirements", text: "Untrusted web content", elements: [], hasFrames: false }, signal: new AbortController().signal } as unknown as Parameters<Planner["next"]>[0];
const done = { kind: "done", elementId: null, value: null, artifactId: null, description: "Review finished" };
function planner(response: Response) { return new OpenAIPlanner({ model: "test-model", apiKey: "test-key", baseUrl: "https://api.example.com/v1" }, vi.fn(async () => response)); }

describe("real planner protocol using mocked HTTP responses", () => {
  it("rejects truncated, refused and multiple competing output messages", async () => {
    for (const body of [
      { status: "incomplete", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(done) }] }] },
      { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "No" }] }] },
      { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(done) }, { type: "output_text", text: JSON.stringify(done) }] }] },
      { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "{broken" }] }] },
    ]) await expect(planner(Response.json(body)).next(input)).rejects.toThrow();
  });
  it("never accepts arbitrary model code, invented action kinds, or extra schema fields", () => {
    for (const value of [{ ...done, kind: "evaluate" }, { ...done, javascript: "document.forms[0].submit()" }, { ...done, kind: "upload", elementId: "known", artifactId: null }]) expect(() => parseStep(value)).toThrow();
  });
  it("bounds a successful provider response before parsing it", async () => {
    await expect(planner(new Response("x".repeat(100_001))).next(input)).rejects.toThrow("PLANNER_INVALID");
  });
  it("classifies quota failures without exposing provider messages or credentials", async () => {
    await expect(planner(Response.json({ error: { code: "credit_balance_exhausted", message: "PRIVATE PROVIDER DATA" } }, { status: 429 })).next(input)).rejects.toMatchObject({ message: "PLANNER_QUOTA" });
    await expect(planner(new Response("PRIVATE AUTH DATA", { status: 401 })).next(input)).rejects.toMatchObject({ message: "PLANNER_AUTH" });
    await expect(planner(new Response("PRIVATE SERVER DATA", { status: 500 })).next(input)).rejects.toMatchObject({ message: "PLANNER_UNAVAILABLE" });
  });
});
