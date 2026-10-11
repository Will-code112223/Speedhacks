/**
 * What a call is for, inferred from the person's request and shown as a
 * choice they can change on the approval step. The authorize route takes the
 * chosen purpose; only "request_refund" needs an amount.
 */

import type { CaseV1 } from "../../../contracts/case";
import type { UiCallPurpose } from "../api/types";

export const PURPOSE_LABELS: Record<UiCallPurpose, string> = {
  file_claim: "File a claim",
  gather_information: "Ask what is needed",
  request_refund: "Request a refund",
};

const GATHER = /\b(how do i|how can i|what do i need|what i need|what is needed|what's needed|status|hours|ask)\b/i;
const FILE_CLAIM = /\b(file|open|submit|start|report)\b[^.?!]{0,40}\bclaims?\b|\bclaims?\b/i;
const REFUND = /\b(refunds?|dispute|charged?|charges|reimburse\w*)\b/i;

/** Questions win over the claim they ask about; a claim wins over a plain charge. */
export function inferPurpose(text: string): UiCallPurpose {
  if (GATHER.test(text)) return "gather_information";
  if (FILE_CLAIM.test(text)) return "file_claim";
  if (REFUND.test(text)) return "request_refund";
  return "request_refund";
}

/**
 * The purpose the approval step starts on. A question in the request wins
 * (the server only suggests file_claim or request_refund); then the server's
 * suggestedPurpose; then the request text. When that purpose still lacks
 * facts and another is ready, the ready one is offered first.
 */
export function initialPurpose(caseData: CaseV1, requestText: string): UiCallPurpose {
  if (caseData.authorization?.purpose) return caseData.authorization.purpose;
  const inferred = inferPurpose(`${requestText} ${caseData.reason}`);
  const preferred = inferred === "gather_information" ? inferred : (caseData.suggestedPurpose ?? inferred);
  if (blockingMissingFields(caseData, preferred).length === 0) return preferred;
  const ready = (["file_claim", "gather_information", "request_refund"] as const).find(
    (purpose) => caseData.missingFieldsByPurpose?.[purpose]?.length === 0,
  );
  return ready ?? preferred;
}

/** Whether some purpose has every fact it needs, so the approval step can be offered. */
export function anyPurposeReady(caseData: CaseV1): boolean {
  return Object.values(caseData.missingFieldsByPurpose ?? {}).some((fields) => fields !== undefined && fields.length === 0);
}

/** Whether the purpose needs a refund amount before the call. */
export function purposeNeedsAmount(purpose: UiCallPurpose): boolean {
  return purpose === "request_refund";
}

const AMOUNT_FIELDS = new Set(["amountminor", "amount", "currency"]);

/** The server's missing fields that still block a call with this purpose. */
export function blockingMissingFields(caseData: CaseV1, purpose: UiCallPurpose): string[] {
  const reported = caseData.missingFieldsByPurpose?.[purpose];
  if (reported !== undefined) return reported;
  if (purposeNeedsAmount(purpose)) return caseData.missingFields;
  return caseData.missingFields.filter((field) => !AMOUNT_FIELDS.has(field.toLowerCase().replace(/[^a-z]/g, "")));
}

export interface PlanPreviewStep {
  title: string;
  detail: string;
}

const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** "2026-10-03" as "Oct 3, 2026"; anything else as written. */
function formatIsoDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(date.getTime()) ? dayFormat.format(date) : value;
}

function sentence(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function money(amountMinor: number | null, currency: string): string | null {
  if (amountMinor === null) return null;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amountMinor / 100);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency}`;
  }
}

/**
 * What the agent will say and ask, built from the current facts and the
 * chosen purpose, so the person sees the call before placing it. Unknown
 * facts are named as unknown, never filled in.
 */
export function previewPlan(caseData: CaseV1, purpose: UiCallPurpose): PlanPreviewStep[] {
  const insurer = caseData.merchant.name ?? "the support line";
  const who = caseData.customer.name ?? "you";
  const policy = caseData.policyNumber
    ? `Gives policy number ${caseData.policyNumber}.`
    : "No policy number on file: asks how they can find the policy.";
  const what = [caseData.claimType, caseData.incidentDate ? `on ${formatIsoDate(caseData.incidentDate)}` : null].filter(Boolean).join(" ");
  const loss = caseData.lossDescription ?? caseData.reason;
  const amount = money(caseData.amountMinor, caseData.currency);

  const reach: PlanPreviewStep = {
    title: `Reach ${insurer}`,
    detail: `Says it is an AI assistant calling for ${who}, and gets through the menu to a person.`,
  };
  const record: PlanPreviewStep = {
    title: "Record the outcome",
    detail: "Reference number, next step and the transcript come back here.",
  };

  switch (purpose) {
    case "file_claim":
      return [
        reach,
        { title: "Identify the policy", detail: policy },
        { title: "Report the loss", detail: sentence([what, loss].filter(Boolean).join(": ")) || "Describes what happened." },
        {
          title: "Open the claim",
          detail: `Asks them to file the claim${amount ? ` for about ${amount}` : ""} and for a claim number.`,
        },
        record,
      ];
    case "gather_information":
      return [
        reach,
        { title: "Identify the policy", detail: policy },
        {
          title: "Ask what is needed",
          detail: `Asks what documents and details are needed${what ? ` for ${what}` : ""}, any deadline, and the status of an open claim.`,
        },
        record,
      ];
    case "request_refund":
      return [
        reach,
        { title: "Explain the charge", detail: caseData.reason || "Explains the charge." },
        {
          title: "Ask for the refund",
          detail: amount ? `Asks for a refund of ${amount} and a reference number.` : "Asks for a refund and a reference number.",
        },
        record,
      ];
  }
}
