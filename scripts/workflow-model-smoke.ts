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
      const result = await model.extract(input);
      if (process.env.WORKFLOW_SMOKE_DIAGNOSTICS === "1") console.log(JSON.stringify({ candidates: result.facts.map(fact => {
        const source = input.workflow.messages.find(message => message.id === fact.sourceId);
        return { field: fact.key, sourceExists: Boolean(source), quoteMatches: Boolean(source?.content.toLowerCase().includes(fact.quote.toLowerCase())), valueMatches: fact.quote.toLowerCase().includes(fact.value.toLowerCase()) };
      }) }));
      return result;
    } } });
    const scenarios: Array<{ name: string; kind: WorkflowKind; summary: string; required: WorkflowFactKey[] }> = [
      { name: "amazon-return", kind: "refund", summary: "Synthetic QA record. I am Avery Example. I bought running shoes from Amazon on October 3, 2026, order ORDER-438, for 79.99 USD. The left sole arrived detached. I want a refund.", required: ["merchantName", "product", "purchaseDate", "orderNumber", "amount", "desiredOutcome"] },
      { name: "duplicate-charge", kind: "duplicate_charge", summary: "Synthetic QA record. Acme Streaming charged my monthly subscription twice on October 4, 2026. Both charges are posted, each for 49.99 USD. Transaction references BILL-001 and BILL-002. I want the second charge refunded.", required: ["merchantName", "product", "purchaseDate", "amount", "desiredOutcome"] },
      { name: "insurance-preparation", kind: "auto_insurance", summary: "Synthetic QA record. Help me prepare a car insurance claim. I am the policyholder with GEICO. On October 4, 2026, in Oakland, my parked 2022 Honda Civic had its rear bumper damaged. I want to report the damage. I do not know the repair cost and have not provided a policy number.", required: ["insuranceProvider", "claimantRole", "vehicle", "lossDate", "lossLocation", "incidentDescription", "desiredOutcome"] },
    ];
    for (const scenario of scenarios) {
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
      console.log(JSON.stringify({ scenario: scenario.name, model: config.llm.model, analysis: result.workflow.analysisStatus,
        factFields: Object.keys(result.workflow.facts).filter(k => result.workflow.facts[k as WorkflowFactKey]?.value),
        questions: result.workflow.questions.length, conflicts: result.workflow.conflicts.length, actions: result.workflow.actions.map(a => ({ type: a.type, status: a.status })) }));
      assert.equal(result.workflow.conflicts.length, 0, `${scenario.name}: unexpected conflicts from consistent input`);
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
