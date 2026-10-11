import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiHttpError } from "@/server/http/errors";
import type { BrowserDependencies } from "@/server/browser/service";
import { OWNER, OTHER, deferred, fixture } from "./helpers";

type FillInput = Parameters<NonNullable<BrowserDependencies["fillPreparation"]>>[0];
const fixtures: ReturnType<typeof fixture>[] = [];
const fields = [{ key: "vehicle", label: "Vehicle", value: "Silver 2022 Honda Civic" },
  { key: "incidentDescription", label: "Damage", value: "Right rear bumper dent and scrape" }];
function setup(overrides: Partial<BrowserDependencies> = {}) {
  const fill = vi.fn(async (input: FillInput) => { input.onFrame(Buffer.from("ACTUAL-CALLBACK-FRAME"), "Ready for review — not submitted"); });
  const f = fixture({ preparation: async () => "Reviewed insurance case brief", preparationFields: async () => structuredClone(fields), fillPreparation: fill, ...overrides });
  fixtures.push(f); return { ...f, fill, request: { expectedRevision: 1, requestId: randomUUID() } };
}
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });
async function terminal(f: ReturnType<typeof setup>, id: string) {
  await vi.waitFor(() => expect(["completed", "failed", "cancelled"]).toContain(f.service.get(OWNER, id).status));
  return f.service.get(OWNER, id);
}

