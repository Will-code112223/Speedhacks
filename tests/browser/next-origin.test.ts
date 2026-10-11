import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { sameOrigin } from "@/server/browser/security";

describe("Next loopback origin handling", () => {
  it("accepts the browser's exact loopback Origin/Host even when Next normalizes its URL", () => {
    const request = new NextRequest("http://127.0.0.1:3000/api/cases/123/workflow", { method: "POST", headers: { origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000", "sec-fetch-site": "same-origin" } });
    expect(new URL(request.url).hostname).toBe("localhost");
    expect(() => sameOrigin(request)).not.toThrow();
  });
  it.each([
    { origin: "http://127.0.0.1:3000", host: "localhost:3000" },
    { origin: "http://127.0.0.1:3001", host: "127.0.0.1:3001" },
    { origin: "https://attacker.example", host: "attacker.example" },
    { origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000", "sec-fetch-site": "cross-site" },
    { origin: "null", host: "127.0.0.1:3000" },
  ])("rejects a different origin, port, Host, or cross-site request: %j", headers => {
    const actualHeaders = new Headers();
    Object.entries(headers).forEach(([key, value]) => { if (value !== undefined) actualHeaders.set(key, value); });
    expect(() => sameOrigin(new NextRequest("http://127.0.0.1:3000/api/cases/123/workflow", { method: "POST", headers: actualHeaders }))).toThrow();
  });
});
