/**
 * Explicitly paid model verification with synthetic inputs in disposable storage.
 * LIVE_WORKFLOW_SMOKE=1 node --env-file=.env.local node_modules/vite-node/vite-node.mjs --config vitest.config.ts scripts/workflow-model-smoke.ts
 * Does not launch a browser, contact a merchant, send telemetry, or call Dial.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CaseService } from "@/server/cases/service";
import { assertLiveLlmConfig, loadConfig } from "@/server/config";
import { OpenAIExtractor } from "@/server/documents/extractor";
import { UploadStore } from "@/server/documents/storage";
import { closeInsurerDatabase } from "@/server/insurers";
import { closeDatabase, openDatabase } from "@/server/persistence/db";
import { CaseRepository } from "@/server/persistence/repository";
import { OpenAIWorkflowExtractor } from "@/server/workflows/extractor";
import { WorkflowService } from "@/server/workflows/service";
import type { WorkflowFactKey, WorkflowKind } from "@/contracts/workflow";

async function main() {
  if (process.env.LIVE_WORKFLOW_SMOKE !== "1") throw new Error("Set LIVE_WORKFLOW_SMOKE=1 to authorize paid model requests with synthetic inputs.");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "recourse-live-workflow-"));
  try {
    const config = loadConfig({ ...process.env, REFUND_MODE: "live", DATA_DIR: dataDir });
    assertLiveLlmConfig(config);
    const modelConfig = { model: config.llm.model!, apiKey: config.llm.apiKey!, baseUrl: config.llm.baseUrl };
    const db = openDatabase(dataDir);
    const repo = new CaseRepository(db);
    const owner = randomUUID();
    const cases = new CaseService({ config, repo, uploads: new UploadStore(dataDir), extractor: new OpenAIExtractor(modelConfig),
      voice: () => { throw new Error("Voice dispatch forbidden in this verification"); } });
    const model = new OpenAIWorkflowExtractor(modelConfig);
    const workflows = new WorkflowService({ config, db, repo, cases, extractor: { async extract(input) {
      let result;
      try { result = await model.extract(input); }
      catch (error) {
        if (process.env.WORKFLOW_SMOKE_DIAGNOSTICS === "1") console.log(JSON.stringify({ modelError: error instanceof Error ? error.message : "unknown" }));
        throw error;
      }
      if (process.env.WORKFLOW_SMOKE_DIAGNOSTICS === "1") console.log(JSON.stringify({ candidates: result.facts.map(fact => {
        const source = input.workflow.messages.find(message => message.id === fact.sourceId);
        return { field: fact.key, sourceExists: Boolean(source), quoteMatches: Boolean(source?.content.toLowerCase().includes(fact.quote.toLowerCase())), valueMatches: fact.quote.toLowerCase().includes(fact.value.toLowerCase()) };
      }) }));
      return result;
    } } });
    const scenarios: Array<{ name: string; kind: WorkflowKind; summary: string; required: WorkflowFactKey[] }> = [
      { name: "amazon-return", kind: "refund", summary: "Synthetic QA record. I am Avery Example. I bought running shoes from Amazon on October 3, 2026, order ORDER-438, for 79.99 USD. The shoes are the wrong size. I want a refund.", required: ["merchantName", "product", "purchaseDate", "orderNumber", "amount", "desiredOutcome"] },
      { name: "duplicate-charge", kind: "duplicate_charge", summary: "Synthetic QA record. Acme Streaming charged my monthly subscription twice on October 4, 2026. Both charges are posted, each for 49.99 USD. Transaction references BILL-001 and BILL-002. I want the second charge refunded.", required: ["merchantName", "product", "purchaseDate", "amount", "desiredOutcome"] },
      { name: "insurance-preparation", kind: "auto_insurance", summary: fs.readFileSync("docs/demo/samples/auto-insurance-intake.txt", "utf8"), required: ["insuranceProvider", "claimantRole", "vehicle", "lossDate", "lossLocation", "incidentDescription", "desiredOutcome"] },
    ];
    if (process.env.WORKFLOW_SMOKE_SCENARIO && !scenarios.some(scenario => scenario.name === process.env.WORKFLOW_SMOKE_SCENARIO)) throw new Error("Unknown WORKFLOW_SMOKE_SCENARIO; no verification performed.");
    for (const scenario of scenarios) {
      if (process.env.WORKFLOW_SMOKE_SCENARIO && process.env.WORKFLOW_SMOKE_SCENARIO !== scenario.name) continue;
      const started = Date.now();
      const initial = await cases.createCase(owner, { summary: scenario.summary, fields: {}, files: [] });
      const result = await workflows.analyze(owner, initial.id, { requestId: randomUUID(), expectedRevision: initial.revision });
      assert.equal(result.workflow.analysisStatus, "complete", `${scenario.name}: analysis incomplete`);
      assert.equal(result.workflow.kind, scenario.kind, `${scenario.name}: wrong classification`);
      for (const key of scenario.required) assert.ok(result.workflow.facts[key]?.value, `${scenario.name}: missing ${key}`);
      assert.equal(result.case.calls.length, 0);
      assert.equal(result.case.outcome.decision, "unknown");
      assert.equal(result.case.outcome.paymentStatus, "unverified");
      assert.equal(result.workflow.caseRevision, result.case.revision);
      if (scenario.kind === "auto_insurance") {
        assert.equal(result.case.amountMinor, null);
        assert.ok(!result.workflow.facts.policyNumber?.value);
      }
      console.log(JSON.stringify({ scenario: scenario.name, elapsedSeconds: (Date.now() - started) / 1000, model: config.llm.model, analysis: result.workflow.analysisStatus,
        factFields: Object.keys(result.workflow.facts).filter(k => result.workflow.facts[k as WorkflowFactKey]?.value),
        questions: result.workflow.questions.length, conflicts: result.workflow.conflicts.length, actions: result.workflow.actions.map(a => ({ type: a.type, status: a.status })) }));
      assert.equal(result.workflow.conflicts.length, 0, `${scenario.name}: unexpected conflicts from consistent input`);
      if (scenario.kind === "auto_insurance") {
        const uploadStarted = Date.now();
        const input = { requestId: randomUUID(), expectedRevision: result.case.revision,
          message: "For the same consensual sample case, attach these visibly synthetic illustrations and sample estimate. Prepare the updated packet in Recourse for review only. No actual loss, inspection, approved amount or external submission is established.",
          files: [
            { name: "auto-damage-sample.png", mimeType: "image/png", bytes: fs.readFileSync("docs/demo/samples/auto-damage-sample.png") },
            { name: "auto-repair-estimate.txt", mimeType: "text/plain", bytes: fs.readFileSync("docs/demo/samples/auto-repair-estimate.txt") },
          ] };
        const updated = await workflows.evidence(owner, initial.id, input);
        if (process.env.WORKFLOW_SMOKE_DIAGNOSTICS === "1") console.log(JSON.stringify({ scenario: "insurance-follow-up", conflicts: updated.workflow.conflicts }));
        assert.equal(updated.workflow.analysisStatus, "complete", "follow-up analysis failed");
        assert.equal(updated.workflow.conflicts.length, 0, "sample follow-up introduced conflicting facts");
        assert.equal(updated.case.evidence.length, 2);
        assert.ok(updated.case.revision > result.case.revision);
        for (const file of input.files) assert.ok(updated.workflow.brief.body.includes(file.name));
        assert.equal(updated.case.calls.length, 0);
        assert.equal(updated.case.outcome.decision, "unknown");
        assert.equal(updated.case.outcome.paymentStatus, "unverified");
        const replay = await workflows.evidence(owner, initial.id, input);
        assert.equal(replay.case.revision, updated.case.revision, "upload retry mutated revision");
        assert.equal(replay.case.evidence.length, 2, "upload retry duplicated evidence");
        console.log(JSON.stringify({ scenario: "insurance-follow-up-packet", elapsedSeconds: (Date.now() - uploadStarted) / 1000,
          analysis: updated.workflow.analysisStatus, evidenceCount: updated.case.evidence.length,
          briefUpdated: true, idempotentReplay: true, callsPlaced: 0, externallySubmitted: false }));
      }
    }
  } finally {
    closeDatabase(); closeInsurerDatabase(); fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  // Never print a provider body, request, credential, or customer input.
  console.error(error instanceof Error ? error.message : "Live workflow verification failed");
  process.exitCode = 1;
});
