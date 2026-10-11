"use client";

/**
 * "Here is what I understood": the extracted facts as an editable form, the
 * missing information, the attached evidence, and the request we will make.
 *
 * Edits go through PATCH with the revision the person started from. If the
 * case moved on in the meantime the server answers 409 and the banner asks
 * for a reload; a newer case never gets overwritten silently.
 */

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { CaseChanges, CaseV1 } from "../../../contracts/case";
import { Banner, Button, Disclosure, Field, KeyValueList, Mono, SelectField, SourcePill } from "../ui/primitives";
import { fileKindLabel, formatMoney, formatPhone } from "../ui/format";
import {
  changesFromDraft,
  CURRENCIES,
  draftFromCase,
  FACT_KEYS,
  FACT_LABELS,
  factKeyForServerField,
  labelForServerField,
  validateFacts,
  type FactErrors,
  type FactKey,
  type FactsDraft,
} from "../state/facts";
import type { UiError } from "../state/errors";
import styles from "./FactsCard.module.css";

export interface FactsCardProps {
  caseData: CaseV1;
  fixture: boolean;
  /** Null when the facts can be edited; otherwise the sentence saying why not. */
  lockedReason: string | null;
  saving: boolean;
  saveError: UiError | null;
  conflict: boolean;
  reloading: boolean;
  reloadError: UiError | null;
  /** Fields a 422 named when approving. */
  flaggedFields: readonly FactKey[];
  /** Extra guidance under the support phone, for example the simulated backend's number rules. */
  phoneHint: string | null;
  /** Resolves with the saved case, or null when the save failed. */
  onSave: (changes: CaseChanges, expectedRevision: number) => Promise<CaseV1 | null>;
  onReload: () => void;
  /** Reports unsaved edits, so the approval step can wait until they are saved or discarded. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Offered when the server says the case belongs to a different mode. */
  onStartNewCase?: () => void;
}

function sameDraft(a: FactsDraft, b: FactsDraft): boolean {
  return FACT_KEYS.every((key) => a[key] === b[key]);
}

