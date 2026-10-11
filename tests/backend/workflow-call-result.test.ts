import { describe, expect, it } from "vitest";
import { workflowCallResult } from "../../src/server/workflows/call-result";

const completed = (transcript: string | null) => workflowCallResult({ state: "completed", transcript, durationSeconds: 67 });
describe("information call receipts", () => {
  it("quotes the recipient's missing documents while excluding the caller's promises", () => {
    const transcript = "Agent: I will submit the claim today.\nUser: We need photos and a repair estimate.\nAgent: I will send them.\nUser: Your reference number is INQ-123.";
    const result = completed(transcript);
    expect(result.highlights).toEqual([
      { kind: "documents", quote: "We need photos and a repair estimate." },
      { kind: "reference", quote: "Your reference number is INQ-123." },
    ]);
    expect(result.nextSteps.join(" ")).toContain("No claim submission");
  });
  it("does not turn multiline caller suggestions and recipient questions into requirements", () => {
    expect(completed("Agent: Would a photo work?\nPlease upload the repair estimate.\n\nUser: Do you have photos or a repair estimate?\nAgent: No.").highlights).toEqual([]);
  });
  it("preserves multiline remote speaker attribution and verbatim negative statements", () => {
    expect(completed("Support: Thank you.\nWe do not need a police report.\nPlease upload a repair estimate.\nAgent: Goodbye.").highlights.map(x => x.quote))
      .toEqual(["We do not need a police report.", "Please upload a repair estimate."]);
  });
  it("keeps unidentified transcript prose and provider metadata out of highlights", () => {
    expect(completed("Please send photos.\nAgent: Hello\n[additional context]:\nUser requested a receipt.\nPlease upload your policy copy.").highlights).toEqual([]);
  });
  it("never recommends obeying a sensitive payment request", () => {
    const result = completed("User: Please send your card number, expiry and CVV.\nAgent: I cannot provide that.");
    expect(result.highlights).toEqual([]);
    expect(result.nextSteps.join(" ")).toContain("trusted channel yourself");
  });
  it("does not infer success from approval, a transfer, or incomplete transcript", () => {
    const result = completed("User: Approved, let me transfer you.\nAgent: Thank you.");
    expect(result.highlights).toEqual([]);
    expect(result).not.toHaveProperty("approved");
    expect(result.nextSteps.join(" ")).toContain("No claim submission");
  });
  it("separates uncertain dispatch, active calls, missing transcript, and failed contact", () => {
    expect(workflowCallResult({ state: "dispatch_unknown", transcript: null, durationSeconds: null }).status).toBe("uncertain");
    expect(workflowCallResult({ state: "in_progress", transcript: "User: Send photos.", durationSeconds: 5 }).status).toBe("pending");
    expect(completed(null).status).toBe("transcript_pending");
    expect(workflowCallResult({ state: "failed", transcript: null, durationSeconds: 0 }).status).toBe("not_connected");
    expect(workflowCallResult({ state: "failed", transcript: "User: Send photos.", durationSeconds: 4 }).status).toBe("transcript_available");
  });
});
