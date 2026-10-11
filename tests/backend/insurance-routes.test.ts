import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CaseV1 } from "@/contracts/case";
import { CALL_PURPOSES } from "@/contracts/voice";
import { closeDatabase } from "@/server/persistence/db";

/** V1.2 insurance facts and authorization purpose over the real route handlers. */
let dataDir: string;
let routes: {
  cases: typeof import("@/app/api/cases/route");
  byId: typeof import("@/app/api/cases/[id]/route");
  authorize: typeof import("@/app/api/cases/[id]/authorize/route");
};

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "insurance-routes-"));
  process.env.REFUND_MODE = "simulated";
  process.env.DATA_DIR = dataDir;
  closeDatabase();
  (globalThis as { __refundService?: unknown }).__refundService = undefined;
  routes = {
    cases: await import("@/app/api/cases/route"),
    byId: await import("@/app/api/cases/[id]/route"),
    authorize: await import("@/app/api/cases/[id]/authorize/route"),
  };
});
afterAll(() => {
  closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const BASE = "http://localhost/api/cases";

async function createClaimCase(extra: Record<string, string> = {}): Promise<{ c: CaseV1; session: string }> {
  const form = new FormData();
  form.set("summary", "Policy number: NWM-HO-0441772. A pipe burst and flooded my kitchen.");
  form.set("customerName", "Jordan Lee");
  form.set("merchantName", "Lemonade");
  form.set("incidentDate", "2026-10-03");
  form.set("lossDescription", "Burst pipe flooded the kitchen");
  form.set("claimType", "water damage");
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  const res = await routes.cases.POST(new Request(BASE, { method: "POST", body: form }));
  expect(res.status).toBe(201);
  const session = res.headers.get("set-cookie")!.split(";")[0]!;
  return { c: ((await res.json()) as { case: CaseV1 }).case, session };
}

const authorize = (id: string, session: string, body: unknown) =>
  routes.authorize.POST(
    new Request(`${BASE}/${id}/authorize`, { method: "POST", headers: { cookie: session, "content-type": "application/json" }, body: JSON.stringify(body) }),
    ctx(id),
  );

describe("insurance routes (V1.2)", () => {
  it("POST /api/cases accepts insurance facts, extracts the policy number and fills the registry number", async () => {
    const { c } = await createClaimCase();
    expect(c.policyNumber).toBe("NWM-HO-0441772");
    expect(c.incidentDate).toBe("2026-10-03");
    expect(c.lossDescription).toBe("Burst pipe flooded the kitchen");
    expect(c.claimType).toBe("water damage");
    expect(c.merchant.supportPhone).toMatch(/^\+1\d{10}$/);
    expect(c.merchant.source).toMatchObject({ kind: "insurer_registry", insurerId: "lemonade", purpose: "claims" });
    // A case describing a loss is prepared for file_claim: no amount needed, claim draft ready.
    expect(c.suggestedPurpose).toBe("file_claim");
    expect(c.missingFields).toEqual([]);
    expect(c.status).toBe("ready_for_approval");
    expect(c.draft?.subject).toBe("New claim: water damage on 2026-10-03 (policy NWM-HO-0441772)");
    expect(c.missingFieldsByPurpose?.request_refund).toEqual(["amountMinor"]);
    expect(c.missingFieldsByPurpose?.gather_information).toEqual([]);
  });

  it("POST /api/cases rejects an invalid incident date", async () => {
    const form = new FormData();
    form.set("summary", "x");
    form.set("incidentDate", "Oct 3");
    const res = await routes.cases.POST(new Request(BASE, { method: "POST", body: form }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { fields: string[] } }).error.fields).toEqual(["incidentDate"]);
  });

  it("authorize validates purpose against the exported CALL_PURPOSES list", async () => {
    const { c, session } = await createClaimCase();
    const bad = await authorize(c.id, session, { expectedRevision: c.revision, purpose: "sue_them" });
    expect(bad.status).toBe(400);
    const msg = ((await bad.json()) as { error: { message: string; fields: string[] } }).error;
    expect(msg.fields).toEqual(["purpose"]);
    for (const p of CALL_PURPOSES) expect(msg.message).toContain(p);

    // Absent purpose = request_refund, which needs an amount this claim case does not have.
    const refund = await authorize(c.id, session, { expectedRevision: c.revision });
    expect(refund.status).toBe(422);
    expect(((await refund.json()) as { error: { fields: string[] } }).error.fields).toEqual(["amountMinor"]);
  });

  it("authorize with file_claim succeeds without an amount once the claim facts are present", async () => {
    if (!(CALL_PURPOSES as readonly string[]).includes("file_claim")) return;
    const { c, session } = await createClaimCase();
    expect(c.missingFieldsByPurpose?.["file_claim" as keyof typeof c.missingFieldsByPurpose]).toEqual([]);
    const ok = await authorize(c.id, session, { expectedRevision: c.revision, purpose: "file_claim" });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { case: CaseV1 }).case.authorization?.purpose).toBe("file_claim");
  });

  it("PATCH edits insurance facts and a manual number replaces the registry source with a user source", async () => {
    const { c, session } = await createClaimCase();
    const res = await routes.byId.PATCH(
      new Request(`${BASE}/${c.id}`, {
        method: "PATCH",
        headers: { cookie: session, "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: c.revision, changes: { merchant: { name: "Lemonade", supportPhone: "+14155550123" }, incidentDate: "2026-10-04" } }),
      }),
      ctx(c.id),
    );
    expect(res.status).toBe(200);
    const next = ((await res.json()) as { case: CaseV1 }).case;
    expect(next.merchant.supportPhone).toBe("+14155550123");
    expect(next.merchant.source).toEqual({ kind: "user" });
    expect(next.incidentDate).toBe("2026-10-04");
  });
});
