/**
 * Which stored plans go with a new case. Plans are private documents, so they
 * are sent only when the message is about insurance: the plans it names, or
 * every plan when it names none. A single named plan also supplies the
 * insurer and its support line as explicit facts.
 *
 * There is no backend plan endpoint; plans reach the server only as files on
 * the case they belong to.
 */

import type { ApiMode, CreateCaseInput } from "../api/types";
import { planToFile, type PlanRecord } from "../plans/store";
import { normalizePhone } from "../ui/format";

/** The case server accepts at most five files per case. */
export const MAX_CASE_FILES = 5;

export interface CaseAttachments {
  files: File[];
  /** File names shown under the person's message. */
  names: string[];
  /** Facts taken from the one plan the message names. */
  prefill: Pick<CreateCaseInput, "merchantName" | "supportPhone">;
  /** One assistant sentence about plans that were left out, if any. */
  notice: string | null;
}

const NONE: CaseAttachments = { files: [], names: [], prefill: {}, notice: null };

const INSURANCE_WORDS = /\b(insur\w*|claims?|polic(?:y|ies)|coverage|covered|deductibles?|adjusters?|premiums?|copays?)\b/i;

/** Words too common in plan and insurer names to identify one. */
const GENERIC_WORDS = new Set([
  "insurance",
  "insurer",
  "assurance",
  "mutual",
  "health",
  "group",
  "plan",
  "plans",
  "policy",
  "company",
  "home",
  "auto",
  "life",
  "care",
  "dental",
  "vision",
  "travel",
  "renters",
  "national",
  "general",
  "first",
  "united",
  "american",
  "family",
  "with",
  "from",
]);

function words(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function distinctiveWords(plan: PlanRecord): string[] {
  return [...words(plan.insurer), ...words(plan.name)].filter((word) => word.length >= 4 && !GENERIC_WORDS.has(word));
}

function isHeic(plan: PlanRecord): boolean {
  return /^image\/hei[cf]$/i.test(plan.fileType) || /\.hei[cf]$/i.test(plan.fileName);
}

function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function attachmentsFor(message: string, plans: readonly PlanRecord[], apiMode: ApiMode): CaseAttachments {
  if (plans.length === 0) return NONE;
  const said = new Set(words(message));
  const named = plans.filter((plan) => distinctiveWords(plan).some((word) => said.has(word)));
  if (named.length === 0 && !INSURANCE_WORDS.test(message)) return NONE;

  const chosen = named.length > 0 ? named : [...plans];
  // The case server accepts PDF, PNG, JPEG, WebP and text; HEIC photos would be rejected with the whole case.
  const skipped = apiMode === "http" ? chosen.filter(isHeic) : [];
  const usable = chosen.filter((plan) => !skipped.includes(plan));
  const sent = usable.slice(0, MAX_CASE_FILES);

  const notes: string[] = [];
  if (skipped.length > 0) {
    const them = skipped.length === 1 ? "it" : "them";
    notes.push(
      `I did not send ${listNames(skipped.map((plan) => plan.fileName))} because the server does not accept HEIC photos. Add a PDF, PNG or JPG of ${them} in Plans to include ${them}.`,
    );
  }
  if (usable.length > sent.length) {
    notes.push(`A case takes at most ${MAX_CASE_FILES} files, so I attached the first ${MAX_CASE_FILES} plans.`);
  }

  const prefill: CaseAttachments["prefill"] = {};
  const only = named.length === 1 ? named[0] : undefined;
  if (only) {
    const insurer = only.insurer.trim();
    if (insurer) prefill.merchantName = insurer;
    const phone = normalizePhone(only.supportPhone);
    if (phone) prefill.supportPhone = phone;
  }

  return {
    files: sent.map(planToFile),
    names: sent.map((plan) => plan.fileName),
    prefill,
    notice: notes.length > 0 ? notes.join(" ") : null,
  };
}
