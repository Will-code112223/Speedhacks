/**
 * V1.3 resolution plan: what the policyholder reads before approving a call.
 *
 * Pure: no I/O, no clock, no randomness. The call section is the server's own
 * call plan (buildCallPlan, the same function authorize() freezes), so what the
 * person reads is what the agent gets. After authorization the frozen plan is
 * passed in and rendered as is. Building this never freezes or authorizes anything.
 *
 * Insurer rules come from the registry (src/server/insurers) with their
 * confidence and source. A rule the registry does not know is never guessed:
 * the plan says the insurer does not publish it.
 */

import type { CaseV1, ResolutionPlanV1, ResolutionStepV1, ResolutionTermV1 } from "@/contracts/case";
import type { CallPlanV1, CallPurpose } from "@/contracts/voice";
import type { InsurerContact, InsurerLookup, InsurerTerm } from "@/server/insurers";
import { buildCallPlan, E164, isIsoDate, isValidAmountMinor, missingFields, type Facts } from "@/server/cases/facts";

/** The case facts the plan reads. A CaseV1 satisfies it. */
export type ResolutionCase = Pick<
  CaseV1,
  | "id"
  | "revision"
  | "customer"
  | "merchant"
  | "amountMinor"
  | "currency"
  | "reason"
  | "policyNumber"
  | "incidentDate"
  | "lossDescription"
  | "claimType"
  | "evidence"
>;

/** The registry fields the plan reads. An InsurerLookup satisfies it. */
export type ResolutionInsurer = Pick<InsurerLookup, "name" | "terms" | "contacts" | "claimsPhone" | "supportPhone">;

export interface ResolutionInput {
  caseDoc: ResolutionCase;
  purpose: CallPurpose;
  /** Registry entry for the case's insurer or company; null when it is not in the registry. */
  insurer: ResolutionInsurer | null;
  /** The plan frozen with the current authorization. When present it is rendered as is. */
  frozen?: CallPlanV1 | null;
}

// ---------------------------------------------------------------------------
// Plain words
// ---------------------------------------------------------------------------

/** The forbidden actions in words a policyholder reads under "What the agent will not do". */
const WILL_NOT_DO: Readonly<Record<string, string>> = {
  // request_refund
  "Do not agree to new charges, upgrades, or retention offers.": "Agree to any new charge, upgrade or offer to keep you as a customer.",
  "Do not change the amount, the merchant, or the reason.": "Change the amount, the company or the reason you approved.",
  "Do not share or request payment card numbers, passwords, or one-time codes.": "Give out or ask for card numbers, passwords or one-time codes.",
  "Do not make commitments on the customer's behalf beyond requesting this refund.": "Promise anything for you beyond asking for this refund.",
  // gather_information
  "Do not request a refund, credit, or reimbursement.": "Ask for a refund, credit or reimbursement.",
  "Do not file, open, or submit a claim, dispute, or complaint.": "File or open a claim, dispute or complaint.",
  "Do not state or confirm an amount that is not listed.": "State or confirm any amount you have not approved.",
  "Do not make any commitment on the customer's behalf.": "Promise anything on your behalf.",
  // file_claim
  "Do not invent or guess any identifier, date, amount, or coverage detail.": "Make up or guess any number, date, amount or coverage detail.",
  "Do not agree to a settlement or accept any amount.": "Agree to a settlement or accept any amount. Only you decide that.",
  "Do not authorize any payment.": "Authorize any payment.",
  "Do not give the policyholder's Social Security number, date of birth, or card numbers; say the policyholder will provide any fact not listed.":
    "Give your Social Security number, date of birth or card numbers. It tells them you will provide anything not listed.",
  "Do not argue about coverage.": "Argue about coverage.",
  "Do not call anyone other than the approved number, or ask to be transferred outside the insurer.":
    "Call any number other than the one you approved, or ask to be transferred outside the insurer.",
};

