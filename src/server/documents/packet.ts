import type { CaseV1 } from "@/contracts/case";
import { formatAmount } from "@/server/cases/facts";
import { historyBriefLines, type HistoryCheck } from "@/server/cases/history";
import type { EvidenceRow } from "@/server/persistence/repository";

/** Plain-text refund request packet with an evidence index. PDF is optional later. */
export function buildPacket(c: CaseV1, evidence: EvidenceRow[], history: HistoryCheck | null = null): string {
  const amount = formatAmount(c.amountMinor, c.currency);
  const lines: string[] = [];
  lines.push("REFUND REQUEST PACKET");
  lines.push("=".repeat(60));
  lines.push(`Case: ${c.id}`);
  lines.push(`Revision: ${c.revision}    Mode: ${c.mode}${c.mode === "simulated" ? " (SIMULATED — not a real support interaction)" : ""}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("FACTS");
  lines.push("-".repeat(60));
  lines.push(`Customer:       ${c.customer.name ?? "[missing]"}${c.customer.email ? ` <${c.customer.email}>` : ""}`);
  lines.push(`Merchant:       ${c.merchant.name ?? "[missing]"}`);
  lines.push(`Support phone:  ${c.merchant.supportPhone ?? "[missing]"}`);
  lines.push(`Amount:         ${amount}`);
  lines.push(`Reason:         ${c.reason || "[missing]"}`);
  if (c.missingFields.length > 0) lines.push(`Missing fields: ${c.missingFields.join(", ")}`);
  lines.push("");
  lines.push("REQUEST");
  lines.push("-".repeat(60));
  if (c.draft) {
    lines.push(`Subject: ${c.draft.subject}`);
    lines.push("");
    lines.push(c.draft.body);
  } else {
    lines.push("(draft not available until every required fact is present)");
  }
  lines.push("");
  lines.push("EVIDENCE INDEX");
  lines.push("-".repeat(60));
  if (evidence.length === 0) lines.push("(no files attached)");
  evidence.forEach((e, i) => {
    lines.push(`${i + 1}. ${e.name}`);
    lines.push(`   type: ${e.mimeType}   size: ${e.sizeBytes} bytes   sha256: ${e.sha256.slice(0, 16)}…   id: ${e.id}`);
  });
  lines.push("");
  if (history) {
    lines.push("TRANSACTION HISTORY");
    lines.push("-".repeat(60));
    lines.push(`Checked:  ${history.checkedAt}   source: ${history.source}   status: ${history.status}`);
    for (const l of historyBriefLines(history).slice(1)) lines.push(l);
    lines.push("");
  }
  lines.push("OUTCOME");
  lines.push("-".repeat(60));
  lines.push(`Decision:        ${c.outcome.decision}`);
  lines.push(`Reference:       ${c.outcome.referenceNumber ?? "none"}`);
  lines.push(`Payment status:  ${c.outcome.paymentStatus}`);
  if (c.outcome.supportingQuote) lines.push(`Support said:    "${c.outcome.supportingQuote}"`);
  if (c.outcome.nextAction) lines.push(`Next action:     ${c.outcome.nextAction}`);
  lines.push("");
  if (c.calls.length > 0) {
    lines.push("CALLS");
    lines.push("-".repeat(60));
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
  lines.push("TIMELINE");
  lines.push("-".repeat(60));
  for (const t of c.timeline) lines.push(`${t.at}  ${t.type.padEnd(24)} ${t.message}`);
  lines.push("");
  return lines.join("\n");
}
