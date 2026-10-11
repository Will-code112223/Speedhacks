import { createHash } from "node:crypto";
import { getCaseService } from "@/server/cases/composition";
import { assertLiveLlmConfig, assertModeValid, loadConfig } from "@/server/config";
import { openDatabase } from "@/server/persistence/db";
import { CaseRepository } from "@/server/persistence/repository";
import { OpenAIWorkflowExtractor } from "./extractor";
import { WorkflowService } from "./service";
const cache = globalThis as unknown as { __caseWorkflowService?: { key: string; service: WorkflowService } };
/** Shared server instance; GET bootstrap needs no model credentials or provider request. */
export function getWorkflowService(): WorkflowService {
  const config = loadConfig(); assertModeValid(config);
  const key = createHash("sha256").update(JSON.stringify([config.dataDir, config.mode, config.llm])).digest("hex");
  if (cache.__caseWorkflowService?.key === key) return cache.__caseWorkflowService.service;
  const db = openDatabase(config.dataDir);
  const service = new WorkflowService({ config, db, repo: new CaseRepository(db), cases: getCaseService(),
    extractor: { async extract(input) {
      assertLiveLlmConfig(config);
      return new OpenAIWorkflowExtractor({ model: config.llm.model!, apiKey: config.llm.apiKey!, baseUrl: config.llm.baseUrl }).extract(input);
    } } });
  cache.__caseWorkflowService = { key, service }; return service;
}
