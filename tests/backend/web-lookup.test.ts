import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@/server/config";
import { ApiHttpError } from "@/server/http/errors";
import { clearWebLookupCache, isOfficialUrl, webLookupInsurerContact } from "@/server/insurers/web-lookup";

const config = loadConfig({ REFUND_MODE: "live", LLM_MODEL: "test-model", OPENAI_API_KEY: "sk-test-secret" });

interface Answer {
  claimsPhone: string | null;
  phoneSourceUrl: string | null;
  claimsUrl?: string | null;
  annotations?: { url: string; title: string }[];
}

/** A fake Responses API: a message whose text is the model's JSON, with url_citation annotations. */
function fakeFetch(answer: Answer) {
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers as Record<string, string> });
    const json = {
      insurerName: "Blue Shield of California",
      claimsPhone: answer.claimsPhone,
      phoneSourceUrl: answer.phoneSourceUrl,
      claimsUrl: answer.claimsUrl ?? null,
      summary: "Members mail a claim form with the itemized bill.",
      sources: [],
    };
    const body = {
      output: [
        { type: "web_search_call" },
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "```json\n" + JSON.stringify(json) + "\n```",
              annotations: (answer.annotations ?? []).map((a) => ({ type: "url_citation", ...a })),
            },
          ],
        },
      ],
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

const OFFICIAL = "https://www.blueshieldca.com/en/home/contact-us?utm_source=openai";
const OFFICIAL_CLEAN = "https://www.blueshieldca.com/en/home/contact-us";

describe("webLookupInsurerContact", () => {
  beforeEach(() => clearWebLookupCache());

  it("accepts a number cited from the insurer's own domain and returns its sources", async () => {
    const fake = fakeFetch({
      claimsPhone: "(888) 256-3650",
      phoneSourceUrl: OFFICIAL,
      claimsUrl: "https://www.blueshieldca.com/en/home/claims",
      annotations: [{ url: OFFICIAL, title: "Contact us | Blue Shield of CA" }],
    });
    const result = await webLookupInsurerContact({ name: "Blue Shield of California" }, { config, fetch: fake.impl });
    expect(result.claimsPhone).toBe("+18882563650");
    expect(result.claimsUrl).toBe("https://www.blueshieldca.com/en/home/claims");
    expect(result.sources[0]).toEqual({ url: OFFICIAL_CLEAN, title: "Contact us | Blue Shield of CA" });
    expect(result.provider).toBe("web_search");
    expect(fake.calls[0]?.url).toBe("https://api.openai.com/v1/responses");
    expect(fake.calls[0]?.body.tools).toEqual([{ type: "web_search" }]);
    expect(fake.calls[0]?.body.model).toBe("test-model");
    expect(JSON.stringify(result)).not.toContain("sk-test-secret");
  });

  it("rejects a number with no citation", async () => {
    const fake = fakeFetch({ claimsPhone: "+18882563650", phoneSourceUrl: OFFICIAL, annotations: [] });
    const result = await webLookupInsurerContact({ name: "Blue Shield of California" }, { config, fetch: fake.impl });
    expect(result.claimsPhone).toBeNull();
  });

  it("rejects a number cited only from a site that is not the insurer's", async () => {
    const other = "https://www.yellowpages.com/blue-shield";
    const fake = fakeFetch({ claimsPhone: "+18882563650", phoneSourceUrl: other, annotations: [{ url: other, title: "Listing" }] });
    const result = await webLookupInsurerContact({ name: "Blue Shield of California" }, { config, fetch: fake.impl });
    expect(result.claimsPhone).toBeNull();
    expect(isOfficialUrl("https://www.blueshieldca.com/", "Blue Shield of California")).toBe(true);
    expect(isOfficialUrl(other, "Blue Shield of California")).toBe(false);
  });

  it("rejects a number outside North America, and premium or Caribbean +1 numbers", async () => {
    for (const phone of ["+44 20 7946 0958", "+1 900 555 0123", "+1 876 555 0123"]) {
      clearWebLookupCache();
      const fake = fakeFetch({ claimsPhone: phone, phoneSourceUrl: OFFICIAL, annotations: [{ url: OFFICIAL, title: "Contact" }] });
      const result = await webLookupInsurerContact({ name: "Blue Shield of California" }, { config, fetch: fake.impl });
      expect(result.claimsPhone, phone).toBeNull();
    }
  });

  it("caches per normalized name for an hour", async () => {
    const fake = fakeFetch({ claimsPhone: "+18882563650", phoneSourceUrl: OFFICIAL, annotations: [{ url: OFFICIAL, title: "Contact" }] });
    let nowMs = Date.parse("2026-10-11T12:00:00Z");
    const now = () => new Date(nowMs);
    await webLookupInsurerContact({ name: "Blue Shield of California" }, { config, fetch: fake.impl, now });
    await webLookupInsurerContact({ name: "  blue shield of california " }, { config, fetch: fake.impl, now });
    expect(fake.calls).toHaveLength(1);
    nowMs += 61 * 60 * 1000;
    await webLookupInsurerContact({ name: "Blue Shield of California" }, { config, fetch: fake.impl, now });
    expect(fake.calls).toHaveLength(2);
  });

  it("answers 503 LIVE_CONFIGURATION_MISSING without LLM config, before any request", async () => {
    const fake = fakeFetch({ claimsPhone: null, phoneSourceUrl: null });
    const bare = loadConfig({ REFUND_MODE: "live" });
    const error = await webLookupInsurerContact({ name: "Aetna" }, { config: bare, fetch: fake.impl }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiHttpError);
    expect((error as ApiHttpError).status).toBe(503);
    expect((error as ApiHttpError).code).toBe("LIVE_CONFIGURATION_MISSING");
    expect(fake.calls).toHaveLength(0);
  });
});
