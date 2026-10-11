import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CaseV1 } from "@/contracts/case";
import type { VoiceAdapter } from "@/contracts/voice";
import { buildCallPlan, liveDestinationProblem } from "@/server/cases/facts";
import { ApiHttpError } from "@/server/http/errors";
import { accessToken, sessionCookieHeader } from "@/server/http/session";
import { closeDatabase } from "@/server/persistence/db";
import { listInsurers } from "@/server/insurers";
import { COMPLETE_FIELDS, SESSION_A, SESSION_B, makeHarness, type Harness } from "./helpers";

const LIVE_ENV = { LLM_MODEL: "m", OPENAI_API_KEY: "k", DIAL_API_KEY: "dial", DIAL_WEBHOOK_SECRET: "s", DIAL_FROM_NUMBER: "+14155559999" };

function fakeLiveVoice(): VoiceAdapter {
  return {
    startCall: vi.fn(async () => ({ state: "accepted" as const, mode: "live" as const, providerCallId: `call_${randomUUID()}` })),
    getCall: vi.fn(async () => ({ state: "queued" as const, transcript: null, durationSeconds: null }) as never),
    verifyWebhook: vi.fn(async () => null),
  };
}

async function expectApi(p: Promise<unknown> | (() => unknown), status: number, code: string): Promise<ApiHttpError> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    expect(e).toBeInstanceOf(ApiHttpError);
    expect((e as ApiHttpError).status).toBe(status);
    expect((e as ApiHttpError).code).toBe(code);
    return e as ApiHttpError;
  }
  throw new Error(`expected ${status} ${code}`);
}

describe("live destination rule (NANP only)", () => {
  it("allows ordinary US and Canadian numbers", () => {
    for (const ok of ["+14155551000", "+12125550100", "+16045550100", "+18005550100", "+19055550100"]) {
      expect(liveDestinationProblem(ok, null)).toBeNull();
    }
  });

  it("rejects international, premium, invalid NANP codes and the own caller ID", () => {
    const refused = [
      "+442071838750", // UK
      "+33142685300", // France
      "+19005550100", // premium area code 900
      "+14159765555", // premium exchange 976
      "+14115550100", // N11 area code
      "+10155550100", // 0-leading area code
      "+11155550100", // 1-leading area code
      "+12925550100", // N9X area code (unassigned)
      "+18765550100", // Jamaica, billed as international
      "+18095550100", // Dominican Republic
      "+14150115555", // 0-leading exchange
      "+14154115555", // N11 exchange
      "+1415555100", // too short
    ];
    for (const phone of refused) expect(liveDestinationProblem(phone, null), phone).not.toBeNull();
    expect(liveDestinationProblem("+14155559999", "+14155559999")).toMatch(/caller ID/);
  });
});

describe("live mode destination enforcement", () => {
  let h: Harness;
  afterEach(() => h?.cleanup());

  it("rejects a disallowed number at creation and at edit with a 422 naming supportPhone", async () => {
    h = makeHarness({ mode: "live", env: LIVE_ENV, voice: fakeLiveVoice() });
    for (const phone of ["+442071838750", "+19005550100", "+14155559999"]) {
      const err = await expectApi(
        h.service.createCase(SESSION_A, { summary: "Charged twice", files: [], fields: { ...COMPLETE_FIELDS, supportPhone: phone } }),
        422,
        "UNSUPPORTED_DESTINATION",
      );
      expect(err.fields).toEqual(["supportPhone"]);
    }
    const c = await h.service.createCase(SESSION_A, { summary: "Charged twice", files: [], fields: COMPLETE_FIELDS });
    const err = await expectApi(
      () => h.service.patchCase(SESSION_A, c.id, c.revision, { merchant: { name: "Acme Streaming", supportPhone: "+14159765555" } }),
      422,
      "UNSUPPORTED_DESTINATION",
    );
    expect(err.fields).toEqual(["supportPhone"]);
  });

  it("drops a disallowed number found in the documents instead of keeping it", async () => {
    h = makeHarness({ mode: "live", env: LIVE_ENV, voice: fakeLiveVoice() });
    const { supportPhone: _omit, ...fields } = COMPLETE_FIELDS;
    const c = await h.service.createCase(SESSION_A, {
      summary: "Charged twice. Support line +44 20 7183 8750.",
      files: [],
      fields,
    });
    expect(c.merchant.supportPhone).toBeNull();
    expect(c.missingFields).toContain("merchant.supportPhone");
  });

  it("simulated mode keeps accepting any E.164 number", async () => {
    h = makeHarness();
    const c = await h.service.createCase(SESSION_A, { summary: "Charged twice", files: [], fields: { ...COMPLETE_FIELDS, supportPhone: "+442071838750" } });
    expect(c.merchant.supportPhone).toBe("+442071838750");
  });
});

