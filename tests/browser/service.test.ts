import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { BrowserService } from "@/server/browser/service";
import { OWNER, OTHER, deferred, done, fixture, ready } from "./helpers";
import type { BrowserPort, PlannedStep } from "@/server/browser/types";
import { BrowserPageChangedError } from "@/server/browser/types";

const fixtures: ReturnType<typeof fixture>[] = [];
function setup(...args: Parameters<typeof fixture>) { const f = fixture(...args); fixtures.push(f); return f; }
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });
const approve = (run: Awaited<ReturnType<typeof ready>>) => ({ command: "approve", pendingActionId: run.pendingAction!.id, observationId: run.pendingAction!.observationId });

describe("real browser service boundaries (mock browser and planner, no live network)", () => {
  it("visits an inspect-only provider once, retains its real captured frame and never plans or sends case data", async () => {
    const executionPolicy = vi.fn(async () => "inspect_only" as const);
    const f = setup({ executionPolicy });
    const run = await ready(f);
    expect(executionPolicy).toHaveBeenCalledWith(OWNER, f.c.id);
    expect(run).toMatchObject({ executionPolicy: "inspect_only", status: "completed", frameAvailable: true, pendingAction: null, currentUrl: f.observation.url });
    expect(run.message).toContain("sample packet stays in Recourse");
    expect(f.port.observe).toHaveBeenCalledTimes(1);
    expect(f.port.screenshot).toHaveBeenCalledTimes(1);
    expect(f.port.execute).not.toHaveBeenCalled();
    expect(f.port.loginHandoff).not.toHaveBeenCalled();
    expect(f.planner.next).not.toHaveBeenCalled();
    expect(await f.service.frame(OWNER, run.id)).toEqual(Buffer.from("MOCK-JPEG"));
    expect(f.port.screenshot).toHaveBeenCalledTimes(1);
    await expect(f.service.command(OWNER, run.id, { command: "resume" })).rejects.toMatchObject({ code: "BROWSER_NOT_ACTIVE" });
    await expect(f.service.command(OWNER, run.id, { command: "approve", pendingActionId: randomUUID(), observationId: randomUUID() })).rejects.toMatchObject({ code: "BROWSER_NOT_ACTIVE" });
    expect((await f.service.start(OWNER, f.input)).id).toBe(run.id);
    expect(f.launch).toHaveBeenCalledTimes(1);
    expect(f.port.execute).not.toHaveBeenCalled();
    expect(() => f.service.get(OTHER, run.id)).toThrow("not found");
    await expect(f.service.frame(OTHER, run.id)).rejects.toMatchObject({ status: 404 });
    expect(() => f.service.artifact(OTHER, run.id, run.artifacts[0]!.id)).toThrow("not found");
  });
  it("stops inspect-only at provider login without opening a credential handoff or capturing a login screen", async () => {
    const f = setup({ executionPolicy: async () => "inspect_only" });
    f.observation.hasPassword = true;
    const run = await ready(f);
    expect(run).toMatchObject({ status: "completed", frameAvailable: false, pendingAction: null });
    expect(run.message).toContain("Provider sign-in is required");
    expect(f.port.loginHandoff).not.toHaveBeenCalled();
    expect(f.port.screenshot).not.toHaveBeenCalled();
    expect(f.planner.next).not.toHaveBeenCalled();
    expect(f.port.execute).not.toHaveBeenCalled();
    await expect(f.service.frame(OWNER, run.id)).rejects.toMatchObject({ status: 404 });
  });
  it("preserves the genuine reviewed workflow and rejects client attempts to select another execution policy", async () => {
    const f = setup({ executionPolicy: async () => "review_each_action" });
    await expect(f.service.start(OWNER, { ...f.input, executionPolicy: "inspect_only" })).rejects.toMatchObject({ status: 400 });
    expect(f.launch).not.toHaveBeenCalled();
    const run = await ready(f);
    expect(run).toMatchObject({ executionPolicy: "review_each_action", status: "needs_approval" });
    expect(f.planner.next).toHaveBeenCalledTimes(1);
    expect(f.port.execute).not.toHaveBeenCalled();
    expect((await f.service.command(OWNER, run.id, approve(run))).status).toBe("completed");
    expect(f.port.execute).toHaveBeenCalledTimes(1);
  });
  it("reserves one startup across concurrent requests and recovers a lost response without another launch", async () => {
    const f = setup();
    const [a, b] = await Promise.all([f.service.start(OWNER, f.input), f.service.start(OWNER, f.input)]);
    expect(a.id).toBe(b.id); expect(f.launch).toHaveBeenCalledTimes(1);
    expect(f.service.find(OWNER, f.c.id, f.input.requestId).id).toBe(a.id);
    await expect(f.service.start(OWNER, { ...f.input, task: "Different objective" })).rejects.toMatchObject({ status: 409 });
  });
  it("cannot turn a simulated case, missing configuration or stale revision into a browser dispatch", async () => {
    const missing = setup({ configured: false });
    await expect(missing.service.start(OWNER, missing.input)).rejects.toMatchObject({ status: 503 });
    expect(missing.store.byRequest(OWNER, missing.input.requestId)).toBeNull(); expect(missing.launch).not.toHaveBeenCalled();
    const simulated = setup(); simulated.c.mode = "simulated";
    await expect(simulated.service.start(OWNER, simulated.input)).rejects.toMatchObject({ code: "MODE_MISMATCH" });
    simulated.c.mode = "live"; simulated.c.revision = 2;
    await expect(simulated.service.start(OWNER, simulated.input)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(simulated.launch).not.toHaveBeenCalled();
  });
  it("creates genuine neutral bytes from owned known facts without fabricating claim details or trusting draft assertions", async () => {
    const f = setup(); const run = await ready(f); const artifact = f.service.artifact(OWNER, run.id, run.artifacts[0]!.id);
    expect(artifact.name).toBe("request.txt"); const body = artifact.bytes.toString();
    expect(body).toContain("Unknown — clarification required"); expect(body).toContain(f.c.doc.reason);
    expect(body).not.toContain("Invented refund assertion"); expect(body).toContain("Not an insurer form");
  });
  it("provides the persisted interview brief to the real planner and generated artifact", async () => {
    const brief = "PREPARATION ONLY\nVehicle: user-supplied sedan\nLoss date: 2026-10-01\nPolicy: user-supplied policy";
    const preparation = vi.fn(async () => brief); const f = setup({ preparation }); const run = await ready(f);
    expect(preparation).toHaveBeenCalledWith(OWNER, f.c.id, 1);
    expect(f.service.artifact(OWNER, run.id, run.artifacts[0]!.id).bytes.toString()).toBe(brief);
    expect(f.planner.next.mock.calls[0]![0].draft).toBe(brief);
  });
  it("rejects stale case facts when an edit races with preparation loading", async () => {
    const gate = deferred<string | null>(); const f = setup({ preparation: async () => gate.promise });
    const attempt = f.service.start(OWNER, f.input);
    await vi.waitFor(() => expect(f.loadCase).toHaveBeenCalledTimes(1));
    f.c.revision = 2; gate.resolve("old brief");
    await expect(attempt).rejects.toMatchObject({ code: "REVISION_CONFLICT" }); expect(f.launch).not.toHaveBeenCalled();
  });
  it("never exposes another owner's run, recovery, screenshot, or artifact", async () => {
    const f = setup(); const run = await ready(f);
    expect(() => f.service.get(OTHER, run.id)).toThrow("not found");
    expect(() => f.service.find(OTHER, f.c.id, f.input.requestId)).toThrow("not found");
    await expect(f.service.frame(OTHER, run.id)).rejects.toMatchObject({ status: 404 });
    expect(() => f.service.artifact(OTHER, run.id, run.artifacts[0]!.id)).toThrow("not found");
    expect(JSON.stringify(run)).not.toContain(OWNER);
  });
  it("does not execute proposals until exact approval; additional payload fields cannot rewrite the action", async () => {
    const f = setup(); const run = await ready(f); expect(f.port.execute).not.toHaveBeenCalled();
    await expect(f.service.command(OWNER, run.id, { ...approve(run), pendingActionId: randomUUID() })).rejects.toMatchObject({ status: 409 });
    await expect(f.service.command(OWNER, run.id, { ...approve(run), value: "malicious overwrite" })).rejects.toMatchObject({ status: 400 });
    expect(f.port.execute).not.toHaveBeenCalled();
    const result = await f.service.command(OWNER, run.id, approve(run));
    expect(f.port.execute).toHaveBeenCalledTimes(1); expect(result.status).toBe("completed");
    expect(result.message).not.toContain(done.description); expect(result.message).toContain("No claim submission or payment result has been verified");
    await expect(f.service.command(OWNER, run.id, approve(run))).rejects.toMatchObject({ status: 409 });
  });
  it("consumes durable approval before dispatch and rejects simultaneous deliveries", async () => {
    const f = setup(); const run = await ready(f); const gate = deferred<void>();
    vi.mocked(f.port.execute).mockImplementation(async () => {
      expect(f.store.get(OWNER, run.id)?.executing).toBe(true);
      expect(f.store.get(OWNER, run.id)?.run.pendingAction).toBeNull(); await gate.promise;
    });
    const first = f.service.command(OWNER, run.id, approve(run));
    await vi.waitFor(() => expect(f.port.execute).toHaveBeenCalledTimes(1));
    await expect(f.service.command(OWNER, run.id, approve(run))).rejects.toMatchObject({ code: "BROWSER_BUSY" });
    gate.resolve(); await first; expect(f.port.execute).toHaveBeenCalledTimes(1);
  });
  it("checks case revision again at approval and re-observes after the async case lookup", async () => {
    const f = setup(); const run = await ready(f); f.c.revision = 2;
    await expect(f.service.command(OWNER, run.id, approve(run))).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(f.port.execute).not.toHaveBeenCalled(); f.c.revision = 1;
    const gate = deferred<typeof f.c>(); f.loadCase.mockImplementationOnce(async () => gate.promise);
    const attempt = f.service.command(OWNER, run.id, approve(run)); f.observation.fingerprint = "changed-during-lookup"; gate.resolve(f.c);
    await expect(attempt).rejects.toMatchObject({ code: "OBSERVATION_CHANGED" }); expect(f.port.execute).not.toHaveBeenCalled();
  });
  it("records ambiguous action failure as uncertain and never retries it", async () => {
    const f = setup(); const run = await ready(f); vi.mocked(f.port.execute).mockRejectedValue(new Error("request may have been sent: PRIVATE DATA"));
    const result = await f.service.command(OWNER, run.id, approve(run)); expect(result.status).toBe("uncertain");
    expect(JSON.stringify(result)).not.toContain("PRIVATE DATA");
    await expect(f.service.command(OWNER, run.id, { command: "resume" })).rejects.toMatchObject({ status: 409 });
    expect((await f.service.start(OWNER, f.input)).status).toBe("uncertain"); expect(f.port.execute).toHaveBeenCalledTimes(1);
    await expect(f.service.start(OWNER, { ...f.input, requestId: randomUUID() })).rejects.toMatchObject({ code: "BROWSER_UNRESOLVED" });
  });
  it("consumes a stale approval but requests a new one when the port detects a last-moment page change", async () => {
    const f = setup(); const run = await ready(f);
    f.planner.next.mockResolvedValue(f.click);
    vi.mocked(f.port.execute).mockRejectedValueOnce(new BrowserPageChangedError());
    await expect(f.service.command(OWNER, run.id, approve(run))).rejects.toMatchObject({ code: "OBSERVATION_CHANGED" });
    expect(f.port.execute).toHaveBeenCalledWith(f.click, undefined, f.observation.fingerprint);
    const updated = f.service.get(OWNER, run.id);
    expect(updated.status).toBe("needs_approval"); expect(updated.pendingAction!.id).not.toBe(run.pendingAction!.id);
    expect(f.store.get(OWNER, run.id)?.executing).toBe(false);
    await expect(f.service.command(OWNER, run.id, approve(run))).rejects.toMatchObject({ status: 409 });
    expect(f.port.execute).toHaveBeenCalledTimes(1);
  });
  it("does not revive cancellation during launch or model planning", async () => {
    const gate = deferred<BrowserPort>(); const f = setup({ launch: async () => gate.promise });
    const run = await f.service.start(OWNER, f.input); await f.service.command(OWNER, run.id, { command: "cancel" }); gate.resolve(f.port);
    await vi.waitFor(() => expect(f.port.close).toHaveBeenCalled()); expect(f.service.get(OWNER, run.id).status).toBe("cancelled"); expect(f.planner.next).not.toHaveBeenCalled();
    const p = deferred<PlannedStep>(); const other = setup({ planner: { next: async () => p.promise } });
    const run2 = await other.service.start(OWNER, other.input); await vi.waitFor(() => expect(other.port.observe).toHaveBeenCalled());
    await other.service.command(OWNER, run2.id, { command: "cancel" }); p.resolve(other.click);
    await new Promise(r => setTimeout(r, 0)); expect(other.service.get(OWNER, run2.id).status).toBe("cancelled"); expect(other.port.execute).not.toHaveBeenCalled();
  });
  it("cancel during a dispatched action remains uncertain even if the browser later resolves", async () => {
    const f = setup(); const run = await ready(f); const gate = deferred<void>(); vi.mocked(f.port.execute).mockImplementation(() => gate.promise);
    const pending = f.service.command(OWNER, run.id, approve(run)); await vi.waitFor(() => expect(f.port.execute).toHaveBeenCalled());
    expect((await f.service.command(OWNER, run.id, { command: "cancel" })).status).toBe("uncertain"); gate.resolve(); await pending;
    expect(f.service.get(OWNER, run.id).status).toBe("uncertain");
  });
  it("process loss makes a persisted pending run uncertain and does not launch again", async () => {
    const f = setup(); const run = await ready(f); await f.service.dispose(); const restarted = new BrowserService(f.deps);
    expect(restarted.get(OWNER, run.id).status).toBe("uncertain");
    expect((await restarted.start(OWNER, f.input)).status).toBe("uncertain"); expect(f.launch).toHaveBeenCalledTimes(1);
  });
  it("login pauses screenshots/planning, uses local handoff, and permits only explicit resume", async () => {
    const f = setup(); f.observation.hasPassword = true; const run = await ready(f);
    expect(run.status).toBe("needs_login"); expect(run.frameAvailable).toBe(false); expect(f.port.loginHandoff).toHaveBeenCalledTimes(1);
    expect(f.port.screenshot).not.toHaveBeenCalled(); expect(f.planner.next).not.toHaveBeenCalled(); await expect(f.service.frame(OWNER, run.id)).rejects.toMatchObject({ status: 404 });
    f.observation.hasPassword = false; const resumed = await f.service.command(OWNER, run.id, { command: "resume" }); expect(resumed.status).toBe("needs_approval");
  });
  it("reject cancels instead of repeatedly proposing the same action", async () => {
    const f = setup(); const run = await ready(f);
    expect((await f.service.command(OWNER, run.id, { command: "reject", pendingActionId: run.pendingAction!.id })).status).toBe("cancelled");
    expect(f.port.execute).not.toHaveBeenCalled(); expect(f.planner.next).toHaveBeenCalledTimes(1);
  });
  it("rechecks case edits made while the browser observation is pending", async () => {
    const f = setup(); const run = await ready(f); const gate = deferred<typeof f.observation>();
    vi.mocked(f.port.observe).mockImplementationOnce(() => gate.promise);
    const attempt = f.service.command(OWNER, run.id, approve(run));
    await vi.waitFor(() => expect(f.port.observe).toHaveBeenCalledTimes(2));
    f.c.revision = 2; gate.resolve(f.observation);
    await expect(attempt).rejects.toMatchObject({ code: "REVISION_CONFLICT" }); expect(f.port.execute).not.toHaveBeenCalled();
  });
  it("cannot restore a screenshot after cancellation while capture was pending", async () => {
    const f = setup(); const run = await ready(f); const gate = deferred<Buffer>();
    vi.mocked(f.port.screenshot).mockImplementationOnce(() => gate.promise);
    const attempt = f.service.frame(OWNER, run.id);
    await f.service.command(OWNER, run.id, { command: "cancel" }); gate.resolve(Buffer.from("late-frame"));
    await expect(attempt).rejects.toMatchObject({ status: 404 }); expect(f.service.get(OWNER, run.id).frameAvailable).toBe(false);
  });
  it("rejects invented target IDs, outside URLs and foreign upload artifacts without any browser action", async () => {
    for (const mutation of [{ elementId: randomUUID() }, { kind: "navigate", value: "https://evil.example/steal", elementId: null }, { kind: "upload", artifactId: randomUUID() }]) {
      const f = setup(); f.planner.next.mockReset().mockResolvedValue({ ...f.click, ...mutation });
      expect((await ready(f)).status).toBe("failed"); expect(f.port.execute).not.toHaveBeenCalled();
    }
  });
  it("caps read-only planner loops instead of running indefinitely", async () => {
    const f = setup(); f.planner.next.mockReset().mockResolvedValue({ kind: "inspect", elementId: null, value: null, artifactId: null, description: "Inspect again" });
    expect((await ready(f)).status).toBe("failed"); expect(f.planner.next).toHaveBeenCalledTimes(4);
  });
});
