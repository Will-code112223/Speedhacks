import type { CallV1, CaseV1 } from "../../../contracts/case";
import { labelForServerField } from "../state/facts";

export type ActivityNodeId = "request" | "evidence" | "brief" | "approval" | "dial" | "outcome";
export type ActivityTone = "idle" | "recorded" | "active" | "attention" | "failed";
export interface ActivityNode {
  id: ActivityNodeId;
  title: string;
  status: string;
  tone: ActivityTone;
  description: string;
  facts: string[];
}

/** A projection of the current contract snapshot, never a fabricated execution trace. */
export function activityNodes(caseData: CaseV1 | null, call: CallV1 | null, fixture: boolean): ActivityNode[] {
  const missing = caseData?.missingFields ?? [];
  const evidence = caseData?.evidence ?? [];
  const authorization = caseData?.authorization;
  const outcome = caseData?.outcome;
  const request: ActivityNode = {
    id: "request", title: "Your request", status: caseData ? "Recorded" : "Not started", tone: caseData ? "recorded" : "idle",
    description: caseData ? "The request saved on this case." : "Describe what happened to begin a case.",
    facts: caseData ? [caseData.reason || "No reason recorded."] : [],
  };
  const files: ActivityNode = {
    id: "evidence", title: "Evidence", status: evidence.length ? `${evidence.length} ${evidence.length === 1 ? "file" : "files"}` : "No case files", tone: evidence.length ? "recorded" : "idle",
    description: "Files attached to this case. Stored insurance plans are separate; this map does not imply their contents were verified.",
    facts: evidence.map((file) => file.name),
  };
  const brief: ActivityNode = {
    id: "brief", title: "Case brief", status: missing.length ? "Needs facts" : caseData?.draft ? "Draft ready" : "Not available",
    tone: missing.length ? "attention" : caseData?.draft ? "recorded" : "idle",
    description: missing.length ? "Clarify the missing facts before a call can be approved." : caseData?.draft ? "A draft is available for review. This is not proof of a submitted claim." : "A brief will appear when the case has enough information.",
    facts: missing.length ? missing.map((field) => `Missing: ${labelForServerField(field)}`) : caseData?.draft ? [caseData.draft.subject] : [],
  };
  const approved: ActivityNode = {
    id: "approval", title: "Your approval", status: authorization ? "Recorded" : "Not approved", tone: authorization ? "recorded" : "idle",
    description: authorization ? "The case contains an authorization record. The backend validates it before dispatch." : "Review the facts and approve the call before the agent acts.",
    facts: authorization ? [`Approved at ${authorization.approvedAt}`, `Case revision ${authorization.revision}`] : [],
  };
  const voice: ActivityNode = {
    id: "dial", title: "Dial call", status: "Not started", tone: "idle",
    description: "No call record is available for this case.", facts: [],
  };
  if (call) {
    const source = fixture || call.mode === "simulated" ? "Simulated" : "Live";
    voice.status = call.state.replaceAll("_", " ");
    voice.tone = call.state === "dispatch_unknown" ? "attention" : call.state === "failed" ? "failed" : call.state === "cancelled" ? "idle" : call.state === "completed" ? "recorded" : "active";
    voice.description = call.state === "dispatch_unknown"
      ? "Dispatch is uncertain. The provider may have received the request; do not start a replacement call."
      : fixture || call.mode === "simulated" ? "Simulated call. No real phone call was placed."
      : "Status from the live-mode call record. A connected conversation is only established when the provider reports it.";
    voice.facts = [source, `Call status: ${voice.status}`, call.transcript ? "Transcript available" : "No transcript available yet"];
    if (call.error) voice.facts.push(call.error);
    if (call.authorizationId !== authorization?.id) {
      voice.status = `Prior call · ${voice.status}`;
      voice.description = `This call belongs to a prior authorization, not the current case brief. ${voice.description}`;
      if (call.state === "completed") voice.tone = "idle";
    }
  }
  const decision = outcome?.decision;
  const result: ActivityNode = {
    id: "outcome", title: "Outcome", status: !decision || decision === "unknown" ? "Not established" : decision.replaceAll("_", " "),
    tone: !decision || decision === "unknown" ? "idle" : decision === "denied" ? "failed" : decision === "needs_information" ? "attention" : decision === "requested" ? "active" : "recorded",
    description: !decision || decision === "unknown" ? "No outcome has been established. An ended call alone does not establish approval." : "The recorded support decision and payment status are separate.",
    facts: outcome ? [outcome.paymentStatus === "confirmed" ? "Payment confirmed" : "Payment unverified", ...(outcome.nextAction ? [outcome.nextAction] : []), ...(outcome.supportingQuote ? [`Evidence: “${outcome.supportingQuote}”`] : [])] : [],
  };
  return [request, files, brief, approved, voice, result];
}

export function activityMode(caseData: CaseV1 | null, call: CallV1 | null, fixture: boolean): string {
  if (fixture) return "Simulated";
  if (call?.mode === "simulated" || (!call && caseData?.mode === "simulated")) return "Simulated";
  if (call?.mode === "live") return "Live call record";
  if (caseData?.mode === "live") return "Live mode · no call yet";
  return "Workflow preview";
}