describe("live dispatch rate limit", () => {
  let h: Harness;
  afterEach(() => h?.cleanup());

  async function dispatch(session: string): Promise<unknown> {
    const c = await h.service.createCase(session, { summary: "Charged twice", files: [], fields: COMPLETE_FIELDS });
    const authorized = h.service.authorize(session, c.id, c.revision);
    return h.service.startCall(session, c.id, { authorizationId: authorized.authorization!.id, requestId: randomUUID() });
  }

  it("allows 3 dispatches per session per rolling hour, then answers 429", async () => {
    const voice = fakeLiveVoice();
    h = makeHarness({ mode: "live", env: LIVE_ENV, voice });
    for (let i = 0; i < 3; i++) await dispatch(SESSION_A);
    const err = await expectApi(dispatch(SESSION_A), 429, "RATE_LIMITED");
    expect(err.message).toMatch(/3 calls in the last hour/);
    expect(voice.startCall).toHaveBeenCalledTimes(3);
    // Another session is unaffected; after an hour the first session may dispatch again.
    await dispatch(SESSION_B);
    h.clock.advance(60 * 60 * 1000 + 1);
    await dispatch(SESSION_A);
    expect(voice.startCall).toHaveBeenCalledTimes(5);
  });

  it("allows 10 dispatches per process per rolling hour across sessions", async () => {
    const voice = fakeLiveVoice();
    h = makeHarness({ mode: "live", env: LIVE_ENV, voice });
    const sessions = ["c", "d", "e", "f"].map((ch) => ch.repeat(48));
    let placed = 0;
    for (const s of sessions) {
      for (let i = 0; i < 3 && placed < 10; i++, placed++) await dispatch(s);
    }
    const err = await expectApi(dispatch(sessions[3]!), 429, "RATE_LIMITED");
    expect(err.message).toMatch(/10 calls in the last hour/);
    expect(voice.startCall).toHaveBeenCalledTimes(10);
  });

  it("an idempotent replay of the same request is not counted and simulated mode is not limited", async () => {
    h = makeHarness({ mode: "live", env: LIVE_ENV, voice: fakeLiveVoice() });
    const c = await h.service.createCase(SESSION_A, { summary: "Charged twice", files: [], fields: COMPLETE_FIELDS });
    const authorizationId = h.service.authorize(SESSION_A, c.id, c.revision).authorization!.id;
    const requestId = randomUUID();
    for (let i = 0; i < 5; i++) await h.service.startCall(SESSION_A, c.id, { authorizationId, requestId });
    await dispatch(SESSION_A);
    await dispatch(SESSION_A);
    h.cleanup();
    h = makeHarness();
    for (let i = 0; i < 5; i++) await dispatch(SESSION_A);
  });
});

