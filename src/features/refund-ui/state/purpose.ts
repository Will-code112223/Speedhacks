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
