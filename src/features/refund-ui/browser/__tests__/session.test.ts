import { describe, expect, it } from "vitest";
import type { BrowserRun } from "../../../../contracts/browser";
import { browserHosts, browserStartUrl, browserStorageKey, createBrowserSession } from "../session";
import { api, deferred, request, run, storage } from "./support";

function setup(savedRunId: string | null | undefined = undefined) {
  const service = api(); const store = storage();
  if (savedRunId !== undefined) store.setItem(browserStorageKey(request.caseId), JSON.stringify({ caseId: request.caseId, request, runId: savedRunId }));
  return { service, store, session: createBrowserSession(request.caseId, service, store) };
}

describe("real browser session recovery", () => {
  it("does nothing on a fresh mount and requires an explicit start", async () => {
    const { service, session, store } = setup();
    await session.recover();
    expect(service.start).not.toHaveBeenCalled(); expect(service.get).not.toHaveBeenCalled(); expect(service.find).not.toHaveBeenCalled();
    expect(session.getSnapshot().recovering).toBe(false);
    service.start.mockImplementation(async () => { expect(JSON.parse(store.getItem(browserStorageKey(request.caseId))!).request).toEqual(request); return run(); });
    await session.start(request);
    expect(service.start).toHaveBeenCalledExactlyOnceWith(request);
  });
  it("recovers by run ID with GET only", async () => {
    const { service, session } = setup("run-1"); await session.recover();
    expect(service.get).toHaveBeenCalledExactlyOnceWith("run-1", undefined);
    expect(service.start).not.toHaveBeenCalled(); expect(service.command).not.toHaveBeenCalled();
    expect(session.getSnapshot().run?.id).toBe("run-1");
  });
  it("looks up an uncertain start by its saved request ID without replaying POST", async () => {
    const { service, session } = setup(null); await session.recover();
    expect(service.find).toHaveBeenCalledExactlyOnceWith(request.caseId, request.requestId, undefined);
    expect(service.start).not.toHaveBeenCalled(); expect(session.getSnapshot().run?.id).toBe("run-1");
  });
  it("reuses the frozen request after a lost start response even if the form/case changed", async () => {
    const { service, session } = setup(); await session.recover();
    service.start.mockRejectedValueOnce(new Error("connection lost"));
    await session.start(request);
    expect(session.getSnapshot()).toMatchObject({ run: null, request, error: "connection lost" });
    await session.start({ ...request, requestId: "new-id", task: "different", expectedRevision: 3 });
    expect(service.start).toHaveBeenNthCalledWith(2, request);
    expect(session.getSnapshot().run?.id).toBe("run-1");
  });
  it.each([{ caseId: "other" }, { requestId: "other" }, { caseRevision: 99 }, { id: "other" }])("rejects a response outside the saved case/request/revision/run: %j", async (patch) => {
    const { service, session } = setup("run-1"); service.get.mockResolvedValue(run(patch)); await session.recover();
    expect(session.getSnapshot().run).toBeNull(); expect(session.getSnapshot().error).toContain("does not belong");
    expect(service.start).not.toHaveBeenCalled();
  });
  it("blocks starting when storage is corrupt or unavailable", async () => {
    const { service, session, store } = setup(); store.getItem.mockReturnValue("broken"); await session.recover(); await session.start(request);
    expect(session.getSnapshot().recoveryBlocked).toBe(true); expect(service.start).not.toHaveBeenCalled();
    const second = setup(); await second.session.recover(); second.store.setItem.mockImplementation(() => { throw new Error("quota"); }); await second.session.start(request);
    expect(second.service.start).not.toHaveBeenCalled(); expect(second.session.getSnapshot().error).toContain("storage");
  });
  it("ignores an aborted recovery response, including a fetch implementation that ignores abort", async () => {
    const { service, session } = setup(null); const pending = deferred<BrowserRun>(); service.find.mockReturnValue(pending.promise);
    const abort = new AbortController(); const recovery = session.recover(abort.signal); abort.abort(); session.dispose(); pending.resolve(run()); await recovery;
    expect(session.getSnapshot().run).toBeNull();
  });
  it("cannot let a stale status read overwrite a newly approved action", async () => {
    const { service, session } = setup("run-1"); await session.recover();
    const stale = deferred<BrowserRun>(); service.get.mockReturnValueOnce(stale.promise); const refresh = session.refresh();
    service.command.mockResolvedValue(run({ status: "completed", message: "Finished" }));
    const command = { command: "approve" as const, pendingActionId: "pending-1", observationId: "observation-1" };
    await session.command(command); stale.resolve(run({ status: "needs_approval" })); await refresh;
    expect(service.command).toHaveBeenCalledExactlyOnceWith("run-1", command);
    expect(session.getSnapshot().run?.status).toBe("completed");
  });
  it("blocks another action after an ambiguous command until a fresh status read; stop stays available", async () => {
    const { service, session } = setup("run-1"); await session.recover(); service.command.mockRejectedValueOnce(new Error("response lost"));
    await session.command({ command: "resume" }); await session.command({ command: "resume" });
    expect(service.command).toHaveBeenCalledTimes(1); expect(session.getSnapshot().commandNeedsRefresh).toBe(true);
    await session.command({ command: "cancel" }); expect(service.command).toHaveBeenCalledTimes(2);
    service.command.mockRejectedValueOnce(new Error("again")); await session.command({ command: "resume" }); await session.refresh();
    expect(session.getSnapshot().commandNeedsRefresh).toBe(false);
  });
  it("allows a deliberate new task only after a confirmed terminal result, never an uncertain action", async () => {
    const { service, session, store } = setup("run-1"); service.get.mockResolvedValue(run({ status: "uncertain" })); await session.recover(); session.newTask();
    expect(session.getSnapshot().run?.status).toBe("uncertain"); expect(store.removeItem).not.toHaveBeenCalled();
    service.get.mockResolvedValue(run({ status: "cancelled" })); await session.refresh(); session.newTask();
    expect(session.getSnapshot()).toMatchObject({ run: null, request: null, recovering: false }); expect(service.start).not.toHaveBeenCalled();
    expect(store.getItem(browserStorageKey(request.caseId))).toBeNull();
  });
});

describe("explicit browser scope", () => {
  it("suggests Amazon order history without dispatching or guessing other provider websites", () => {
    expect(browserStartUrl("Amazon")).toBe(request.startUrl); expect(browserStartUrl("GEICO")).toBe(""); expect(browserStartUrl(null)).toBe("");
  });
  it("adds only explicitly entered exact domains and rejects credentials, paths and other schemes", () => {
    expect(browserHosts("https://www.amazon.com/orders", "accounts.amazon.com, WWW.AMAZON.COM")).toEqual({ url: "https://www.amazon.com/orders", hosts: ["www.amazon.com", "accounts.amazon.com"] });
    for (const url of ["http://example.com", "javascript:alert(1)", "https://user:password@example.com"]) expect(browserHosts(url, "")).toBeNull();
    for (const host of ["https://example.com", "*.amazon.com", "example.com/path", "bad..example.com"]) expect(browserHosts("https://example.com", host)).toBeNull();
  });
});
