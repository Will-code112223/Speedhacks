"use client";

/**
 * Plans state for the shell: loads from the browser store, validates and adds
 * files, persists field edits with a short debounce, and supports undo after a
 * removal. One instance lives in RefundApp and is passed down.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createLocalId } from "../state/ids";
import { openPlanStore, planToFile, validatePlanFile, type PlanFields, type PlanRecord, type PlanStore } from "./store";

const ONBOARDED_FLAG = "onboarded";
const WRITE_DELAY_MS = 300;

export interface AddFilesResult {
  added: PlanRecord[];
  /** One sentence per file that was not added. */
  rejected: string[];
}

export interface PlansController {
  status: "loading" | "ready";
  plans: PlanRecord[];
  /** False when the browser blocked IndexedDB and plans only last for this tab. */
  persistent: boolean;
  onboarded: boolean;
  saveError: string | null;
  addFiles(files: readonly File[]): AddFilesResult;
  updatePlan(id: string, fields: Partial<PlanFields>): void;
  removePlan(id: string): PlanRecord | null;
  restorePlan(plan: PlanRecord): void;
  completeOnboarding(): void;
  /** The stored plans as Files, in the order they were added. */
  planFiles(): File[];
}

function describeStorageError(error: unknown): string {
  const detail = error instanceof Error && error.message ? ` ${error.message}` : "";
  return `Your latest plan changes could not be saved in this browser.${detail}`;
}

export function usePlans(): PlansController {
  const [status, setStatus] = useState<"loading" | "ready">("loading");
  const [plans, setPlans] = useState<PlanRecord[]>([]);
  const [persistent, setPersistent] = useState(true);
  const [onboarded, setOnboarded] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const storeRef = useRef<PlanStore | null>(null);
  const plansRef = useRef<PlanRecord[]>([]);
  const pendingWrites = useRef(new Map<string, number>());

  useEffect(() => {
    plansRef.current = plans;
  }, [plans]);

  useEffect(() => {
    let cancelled = false;
    openPlanStore()
      .then(async (store) => {
        const [list, flag] = await Promise.all([store.list(), store.getFlag(ONBOARDED_FLAG)]);
        if (cancelled) return;
        storeRef.current = store;
        plansRef.current = list;
        setPersistent(store.persistent);
        setPlans(list);
        setOnboarded(flag);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setSaveError(describeStorageError(error));
        setStatus("ready");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback((plan: PlanRecord) => {
    const store = storeRef.current;
    if (!store) return;
    store.put(plan).then(
      () => setSaveError(null),
      (error: unknown) => setSaveError(describeStorageError(error)),
    );
  }, []);

  const flushWrite = useCallback(
    (id: string) => {
      const timer = pendingWrites.current.get(id);
      if (timer !== undefined) window.clearTimeout(timer);
      pendingWrites.current.delete(id);
      const plan = plansRef.current.find((candidate) => candidate.id === id);
      if (plan) persist(plan);
    },
    [persist],
  );

  // Flush edits that are still waiting for their debounce when the shell unmounts.
  useEffect(() => {
    const writes = pendingWrites.current;
    return () => {
      for (const id of [...writes.keys()]) flushWrite(id);
    };
  }, [flushWrite]);

  const addFiles = useCallback(
    (files: readonly File[]): AddFilesResult => {
      const added: PlanRecord[] = [];
      const rejected: string[] = [];
      const known = [...plansRef.current];
      for (const file of files) {
        const problem = validatePlanFile(file);
        if (problem) {
          rejected.push(problem);
          continue;
        }
        const duplicate = known.some(
          (plan) => plan.fileName === file.name && plan.fileSize === file.size && plan.fileLastModified === file.lastModified,
        );
        if (duplicate) {
          rejected.push(`${file.name} is already in your plans.`);
          continue;
        }
        const plan: PlanRecord = {
          id: createLocalId(),
          name: "",
          insurer: "",
          policyNumber: "",
          supportPhone: "",
          fileName: file.name,
          fileType: file.type,
          fileSize: file.size,
          fileLastModified: file.lastModified,
          addedAt: new Date(Date.now() + added.length).toISOString(),
          file,
        };
        added.push(plan);
        known.push(plan);
      }
      if (added.length > 0) {
        plansRef.current = known;
        setPlans(known);
        added.forEach(persist);
      }
      return { added, rejected };
    },
    [persist],
  );

  const updatePlan = useCallback(
    (id: string, fields: Partial<PlanFields>) => {
      const next = plansRef.current.map((plan) => (plan.id === id ? { ...plan, ...fields } : plan));
      plansRef.current = next;
      setPlans(next);
      const existing = pendingWrites.current.get(id);
      if (existing !== undefined) window.clearTimeout(existing);
      pendingWrites.current.set(
        id,
        window.setTimeout(() => flushWrite(id), WRITE_DELAY_MS),
      );
    },
    [flushWrite],
  );

  const removePlan = useCallback((id: string): PlanRecord | null => {
    const removed = plansRef.current.find((plan) => plan.id === id) ?? null;
    if (!removed) return null;
    const timer = pendingWrites.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    pendingWrites.current.delete(id);
    const next = plansRef.current.filter((plan) => plan.id !== id);
    plansRef.current = next;
    setPlans(next);
    storeRef.current?.remove(id).then(
      () => setSaveError(null),
      (error: unknown) => setSaveError(describeStorageError(error)),
    );
    return removed;
  }, []);

  const restorePlan = useCallback(
    (plan: PlanRecord) => {
      if (plansRef.current.some((candidate) => candidate.id === plan.id)) return;
      const next = [...plansRef.current, plan].sort((a, b) => a.addedAt.localeCompare(b.addedAt));
      plansRef.current = next;
      setPlans(next);
      persist(plan);
    },
    [persist],
  );

  const completeOnboarding = useCallback(() => {
    setOnboarded(true);
    storeRef.current?.setFlag(ONBOARDED_FLAG, true).catch((error: unknown) => setSaveError(describeStorageError(error)));
  }, []);

  const planFiles = useCallback(() => plansRef.current.map(planToFile), []);

  return {
    status,
    plans,
    persistent,
    onboarded,
    saveError,
    addFiles,
    updatePlan,
    removePlan,
    restorePlan,
    completeOnboarding,
    planFiles,
  };
}
