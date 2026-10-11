/** Additive browser execution contract. CaseV1 and VoiceAdapter remain unchanged. */
export type BrowserRunStatus = "starting" | "running" | "needs_approval" | "needs_login" | "completed" | "failed" | "cancelled" | "uncertain";
export type BrowserActionKind = "navigate" | "click" | "fill" | "select" | "upload";

export interface BrowserPendingAction {
  id: string;
  observationId: string;
  kind: BrowserActionKind;
  description: string;
  /** Human-readable target from the observed page. Never executable JavaScript. */
  target: string;
  value: string | null;
  artifactId: string | null;
}

export interface BrowserArtifact {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  downloadUrl: string;
}

export interface BrowserRun {
  id: string;
  caseId: string;
  caseRevision: number;
  requestId: string;
  status: BrowserRunStatus;
  task: string;
  startUrl: string;
  allowedHosts: string[];
  currentUrl: string | null;
  pageTitle: string | null;
  message: string;
  pendingAction: BrowserPendingAction | null;
  artifacts: BrowserArtifact[];
  events: { id: string; at: string; message: string }[];
  /** True only after a real frame is available. Frames are private, never cached. */
  frameAvailable: boolean;
  updatedAt: string;
  createdAt: string;
}

export interface StartBrowserRequest {
  caseId: string;
  expectedRevision: number;
  requestId: string;
  task: string;
  startUrl: string;
  allowedHosts: string[];
}

export type BrowserCommand =
  | { command: "approve"; pendingActionId: string; observationId: string }
  | { command: "reject"; pendingActionId: string }
  | { command: "resume" }
  | { command: "cancel" };

export interface BrowserRunResponse { run: BrowserRun }

/** GET /api/runtime, no secrets or configured values. */
export interface RuntimeReadiness {
  mode: "live";
  extraction: { ready: boolean; missing: string[] };
  calls: { ready: boolean; missing: string[] };
  browser: { ready: boolean; missing: string[] };
}
