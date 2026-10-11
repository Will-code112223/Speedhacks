import type { WorkflowCallAttempt, WorkflowCallResult } from "@/contracts/workflow-call";

type ResultInput = Pick<WorkflowCallAttempt, "state" | "transcript" | "durationSeconds">;
const SENSITIVE = /\b(?:cvv|cvc|card number|credit card|debit card|security code|one.time (?:code|password)|password|social security|ssn|bank account|routing number)\b/i;
const QUESTION = /\?|^(?:can|could|would|will|do|does|did|have|has|is|are|was|were|what|which|when|where|why|how)\b/i;

/** Preserve speaker attribution across multiline turns, including Dial's Agent/User labels. */
function recipientTurns(transcript: string): string[] {
  const turns: string[] = [];
  let role: "recipient" | "caller" | "unknown" = "unknown";
  let current = "";
  function flush() { if (role === "recipient" && current.trim()) turns.push(current.trim()); current = ""; }
  for (const raw of transcript.slice(0, 250_000).split(/\r?\n/)) {
    const match = raw.match(/^\s*(?:\[\d{1,2}:\d{2}(?::\d{2})?\]\s*)?(Agent|AI assistant|Assistant|User|Support|Representative|Customer service|transfer_target)\s*:\s*(.*)$/i);
    if (match) {
      flush(); role = /^(?:user|support|representative|customer service|transfer_target)$/i.test(match[1]!) ? "recipient" : "caller";
      current = match[2]!;
    } else if (/^\s*\[.*\]:/.test(raw)) { flush(); role = "unknown"; }
    else current += `${current ? "\n" : ""}${raw}`;
  }
  flush(); return turns;
}

/**
 * A deliberately extractive receipt, not an insurer/merchant adjudicator.
 * Excerpts are verbatim recipient statements. They never mutate case facts,
 * prove that a claim was filed, or infer a refund or coverage determination.
 */
export function workflowCallResult(call: ResultInput): WorkflowCallResult {
  if (call.state === "dispatch_unknown") return {
    status: "uncertain", summary: "Dial may have received the call request; its status is unconfirmed.", highlights: [],
    nextSteps: ["Check the existing attempt before placing another call. Refreshing does not redial."],
  };
  if (["dispatch_pending", "queued", "in_progress"].includes(call.state)) return {
    status: "pending", summary: call.state === "in_progress" ? "The call is in progress." : "The call is connecting.", highlights: [],
    nextSteps: ["The transcript and returned information will appear after the call."],
  };
  const transcript = call.transcript?.trim();
  if (!transcript) {
    const unsuccessful = call.state === "failed" || call.state === "cancelled";
    return { status: unsuccessful ? "not_connected" : "transcript_pending",
      summary: unsuccessful ? "The call ended without a confirmed conversation." : "The call ended. Dial has not provided a transcript yet.",
      highlights: [], nextSteps: [unsuccessful ? "Review the call status before authorizing another attempt." : "Keep this case open or refresh later to retrieve the transcript."] };
  }
  const highlights: WorkflowCallResult["highlights"] = [];
  let sensitive = false;
  for (const turn of recipientTurns(transcript)) {
    if (SENSITIVE.test(turn)) { sensitive = true; continue; }
    // Questions and unlabelled text are not evidence of requirements or decisions.
    for (const quote of turn.split(/(?<=[.!?])\s+/).map(text => text.trim()).filter(Boolean)) {
      if (quote.length > 1200 || QUESTION.test(quote)) continue;
      let kind: WorkflowCallResult["highlights"][number]["kind"] | null = null;
      if (/\b(?:photos?|pictures?|repair estimates?|receipts?|documents?|proof|police report|claim form|policy (?:document|copy))\b/i.test(quote)) kind = "documents";
      else if (/\b(?:reference|confirmation|claim|case|ticket)\s*(?:number|id|code|#)\b/i.test(quote)) kind = "reference";
      else if (/\b(?:please|you (?:can|need to|should|must)|next step|upload|send|submit|contact|call back|follow up)\b/i.test(quote)) kind = "next_step";
      if (kind && !highlights.some(item => item.quote === quote)) highlights.push({ kind, quote });
      if (highlights.length >= 12) break;
    }
    if (highlights.length >= 12) break;
  }
  const nextSteps = ["Review the recipient's statements and the full transcript before acting."];
  if (highlights.some(item => item.kind === "documents")) nextSteps.push("Check which documents the recipient requested, then gather what you can provide and clarify anything unavailable.");
  if (sensitive) nextSteps.push("A request involving sensitive information was detected. Complete any necessary verification through the provider's trusted channel yourself.");
  nextSteps.push("No claim submission, coverage decision, or payment is established by this information call.");
  return { status: "transcript_available", summary: highlights.length
    ? "The conversation is available. The recipient's relevant statements are quoted below."
    : "The conversation is available. No document, reference, or next-step statement could be confidently isolated; review the transcript.",
    highlights, nextSteps };
}
