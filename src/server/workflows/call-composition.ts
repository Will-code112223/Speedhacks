import { createHash } from "node:crypto";
import { createDialAdapter } from "@/integrations/dial";
import { assertModeValid, loadConfig } from "@/server/config";
import { openDatabase } from "@/server/persistence/db";
import { CaseRepository } from "@/server/persistence/repository";
import { getWorkflowService } from "./composition";
import { WorkflowCallService } from "./call-service";

const cache = globalThis as unknown as { __workflowCallService?: { key: string; service: WorkflowCallService } };
export function getWorkflowCallService(): WorkflowCallService {
  const config = loadConfig(); assertModeValid(config);
  const key = createHash("sha256").update(JSON.stringify(config)).digest("hex");
  if (cache.__workflowCallService?.key === key) return cache.__workflowCallService.service;
  const db = openDatabase(config.dataDir);
  const service = new WorkflowCallService({ config, db, repo: new CaseRepository(db), workflow: getWorkflowService(),
    voice: maxDurationSeconds => createDialAdapter({ mode: "live" }, { config: {
      apiKey: config.dial.apiKey ?? undefined, fromNumber: config.dial.fromNumber ?? undefined,
      webhookSecret: config.dial.webhookSecret ?? undefined, maxCallDurationSeconds: maxDurationSeconds,
    } }) });
  cache.__workflowCallService = { key, service }; return service;
}