export default function FactsCard(props: FactsCardProps) {
  const {
    caseData,
    fixture,
    lockedReason,
    saving,
    saveError,
    conflict,
    reloading,
    reloadError,
    flaggedFields,
    phoneHint,
    onSave,
    onReload,
    onDirtyChange,
    onStartNewCase,
  } = props;
  const formId = useId();
  const fieldId = (key: FactKey) => `${formId}-${key}`;

  // `base` is the snapshot the person is editing from; its revision goes out with the PATCH.
  const [base, setBase] = useState(caseData);
  const [draft, setDraft] = useState(() => draftFromCase(caseData));
  const [syncedFrom, setSyncedFrom] = useState(caseData);
  const [touched, setTouched] = useState<Partial<Record<FactKey, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const inFlight = useRef(false);

  const dirty = !sameDraft(draft, draftFromCase(base));

  // Report unsaved edits by value; the listener is read from a ref so its identity never matters.
  const editing = dirty && lockedReason === null;
  const dirtyListener = useRef(onDirtyChange);
  useEffect(() => {
    dirtyListener.current = onDirtyChange;
  });
  useEffect(() => {
    dirtyListener.current?.(editing);
  }, [editing]);
  useEffect(() => () => dirtyListener.current?.(false), []);

  // Adopt newer server facts while the person has no unsaved edits.
  if (caseData !== syncedFrom) {
    setSyncedFrom(caseData);
    if (!dirty) {
      setBase(caseData);
      setDraft(draftFromCase(caseData));
    }
  }

  const errors: FactErrors = validateFacts(draft, base);
  const visibleError = (key: FactKey): string | null => {
    const local = errors[key];
    if (local && (touched[key] || submitted)) return local;
    if (!dirty && flaggedFields.includes(key)) return "Needed before the call can be approved.";
    return null;
  };

  const missingKeys = new Set(
    caseData.missingFields.map(factKeyForServerField).filter((key): key is FactKey => key !== null),
  );
  const missingHint = (key: FactKey) => (missingKeys.has(key) && draft[key].trim() === "" ? "Needed for the call" : undefined);

  const set = (key: FactKey) => (value: string) => setDraft((current) => ({ ...current, [key]: value }));
  const touch = (key: FactKey) => () => setTouched((current) => ({ ...current, [key]: true }));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (lockedReason || saving || conflict || inFlight.current) return;
    setSubmitted(true);
    const firstInvalid = FACT_KEYS.find((key) => errors[key]);
    if (firstInvalid) {
      document.getElementById(fieldId(firstInvalid))?.focus();
      return;
    }
    const changes = changesFromDraft(base, draft);
    if (!changes) return;
    inFlight.current = true;
    try {
      const saved = await onSave(changes, base.revision);
      if (saved) {
        setBase(saved);
        setSyncedFrom(saved);
        setDraft(draftFromCase(saved));
        setTouched({});
        setSubmitted(false);
      }
    } finally {
      inFlight.current = false;
    }
  };

  const discard = () => {
    setDraft(draftFromCase(caseData));
    setBase(caseData);
    setTouched({});
    setSubmitted(false);
  };

  const missingLabels = caseData.missingFields.map(labelForServerField);

  return (
    <div className={styles.card} data-testid="facts-card">
      <div className={styles.header}>
        <span className={styles.eyebrow}>Case facts</span>
        <span className={styles.headerMeta}>
          <SourcePill fixture={fixture} simulated={caseData.mode === "simulated"} />
          <span className={styles.revision} title="Each saved change to the facts creates a new revision">
            Revision <Mono>{caseData.revision}</Mono>
          </span>
        </span>
      </div>

      {conflict ? (
        <Banner
          tone="warning"
          role="alert"
          title="This case changed elsewhere."
          testId="error-banner"
          actions={
            <Button size="small" variant="secondary" busy={reloading} onClick={onReload} data-testid="reload-case">
              Reload case
            </Button>
          }
        >
          Your edit was not saved. Reload to see the latest facts, then make your change again.
        </Banner>
      ) : null}

      {reloadError ? (
        <Banner tone="danger" role="alert" title={reloadError.title} testId="error-banner">
          {reloadError.message}
        </Banner>
      ) : null}

      {missingLabels.length > 0 ? (
        <div className={styles.missing} data-testid="missing-list">
          <span className={styles.missingTitle}>Missing information</span>
          <ul className={styles.missingItems}>
            {missingLabels.map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ul>
          <span className={styles.missingNote}>
            {lockedReason ? "These facts are still missing." : "Add these below. The call can be approved once they are filled in."}
          </span>
        </div>
      ) : null}

      {lockedReason ? (
        <>
          <KeyValueList
            items={[
              { key: FACT_LABELS.customerName, value: caseData.customer.name },
              { key: FACT_LABELS.customerEmail, value: caseData.customer.email },
              { key: FACT_LABELS.merchantName, value: caseData.merchant.name },
              {
                key: FACT_LABELS.supportPhone,
                value: caseData.merchant.supportPhone ? <Mono>{formatPhone(caseData.merchant.supportPhone)}</Mono> : null,
              },
              {
                key: FACT_LABELS.amountMinor,
                value:
                  caseData.amountMinor !== null ? <Mono>{formatMoney(caseData.amountMinor, caseData.currency)}</Mono> : null,
              },
              { key: FACT_LABELS.policyNumber, value: caseData.policyNumber ? <Mono>{caseData.policyNumber}</Mono> : null },
              { key: FACT_LABELS.claimType, value: caseData.claimType ?? null },
              { key: FACT_LABELS.incidentDate, value: caseData.incidentDate ? <Mono>{caseData.incidentDate}</Mono> : null },
              { key: FACT_LABELS.reason, value: caseData.reason },
              { key: FACT_LABELS.lossDescription, value: caseData.lossDescription ?? null },
            ]}
          />
          <p className={styles.locked}>{lockedReason}</p>
        </>
      ) : (
        <form className={styles.form} onSubmit={submit} noValidate aria-label="Case facts">
          <div className={styles.grid}>
            <Field
              id={fieldId("customerName")}
              label={FACT_LABELS.customerName}
              name="name"
              autoComplete="name"
              value={draft.customerName}
              hint={missingHint("customerName")}
              error={visibleError("customerName")}
              onChange={(event) => set("customerName")(event.target.value)}
              onBlur={touch("customerName")}
              data-testid="facts-edit-customerName"
            />
            <Field
              id={fieldId("customerEmail")}
              label={FACT_LABELS.customerEmail}
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              spellCheck={false}
              placeholder="name@example.com…"
              value={draft.customerEmail}
              hint={missingHint("customerEmail")}
              error={visibleError("customerEmail")}
              onChange={(event) => set("customerEmail")(event.target.value)}
              onBlur={touch("customerEmail")}
              data-testid="facts-edit-customerEmail"
            />
            <Field
              id={fieldId("merchantName")}
              label={FACT_LABELS.merchantName}
              name="merchant-name"
              autoComplete="off"
              value={draft.merchantName}
              hint={missingHint("merchantName")}
              error={visibleError("merchantName")}
              onChange={(event) => set("merchantName")(event.target.value)}
              onBlur={touch("merchantName")}
              data-testid="facts-edit-merchantName"
            />
            <Field
              id={fieldId("supportPhone")}
              label={FACT_LABELS.supportPhone}
              name="merchant-phone"
              type="tel"
              inputMode="tel"
              autoComplete="off"
              spellCheck={false}
              placeholder="+1 800 555 0199…"
              value={draft.supportPhone}
              hint={
                [missingHint("supportPhone") ? "Needed for the call: type the number from your insurance ID card" : undefined, phoneHint]
                  .filter(Boolean)
                  .join(". ") || undefined
              }
              error={visibleError("supportPhone")}
              onChange={(event) => set("supportPhone")(event.target.value)}
              onBlur={touch("supportPhone")}
              data-testid="facts-edit-supportPhone"
            />
            <Field
              id={fieldId("policyNumber")}
              label={FACT_LABELS.policyNumber}
              name="policy-number"
              autoComplete="off"
              spellCheck={false}
              value={draft.policyNumber}
              hint={missingHint("policyNumber")}
              error={visibleError("policyNumber")}
              onChange={(event) => set("policyNumber")(event.target.value)}
              onBlur={touch("policyNumber")}
              data-testid="facts-edit-policyNumber"
            />
            <Field
              id={fieldId("claimType")}
              label={FACT_LABELS.claimType}
              name="claim-type"
              autoComplete="off"
              placeholder="Water damage…"
              value={draft.claimType}
              hint={missingHint("claimType")}
              error={visibleError("claimType")}
              onChange={(event) => set("claimType")(event.target.value)}
              onBlur={touch("claimType")}
              data-testid="facts-edit-claimType"
            />
            <Field
              id={fieldId("incidentDate")}
              label={FACT_LABELS.incidentDate}
              name="incident-date"
              type="date"
              autoComplete="off"
              value={draft.incidentDate}
              hint={missingHint("incidentDate")}
              error={visibleError("incidentDate")}
              onChange={(event) => set("incidentDate")(event.target.value)}
              onBlur={touch("incidentDate")}
              data-testid="facts-edit-incidentDate"
            />
            <div className={styles.spacer} aria-hidden="true" />
            <div className={styles.numeric}>
              {/* decimal keeps the numeric keypad and adds the separator cents need */}
              <Field
                id={fieldId("amountMinor")}
                label={FACT_LABELS.amountMinor}
                name="amount"
                inputMode="decimal"
                autoComplete="transaction-amount"
                placeholder="1,200.00…"
                value={draft.amountMinor}
                hint={missingHint("amountMinor")}
                error={visibleError("amountMinor")}
                onChange={(event) => set("amountMinor")(event.target.value)}
                onBlur={touch("amountMinor")}
                data-testid="facts-edit-amountMinor"
              />
            </div>
            <SelectField
              id={fieldId("currency")}
              label={FACT_LABELS.currency}
              name="currency"
              autoComplete="transaction-currency"
              value={draft.currency}
              error={visibleError("currency")}
              onChange={(event) => set("currency")(event.target.value)}
              data-testid="facts-edit-currency"
            >
              {[...new Set([...CURRENCIES, caseData.currency])].map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </SelectField>
            <div className={styles.wide}>
              <Field
                as="textarea"
                id={fieldId("reason")}
                label={FACT_LABELS.reason}
                name="reason"
                autoComplete="off"
                rows={3}
                value={draft.reason}
                hint={missingHint("reason")}
                error={visibleError("reason")}
                onChange={(event) => set("reason")(event.target.value)}
                onBlur={touch("reason")}
                data-testid="facts-edit-reason"
              />
            </div>
            <div className={styles.wide}>
              <Field
                as="textarea"
                id={fieldId("lossDescription")}
                label={FACT_LABELS.lossDescription}
                name="loss-description"
                autoComplete="off"
                rows={3}
                value={draft.lossDescription}
                hint={missingHint("lossDescription")}
                error={visibleError("lossDescription")}
                onChange={(event) => set("lossDescription")(event.target.value)}
                onBlur={touch("lossDescription")}
                data-testid="facts-edit-lossDescription"
              />
            </div>
          </div>

          {saveError && !conflict ? (
            <Banner
              tone="danger"
              role="alert"
              title={saveError.title}
              testId="error-banner"
              actions={
                saveError.kind === "mode_mismatch" && onStartNewCase ? (
                  <Button size="small" variant="secondary" onClick={onStartNewCase}>
                    Start a new case
                  </Button>
                ) : null
              }
            >
              {saveError.message}
              {saveError.fieldLabels.length > 0 ? ` Check: ${saveError.fieldLabels.join(", ")}.` : null}
            </Banner>
          ) : null}

          <div className={styles.actions}>
            <span className={styles.saveStatus} role="status">
              {saving ? "Saving" : dirty ? "Unsaved changes" : ""}
            </span>
            {dirty ? (
              <Button variant="ghost" size="small" onClick={discard} disabled={saving}>
                Discard
              </Button>
            ) : null}
            <Button
              type="submit"
              variant={dirty ? "primary" : "secondary"}
              size="small"
              busy={saving}
              disabled={!dirty || conflict}
              data-testid="facts-save"
            >
              Save changes
            </Button>
          </div>
        </form>
      )}

      {caseData.evidence.length > 0 ? (
        <div className={styles.section}>
          <span className={styles.eyebrow}>Attached</span>
          <ul className={styles.evidence}>
            {caseData.evidence.map((item) => (
              <li key={item.id}>
                <span className={styles.evidenceName}>{item.name}</span>
                <span className={styles.evidenceKind}>{fileKindLabel(item.name, item.mimeType)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className={styles.section}>
        <Disclosure summary="Show the request we will make" testId="draft-toggle">
          {caseData.draft ? (
            <div className={styles.draft}>
              <p className={styles.draftSubject}>{caseData.draft.subject}</p>
              <p className={styles.draftBody}>{caseData.draft.body}</p>
            </div>
          ) : (
            <p className={styles.muted}>The request is drafted once the facts are complete.</p>
          )}
        </Disclosure>
      </div>
    </div>
  );
}
