import type { CaseWorkflow } from "@/contracts/workflow";

const normal = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
// Only normalize a trailing numeric size label. Different sizes, colors,
// models and regional size systems still require clarification.
export const productIdentity = (value: string) => normal(value).replace(/,\s*size\s+(\d+(?:\.\d+)?)$/, ", $1");

const retailerButtons = new Set(["return or replace items", "buy it again", "get product support", "track package", "write a product review", "view order details", "view invoice"]);
export const isRetailerButton = (value: string) => retailerButtons.has(normal(value));

/** Repair only recognizably invalid historical flags; never drop genuine disagreements. */
export function reviewedConflicts(workflow: CaseWorkflow): string[] {
  return workflow.conflicts.filter(conflict => {
    const match = /^(currency|product|desiredOutcome): [^“”]+ was recorded as “([^“”]+)”, but another source says “([^“”]+)”\. Which is correct\?$/.exec(conflict);
    if (!match) return true;
    const [, key, before = "", after = ""] = match;
    const current = workflow.facts[key as "currency" | "product" | "desiredOutcome"];
    if (!current?.value || normal(current.value) !== normal(before)) return true;
    if (key === "currency" && after.trim() === "$" && /^[A-Z]{3}$/.test(current.value)) return false;
    if (key === "product" && productIdentity(before) === productIdentity(after)) return false;
    if (key === "desiredOutcome" && current.source === "user" && isRetailerButton(after) &&
      !workflow.messages.some(message => message.role === "user" && normal(message.content).includes(normal(after)))) return false;
    return true;
  });
}
