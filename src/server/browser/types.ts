import type { BrowserActionKind, BrowserRun } from "@/contracts/browser";

export interface ObservedElement {
  id: string; tag: string; type: string; label: string; href: string | null;
  disabled: boolean; options: string[];
}
export interface Observation {
  id: string; url: string; title: string; text: string; elements: ObservedElement[];
  /** Includes hidden form state and values, but only the hash leaves the worker. */
  fingerprint: string; hasPassword: boolean; hasFrames: boolean;
}
export interface PlannedStep {
  kind: BrowserActionKind | "scroll" | "inspect" | "needs_login" | "done" | "blocked";
  elementId: string | null; value: string | null; artifactId: string | null;
  description: string;
}
export interface BrowserPort {
  observe(): Promise<Observation>;
  screenshot(): Promise<Buffer>;
  execute(step: PlannedStep, artifact?: { name: string; mimeType: string; bytes: Buffer }, expectedFingerprint?: string): Promise<void>;
  loginHandoff(): Promise<void>;
  close(): Promise<void>;
}
/** Raised only by a pre-dispatch check: no action or write window was opened. */
export class BrowserPageChangedError extends Error {
  constructor() { super("BROWSER_PAGE_CHANGED_BEFORE_DISPATCH"); }
}
export interface Planner {
  next(input: { run: BrowserRun; observation: Observation; draft: string; signal: AbortSignal }): Promise<PlannedStep>;
}
export interface StoredRun {
  preparationFields?: Array<{ key: string; label: string; value: string }>;
  owner: string; requestHash: string; run: BrowserRun; draft: string;
  pending: { step: PlannedStep; fingerprint: string } | null;
  executing: boolean; steps: number;
}
export interface StoredArtifact { id: string; name: string; mimeType: string; bytes: Buffer }
