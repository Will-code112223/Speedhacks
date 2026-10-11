import type { CaseWorkflow } from "@/contracts/workflow";

/** Explicit sample provenance persists even if later messages ask to hide it. */
export function isSampleInsurance(workflow: Pick<CaseWorkflow, "kind" | "messages">): boolean {
  return workflow.kind === "auto_insurance" && workflow.messages.some(message => message.role === "user" &&
    /\b(?:sample case|fictional|synthetic|role[- ]play|not an actual loss|not an actual claim)\b/i.test(message.content));
}
