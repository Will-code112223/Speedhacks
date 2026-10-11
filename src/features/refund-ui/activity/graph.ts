import type { CallV1, CaseV1 } from "../../../contracts/case";
import { activityNodes, type ActivityNode, type ActivityNodeId } from "./model";

export interface GraphNode extends Omit<ActivityNode, "id"> {
  id: ActivityNodeId | "agent";
  /** Node centers in a 960 × 590 world. */
  x: number;
  y: number;
}

export interface GraphEdge {
  id: string;
  source: GraphNode["id"];
  target: GraphNode["id"];
  label: string;
  /** Relationship provenance, never network traffic or proof of successful dispatch. */
  state: "recorded" | "pending" | "historical";
}

const POSITIONS: Record<ActivityNodeId, { x: number; y: number }> = {
  request: { x: 125, y: 145 },
  evidence: { x: 125, y: 430 },
  brief: { x: 585, y: 120 },
  approval: { x: 815, y: 145 },
  dial: { x: 815, y: 415 },
  outcome: { x: 540, y: 475 },
};

/**
 * V1 calls have no caseId. A historical call must be present in this case's
 * calls collection. A newly returned dispatch may precede the next case poll;
 * its current authorization ID supplies the association in that interval.
 */
function observedCall(caseData: CaseV1 | null, call: CallV1 | null): CallV1 | null {
  if (!caseData || !call) return null;
  const recorded = caseData.calls.find((candidate) => candidate.id === call.id);
  if (recorded) return recorded.authorizationId === call.authorizationId ? call : null;
  return caseData.authorization?.id === call.authorizationId ? call : null;
}

function edge(source: GraphNode["id"], target: GraphNode["id"], label: string, state: GraphEdge["state"]): GraphEdge {
  return { id: `${source}-${target}`, source, target, label, state };
}

/** Spatial dependency graph projected only from supplied, associated case records. */
export function activityGraph(caseData: CaseV1 | null, call: CallV1 | null, fixture: boolean): { nodes: GraphNode[]; edges: GraphEdge[]; call: CallV1 | null } {
  const associatedCall = observedCall(caseData, call);
  const authorization = caseData?.authorization;
  const currentApproval = Boolean(authorization && authorization.revision === caseData?.revision);
  const currentDispatch = Boolean(associatedCall && currentApproval && associatedCall.authorizationId === authorization?.id);
  const historicalDispatch = Boolean(associatedCall && !currentDispatch);
  const hasDraft = Boolean(caseData?.draft);
  const hasOutcome = Boolean(caseData && caseData.outcome.decision !== "unknown");
  const nodes: GraphNode[] = activityNodes(caseData, associatedCall, fixture).map((node) => ({ ...node, ...POSITIONS[node.id] }));
  if (authorization && !currentApproval) {
    const approvalNode = nodes.find((node) => node.id === "approval")!;
    approvalNode.status = "Prior revision";
    approvalNode.tone = "attention";
    approvalNode.description = `This approval records revision ${authorization.revision}, not the current revision ${caseData!.revision}. The current facts require a new approval before another call.`;
  }
  if (historicalDispatch && associatedCall) {
    const dialNode = nodes.find((node) => node.id === "dial")!;
    dialNode.status = `Prior call · ${associatedCall.state.replaceAll("_", " ")}`;
    // The base projection recognizes changed IDs, but not a stale revision
    // with an unchanged authorization ID. Keep node and edge provenance aligned.
    if (!dialNode.description.startsWith("This call belongs to a prior authorization")) {
      dialNode.description = `This call belongs to a prior authorization, not the current case brief. ${dialNode.description}`;
    }
    if (associatedCall.state === "completed") dialNode.tone = "idle";
  }
  nodes.push({
    id: "agent", title: "Recourse", x: 390, y: 285,
    status: caseData ? "Case workspace" : "Ready for a request",
    tone: caseData ? "recorded" : "idle",
    description: "Saved case details and actions.",
    facts: caseData ? [`Case revision ${caseData.revision}`, `Case status: ${caseData.status.replaceAll("_", " ")}`] : [],
  });

  const edges: GraphEdge[] = [
    edge("request", "agent", caseData ? "Saved request" : "Request intake", caseData ? "recorded" : "pending"),
    edge("evidence", "agent", "Attached evidence", caseData?.evidence.length ? "recorded" : "pending"),
    edge("agent", "brief", hasDraft ? "Case draft" : "Prepare brief", hasDraft ? "recorded" : "pending"),
    edge("brief", "approval", currentApproval && hasDraft ? "Approved facts" : "Review & approve", currentApproval && hasDraft ? "recorded" : "pending"),
  ];

  if (historicalDispatch) {
    edges.push(edge("agent", "dial", "Prior authorization", "historical"));
  } else {
    edges.push(edge("approval", "dial", currentDispatch ? "Dispatch requested" : "Authorize call", currentDispatch ? "recorded" : "pending"));
    const reconciled = currentDispatch && associatedCall?.state === "completed" && hasOutcome;
    edges.push(edge("dial", "outcome", reconciled ? "Recorded call result" : "Reconcile result", reconciled ? "recorded" : "pending"));
  }

  // CaseV1 directly contains its outcome. This edge preserves that provenance
  // even when no associated call is available; it never infers payment.
  edges.push(edge("agent", "outcome", hasOutcome ? "Case outcome" : "Outcome review", hasOutcome ? "recorded" : "pending"));
  return { nodes, edges, call: associatedCall };
}
