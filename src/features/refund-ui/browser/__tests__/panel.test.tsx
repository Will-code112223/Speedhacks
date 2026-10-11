import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrowserPanelView } from "../BrowserPanel";
import { api, caseData, ready, request, run, state } from "./support";
import type { BrowserSessionState } from "../session";

function render(overrides: Partial<BrowserSessionState> = {}, configured = true) {
  return renderToStaticMarkup(<BrowserPanelView caseData={caseData()} state={state(overrides)} runtime={configured ? ready : { ...ready, browser: { ready: false, missing: ["OPENAI_API_KEY", "LLM_MODEL"] } }} runtimeError={null} canStart={configured} watching={true} api={api()} onRetryRuntime={() => {}} onStart={async () => {}} onCommand={() => {}} onRefresh={() => {}} onNewTask={() => {}} />);
}

describe("browser panel honest controls", () => {
  it("opens the actual prepared workflow task and provider URL without starting it during rendering", () => {
    const html = renderToStaticMarkup(<BrowserPanelView preset={{ task: "Prepare the current claim using the reviewed case brief.", startUrl: "https://claims.geico.com/", allowedHosts: ["claims.geico.com"] }} caseData={caseData()} state={state()} runtime={ready} runtimeError={null} canStart={true} watching={true} api={api()} onRetryRuntime={() => {}} onStart={async () => { throw new Error("Rendering cannot start a browser"); }} onCommand={() => {}} onRefresh={() => {}} onNewTask={() => {}} />);
    expect(html).toContain("Prepare the current claim using the reviewed case brief.");
    expect(html).toContain('value="https://claims.geico.com/"');
    expect(html).toContain("Start browser task");
  });
  it("permits a browser task when amount and support phone are unknown, without requiring a call", () => {
    const html = render(); expect(html).toContain("Starting website"); expect(html).toContain(request.startUrl); expect(html).toContain("Start browser task");
    expect(html).not.toContain("Approve this call"); expect(html).not.toContain("<img");
  });
  it("shows missing configuration with a disabled start, never simulated success", () => {
    const html = render({}, false); expect(html).toContain("Browser setup needed"); expect(html).toContain("OPENAI_API_KEY, LLM_MODEL");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Start browser task<\/button>/); expect(html).not.toContain("Running");
  });
  it("exposes the exact pending action and preserves uncertainty rather than displaying a successful claim", () => {
    const pending = { id: "p", observationId: "o", kind: "fill" as const, description: "Fill the return reason", target: "Reason", value: "Shoes did not fit", artifactId: null };
    const html = render({ run: run({ status: "needs_approval", pendingAction: pending }) });
    expect(html).toContain(pending.description); expect(html).toContain(pending.value); expect(html).toContain("Approve action"); expect(html).toContain("Reject");
    const uncertain = render({ run: run({ status: "uncertain" }) }); expect(uncertain).toContain("Action outcome unknown"); expect(uncertain).toContain("No automatic retry"); expect(uncertain).not.toContain("Approve action"); expect(uncertain).not.toContain("New browser task");
  });
  it("disables approval after a lost command response while allowing stop and status refresh", () => {
    const html = render({ commandNeedsRefresh: true, run: run({ status: "needs_approval", pendingAction: { id: "p", observationId: "o", kind: "click", description: "Click return", target: "Return", value: null, artifactId: null } }) });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Approve action<\/button>/); expect(html).toContain("Stop browser task"); expect(html).toContain("Refresh status");
  });
  it("pauses the screenshot during login and exposes only an explicit resume", () => {
    const html = render({ run: run({ status: "needs_login" }) }); expect(html).toContain("Screen capture is paused during sign-in"); expect(html).toContain("Resume after sign-in"); expect(html).not.toContain("<img");
  });
  it("identifies a public website preview without presenting sample uploads or insurer approval", () => {
    const html = render({ run: run({ executionPolicy: "inspect_only", status: "completed", message: "Public provider page inspected. No details sent.", currentUrl: "https://www.aaa.com/", pageTitle: "AAA" }) });
    expect(html).toContain("Public website preview");
    expect(html).toContain("nothing is filled or uploaded to this provider");
    expect(html).toContain("Browser task complete");
    expect(html).toContain("https://www.aaa.com/");
    expect(html).not.toContain("claim approved");
    expect(html).not.toContain("<img");
  });
  it("shows real recorded events and safe artifacts without fictional activity or external download links", () => {
    const html = render({ run: run({ events: [{ id: "event-1", at: "2026-10-11T20:00:00.000Z", message: "Observed the order list" }], artifacts: [{ id: "doc", name: "request.txt", mimeType: "text/plain", sizeBytes: 2048, downloadUrl: "/api/browser/run-1/artifacts/doc" }, { id: "bad", name: "untrusted.txt", mimeType: "text/plain", sizeBytes: 20, downloadUrl: "https://evil.example/file" }] }) });
    expect(html).toContain("Observed the order list"); expect(html).toContain('href="/api/browser/run-1/artifacts/doc"'); expect(html).not.toContain('href="https://evil.example'); expect(html).toContain("download unavailable"); expect(html).not.toContain("<img");
  });
});
