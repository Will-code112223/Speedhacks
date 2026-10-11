import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiHttpError } from "../../src/server/http/errors";

const mocks = vi.hoisted(() => ({ get: vi.fn(), recording: vi.fn(), owner: vi.fn() }));
vi.mock("@/server/workflows/call-composition", () => ({ getWorkflowCallService: () => ({ get: mocks.get }) }));
vi.mock("@/integrations/dial/recording", () => ({ getDialRecording: mocks.recording }));
vi.mock("@/server/config", () => ({ loadConfig: () => ({ dial: { apiKey: "test-only-key" } }) }));
vi.mock("@/server/http/session", () => ({ readSession: mocks.owner }));
import { GET } from "../../src/app/api/cases/[id]/workflow/calls/[callId]/recording/route";

const context = { params: Promise.resolve({ id: "case-a", callId: "attempt-a" }) };
const request = () => new Request("https://recourse.example/api/cases/case-a/workflow/calls/attempt-a/recording?providerCallId=attacker");
beforeEach(() => {
  vi.clearAllMocks(); mocks.owner.mockReturnValue("owner-a");
  mocks.get.mockReturnValue({ providerCallId: "stored-provider-id", state: "completed" });
  mocks.recording.mockResolvedValue({ state: "available", bytes: new Uint8Array([1, 2, 3]), contentType: "audio/wav" });
});
describe("private call recording endpoint", () => {
  it("checks the stored owner/case/attempt before fetching and never accepts a provider ID from the URL", async () => {
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect(mocks.get).toHaveBeenCalledWith("owner-a", "case-a", "attempt-a");
    expect(mocks.recording).toHaveBeenCalledWith("stored-provider-id", { apiKey: "test-only-key" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
  });
  it("makes no provider request without a session", async () => {
    mocks.owner.mockReturnValue(null);
    expect((await GET(request(), context)).status).toBe(404);
    expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.recording).not.toHaveBeenCalled();
  });
  it("makes no provider request when the owned attempt lookup fails", async () => {
    mocks.get.mockImplementation(() => { throw new ApiHttpError(404, "NOT_FOUND", "Not found"); });
    expect((await GET(request(), context)).status).toBe(404);
    expect(mocks.recording).not.toHaveBeenCalled();
  });
  it.each(["dispatch_unknown", "dispatch_pending", "queued", "in_progress"])("does not advertise playback for %s", async state => {
    mocks.get.mockReturnValue({ state, providerCallId: "stored-provider-id" });
    expect((await GET(request(), context)).status).toBe(404);
    expect(mocks.recording).not.toHaveBeenCalled();
  });
  it("handles delayed recordings without exposing credentials or upstream signed URLs", async () => {
    mocks.recording.mockResolvedValue({ state: "unavailable", reason: "not_available" });
    const response = await GET(request(), context);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("test-only-key");
  });
});
