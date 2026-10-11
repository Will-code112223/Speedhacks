"use client";

/**
 * The plans step. First run shows it as a focused onboarding step; later the
 * rail's "Add plan" opens it in place of the chat to add or edit plans.
 */

import { useEffect, useId, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { Banner, Button, Field, Mono } from "../ui/primitives";
import { FileIcon, UploadIcon } from "../ui/icons";
import { fileKindLabel, formatBytes, normalizePhone, PHONE_HINT } from "../ui/format";
import { PLAN_ACCEPT, type PlanRecord } from "./store";
import type { PlansController } from "./usePlans";
import ProviderKnowledge from "./ProviderKnowledge";
import PolicyPreview from "./PolicyPreview";
import styles from "./PlansManager.module.css";

const UNDO_MS = 8000;

export interface PlansManagerProps {
  plans: PlansController;
  mode: "onboarding" | "manage";
  /** Onboarding: Continue or Skip. Manage: Done. */
  onDone: () => void;
}

export default function PlansManager({ plans, mode, onDone }: PlansManagerProps) {
  const headingId = useId();
  const [rejections, setRejections] = useState<string[]>([]);
  const [lastRemoved, setLastRemoved] = useState<PlanRecord | null>(null);

  useEffect(() => {
    if (!lastRemoved) return;
    const timer = window.setTimeout(() => setLastRemoved(null), UNDO_MS);
    return () => window.clearTimeout(timer);
  }, [lastRemoved]);

  const handleFiles = (files: File[]) => {
    if (files.length === 0) return;
    const result = plans.addFiles(files);
    setRejections(result.rejected);
  };

  const remove = (id: string) => {
    const removed = plans.removePlan(id);
    if (removed) setLastRemoved(removed);
  };

  const undo = () => {
    if (lastRemoved) plans.restorePlan(lastRemoved);
    setLastRemoved(null);
  };

  const onboarding = mode === "onboarding";
  const count = plans.plans.length;

  return (
    <section className={onboarding ? styles.onboarding : styles.manage} aria-labelledby={headingId}>
      <div className={styles.inner}>
        <header className={styles.intro}>
          <h1 id={headingId} className={styles.title}>
            {onboarding ? "Add your insurance plans" : "Your plans"}
          </h1>
        </header>

        <ProviderKnowledge />

        <h2 className={styles.listHeading}>Your policy documents</h2>
        <DropZone onFiles={handleFiles} />

        {rejections.length > 0 ? (
          <Banner tone="danger" role="alert" testId="error-banner">
            <ul className={styles.rejections}>
              {rejections.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </Banner>
        ) : null}

        {!plans.persistent ? (
          <Banner tone="warning" role="status">
            This browser is not allowing local storage, so your plans last only until you close this tab.
          </Banner>
        ) : null}

        {plans.saveError ? (
          <Banner tone="warning" role="alert">
            {plans.saveError}
          </Banner>
        ) : null}

        {count > 0 ? (
          <div className={styles.listBlock}>
            <h2 className={styles.listHeading}>
              {count === 1 ? "1 plan" : `${count} plans`}
            </h2>
            <ul className={styles.planList}>
              {plans.plans.map((plan) => (
                <PlanRow
                  key={plan.id}
                  plan={plan}
                  onChange={(fields) => plans.updatePlan(plan.id, fields)}
                  onRemove={() => remove(plan.id)}
                />
              ))}
            </ul>
          </div>
        ) : null}

        {lastRemoved ? (
          <Banner
            role="status"
            actions={
              <Button size="small" variant="secondary" onClick={undo}>
                Undo
              </Button>
            }
          >
            Removed {lastRemoved.fileName}.
          </Banner>
        ) : null}

        <footer className={styles.footer}>
          <div className={styles.actions}>
            {onboarding && count === 0 ? (
              <Button variant="ghost" onClick={onDone} data-testid="plans-skip">
                Skip for now
              </Button>
            ) : null}
            {onboarding ? (
              <Button variant="primary" onClick={onDone} disabled={count === 0} data-testid="plans-continue">
                Continue
              </Button>
            ) : (
              <Button variant="primary" onClick={onDone} data-testid="plans-continue">
                Done
              </Button>
            )}
          </div>
        </footer>
      </div>
    </section>
  );
}

function DropZone({ onFiles }: { onFiles: (files: File[]) => void }) {
  const inputId = useId();
  const hintId = useId();
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes("Files");

  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth.current += 1;
    setDragging(true);
  };
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = () => {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    depth.current = 0;
    setDragging(false);
    onFiles(Array.from(event.dataTransfer.files));
  };
  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    onFiles(Array.from(event.target.files ?? []));
    // Allow choosing the same file again after removing it.
    event.target.value = "";
  };

  return (
    <div
      className={[styles.dropZone, dragging ? styles.dropZoneActive : ""].join(" ")}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      data-testid="plans-dropzone"
    >
      <input
        id={inputId}
        type="file"
        multiple
        accept={PLAN_ACCEPT}
        className={styles.fileInput}
        onChange={onChange}
        aria-describedby={hintId}
        data-testid="plans-file-input"
      />
      <label htmlFor={inputId} className={styles.dropLabel}>
        <span className={styles.dropIcon}>
          <UploadIcon />
        </span>
        <span className={styles.dropText}>
          <span className={styles.dropAction}>Choose files</span> or drop them here
        </span>
        <span id={hintId} className={styles.dropHint}>
          PDF, PNG, JPG or HEIC, up to 10 MB each
        </span>
      </label>
    </div>
  );
}

