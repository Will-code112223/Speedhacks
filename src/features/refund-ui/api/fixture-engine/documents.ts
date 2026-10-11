/** The request draft and the downloadable packet, in the same layout as the server's. */

import type { CaseV1 } from "../../../../contracts/case";
import { freeze, type Facts } from "./facts";
import { formatMoney } from "./money";
import type { EvidenceRecord } from "./records";
import type { RequestKind } from "./scenarios";
import { iso } from "./time";

/** Null until every required fact is present, like the server. */
export function buildDraft(kind: RequestKind, facts: Facts, evidence: readonly EvidenceRecord[]): CaseV1["draft"] {
  const f = freeze(facts, kind);
  if (f === null) return null;
  // Only a claim filed before any estimate has no amount; a refund always has one.
  const amount = f.amountMinor === null ? null : formatMoney(f.amountMinor, f.currency);
  const contact = f.customerEmail ? ` (${f.customerEmail})` : "";
  const evidenceLines =
    evidence.length > 0 ? evidence.map((e, i) => `  ${i + 1}. ${e.name} (${e.mimeType})`).join("\n") : "  (none attached)";
  const wording =
    kind === "claim"
      ? {
          subject: amount === null ? `Claim request with ${f.merchantName}` : `Claim request: ${amount} with ${f.merchantName}`,
          greeting: `Hello ${f.merchantName},`,
          ask: amount === null ? "I am filing a claim. The amount is not known yet." : `I am filing a claim for ${amount}.`,
          close: "Please open the claim and provide a claim number and the next steps.",
        }
      : {
          subject: `Refund request: duplicate charge${amount === null ? "" : ` of ${amount}`} at ${f.merchantName}`,
          greeting: `Hello ${f.merchantName} support,`,
          ask: `I am requesting a refund${amount === null ? "" : ` of ${amount}`} for a duplicate charge.`,
          close: "Please confirm the refund and provide a reference number.",
        };
  const body = [
    wording.greeting,
    "",
    `My name is ${f.customerName}${contact}.`,
    wording.ask,
    "",
    `Reason: ${f.reason}`,
    "",
    "Evidence attached:",
    evidenceLines,
    "",
    wording.close,
    "",
    "Thank you,",
    f.customerName,
  ].join("\n");
  return { subject: wording.subject, body };
}

const RULE = "-".repeat(60);

export function buildPacket(
  kind: RequestKind,
  c: CaseV1,
  evidence: readonly EvidenceRecord[],
  generatedAtMs: number,
): string {
  // A null amount that is not missing is a claim filed before any estimate.
  const noAmount = c.missingFields.includes("amountMinor") ? "[amount missing]" : "not known yet";
  const amount = c.amountMinor === null ? noAmount : formatMoney(c.amountMinor, c.currency);
  const lines: string[] = [
    kind === "claim" ? "CLAIM REQUEST PACKET" : "REFUND REQUEST PACKET",
    "=".repeat(60),
    `Case: ${c.id}`,
    `Revision: ${c.revision}    Mode: ${c.mode} (SIMULATED - fixture data, not a real support interaction)`,
    `Generated: ${iso(generatedAtMs)}`,
    "",
    "FACTS",
    RULE,
    `Customer:       ${c.customer.name ?? "[missing]"}${c.customer.email ? ` <${c.customer.email}>` : ""}`,
    `Merchant:       ${c.merchant.name ?? "[missing]"}`,
    `Support phone:  ${c.merchant.supportPhone ?? "[missing]"}`,
    `Amount:         ${amount}`,
    `Reason:         ${c.reason || "[missing]"}`,
  ];
  if (c.missingFields.length > 0) lines.push(`Missing fields: ${c.missingFields.join(", ")}`);
  lines.push("", "REQUEST", RULE);
  if (c.draft) lines.push(`Subject: ${c.draft.subject}`, "", c.draft.body);
  else lines.push("(draft not available until every required fact is present)");
  lines.push("", "EVIDENCE INDEX", RULE);
  if (evidence.length === 0) lines.push("(no files attached)");
  evidence.forEach((e, i) => {
    lines.push(`${i + 1}. ${e.name}`, `   type: ${e.mimeType}   size: ${e.sizeBytes} bytes   id: ${e.id}`);
  });
  lines.push(
    "",
    "OUTCOME",
    RULE,
    `Decision:        ${c.outcome.decision}`,
    `Reference:       ${c.outcome.referenceNumber ?? "none"}`,
    `Payment status:  ${c.outcome.paymentStatus}`,
  );
  if (c.outcome.supportingQuote) lines.push(`Support said:    "${c.outcome.supportingQuote}"`);
  if (c.outcome.nextAction) lines.push(`Next action:     ${c.outcome.nextAction}`);
  lines.push("");
  if (c.calls.length > 0) {
    lines.push("CALLS", RULE);
    for (const call of c.calls) {
      lines.push(`- ${call.id}  state=${call.state}  mode=${call.mode}  provider=${call.providerCallId ?? "n/a"}`);
      if (call.error) lines.push(`  error: ${call.error}`);
      if (call.transcript) {
        lines.push("  transcript:");
        for (const t of call.transcript.split("\n")) lines.push(`    ${t}`);
      }
    }
    lines.push("");
  }
  lines.push("TIMELINE", RULE);
  for (const t of c.timeline) lines.push(`${t.at}  ${t.type.padEnd(24)} ${t.message}`);
  lines.push("");
  return lines.join("\n");
}
