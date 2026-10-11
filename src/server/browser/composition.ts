import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getRuntimeReadiness, loadConfig } from "@/server/config";
import { CaseRepository } from "@/server/persistence/repository";
import { openDatabase } from "@/server/persistence/db";
import { ApiHttpError, notFound } from "@/server/http/errors";
import { BrowserService } from "./service";
import { BrowserStore } from "./store";
import { OpenAIPlanner } from "./planner";
import { launchBrowser } from "./playwright";
import { getWorkflowService } from "@/server/workflows/composition";
import { isSampleInsurance } from "./policy";

const globals = globalThis as unknown as { __recourseBrowserService?: { key: string; service: BrowserService } };
export function getBrowserService(): BrowserService {
  const config = loadConfig();
  const key = createHash("sha256").update(JSON.stringify([config.dataDir, config.mode, config.invalidMode, config.llm,
    process.env.BROWSER_ENABLED, process.env.BROWSER_HEADLESS, process.env.BROWSER_EXECUTABLE_PATH])).digest("hex");
  if (globals.__recourseBrowserService?.key === key) return globals.__recourseBrowserService.service;
  if (globals.__recourseBrowserService) void globals.__recourseBrowserService.service.dispose();
  const repo = new CaseRepository(openDatabase(config.dataDir));
  const owned = (owner: string, id: string) => { const c = repo.getOwnedCase(id, owner); if (!c) throw notFound(); return c; };
  const service = new BrowserService({
    enabled: process.env.BROWSER_ENABLED?.trim() === "true", configured: getRuntimeReadiness().browser.ready,
    store: new BrowserStore(path.join(config.dataDir, "browser")),
    planner: new OpenAIPlanner({ model: config.llm.model ?? "", apiKey: config.llm.apiKey ?? "", baseUrl: config.llm.baseUrl }),
    loadCase: async (owner, id) => owned(owner, id),
    executionPolicy: async (owner, id) => isSampleInsurance(getWorkflowService().get(owner, id).workflow) ? "inspect_only" : "review_each_action",
    preparationFields: async (owner, id) => {
      const { workflow, case: c } = getWorkflowService().get(owner, id);
      if (workflow.kind !== "auto_insurance" || workflow.analysisStatus !== "complete" || workflow.conflicts.length ||
        workflow.questions.some(q => q.required) || !c.evidence.length) {
        throw new ApiHttpError(409, "WORKFLOW_REVIEW_REQUIRED", "Complete the insurance facts and attach evidence before preparing the local form.");
      }
      const keys = ["customerName", "insuranceProvider", "claimantRole", "vehicle", "lossDate", "lossLocation", "incidentDescription", "desiredOutcome"] as const;
      return keys.map(key => ({ key, label: workflow.facts[key]?.label ?? key, value: workflow.facts[key]?.value ?? "Unknown — needs review" }));
    },
    preparation: async (owner, id, revision) => {
      const response = getWorkflowService().get(owner, id);
      if (response.case.revision !== revision || response.workflow.caseRevision !== revision) {
        throw new ApiHttpError(409, "REVISION_CONFLICT", "The case changed; review the current preparation before starting browser work.");
      }
      if (response.workflow.analysisStatus !== "complete" || response.workflow.conflicts.length > 0) {
        throw new ApiHttpError(409, "WORKFLOW_REVIEW_REQUIRED", "Complete the case analysis and resolve conflicting information before starting browser work.");
      }
      return response.workflow.brief.body;
    },
    evidence: async (owner, id) => {
      owned(owner, id);
      return repo.listEvidence(id).map(e => {
        const directory = fs.realpathSync(path.join(config.dataDir, "uploads", id));
        const file = fs.realpathSync(e.storedPath);
        if (path.dirname(file) !== directory || !fs.statSync(file).isFile() || fs.statSync(file).size > 10 * 1024 * 1024) throw new Error("EVIDENCE_SCOPE_INVALID");
        const bytes = fs.readFileSync(file);
        if (createHash("sha256").update(bytes).digest("hex") !== e.sha256) throw new Error("EVIDENCE_CHANGED");
        return { id: e.id, name: e.name, mimeType: e.mimeType, bytes };
      });
    },
    launch: input => launchBrowser({ ...input, headless: process.env.BROWSER_HEADLESS === "true", executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined }),
  });
  globals.__recourseBrowserService = { key, service }; return service;
}