/** "Do not X." -> "X." for a constant this module has no wording for yet. */
export function willNotDo(forbidden: readonly string[]): string[] {
  return forbidden.map((line) => {
    const known = WILL_NOT_DO[line];
    if (known) return known;
    const rest = line.replace(/^Do not\s+/i, "");
    return rest.charAt(0).toUpperCase() + rest.slice(1);
  });
}

const CONFIDENCE_LABELS: Readonly<Record<string, string>> = {
  verified_official: "From the insurer's own website",
  reported: "Reported by a third party, not confirmed",
  regulatory_default: "Typical legal rule, not the insurer's own",
  unknown: "Not known",
};

export function confidenceLabel(confidence: string): string {
  return CONFIDENCE_LABELS[confidence] ?? "Not confirmed";
}

/** Registry term keys shown per purpose, in reading order, with their plain-words names. */
const TERM_LABELS: Readonly<Record<string, string>> = {
  claim_filing_method: "How to file a claim",
  claim_report_deadline: "Deadline to report a loss",
  claim_decision_timeline: "How long a decision takes",
  appeal_method: "If a claim is denied",
  appeal_window_days: "Time to appeal a denial",
  identity_verification_on_call: "What they ask to verify you",
  billing_dispute_process: "Disputing a charge",
  premium_refund_timeline: "When a refund is paid",
  cancellation_refund_method: "How a cancellation refund is worked out",
};

const TERMS_BY_PURPOSE: Readonly<Record<CallPurpose, readonly string[]>> = {
  file_claim: ["claim_filing_method", "claim_report_deadline", "claim_decision_timeline", "appeal_method", "appeal_window_days", "identity_verification_on_call"],
  gather_information: ["claim_filing_method", "claim_report_deadline", "claim_decision_timeline", "appeal_method", "appeal_window_days", "identity_verification_on_call"],
  request_refund: ["billing_dispute_process", "premium_refund_timeline", "identity_verification_on_call"],
};

const TOKEN_WORDS: Readonly<Record<string, string>> = {
  pro_rata: "Pro rata (you get back the unused part of the premium)",
  short_rate: "Short rate (the unused premium minus a cancellation charge)",
  state_dependent: "Depends on your state",
  no: "No",
  yes: "Yes",
  none: "None",
};

/** A registry value as words, or null when the registry does not know it. */
function termValue(term: InsurerTerm): string | null {
  const text = term.value?.trim();
  if (text) {
    const token = TOKEN_WORDS[text];
    if (token) return token;
    if (term.valueNumber !== null && /^\d+(\.\d+)?$/.test(text) && term.unit) return `${text} ${term.unit}`;
    return text;
  }
  if (term.valueNumber !== null) return term.unit ? `${term.valueNumber} ${term.unit}` : String(term.valueNumber);
  return null;
}

/**
 * The known rules for this purpose, one per key: a rule for every line ("all") first,
 * then the first line-specific one. Unknown values are left out, never guessed.
 */
export function insurerTerms(insurer: ResolutionInsurer | null, purpose: CallPurpose): ResolutionTermV1[] {
  if (!insurer) return [];
  const out: ResolutionTermV1[] = [];
  for (const key of TERMS_BY_PURPOSE[purpose]) {
    const candidates = insurer.terms.filter((t) => t.key === key && t.confidence !== "unknown" && termValue(t) !== null);
    const term = candidates.find((t) => t.line === "all") ?? candidates[0];
    if (!term) continue;
    out.push({
      key,
      label: TERM_LABELS[key] ?? key.replace(/_/g, " "),
      value: termValue(term) as string,
      confidence: term.confidence,
      confidenceLabel: confidenceLabel(term.confidence),
      sourceUrl: term.sourceUrl,
    });
  }
  return out;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function sourceOf(term: ResolutionTermV1 | undefined): ResolutionStepV1["source"] {
  return term?.sourceUrl ? { label: `${hostOf(term.sourceUrl)}, ${term.confidenceLabel.toLowerCase()}`, url: term.sourceUrl } : undefined;
}

/** "+18007325246" -> "800-732-5246"; anything else as stored. */
export function spokenPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : e164;
}

