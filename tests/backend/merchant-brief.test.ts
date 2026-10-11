import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FixtureTransactionHistory } from "@/integrations/keewano/history";
import { FixtureMerchantInsights } from "@/integrations/keewano/insights";
import type { MerchantInsights } from "@/server/cases/insights";
import { CaseService } from "@/server/cases/service";
import { createSimulatedVoiceAdapter } from "@/server/cases/simulated-voice";
import { loadConfig } from "@/server/config";
import { HeuristicExtractor } from "@/server/documents/extractor";
import { UploadStore } from "@/server/documents/storage";
import { closeDatabase, openDatabase } from "@/server/persistence/db";
import { CaseRepository } from "@/server/persistence/repository";
import { COMPLETE_FIELDS, SESSION_A, TEST_SECRET } from "./helpers";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function build(insights: MerchantInsights | null) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "refund-merchant-"));
  closeDatabase();
  const config = loadConfig({ REFUND_MODE: "simulated", DATA_DIR: dataDir, SIMULATED_WEBHOOK_SECRET: TEST_SECRET, RECONCILE_MIN_INTERVAL_MS: "0" });
  const clock = { now: Date.parse("2026-10-11T20:00:00.000Z") };
  const voice = createSimulatedVoiceAdapter({ ...config.simulated, now: () => clock.now });
  const repo = new CaseRepository(openDatabase(config.dataDir));
  const service = new CaseService({
    config,
    repo,
    uploads: new UploadStore(config.dataDir),
    extractor: new HeuristicExtractor(),
    voice: () => voice,
    history: new FixtureTransactionHistory(),
    insights,
    now: () => new Date(clock.now),
  });
  cleanups.push(() => {
    closeDatabase();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { service, repo };
}

const create = (service: CaseService) =>
  service.createCase(SESSION_A, { summary: "Charged twice on October 3.", files: [], fields: COMPLETE_FIELDS });

describe("merchant track record before authorization", () => {
  it("lands on the timeline at creation and is frozen into the brief and the packet", async () => {
    const { service, repo } = build(new FixtureMerchantInsights());
    const c = await create(service);
    const entry = c.timeline.find((t) => t.type === "merchant_record");
    expect(entry?.message).toMatch(/^Merchant track record \(fixture\): Acme Streaming — 9 of 13 refund requests approved/);
    const authorized = service.authorize(SESSION_A, c.id, c.revision);
    const auth = repo.getAuthorization(authorized.authorization!.id)!;
    expect(auth.snapshot.merchantRecord).toMatchObject({ merchant: "Acme Streaming", approved: 9, cases: 13, revision: 1 });
    expect(auth.snapshot.brief).toContain("Merchant track record:");
    expect(auth.snapshot.brief).toContain("usually approves refund requests like this one");
    expect(auth.snapshot.brief).toContain("Transaction history evidence:"); // both checks coexist
    expect(service.packet(SESSION_A, c.id)).toContain("Merchant: Merchant track record (fixture): Acme Streaming");
  });

  it("re-captures for a new merchant after an edit, on the next read, and freezes only the current revision", async () => {
    const { service, repo } = build(new FixtureMerchantInsights());
    let c = await create(service);
    c = service.patchCase(SESSION_A, c.id, 1, { merchant: { name: "Nobody Inc", supportPhone: "+14155551000" } });
    expect(c.timeline.filter((t) => t.type === "merchant_record").length).toBe(1);
    c = await service.getCase(SESSION_A, c.id);
    const records = c.timeline.filter((t) => t.type === "merchant_record");
    expect(records.length).toBe(2);
    expect(records[1]!.message).toContain("no refund calls to Nobody Inc on record yet");
    c = await service.getCase(SESSION_A, c.id);
    expect(c.timeline.filter((t) => t.type === "merchant_record").length).toBe(2); // once per revision
    const authorized = service.authorize(SESSION_A, c.id, c.revision);
    const auth = repo.getAuthorization(authorized.authorization!.id)!;
    expect(auth.snapshot.merchantRecord).toMatchObject({ merchant: "Nobody Inc", cases: 0, revision: 2 });
    expect(auth.snapshot.brief).toContain("No prior decisions are known for this merchant");
  });

  it("stays silent when there is no source or the source fails, and never blocks authorization", async () => {
    const none = build(null);
    const c1 = await create(none.service);
    expect(c1.timeline.some((t) => t.type === "merchant_record")).toBe(false);
    const broken = build({ kind: "keewano", merchantRecord: async () => { throw new Error("MCP down"); } });
    const c2 = await create(broken.service);
    expect(c2.timeline.some((t) => t.type === "merchant_record")).toBe(false);
    const authorized = broken.service.authorize(SESSION_A, c2.id, c2.revision);
    const auth = broken.repo.getAuthorization(authorized.authorization!.id)!;
    expect(auth.snapshot.merchantRecord ?? null).toBeNull();
    expect(auth.snapshot.brief).not.toContain("Merchant track record:");
  });
});
