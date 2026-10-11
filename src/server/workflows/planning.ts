import type { CaseV1 } from "@/contracts/case";
import type { CaseWorkflow, WorkflowAction, WorkflowContact, WorkflowFactKey, WorkflowQuestion } from "@/contracts/workflow";
import { FACT_LABELS, requiredFor, value } from "./facts";

const QUESTIONS: Record<WorkflowFactKey, string> = {
  customerName: "What name should appear on your preparation document?", customerEmail: "What contact email should the provider use?",
  merchantName: "Which merchant or service charged you?", supportPhone: "Do you have a support number from your receipt or account?",
  amount: "What amount is at issue, and is it a posted charge or still pending?", currency: "Which currency is shown on the charge?",
  product: "What product or service is this about?", orderNumber: "What is the order or transaction reference?",
  purchaseDate: "When did you buy it or see the charge?", issue: "What specifically went wrong?",
  desiredOutcome: "What would you like the provider to do?", lossDate: "When did the damage or incident happen?",
  lossLocation: "Where did the incident happen?", vehicle: "Which vehicle was involved? Include its year, make and model if known.",
  incidentDescription: "What happened, and what damage did you observe?", policyNumber: "If available, what is the applicable policy number? You can upload the policy instead.",
  insuranceProvider: "Which insurer and type of policy does this involve?", claimantRole: "Are you the policyholder, another involved party, or helping someone else?",
  otherPartyName: "Is another person involved whose information we may need?", otherPartyPhone: "If contact is needed, what number did that person give you, and do you have permission to contact them?",
};
export function rebuildWorkflow(workflow: CaseWorkflow, c: CaseV1, contacts: WorkflowContact[], now: string, state?: "processing" | "failed"): CaseWorkflow {
  // AAA is a federation of regional clubs. An incident location does not tell
  // us which company issued the policy; only an explicit CSAA carrier does.
  contacts = withAaaPortal(workflow, contacts);
  const questions: WorkflowQuestion[] = requiredFor(workflow.kind).filter(key => !value(workflow, key))
    .map(field => ({ id: `question-${field}`, field, question: QUESTIONS[field], required: true }));
  if (workflow.kind === "auto_insurance" && !value(workflow, "policyNumber") && /policyholder|insured|owner/i.test(value(workflow, "claimantRole") ?? "")) {
    questions.push({ id: "question-policyNumber", field: "policyNumber", question: QUESTIONS.policyNumber, required: false });
  }
  for (const conflict of workflow.conflicts) {
    const field = conflict.split(":")[0] as WorkflowFactKey;
    if (field in FACT_LABELS) questions.unshift({ id: `conflict-${field}`, field, question: conflict.slice(field.length + 1).trim(), required: true });
  }
  if (!c.evidence.length) questions.push({ id: "question-evidence", field: "evidence", question: workflow.kind === "auto_insurance"
    ? "Can you attach your relevant policy, damage photos, or a repair estimate? Only upload documents for this case."
    : "Can you attach the order confirmation, receipt, or relevant statement showing the issue?", required: false });
  const title = workflow.kind === "auto_insurance" ? "Insurance claim preparation" : workflow.kind === "duplicate_charge" ? "Duplicate-charge review" : "Customer request preparation";
  const lines = [`${title.toUpperCase()} — REVIEW BEFORE SHARING`, `Case ${c.id}; revision ${c.revision}`, "",
    "This is a preparation document, not an official provider form, a submitted claim, a coverage decision, or a confirmed refund.", "", "USER'S INITIAL REQUEST", workflow.messages.find(m => m.role === "user")?.content ?? c.reason, "",
    `Analysis status: ${workflow.analysisStatus ?? "not_started"}. Unknown facts remain unknown.`, "", "RECORDED FACTS"];
  for (const [key, fact] of Object.entries(workflow.facts)) {
    if (fact?.value) lines.push(`${FACT_LABELS[key as WorkflowFactKey]}: ${fact.value}`, `  Source: ${fact.source}${fact.sourceRefs.length ? ` (${fact.sourceRefs.join(", ")})` : " (existing case record)"}`);
  }
  lines.push("", "UNKNOWNS AND CLARIFICATIONS", ...(questions.length ? questions.map(q => `- ${q.question}`) : ["- No remaining interview questions identified. Provider-specific requirements still need review."]));
  if (workflow.conflicts.length) lines.push("", "CONFLICTING EVIDENCE — DO NOT CHOOSE A VALUE WITHOUT CLARIFICATION", ...workflow.conflicts.map(x => `- ${x}`));
  lines.push("", "EVIDENCE INDEX", ...(c.evidence.length ? c.evidence.map(e => `- ${e.name} (${e.mimeType}; evidence ${e.id})`) : ["- No evidence attached yet."]),
    "", "REVIEWED ACTION BOUNDARIES", "- Review the provider's requirements and fill only facts supported by this case.",
    "- Stop for unknown fields, identity verification, signatures, attestations, final submission, payment, or any new commitment.",
    "- No phone call, form submission, refund, or insurance outcome is authorized or established by this document.");
  const body = lines.join("\n");
  const actions: WorkflowAction[] = [{ id: "preparation-document", type: "document", title: "Download preparation document",
    description: "Current facts, unknowns, sources and evidence list. Review it before sharing.", status: "ready", blockedBy: [], browser: null, call: null }];
  const browserContacts = contacts.filter(contact => contact.url && contact.role !== "other_party");
  for (const contact of browserContacts.slice(0, 4)) {
    let url: URL; try { url = new URL(contact.url!); if (url.protocol !== "https:" || url.username || url.password || url.port) continue; } catch { continue; }
    const blockedBy = [...workflow.conflicts.map(() => "Resolve conflicting evidence before using it externally")];
    if (state === "processing") blockedBy.push("Interview extraction is in progress");
    if (state === "failed") blockedBy.push("Review the failed interview update before external action");
    const insurance = workflow.kind === "auto_insurance";
    const task = `Help prepare this ${insurance ? "insurance request" : "customer request"}: ${(value(workflow, insurance ? "incidentDescription" : "issue") ?? c.reason).slice(0, 650)}. Requested outcome: ${(value(workflow, "desiredOutcome") ?? "clarification required").slice(0, 250)}. Review the provider's requirements and use the attached preparation document and evidence. Fill only known, supported facts. Stop and ask for missing facts; do not invent any. Stop before final submission, signing, attesting, accepting terms, payment, or any new commitment. The human must review each browser action. This task does not authorize phone calls.${insurance ? " Confirm the actual policy carrier and policy ZIP with the user; never infer them from the incident location. Sample or role-play records are for local review only: do not type or upload them to a real provider. Browser preparation is not insurer approval or a filed claim." : ""}`;
    actions.push({ id: `browser-${contact.id}`, type: "browser", title: `Open ${contact.name}`, description: insurance ? "View the real provider portal. Confirm the carrier and policy details first; stop before submission. Sample records stay in Recourse." : "Review this sourced destination and its applicability. Open the real provider workflow; each browser step requires approval.",
      status: blockedBy.length ? "blocked" : "ready", blockedBy, browser: { startUrl: url.href, allowedHosts: [url.hostname], task }, call: null });
  }
  if (!browserContacts.length) actions.push({ id: "provider-portal-needed", type: "clarify", title: "Confirm the provider's official portal", description: "No sourced provider portal is available for the current facts.", status: "blocked", blockedBy: ["Confirm the merchant or insurer and an official destination"], browser: null, call: null });
  const roles: WorkflowContact["role"][] = workflow.kind === "auto_insurance" ? ["other_party", "insurer"] : ["merchant"];
  for (const role of roles) {
    const contact = contacts.find(x => x.role === role && x.phone);
    const purpose = role === "other_party" ? "Ask the involved person only for missing incident information they are willing to share."
      : workflow.kind === "auto_insurance" ? "Ask the insurer what documents and process apply; do not report an incident or open a claim." : "Ask the merchant about the documented issue and available refund procedure.";
    const blockedBy = workflow.conflicts.length ? ["Resolve conflicting evidence before approving a call"] : [];
    if (state === "processing") blockedBy.push("Interview extraction is in progress");
    if (state === "failed") blockedBy.push("Review the failed interview update before approving a call");
    if (!contact) blockedBy.push("A confirmed recipient phone number is missing");
    actions.push({ id: `call-${role}`, type: "call", title: role === "other_party" ? "Review a separate information call" : `Review ${role === "insurer" ? "insurer" : "merchant"} information call`, description: purpose,
      status: blockedBy.length ? "blocked" : "ready", blockedBy, browser: null, call: { role, to: contact?.phone ?? null, purpose,
        brief: `${purpose}\nIdentify yourself as an AI assistant. Use only the following reviewed preparation facts. Do not file, submit, seek payment, impersonate anyone, or make commitments.\n\n${body}` } });
  }
  const stage = state === "processing" ? "in_progress" : state === "failed" || workflow.conflicts.length ? "needs_review" : questions.some(q => q.required) ? "collecting" : "ready";
  return { ...workflow, caseRevision: c.revision, stage, questions, contacts, brief: { title, body, updatedAt: now }, actions, updatedAt: now };
}