describe("support number provenance", () => {
  let h: Harness;
  afterEach(() => h?.cleanup());
  const CLAIM = { customerName: "Jordan Lee", lossDescription: "Water damage from a burst pipe", claimType: "water damage" };

  it("labels typed numbers user and extracted numbers document", async () => {
    h = makeHarness();
    const typed = await h.service.createCase(SESSION_A, { summary: "Charged twice", files: [], fields: COMPLETE_FIELDS });
    expect(typed.merchant.source).toEqual({ kind: "user" });
    const { supportPhone: _omit, ...fields } = COMPLETE_FIELDS;
    const extracted = await h.service.createCase(SESSION_A, { summary: "Charged twice. Call support at +1 (415) 555-0123.", files: [], fields });
    expect(extracted.merchant.supportPhone).toBe("+14155550123");
    expect(extracted.merchant.source).toEqual({ kind: "document" });
    // Editing only the merchant name keeps a document number and its label.
    const renamed = h.service.patchCase(SESSION_A, extracted.id, extracted.revision, { merchant: { name: "Acme TV", supportPhone: "+14155550123" } });
    expect(renamed.merchant.source).toEqual({ kind: "document" });
  });

  it("never keeps a registry number under a different insurer name", async () => {
    h = makeHarness();
    const registered = listInsurers(":memory:").map((i) => i.name);
    expect(registered).toContain("Lemonade");
    const c = await h.service.createCase(SESSION_A, { summary: "Claim.", files: [], fields: { ...CLAIM, merchantName: "Lemonade" } });
    expect(c.merchant.source?.kind).toBe("insurer_registry");
    const lemonadePhone = c.merchant.supportPhone;
    expect(lemonadePhone).not.toBeNull();

    // Renamed to an insurer that is not in the registry, number resent unchanged: cleared, with the ID-card note.
    const renamed = h.service.patchCase(SESSION_A, c.id, c.revision, { merchant: { name: "Northwind Mutual", supportPhone: lemonadePhone } });
    expect(renamed.merchant.supportPhone).toBeNull();
    expect(renamed.merchant.source).toBeNull();
    expect(renamed.timeline.some((t) => t.type === "insurer_registry" && /ID card/.test(t.message))).toBe(true);

    // Renamed to another registry insurer: re-resolved for the new name, never the old number.
    const c2 = await h.service.createCase(SESSION_A, { summary: "Claim.", files: [], fields: { ...CLAIM, merchantName: "Lemonade" } });
    const farmers = h.service.patchCase(SESSION_A, c2.id, c2.revision, { merchant: { name: "Farmers", supportPhone: c2.merchant.supportPhone } });
    expect(farmers.merchant.supportPhone).not.toBe(lemonadePhone);
    const src = farmers.merchant.source;
    if (src?.kind === "insurer_registry") expect(src.insurerName).toMatch(/Farmers/);
    else expect(farmers.merchant.supportPhone).toBeNull();
  });
});

describe("claim calls never carry the raw summary", () => {
  it("file_claim plans do not disclose reason; refund plans still do", () => {
    const base = {
      caseId: randomUUID(),
      revision: 1,
      customer: { name: "Jordan Lee", email: null },
      merchantName: "Lemonade",
      amountMinor: null,
      currency: "USD",
      reason: "My SSN is 123-45-6789 and they owe me $5,000",
      evidence: [],
      lossDescription: "Water damage from a burst pipe",
      claimType: "water damage",
    };
    const claim = buildCallPlan({ ...base, purpose: "file_claim" });
    expect(claim.permittedDisclosures).not.toContain("reason");
    expect(claim.permittedDisclosures).toEqual(expect.arrayContaining(["lossDescription", "claimType"]));
    const refund = buildCallPlan({ ...base, purpose: "request_refund", amountMinor: 4999 });
    expect(refund.permittedDisclosures).toContain("reason");
  });
});

