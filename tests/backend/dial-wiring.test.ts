import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDialAdapter } from "@/integrations/dial";
import { buildCaseService } from "@/server/cases/composition";
import { loadConfig } from "@/server/config";
import { ApiHttpError } from "@/server/http/errors";
import { closeDatabase } from "@/server/persistence/db";
import { COMPLETE_FIELDS, SESSION_A, authorizeAndCall, createReadyCase, makeHarness, type Harness } from "./helpers";

/** Teammate 3's adapter (src/integrations/dial) through teammate 2's service. No network is used. */
const dirs: string[] = [];
let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
  closeDatabase();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("Dial adapter wiring", () => {
  it("runs T3's simulated Dial adapter end to end: dispatch, poll, transcript, evidence-backed outcome", async () => {
    h = makeHarness({ voice: createDialAdapter({ mode: "simulated" }) });
    const c = await createReadyCase(h);
    const { call } = await authorizeAndCall(h, c);
    expect(call.state).toBe("queued");
    expect(call.providerCallId).toMatch(/^sim_dial_[a-f0-9]{64}$/);
    const cs = await h.service.getCase(SESSION_A, c.id);
    expect(cs.calls[0]?.state).toBe("completed");
    expect(cs.calls[0]?.transcript).toContain("SIMULATED");
    expect(cs.outcome.decision).toBe("needs_information");
    expect(cs.outcome.referenceNumber).toBe("DEMO-REFUND-001");
    expect(cs.outcome.paymentStatus).toBe("unverified");
    expect(cs.status).toBe("needs_information");
  });

  it("rejects an external webhook that names a simulated Dial call id as INVALID_WEBHOOK", async () => {
    h = makeHarness({ voice: createDialAdapter({ mode: "simulated" }) });
    const body = new TextEncoder().encode(JSON.stringify({ id: "evt", type: "call.ended", data: { callId: "sim_dial_" + "0".repeat(64) } }));
    const r = await h.service.handleWebhook(body, new Headers({ "x-dial-signature": "t=1,v1=00" }));
    expect(r.status).toBe(401);
  });

  it("live mode without Dial configuration is a visible 503 from the composition root, nothing persisted", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "refund-wiring-"));
    dirs.push(dataDir);
    closeDatabase();
    // OPENAI_BASE_URL points at a closed local port so no request ever leaves the machine.
    const config = loadConfig({
      REFUND_MODE: "live",
      DATA_DIR: dataDir,
      LLM_MODEL: "configured-by-user",
      OPENAI_API_KEY: "synthetic-test-key",
      OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
    });
    const service = buildCaseService(config);
    // Extraction would call the LLM; supply every fact by hand and skip documents so no request is made.
    const created = await service.createCase(SESSION_A, { summary: "Duplicate charge", files: [], fields: COMPLETE_FIELDS }).catch((e) => e);
    // In live mode the OpenAI extractor is used; a network failure is recorded, not fabricated.
    expect(created).not.toBeInstanceOf(ApiHttpError);
    const c = created as Awaited<ReturnType<typeof service.createCase>>;
    expect(c.mode).toBe("live");
    expect(c.timeline.some((t) => t.type === "extraction_failed")).toBe(true);
    const a = service.authorize(SESSION_A, c.id, c.revision);
    try {
      await service.startCall(SESSION_A, c.id, { authorizationId: a.authorization!.id, requestId: randomUUID() });
      throw new Error("expected 503");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiHttpError);
      const e = err as ApiHttpError;
      expect(e.status).toBe(503);
      expect(e.code).toBe("LIVE_CONFIGURATION_MISSING");
      expect(e.fields).toEqual(["DIAL_API_KEY", "DIAL_FROM_NUMBER", "DIAL_WEBHOOK_SECRET"]);
    }
    const after = await service.getCase(SESSION_A, c.id);
    expect(after.calls).toHaveLength(0);
  });
});
