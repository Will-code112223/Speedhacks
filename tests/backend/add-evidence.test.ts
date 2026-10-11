import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CaseService } from "@/server/cases/service";
import { createSimulatedVoiceAdapter } from "@/server/cases/simulated-voice";
import { EMPTY_FIELDS, type ExtractedFields, type Extractor } from "@/server/documents/extractor";
import { UploadStore, type UploadInput } from "@/server/documents/storage";
import { ApiHttpError } from "@/server/http/errors";
import { COMPLETE_FIELDS, SESSION_A, SESSION_B, authorizeAndCall, createReadyCase, makeHarness, type Harness } from "./helpers";

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.cleanup());

const expectApi = async (p: Promise<unknown>, status: number, code: string) => {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiHttpError);
    const e = err as ApiHttpError;
    expect([e.status, e.code]).toEqual([status, code]);
    return e;
  }
  throw new Error(`expected ${status} ${code}`);
};

const png: UploadInput = { name: "kitchen.png", mimeType: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]) };
const pdf: UploadInput = { name: "estimate.pdf", mimeType: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.4 estimate") };

/** A service over the harness's database whose extractor is scripted per test. */
function withExtractor(extractor: Extractor): CaseService {
  return new CaseService({
    config: h.config,
    repo: h.repo,
    uploads: new UploadStore(h.config.dataDir),
    extractor,
    voice: () => createSimulatedVoiceAdapter({ ...h.config.simulated, now: () => h.clock.now }),
    now: () => new Date(h.clock.now),
  });
}

function scripted(fields: Partial<ExtractedFields>, seen: { documents: string[][] } = { documents: [] }): Extractor {
  return {
    kind: "heuristic",
    async extract(input) {
      seen.documents.push(input.documents.map((d) => d.name));
      // Facts come from documents only, so a case created without files gets none.
      if (input.documents.length === 0) return { fields: { ...EMPTY_FIELDS }, provenance: [], notes: [] };
      const all = { ...EMPTY_FIELDS, ...fields };
      return {
        fields: all,
        provenance: (Object.entries(fields) as [keyof ExtractedFields, unknown][]).map(([field, value]) => ({
          field,
          value: String(value),
          sourceKind: "document" as const,
          sourceRef: input.documents[0]?.evidenceId ?? null,
          excerpt: String(value),
        })),
        notes: [],
      };
    },
  };
}

describe("CaseService.addEvidence", () => {
  it("stores the files, logs evidence_added per file and bumps the revision", async () => {
    const c = await createReadyCase(h);
    const next = await h.service.addEvidence(SESSION_A, c.id, [png, pdf]);
    expect(next.revision).toBe(c.revision + 1);
    expect(next.evidence.map((e) => e.name).sort()).toEqual(["estimate.pdf", "kitchen.png", "receipt.txt"]);
    const added = next.timeline.filter((t) => t.type === "evidence_added").map((t) => t.message);
    expect(added).toHaveLength(3);
    expect(added.some((m) => /kitchen\.png \(image\/png, 11 bytes\)/.test(m))).toBe(true);
    for (const row of h.repo.listEvidence(c.id)) expect(fs.existsSync(path.resolve(h.config.dataDir, row.storedPath)) || fs.existsSync(row.storedPath)).toBe(true);
  });

  it("fills only empty facts from the new documents, never overwriting the user's values", async () => {
    const seen = { documents: [] as string[][] };
    const svc = withExtractor(scripted({ customerName: "Someone Else", policyNumber: "HO-123456", amountMinor: 1 }, seen));
    const c = await svc.createCase(SESSION_A, { summary: "Water damage to my kitchen.", files: [png], fields: COMPLETE_FIELDS });
    expect(c.policyNumber).toBe("HO-123456");
    const cleared = await svc.createCase(SESSION_A, { summary: "Water damage to my kitchen.", files: [], fields: COMPLETE_FIELDS });
    expect(cleared.policyNumber).toBeNull();
    seen.documents.length = 0;

    const next = await svc.addEvidence(SESSION_A, cleared.id, [pdf]);
    // Only the new document is read.
    expect(seen.documents).toEqual([["estimate.pdf"]]);
    expect(next.policyNumber).toBe("HO-123456");
    expect(next.customer.name).toBe(COMPLETE_FIELDS.customerName);
    expect(next.amountMinor).toBe(COMPLETE_FIELDS.amountMinor);
    expect(next.timeline.some((t) => t.type === "facts_extracted")).toBe(true);
    const provenance = h.repo.listProvenance(cleared.id).filter((p) => p.revision === next.revision);
    expect(provenance.map((p) => p.field)).toEqual(["policyNumber"]);
  });

  it("invalidates an existing authorization", async () => {
    const c = await createReadyCase(h);
    const authorized = h.service.authorize(SESSION_A, c.id, c.revision);
    expect(authorized.authorization).not.toBeNull();
    const next = await h.service.addEvidence(SESSION_A, c.id, [png]);
    expect(next.authorization).toBeNull();
    expect(next.status).not.toBe("authorized");
    expect(next.timeline.some((t) => t.type === "authorization_cleared")).toBe(true);
  });

  it("refuses while a call is in flight and stores nothing", async () => {
    const c = await createReadyCase(h);
    await authorizeAndCall(h, c);
    await expectApi(h.service.addEvidence(SESSION_A, c.id, [png]), 409, "CALL_IN_PROGRESS");
    expect(h.repo.listEvidence(c.id)).toHaveLength(1);
  });

  it("makes an extraction failure visible in the timeline and still attaches the files", async () => {
    const c = await createReadyCase(h);
    const failing: Extractor = {
      kind: "openai",
      async extract() {
        throw new Error("model unavailable");
      },
    };
    const next = await withExtractor(failing).addEvidence(SESSION_A, c.id, [pdf]);
    const failed = next.timeline.find((t) => t.type === "extraction_failed");
    expect(failed?.message).toMatch(/model unavailable/);
    expect(next.evidence.map((e) => e.name)).toContain("estimate.pdf");
    expect(next.revision).toBe(c.revision + 1);
  });

  it("is owner-scoped and validates uploads", async () => {
    const c = await createReadyCase(h);
    await expectApi(h.service.addEvidence(SESSION_B, c.id, [png]), 404, "NOT_FOUND");
    await expectApi(h.service.addEvidence(SESSION_A, c.id, Array.from({ length: 6 }, () => png)), 400, "BAD_REQUEST");
    await expectApi(h.service.addEvidence(SESSION_A, c.id, []), 400, "BAD_REQUEST");
  });
});