describe("local preparation service boundaries (mock Chromium filler, real persistence)", () => {
  it("passes owned fields and exact evidence bytes into local filling, then exposes only callback frames without planner or external launch", async () => {
    const evidence = vi.fn(async () => [{ id: randomUUID(), name: "damage.png", mimeType: "image/png", bytes: Buffer.from([0, 1, 254, 255]) }]);
    const preparationFields = vi.fn(async () => structuredClone(fields));
    const f = setup({ evidence, preparationFields });
    const started = await f.service.startPreparation(OWNER, f.c.id, f.request);
    const run = await terminal(f, started.id);
    expect(evidence).toHaveBeenCalledWith(OWNER, f.c.id);
    expect(preparationFields).toHaveBeenCalledWith(OWNER, f.c.id);
    expect(f.fill).toHaveBeenCalledTimes(1);
    const input = f.fill.mock.calls[0]![0];
    expect(input.fields).toEqual(fields);
    expect(input.artifacts).toHaveLength(1);
    expect(input.artifacts[0]).toMatchObject({ name: "damage.png", mimeType: "image/png", bytes: Buffer.from([0, 1, 254, 255]) });
    expect(run).toMatchObject({ status: "completed", executionPolicy: "local_preparation", currentUrl: "about:blank", allowedHosts: [], pendingAction: null, frameAvailable: true });
    expect(run.message).toContain("nothing submitted to an insurer");
    expect(f.launch).not.toHaveBeenCalled(); expect(f.planner.next).not.toHaveBeenCalled(); expect(f.port.execute).not.toHaveBeenCalled();
    expect(await f.service.frame(OWNER, run.id)).toEqual(Buffer.from("ACTUAL-CALLBACK-FRAME"));
    const copiedFrame = await f.service.frame(OWNER, run.id); copiedFrame.fill(0);
    expect(await f.service.frame(OWNER, run.id)).toEqual(Buffer.from("ACTUAL-CALLBACK-FRAME"));
    expect(f.service.artifact(OWNER, run.id, run.artifacts[0]!.id).bytes.toString()).toBe("Reviewed insurance case brief");
    expect(() => f.service.get(OTHER, run.id)).toThrow("not found");
    await expect(f.service.frame(OTHER, run.id)).rejects.toMatchObject({ status: 404 });
    expect(() => f.service.artifact(OTHER, run.id, run.artifacts[1]!.id)).toThrow("not found");
  });

  it("reserves one local fill across concurrent start requests and replay after completion", async () => {
    const gate = deferred<void>();
    const fill = vi.fn(async () => gate.promise); const f = setup({ fillPreparation: fill });
    const [a, b] = await Promise.all([f.service.startPreparation(OWNER, f.c.id, f.request), f.service.startPreparation(OWNER, f.c.id, f.request)]);
    expect(a.id).toBe(b.id); expect(fill).toHaveBeenCalledTimes(1);
    gate.resolve(); await terminal(f, a.id);
    expect((await f.service.startPreparation(OWNER, f.c.id, f.request)).id).toBe(a.id);
    expect(fill).toHaveBeenCalledTimes(1);
    await expect(f.service.startPreparation(OWNER, f.c.id, { ...f.request, expectedRevision: 2 })).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
  });

  it("rejects another owner and stale revisions before loading case evidence or filling", async () => {
    const evidence = vi.fn(async () => []); const f = setup({ evidence });
    await expect(f.service.startPreparation(OTHER, f.c.id, f.request)).rejects.toThrow("NOT_OWNED");
    f.c.revision = 2;
    await expect(f.service.startPreparation(OWNER, f.c.id, f.request)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(evidence).not.toHaveBeenCalled(); expect(f.fill).not.toHaveBeenCalled();
    expect(f.store.byRequest(OWNER, f.request.requestId)).toBeNull();
  });

  it("propagates the reviewed preparation guard before starting when analysis has unresolved conflicts", async () => {
    const preparation = vi.fn(async () => { throw new ApiHttpError(409, "WORKFLOW_NOT_READY", "Resolve conflicting information"); });
    const preparationFields = vi.fn(async () => fields); const f = setup({ preparation, preparationFields });
    await expect(f.service.startPreparation(OWNER, f.c.id, f.request)).rejects.toMatchObject({ code: "WORKFLOW_NOT_READY" });
    expect(preparation).toHaveBeenCalledWith(OWNER, f.c.id, 1);
    expect(preparationFields).not.toHaveBeenCalled(); expect(f.fill).not.toHaveBeenCalled();
    expect(f.store.byRequest(OWNER, f.request.requestId)).toBeNull();
  });

  it("rejects revision changes while the preparation snapshot is loading", async () => {
    const gate = deferred<typeof fields>(); const preparationFields = vi.fn(async () => gate.promise); const f = setup({ preparationFields });
    const pending = f.service.startPreparation(OWNER, f.c.id, f.request);
    await vi.waitFor(() => expect(preparationFields).toHaveBeenCalledTimes(1));
    f.c.revision = 2; gate.resolve(fields);
    await expect(pending).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(f.fill).not.toHaveBeenCalled(); expect(f.store.byRequest(OWNER, f.request.requestId)).toBeNull();
  });

  it("does not report a stale packet ready when the case changes during filling", async () => {
    const gate = deferred<void>(); let captured!: FillInput;
    const fill = vi.fn(async (input: FillInput) => { captured = input; input.onFrame(Buffer.from("PARTIAL"), "Filled Vehicle"); await gate.promise; });
    const f = setup({ fillPreparation: fill }); const run = await f.service.startPreparation(OWNER, f.c.id, f.request);
    await vi.waitFor(() => expect(fill).toHaveBeenCalledTimes(1));
    expect(await f.service.frame(OWNER, run.id)).toEqual(Buffer.from("PARTIAL"));
    f.c.revision = 2; gate.resolve();
    expect((await terminal(f, run.id)).status).toBe("failed");
    expect(captured.signal.aborted).toBe(true);
    await expect(f.service.frame(OWNER, run.id)).rejects.toMatchObject({ status: 404 });
  });

  it("cancels local filling and ignores late screenshots or resolution without reviving the run", async () => {
    const gate = deferred<void>(); let captured!: FillInput;
    const fill = vi.fn(async (input: FillInput) => { captured = input; input.onFrame(Buffer.from("PARTIAL"), "Filled Vehicle"); await gate.promise; });
    const f = setup({ fillPreparation: fill }); const run = await f.service.startPreparation(OWNER, f.c.id, f.request);
    await vi.waitFor(() => expect(fill).toHaveBeenCalledTimes(1));
    const cancelled = await f.service.command(OWNER, run.id, { command: "cancel" });
    expect(cancelled).toMatchObject({ status: "cancelled", frameAvailable: false });
    expect(captured.signal.aborted).toBe(true);
    captured.onFrame(Buffer.from("LATE"), "Must not appear"); gate.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    const latest = f.service.get(OWNER, run.id);
    expect(latest.status).toBe("cancelled"); expect(latest.events.some(event => event.message === "Must not appear")).toBe(false);
    await expect(f.service.frame(OWNER, run.id)).rejects.toMatchObject({ status: 404 });
    await expect(f.service.command(OWNER, run.id, { command: "resume" })).rejects.toMatchObject({ code: "BROWSER_NOT_ACTIVE" });
  });

  it("rejects client-controlled fields or upload destinations and missing server-owned preparation fields", async () => {
    const f = setup({ preparationFields: async () => [] });
    await expect(f.service.startPreparation(OWNER, f.c.id, { ...f.request, fields })).rejects.toMatchObject({ status: 400 });
    await expect(f.service.startPreparation(OWNER, f.c.id, { ...f.request, startUrl: "https://aaa.com/claims" })).rejects.toMatchObject({ status: 400 });
    await expect(f.service.startPreparation(OWNER, f.c.id, f.request)).rejects.toMatchObject({ status: 400 });
    expect(f.fill).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled();
  });
});
