import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceAdapter } from "@/contracts/voice";
import { buildCaseService } from "@/server/cases/composition";
import { CaseService } from "@/server/cases/service";
import { loadConfig } from "@/server/config";
import { HeuristicExtractor } from "@/server/documents/extractor";
import { UploadStore } from "@/server/documents/storage";
import { ApiHttpError } from "@/server/http/errors";
import { closeDatabase } from "@/server/persistence/db";
import { SESSION_A, authorizeAndCall, createReadyCase, makeHarness, type Harness } from "./helpers";

/** Teammate 3's verified boundary findings against 23bd75a (docs/handoffs/dial.txt, 12be4ab). */
let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.cleanup());

const expectApi = async (p: Promise<unknown> | (() => unknown), status: number, code: string): Promise<ApiHttpError> => {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (err) {
    expect(err).toBeInstanceOf(ApiHttpError);
    const e = err as ApiHttpError;
    expect([e.status, e.code]).toEqual([status, code]);
    return e;
  }
  throw new Error(`expected ${status} ${code}`);
};

describe("mode isolation", () => {
  it("a case authorized in simulated mode never dispatches through a live adapter after a mode switch", async () => {
    const c = await createReadyCase(h);
    const authorized = h.service.authorize(SESSION_A, c.id, c.revision);
    const liveAdapter: VoiceAdapter = {
      startCall: vi.fn(async () => ({ state: "accepted" as const, mode: "live" as const, providerCallId: "call_live" })),
      getCall: vi.fn(async () => {
        throw new Error("must not be called");
      }),
      verifyWebhook: vi.fn(async () => null),
    };
    // Same database, server restarted with REFUND_MODE=live.
    const liveConfig = loadConfig({ REFUND_MODE: "live", DATA_DIR: h.config.dataDir, LLM_MODEL: "m", OPENAI_API_KEY: "k" });
    const live = new CaseService({
      config: liveConfig,
      repo: h.repo,
      uploads: new UploadStore(liveConfig.dataDir),
      extractor: new HeuristicExtractor(),
      voice: () => liveAdapter,
      now: () => new Date(h.clock.now),
    });
    await expectApi(
      live.startCall(SESSION_A, c.id, { authorizationId: authorized.authorization!.id, requestId: randomUUID() }),
      409,
      "MODE_MISMATCH",
    );
    expect(liveAdapter.startCall).not.toHaveBeenCalled();
    expect(h.repo.listCalls(c.id)).toHaveLength(0);
    await expectApi(() => live.authorize(SESSION_A, c.id, c.revision), 409, "MODE_MISMATCH");
    // Reading the case in live mode must not look a simulated call up through the live provider.
    await authorizeAndCall(h, c);
    const viewedLive = await live.getCase(SESSION_A, c.id);
    expect(viewedLive.calls[0]?.mode).toBe("simulated");
    expect(liveAdapter.getCall).not.toHaveBeenCalled();
  });
});