const dayFormat = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" });

function longDate(iso: string): string {
  return dayFormat.format(new Date(`${iso}T00:00:00.000Z`));
}

function formatMoney(amountMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amountMinor / 100);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency}`;
  }
}

function withSource(step: ResolutionStepV1, source: ResolutionStepV1["source"]): ResolutionStepV1 {
  return source ? { ...step, source } : step;
}

function item(title: string, detail: string, status?: "done" | "missing"): ResolutionStepV1 {
  return status ? { title, detail, status } : { title, detail };
}

// ---------------------------------------------------------------------------
// Before the call
// ---------------------------------------------------------------------------

const PHOTO = /\.(jpe?g|png|heic|heif|webp|gif)$/i;
const ESTIMATE = /\b(estimate|quote|invoice|receipt|bill)s?\b/i;
const RECEIPT = /\b(receipt|order|invoice|confirmation)s?\b/i;
const STATEMENT = /\b(statement|bank|card|transactions?)\b/i;

function evidenceWords(name: string): string {
  return name.replace(/[_\-.]+/g, " ");
}

function hasPhotos(evidence: ResolutionCase["evidence"]): boolean {
  return evidence.some((e) => e.mimeType.startsWith("image/") || PHOTO.test(e.name));
}

function hasNamed(evidence: ResolutionCase["evidence"], pattern: RegExp): boolean {
  return evidence.some((e) => pattern.test(evidenceWords(e.name)));
}

/** The registry contact behind the number on the case, for its hours. */
function contactFor(insurer: ResolutionInsurer | null, phone: string | null): InsurerContact | null {
  if (!insurer || !phone) return null;
  return insurer.contacts.find((c) => c.channel === "phone" && c.phoneE164 === phone) ?? null;
}

function numberStep(caseDoc: ResolutionCase, insurer: ResolutionInsurer | null, company: string): ResolutionStepV1 {
  const phone = caseDoc.merchant.supportPhone;
  if (!phone || !E164.test(phone)) {
    return item("Number to call", `Add the number to call for ${company}, for example the claims number on your insurance ID card.`, "missing");
  }
  const contact = contactFor(insurer, phone);
  const line = contact?.purpose === "claims" ? "claims line" : contact?.purpose === "customer_service" ? "customer service line" : null;
  const hours = contact?.hours ? (contact.hours.startsWith("24/7") ? ", open 24 hours a day" : `, open ${contact.hours}`) : "";
  const what = line ? `${company} ${line}${hours}` : company;
  const step = item("Number to call", `${spokenPhone(phone)} (${what}).`, "done");
  return contact?.sourceUrl ? withSource(step, { label: hostOf(contact.sourceUrl), url: contact.sourceUrl }) : step;
}

const PROPERTY_LOSS = /\b(water|flood|leak|pipe|fire|smoke|storm|wind|hail|roof|mold|freez)/i;

function beforeClaim(caseDoc: ResolutionCase, insurer: ResolutionInsurer | null, company: string): ResolutionStepV1[] {
  const loss = `${caseDoc.claimType ?? ""} ${caseDoc.lossDescription ?? ""}`;
  const policy = caseDoc.policyNumber?.trim();
  const steps: ResolutionStepV1[] = [
    policy
      ? item("Policy number", `Policy ${policy} is on file. The agent reads it out one character at a time.`, "done")
      : item(
          "Policy number",
          caseDoc.customer.name?.trim()
            ? "Find it on your declarations page or insurance ID card. Without it, the agent gives your name so they can look up the policy."
            : "Find it on your declarations page or insurance ID card. The agent needs it, or at least your name, to find the policy.",
          "missing",
        ),
    caseDoc.customer.name?.trim()
      ? item("Your name", `${caseDoc.customer.name} is the policyholder the agent calls for.`, "done")
      : item("Your name", "Add the policyholder's name as it appears on the policy.", policy ? undefined : "missing"),
    isIsoDate(caseDoc.incidentDate)
      ? item("Date of loss", `${longDate(caseDoc.incidentDate)}.`, "done")
      : item("Date of loss", "Add the date the damage happened or was found.", "missing"),
    caseDoc.lossDescription?.trim()
      ? item("What happened", "Your description is on file. The agent reports it in your words and adds nothing.", "done")
      : item("What happened", "Add a short description of what happened and what was damaged.", "missing"),
    hasPhotos(caseDoc.evidence)
      ? item("Photos of the damage", "Photos are attached to this case.", "done")
      : item("Photos of the damage", "Take clear photos of the damage before anything is cleaned up or repaired, and attach them here.", "missing"),
    hasNamed(caseDoc.evidence, ESTIMATE)
      ? item("Receipts and repair estimates", "Receipts or estimates are attached to this case.", "done")
      : item(
          "Receipts and repair estimates",
          "Keep receipts for emergency repairs and get a written repair estimate if you can. The insurer usually asks for them after the claim is opened.",
          "missing",
        ),
    numberStep(caseDoc, insurer, company),
  ];
  if (PROPERTY_LOSS.test(loss)) {
    steps.push(item("Stop further damage", "If it is safe, stop the source (for example shut off the water) and keep damaged items until the adjuster has seen them."));
  }
  return steps;
}

function beforeRefund(caseDoc: ResolutionCase, insurer: ResolutionInsurer | null, company: string): ResolutionStepV1[] {
  return [
    caseDoc.customer.name?.trim()
      ? item("Your name", `${caseDoc.customer.name} is the account holder the agent calls for.`, "done")
      : item("Your name", "Add the name on the account.", "missing"),
    isValidAmountMinor(caseDoc.amountMinor)
      ? item("Amount charged", `${formatMoney(caseDoc.amountMinor, caseDoc.currency)} is the amount the agent asks back.`, "done")
      : item("Amount charged", "Add the exact amount of the charge you want refunded.", "missing"),
    hasNamed(caseDoc.evidence, RECEIPT)
      ? item("Receipt or order confirmation", "A receipt or order confirmation is attached to this case.", "done")
      : item("Receipt or order confirmation", "Attach the receipt or order confirmation email for the purchase.", "missing"),
    hasNamed(caseDoc.evidence, STATEMENT)
      ? item("Statement line", "A bank or card statement is attached to this case.", "done")
      : item("Statement line", "Attach a screenshot of the statement showing the charge, and the duplicate if there is one.", "missing"),
    item("Order or account number", "Have it ready in case they ask. The agent does not have it and will say you will provide it."),
    numberStep(caseDoc, insurer, company),
  ];
}

function beforeInformation(caseDoc: ResolutionCase, insurer: ResolutionInsurer | null, company: string, insurance: boolean): ResolutionStepV1[] {
  const steps: ResolutionStepV1[] = [
    caseDoc.customer.name?.trim()
      ? item("Your name", `${caseDoc.customer.name} is who the agent calls for.`, "done")
      : item("Your name", "Add your name as it appears on the account or policy.", "missing"),
  ];
  if (insurance) {
    const policy = caseDoc.policyNumber?.trim();
    steps.push(
      policy
        ? item("Policy number", `Policy ${policy} is on file.`, "done")
        : item("Policy number", "Helpful but not required to ask questions. Find it on your declarations page or insurance ID card."),
    );
  }
  steps.push(
    caseDoc.reason.trim()
      ? item("What you want to find out", "Your summary is on file. The agent asks only the approved questions below.", "done")
      : item("What you want to find out", "Add a short summary of your situation.", "missing"),
    numberStep(caseDoc, insurer, company),
  );
  return steps;
}

// ---------------------------------------------------------------------------
// After the call
// ---------------------------------------------------------------------------

function term(terms: ResolutionTermV1[], key: string): ResolutionTermV1 | undefined {
  return terms.find((t) => t.key === key);
}

function stated(company: string, t: ResolutionTermV1): string {
  if (t.confidence === "regulatory_default") return `Typically: ${t.value}`;
  if (t.confidence === "reported") return `Reported, not confirmed by ${company}: ${t.value}`;
  return `${company} says: ${t.value}`;
}

function sentence(text: string): string {
  const t = text.trim();
  return /[.!?)]$/.test(t) ? t : `${t}.`;
}

function afterClaim(company: string, terms: ResolutionTermV1[]): ResolutionStepV1[] {
  const filing = term(terms, "claim_filing_method");
  const deadline = term(terms, "claim_report_deadline");
  const decision = term(terms, "claim_decision_timeline");
  const appeal = term(terms, "appeal_method");
  const window = term(terms, "appeal_window_days");
  const handler = filing && /\b(handler|adjuster)\b/i.test(filing.value);
  return [
    item("You get a claim number", "The agent reads back the claim number and the next steps. They appear here with the call transcript."),
    withSource(
      item(
        "An adjuster contacts you",
        handler
          ? `${company} assigns a claim handler (an adjuster) who contacts you to review the damage. Keep your phone nearby.`
          : `${company} assigns an adjuster who contacts you to review the damage. Ask on the call when to expect them.`,
      ),
      handler ? sourceOf(filing) : undefined,
    ),
    item("Send the documents they ask for", "Send the photos, receipts and estimates they ask for, the way they ask (online, in their app or by email). Keep copies of everything."),
    deadline
      ? withSource(item("Deadline to report the loss", sentence(stated(company, deadline))), sourceOf(deadline))
      : item("Deadline to report the loss", `${company} does not publish a fixed deadline. Policies usually require prompt notice, so this call reports it now.`),
    decision
      ? withSource(item("When to expect a decision", sentence(stated(company, decision))), sourceOf(decision))
      : item("When to expect a decision", `${company} does not publish how long a decision takes. The agent asks for the next step, and you can ask the adjuster for a date.`),
    appeal
      ? withSource(
          item("If the claim is denied", sentence(`${stated(company, appeal)}${window ? ` Time to appeal: ${window.value}.` : ""}`)),
          sourceOf(appeal),
        )
      : item(
          "If the claim is denied",
          "Ask for the denial in writing with the policy language it relies on, and raise it with the adjuster. If that does not resolve it, you can file a complaint with your state's department of insurance.",
        ),
  ];
}

function afterRefund(company: string, terms: ResolutionTermV1[]): ResolutionStepV1[] {
  const timeline = term(terms, "premium_refund_timeline");
  const dispute = term(terms, "billing_dispute_process");
  return [
    item("You get a reference number", "The agent reads back the reference number and when the refund will appear. They show here with the call transcript."),
    timeline
      ? withSource(item("Watch for the refund", sentence(stated(company, timeline))), sourceOf(timeline))
      : item("Watch for the refund", "Check your statement for the refund by the date they give on the call."),
    dispute
      ? withSource(item("If it does not arrive", sentence(stated(company, dispute))), sourceOf(dispute))
      : item("If it does not arrive", `Contact ${company} again with the reference number, or dispute the charge with your card issuer. Card disputes usually have to be raised within 60 days of the statement.`),
  ];
}

function afterInformation(company: string, terms: ResolutionTermV1[], insurance: boolean): ResolutionStepV1[] {
  const deadline = term(terms, "claim_report_deadline");
  const steps: ResolutionStepV1[] = [
    item("You get the answers", "Each answer and any reference number come back here with the call transcript. Nothing is filed or requested on this call."),
    item(
      "You decide what is next",
      insurance
        ? "With the answers you can add what is missing and approve a call that files the claim, or stop there."
        : "With the answers you can add what is missing and approve a refund request, or stop there.",
    ),
  ];
  if (insurance) {
    steps.push(
      deadline
        ? withSource(item("Deadline to report a loss", sentence(stated(company, deadline))), sourceOf(deadline))
        : item("Deadline to report a loss", `${company} does not publish a fixed deadline, so the agent asks about it. Policies usually require prompt notice.`),
    );
  }
  return steps;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

function factsOf(caseDoc: ResolutionCase): Facts {
  return {
    customer: caseDoc.customer,
    merchant: caseDoc.merchant,
    amountMinor: caseDoc.amountMinor,
    currency: caseDoc.currency,
    reason: caseDoc.reason,
    policyNumber: caseDoc.policyNumber ?? null,
    incidentDate: caseDoc.incidentDate ?? null,
    lossDescription: caseDoc.lossDescription ?? null,
    claimType: caseDoc.claimType ?? null,
  };
}

/** Goal when an older frozen plan has none (pre-V1.2 rows). */
const FALLBACK_GOALS: Readonly<Record<CallPurpose, string>> = {
  request_refund: "Ask for a refund of the duplicate charge and get a reference number.",
  gather_information: "Ask the approved questions and note the answers. Do not request a refund or file anything.",
  file_claim: "Open a new claim and get the claim number.",
};

function callSection(plan: CallPlanV1): ResolutionPlanV1["call"] {
  return {
    goal: plan.goal ?? FALLBACK_GOALS[plan.purpose],
    steps: plan.steps ? [...plan.steps] : [...plan.permittedActions],
    questions: plan.questions.map((q) => q.text),
    readBack: plan.readBack ?? "Read back any reference number and the next step, then ask them to confirm.",
    willNotDo: willNotDo(plan.forbiddenActions),
  };
}

/**
 * The resolution plan for one purpose. The call section is buildCallPlan's output for the
 * current facts (a best-effort draft marked ready:false while facts are missing), or the
 * frozen plan when one is passed.
 */
export function buildResolutionPlan({ caseDoc, purpose: requested, insurer, frozen = null }: ResolutionInput): ResolutionPlanV1 {
  const purpose = frozen?.purpose ?? requested;
  const facts = factsOf(caseDoc);
  const missing = frozen ? [] : missingFields(facts, purpose);
  const company = insurer?.name ?? (caseDoc.merchant.name?.trim() || (purpose === "request_refund" ? "the company" : "the insurer"));
  const insurance =
    purpose === "file_claim" ||
    insurer !== null ||
    Boolean(caseDoc.policyNumber?.trim() || caseDoc.claimType?.trim() || caseDoc.lossDescription?.trim());
  const plan =
    frozen ??
    buildCallPlan({
      purpose,
      caseId: caseDoc.id,
      revision: caseDoc.revision,
      customer: caseDoc.customer,
      merchantName: caseDoc.merchant.name?.trim() || company,
      amountMinor: isValidAmountMinor(caseDoc.amountMinor) ? caseDoc.amountMinor : null,
      currency: caseDoc.currency,
      reason: caseDoc.reason,
      evidence: caseDoc.evidence,
      policyNumber: caseDoc.policyNumber ?? null,
      incidentDate: caseDoc.incidentDate ?? null,
      lossDescription: caseDoc.lossDescription ?? null,
      claimType: caseDoc.claimType ?? null,
    });
  const terms = insurerTerms(insurer, purpose);
  const before =
    purpose === "file_claim"
      ? beforeClaim(caseDoc, insurer, company)
      : purpose === "request_refund"
        ? beforeRefund(caseDoc, insurer, company)
        : beforeInformation(caseDoc, insurer, company, insurance);
  const after =
    purpose === "file_claim"
      ? afterClaim(company, terms)
      : purpose === "request_refund"
        ? afterRefund(company, terms)
        : afterInformation(company, terms, insurance);
  return {
    version: 1,
    purpose,
    ready: missing.length === 0,
    frozen: frozen !== null,
    missingFields: missing,
    insurerName: insurer?.name ?? (caseDoc.merchant.name?.trim() || null),
    before,
    call: callSection(plan),
    after,
    insurerTerms: terms,
  };
}