/** Official entry points verified 2026-10-11. Never invent a club or policy ZIP. */
function withAaaPortal(workflow: CaseWorkflow, contacts: WorkflowContact[]): WorkflowContact[] {
  if (workflow.kind !== "auto_insurance" || contacts.some(contact => contact.role === "insurer" && contact.url)) return contacts;
  const provider = value(workflow, "insuranceProvider") ?? "";
  const csaa = /\bCSAA\b/i.test(provider);
  if (!csaa && !/\bAAA\b/i.test(provider)) return contacts;
  return [...contacts, {
    id: csaa ? "csaa-mypolicy" : "aaa-regional-entry", role: "insurer", phone: null,
    name: csaa ? "CSAA MyPolicy (policy ZIP required)" : "AAA (confirm your regional club)",
    url: csaa ? "https://www.mypolicy.csaa-insurance.aaa.com/" : "https://www.aaa.com/",
    source: "knowledge_base", sourceUrl: csaa ? "https://csaa-insurance.aaa.com/content/aaa-ie/b2c/en/misc/manage-mypolicy.html/" : "https://www.aaa.com/",
    requiresConfirmation: true,
  }];
}
export function nextAssistantMessage(workflow: CaseWorkflow): string {
  if (workflow.conflicts.length) return `I found conflicting information and kept the earlier value unchanged. ${workflow.questions.filter(q => q.id.startsWith("conflict-")).map(q => q.question).slice(0, 2).join(" ")}`;
  const next = workflow.questions.filter(q => q.required).slice(0, 2);
  if (next.length) return `I updated your preparation with the supported information. ${next.map(q => q.question).join(" ")}`;
  return "The preparation document is updated. Review the facts and evidence, then choose a sourced browser action to work through the provider's requirements. Nothing has been submitted or called.";
}