describe("configuration errors at dispatch", () => {
  it("an adapter rejection with a configuration code is a 503 that releases the attempt instead of consuming the authorization", async () => {
    const voice: VoiceAdapter = {
      startCall: vi
        .fn<VoiceAdapter["startCall"]>()
        .mockResolvedValueOnce({ state: "rejected", mode: "live", code: "MISSING_CONFIG", message: "Configure DIAL_API_KEY on the server." })
        .mockResolvedValueOnce({ state: "accepted", mode: "simulated", providerCallId: `sim_${Date.now()}_approved_0badf00d` }),
      getCall: (id) => h.voice.getCall(id),
      verifyWebhook: async () => null,
    };
    const hh = makeHarness({ voice });
    try {
      const c = await createReadyCase(hh);
      const a = hh.service.authorize(SESSION_A, c.id, 1);
      const authorizationId = a.authorization!.id;
      await expectApi(hh.service.startCall(SESSION_A, c.id, { authorizationId, requestId: randomUUID() }), 503, "LIVE_CONFIGURATION_MISSING");
      expect(hh.repo.listCalls(c.id)).toHaveLength(0);
      const cs = await hh.service.getCase(SESSION_A, c.id);
      expect(cs.timeline.some((t) => t.type === "call_dispatch_config_error")).toBe(true);
      // Once configuration is fixed the same authorization can dispatch.
      const call = await hh.service.startCall(SESSION_A, c.id, { authorizationId, requestId: randomUUID() });
      expect(call.state).toBe("queued");
      expect(voice.startCall).toHaveBeenCalledTimes(2);
    } finally {
      hh.cleanup();
    }
  });

  it("an invalid DIAL_MAX_CALL_DURATION_SECONDS fails visibly before any attempt is persisted", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "refund-boundary-"));
    closeDatabase();
    try {
      const config = loadConfig({
        REFUND_MODE: "live",
        DATA_DIR: dataDir,
        LLM_MODEL: "m",
        OPENAI_API_KEY: "k",
        OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
        DIAL_API_KEY: "synthetic-dial-key",
        DIAL_FROM_NUMBER: "+12025550100",
        DIAL_MAX_CALL_DURATION_SECONDS: "abc",
      });
      expect(config.dial.maxCallDurationInvalid).toBe("abc");
      const service = buildCaseService(config);
      const c = await service.createCase(SESSION_A, {
        summary: "Duplicate charge",
        files: [],
        fields: { customerName: "S", merchantName: "M", supportPhone: "+12025550123", amountMinor: 100, currency: "USD" },
      });
      const a = service.authorize(SESSION_A, c.id, 1);
      const e = await expectApi(
        service.startCall(SESSION_A, c.id, { authorizationId: a.authorization!.id, requestId: randomUUID() }),
        503,
        "LIVE_CONFIGURATION_MISSING",
      );
      expect(e.fields).toEqual(["DIAL_MAX_CALL_DURATION_SECONDS"]);
      expect(await service.getCase(SESSION_A, c.id).then((x) => x.calls)).toHaveLength(0);
    } finally {
      closeDatabase();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("validated configuration reaches the Dial adapter", () => {
  const DIAL_KEYS = ["DIAL_API_KEY", "DIAL_FROM_NUMBER", "DIAL_WEBHOOK_SECRET", "DIAL_MAX_CALL_DURATION_SECONDS"] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of DIAL_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k]; // scrubbed environment: only the validated config may reach the adapter
    }
  });
  afterEach(() => {
    for (const k of DIAL_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("dispatches with the config validated by the composition root, not process.env (fake transport, no network)", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "refund-boundary-"));
    closeDatabase();
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (init?.method === "POST" && url.endsWith("/calls")) {
        return new Response(JSON.stringify({ call: { id: "call_fake_123", status: { state: "Queued" } } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 500 });
    });
    try {
      const config = loadConfig({
        REFUND_MODE: "live",
        DATA_DIR: dataDir,
        LLM_MODEL: "m",
        OPENAI_API_KEY: "k",
        OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
        DIAL_API_KEY: "synthetic-dial-key",
        DIAL_FROM_NUMBER: "+12025550100",
      });
      const service = buildCaseService(config, { dialDependencies: { fetch: fetchMock as unknown as typeof fetch } });
      const c = await service.createCase(SESSION_A, {
        summary: "Duplicate charge",
        files: [],
        fields: { customerName: "Sam Rivera", merchantName: "Acme", supportPhone: "+12025550123", amountMinor: 4999, currency: "USD" },
      });
      const a = service.authorize(SESSION_A, c.id, 1);
      const call = await service.startCall(SESSION_A, c.id, { authorizationId: a.authorization!.id, requestId: randomUUID() });
      expect(call.state).toBe("queued");
      expect(call.providerCallId).toBe("call_fake_123");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0]!;
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer synthetic-dial-key");
      expect(headers.get("idempotency-key")).toBe(call.id);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.to).toBe("+12025550123");
      expect(body.fromNumber).toBe("+12025550100");
      expect(body.maxCallDurationSeconds).toBe(300);
    } finally {
      closeDatabase();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