describe("HTTP hardening (access code, summary cap, upload size, cookies)", () => {
  let dataDir: string;
  let routes: {
    cases: typeof import("@/app/api/cases/route");
    byId: typeof import("@/app/api/cases/[id]/route");
    capabilities: typeof import("@/app/api/capabilities/route");
    access: typeof import("@/app/api/access/route");
    insurers: typeof import("@/app/api/insurers/route");
  };
  const saved = { ...process.env };

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "refund-hosting-"));
    process.env.REFUND_MODE = "simulated";
    process.env.DATA_DIR = dataDir;
    delete process.env.APP_ACCESS_CODE;
    closeDatabase();
    (globalThis as { __refundService?: unknown }).__refundService = undefined;
    routes = {
      cases: await import("@/app/api/cases/route"),
      byId: await import("@/app/api/cases/[id]/route"),
      capabilities: await import("@/app/api/capabilities/route"),
      access: await import("@/app/api/access/route"),
      insurers: await import("@/app/api/insurers/route"),
    };
  });
  afterAll(() => {
    process.env = saved;
    closeDatabase();
    (globalThis as { __refundService?: unknown }).__refundService = undefined;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  afterEach(() => {
    delete process.env.APP_ACCESS_CODE;
  });

  const form = (summary: string) => {
    const f = new FormData();
    f.set("summary", summary);
    for (const [k, v] of Object.entries(COMPLETE_FIELDS)) f.set(k, String(v));
    return f;
  };

  it("with APP_ACCESS_CODE set, /api routes answer 401 until POST /api/access sets the cookie", async () => {
    process.env.APP_ACCESS_CODE = "open sesame";
    const caps = await routes.capabilities.GET();
    expect(caps.status).toBe(200);
    expect(((await caps.json()) as { accessRequired: boolean }).accessRequired).toBe(true);

    const denied = await routes.cases.POST(new Request("http://localhost/api/cases", { method: "POST", body: form("Charged twice") }));
    expect(denied.status).toBe(401);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe("ACCESS_REQUIRED");
    const deniedList = await routes.insurers.GET(new Request("http://localhost/api/insurers"));
    expect(deniedList.status).toBe(401);
    const forged = await routes.cases.POST(
      new Request("http://localhost/api/cases", { method: "POST", body: form("Charged twice"), headers: { cookie: "recourse_access=open%20sesame" } }),
    );
    expect(forged.status).toBe(401);

    const wrong = await routes.access.POST(new Request("http://localhost/api/access", { method: "POST", body: JSON.stringify({ code: "nope" }) }));
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();

    const ok = await routes.access.POST(new Request("http://localhost/api/access", { method: "POST", body: JSON.stringify({ code: "open sesame" }) }));
    expect(ok.status).toBe(204);
    const cookie = ok.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^recourse_access=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Lax/);
    expect(cookie.split(";")[0]).toBe(`recourse_access=${accessToken("open sesame")}`);
    expect(cookie).not.toContain("open sesame");

    const allowed = await routes.cases.POST(
      new Request("http://localhost/api/cases", { method: "POST", body: form("Charged twice"), headers: { cookie: cookie.split(";")[0]! } }),
    );
    expect(allowed.status).toBe(201);
  });

  it("without APP_ACCESS_CODE nothing is gated and capabilities say so", async () => {
    const caps = await routes.capabilities.GET();
    expect(((await caps.json()) as { accessRequired: boolean }).accessRequired).toBe(false);
    const created = await routes.cases.POST(new Request("http://localhost/api/cases", { method: "POST", body: form("Charged twice") }));
    expect(created.status).toBe(201);
  });

  it("caps the summary at 2000 characters on create and edit with a 422 naming summary", async () => {
    const tooLong = await routes.cases.POST(new Request("http://localhost/api/cases", { method: "POST", body: form("x".repeat(2001)) }));
    expect(tooLong.status).toBe(422);
    expect(((await tooLong.json()) as { error: { fields: string[] } }).error.fields).toEqual(["summary"]);

    const created = await routes.cases.POST(new Request("http://localhost/api/cases", { method: "POST", body: form("x".repeat(2000)) }));
    expect(created.status).toBe(201);
    const session = created.headers.get("set-cookie")!.split(";")[0]!;
    const { case: c } = (await created.json()) as { case: CaseV1 };
    const patch = await routes.byId.PATCH(
      new Request(`http://localhost/api/cases/${c.id}`, {
        method: "PATCH",
        headers: { cookie: session, "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: c.revision, changes: { reason: "y".repeat(2001) } }),
      }),
      { params: Promise.resolve({ id: c.id }) },
    );
    expect(patch.status).toBe(422);
    expect(((await patch.json()) as { error: { fields: string[] } }).error.fields).toEqual(["summary"]);
  });

  it("rejects a declared body over the upload budget before parsing it", async () => {
    const res = await routes.cases.POST(
      new Request("http://localhost/api/cases", {
        method: "POST",
        headers: { "content-length": String(51 * 1024 * 1024 + 1), "content-type": "multipart/form-data; boundary=x" },
        body: "--x--",
      }),
    );
    expect(res.status).toBe(413);
  });

  it("marks cookies Secure only in production", () => {
    const env = process.env as Record<string, string | undefined>;
    const prev = env.NODE_ENV;
    try {
      env.NODE_ENV = "production";
      expect(sessionCookieHeader("a".repeat(48))).toMatch(/; Secure$/);
      env.NODE_ENV = "test";
      expect(sessionCookieHeader("a".repeat(48))).not.toMatch(/Secure/);
    } finally {
      env.NODE_ENV = prev;
    }
  });
});