interface PlanRowProps {
  plan: PlanRecord;
  onChange: (fields: Partial<Pick<PlanRecord, "name" | "insurer" | "policyNumber" | "supportPhone">>) => void;
  onRemove: () => void;
}

function PlanRow({ plan, onChange, onRemove }: PlanRowProps) {
  const baseId = useId();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [phoneTouched, setPhoneTouched] = useState(false);
  const phoneError =
    phoneTouched && plan.supportPhone.trim() !== "" && normalizePhone(plan.supportPhone) === null ? PHONE_HINT : null;

  return (
    <li className={styles.planRow} data-testid="plan-row">
      <div className={styles.planFile}>
        <span className={styles.fileIcon}>
          <FileIcon />
        </span>
        <span className={styles.fileName} title={plan.fileName}>
          {plan.fileName}
        </span>
        <span className={styles.fileMeta}>
          <Mono>{formatBytes(plan.fileSize)}</Mono>
          <span aria-hidden="true"> · </span>
          {fileKindLabel(plan.fileName, plan.fileType)}
        </span>
        <Button id={`${baseId}-preview`} variant="ghost" size="small" onClick={() => setPreviewOpen((value) => !value)} aria-label={`Preview ${plan.fileName}`} aria-expanded={previewOpen}>
          Preview
        </Button>
        <Button variant="ghost" size="small" onClick={onRemove} aria-label={`Remove ${plan.fileName}`}>
          Remove
        </Button>
      </div>
      {previewOpen ? <PolicyPreview plan={plan} onClose={() => { document.getElementById(`${baseId}-preview`)?.focus(); setPreviewOpen(false); }} /> : null}
      <div className={styles.planFields}>
        <Field
          id={`${baseId}-name`}
          label="Plan name"
          name="plan-name"
          autoComplete="off"
          placeholder="Homeowners 2026…"
          value={plan.name}
          onChange={(event) => onChange({ name: event.target.value })}
        />
        <Field
          id={`${baseId}-insurer`}
          label="Insurer"
          name="insurer"
          autoComplete="organization"
          placeholder="Insurance provider"
          value={plan.insurer}
          onChange={(event) => onChange({ insurer: event.target.value })}
        />
        <Field
          id={`${baseId}-policy`}
          label="Policy number"
          name="policy-number"
          autoComplete="off"
          spellCheck={false}
          placeholder="HO-4471-2210…"
          value={plan.policyNumber}
          onChange={(event) => onChange({ policyNumber: event.target.value })}
        />
        <Field
          id={`${baseId}-phone`}
          label="Support phone"
          name="support-phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          spellCheck={false}
          placeholder="+1 800 555 0199…"
          value={plan.supportPhone}
          error={phoneError}
          onBlur={() => setPhoneTouched(true)}
          onChange={(event) => onChange({ supportPhone: event.target.value })}
        />
      </div>
    </li>
  );
}