describe("dispatch_unknown reconciliation", () => {
  let h: Harness;
  afterEach(() => h?.cleanup());

  function unknownThen(next: "accepted" | "rejected" | "unknown") {
    const startCall = vi.fn();
    startCall.mockResolvedValueOnce({ state: "dispatch_unknown", mode: "live", message: "timeout" });
    if (next === "accepted") startCall.mockResolvedValueOnce({ state: "accepted", mode: "live", providerCallId: "call_original" });
    if (next === "rejected") startCall.mockResolvedValueOnce({ state: "rejected", mode: "live", code: "DIAL_HTTP_400", message: "bad" });
    if (next === "unknown") startCall.mockResolvedValueOnce({ state: "dispatch_unknown", mode: "live", message: "still timing out" });
    const voice: VoiceAdapter = { ...fakeLiveVoice(), startCall };
    return voice;
  }

  async function unknownAttempt() {
    const c = await h.service.createCase(SESSION_A, { summary: "Charged twice", files: [], fields: COMPLETE_FIELDS });
    const authorizationId = h.service.authorize(SESSION_A, c.id, c.revision).authorization!.id;
    const call = await h.service.startCall(SESSION_A, c.id, { authorizationId, requestId: randomUUID() });
    expect(call.state).toBe("dispatch_unknown");
    return { c, call };
  }

  it("adopts the original call through an identical idempotent replay", async () => {
    const voice = unknownThen("accepted");
    h = makeHarness({ mode: "live", env: LIVE_ENV, voice });
    const { c, call } = await unknownAttempt();
    const reconciled = await h.service.reconcileUnknownCall(SESSION_A, c.id, call.id);
    expect(reconciled.state).toBe("queued");
    expect(reconciled.providerCallId).toBe("call_original");
    const calls = (voice.startCall as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]![0]).toEqual(calls[0]![0]);
    expect(calls[1]![0].attemptId).toBe(call.id);
    // Settled attempts are returned unchanged; nothing is sent again.
    await h.service.reconcileUnknownCall(SESSION_A, c.id, call.id);
    expect(calls).toHaveLength(2);
  });

  it("a definitive refusal marks the attempt failed and unlocks the case", async () => {
    h = makeHarness({ mode: "live", env: LIVE_ENV, voice: unknownThen("rejected") });
    const { c, call } = await unknownAttempt();
    expect((await h.service.reconcileUnknownCall(SESSION_A, c.id, call.id)).state).toBe("failed");
    const edited = h.service.patchCase(SESSION_A, c.id, c.revision, { amountMinor: 5000 });
    expect(edited.revision).toBe(c.revision + 1);
  });

  it("still unknown stays locked; past the replay window it fails without contacting the provider", async () => {
    const voice = unknownThen("unknown");
    h = makeHarness({ mode: "live", env: LIVE_ENV, voice });
    const { c, call } = await unknownAttempt();
    expect((await h.service.reconcileUnknownCall(SESSION_A, c.id, call.id)).state).toBe("dispatch_unknown");
    expect(voice.startCall).toHaveBeenCalledTimes(2);
    h.clock.advance(60 * 60 * 1000 + 1);
    expect((await h.service.reconcileUnknownCall(SESSION_A, c.id, call.id)).state).toBe("failed");
    expect(voice.startCall).toHaveBeenCalledTimes(2);
  });
});
