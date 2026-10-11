"use client";

/**
 * The approval step: a plain confirmation in the chat. It restates who will
 * be called, the amount and the reason, asks for one explicit confirmation,
 * then authorizes the current revision and starts the call.
 *
 * Once a call was placed under it, the step freezes into a short record.
 */

import { useId, useState } from "react";
import type { CallV1, CaseChanges, CaseV1 } from "../../../contracts/case";
import { UI_CALL_PURPOSES, type UiCallPurpose } from "../api/types";
import { Banner, Button, Field, KeyValueList, Mono, Pill } from "../ui/primitives";
import { formatClock, formatMoney, formatPhone } from "../ui/format";
import type { UiError } from "../state/errors";
import { factKeyForServerField, labelForServerField } from "../state/facts";
import { blockingMissingFields, initialPurpose, PURPOSE_LABELS, purposeNeedsAmount } from "../state/purpose";
import styles from "./ApprovalCard.module.css";

export interface ApprovalCardProps {
  caseData: CaseV1;
  /** The call placed under this approval, when it was placed. */
  placedCall: CallV1 | null;
  /** Whether this is the step the person can act on (the newest open one). */
  current: boolean;
  /** Approving dials a real number now (server REFUND_MODE=live over http). */
  live?: boolean;
  /** The person's own request, used to prefill what the call is for. */
  requestText?: string;
  /**
   * The chosen purpose, when the parent owns it (the plan card above reads it). Absent:
   * the card keeps its own choice, starting from initialPurpose.
   */
  purpose?: UiCallPurpose;
  onPurposeChange?: (purpose: UiCallPurpose) => void;
  busy: boolean;
  stage: "authorizing" | "dispatching" | null;
  error: UiError | null;
  /** Calls are blocked while the facts card has unsaved edits or a conflict. */
  blockedReason: string | null;
  /**
   * Saves facts the chosen purpose still needs, from the inline form in this card.
   * Absent: the card only names the missing facts and points at the facts card above.
   */
  onSaveFacts?: (changes: CaseChanges, expectedRevision: number) => Promise<CaseV1 | null>;
  onApprove: (purpose: UiCallPurpose) => void;
  /** Offered when the server says the case belongs to a different mode. */
  onStartNewCase?: () => void;
}

function errorBody(error: UiError) {
  if (error.kind === "missing_facts" && error.fieldLabels.length > 0) {
    return (
      <>
        {error.message}
        <ul className={styles.errorFields}>
          {error.fieldLabels.map((label) => (
            <li key={label}>{label}</li>
          ))}
        </ul>
      </>
    );
  }
  return error.message;
}

/** What the call asks for, stated from the chosen purpose and the case's amount. */
function askingFor(purpose: UiCallPurpose, amount: string | null): string | null {
  switch (purpose) {
    case "file_claim":
      return "Claim filed and a claim number";
    case "gather_information":
      return "What is needed to file, and the next step";
    case "request_refund":
      return amount ? `Refund of ${amount} and a reference number` : null;
  }
}

const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

function formatDay(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : dateFormat.format(date);
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Where the number about to be dialed came from, in one sentence. */
function provenance(source: CaseV1["merchant"]["source"]): string {
  if (source?.kind === "user") return "Entered by you.";
  if (!source || source.kind !== "insurer_registry") return "From your documents.";
  const line = source.purpose === "claims" ? "Claims line" : "Customer service line";
  const confidence = source.confidence.replace(/_/g, " ");
  const day = formatDay(source.retrievedAt);
  const host = hostOf(source.sourceUrl);
  const parts = [`${line} from the insurer registry, ${confidence}${day ? ` on ${day}` : ""}`];
  if (host) parts.push(`source ${host}`);
  return `${parts.join(", ")}. Confirm it matches the number on your ID card.`;
}

type InlineKind = "text" | "tel" | "date" | "number" | "textarea";

interface InlineField {
  /** The server's field name, as missingFields reports it. */
  field: string;
  label: string;
  kind: InlineKind;
  hint?: string;
  wide?: boolean;
  /** Not required on its own (the policy number and the name stand in for each other). */
  optional?: boolean;
}

/** The inline controls for the facts a purpose still needs, in the server's order. */
function inlineFields(missing: string[], caseData: CaseV1): InlineField[] {
  const out: InlineField[] = [];
  const add = (f: InlineField) => {
    if (!out.some((o) => o.field === f.field)) out.push(f);
  };
  for (const field of missing) {
    switch (field) {
      case "policyNumber":
        add({ field, label: labelForServerField(field), kind: "text", hint: "From your declarations page or insurance ID card, or add your name instead.", optional: true });
        if (!caseData.customer.name?.trim()) add({ field: "customer.name", label: labelForServerField("customer.name"), kind: "text", hint: "The policyholder the agent calls for.", optional: true });
        break;
      case "merchant.supportPhone":
        add({ field, label: labelForServerField(field), kind: "tel", hint: "Any number, for example the one on your insurance ID card." });
        break;
      case "amountMinor":
        add({ field, label: labelForServerField(field), kind: "number", hint: "In dollars." });
        break;
      case "incidentDate":
        add({ field, label: labelForServerField(field), kind: "date" });
        break;
      case "lossDescription":
        add({ field, label: labelForServerField(field), kind: "textarea", wide: true, hint: "What happened and what was damaged, in your words." });
        break;
      case "reason":
        add({ field, label: labelForServerField(field), kind: "textarea", wide: true });
        break;
      case "currency":
        add({ field, label: labelForServerField(field), kind: "text", hint: "Three-letter code, for example USD." });
        break;
      default:
        add({ field, label: labelForServerField(field), kind: "text" });
    }
  }
  return out;
}

/** A typed North American number becomes E.164; anything else is sent as typed for the server to judge. */
function inlinePhone(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("+")) return `+${trimmed.slice(1).replace(/\D/g, "")}`;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return trimmed;
}

/** The CaseChanges the inline form produces; untouched fields are left out so nothing else changes. */
function inlineChanges(fields: InlineField[], values: Record<string, string>, caseData: CaseV1): CaseChanges {
  const changes: CaseChanges = {};
  for (const f of fields) {
    const v = values[f.field]?.trim();
    if (!v) continue;
    switch (f.field) {
      case "customer.name":
        changes.customer = { name: v, email: caseData.customer.email };
        break;
      case "merchant.name":
        changes.merchant = { name: v, supportPhone: changes.merchant?.supportPhone ?? caseData.merchant.supportPhone };
        break;
      case "merchant.supportPhone":
        changes.merchant = { name: changes.merchant?.name ?? caseData.merchant.name, supportPhone: inlinePhone(v) };
        break;
      case "amountMinor": {
        const amount = Number(v.replace(/[^0-9.]/g, ""));
        if (Number.isFinite(amount)) changes.amountMinor = Math.round(amount * 100);
        break;
      }
      case "currency":
        changes.currency = v.toUpperCase();
        break;
      case "reason":
        changes.reason = v;
        break;
      case "policyNumber":
        changes.policyNumber = v;
        break;
      case "incidentDate":
        changes.incidentDate = v;
        break;
      case "lossDescription":
        changes.lossDescription = v;
        break;
      case "claimType":
        changes.claimType = v;
        break;
      default:
        break;
    }
  }
  return changes;
}

export default function ApprovalCard(props: ApprovalCardProps) {
  const { caseData, placedCall, current, live = false, requestText, busy, stage, error, blockedReason, onApprove, onStartNewCase, onPurposeChange, onSaveFacts } = props;
  // Values typed into the inline form for facts the chosen purpose still needs, keyed by server field.
  const [inline, setInline] = useState<Record<string, string>>({});
  const [inlineSaving, setInlineSaving] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const checkboxId = useId();
  const headingId = useId();
  const purposeName = useId();
  const [ownPurpose, setOwnPurpose] = useState<UiCallPurpose>(() => initialPurpose(caseData, requestText ?? ""));
  const purpose = props.purpose ?? ownPurpose;
  const setPurpose = (next: UiCallPurpose) => {
    setOwnPurpose(next);
    onPurposeChange?.(next);
  };
  // The confirmation belongs to the revision the person saw; new facts need a new confirmation.
  const [confirmedRevision, setConfirmedRevision] = useState<number | null>(null);
  const confirmed = confirmedRevision === caseData.revision;

  const merchant = caseData.merchant.name ?? "the merchant";
  const phone = formatPhone(caseData.merchant.supportPhone);
  const amount = formatMoney(caseData.amountMinor, caseData.currency);

  if (placedCall) {
    return (
      <div className={styles.record}>
        <Pill tone="success" dot>
          Approved
        </Pill>
        <span>
          You approved the call to {merchant}
          {phone ? (
            <>
              {" "}
              at <Mono>{phone}</Mono>
            </>
          ) : null}
          {caseData.authorization ? ` at ${formatClock(caseData.authorization.approvedAt)}` : ""}.
        </span>
      </div>
    );
  }

  if (!current) return null;

  const missing = blockingMissingFields(caseData, purpose);
  const noPhone = caseData.merchant.supportPhone === null || caseData.merchant.supportPhone.trim() === "";
  const needsAmount = purposeNeedsAmount(purpose);
  const verb = live ? "place" : "approve";

  if (noPhone) {
    return (
      <p className={styles.waiting} data-testid="approval-needs-phone">
        There is no number to call yet. Type any number into Number to call above, for example the one on your insurance ID card, then {verb} the call here.
      </p>
    );
  }

  const purposePicker = (
    <fieldset className={styles.purpose} disabled={busy}>
      <legend className={styles.purposeLegend}>What the call is for</legend>
      <div className={styles.purposeOptions}>
        {UI_CALL_PURPOSES.map((option) => (
          <label key={option} className={[styles.purposeOption, option === purpose ? styles.purposeChosen : ""].join(" ")}>
            <input
              type="radio"
              name={purposeName}
              value={option}
              checked={option === purpose}
              onChange={() => setPurpose(option)}
              className={styles.purposeRadio}
              data-testid={`purpose-${option}`}
            />
            {PURPOSE_LABELS[option]}
          </label>
        ))}
      </div>
    </fieldset>
  );

  if (missing.length > 0) {
    // Another purpose may be ready (no amount is needed to ask what is needed), so the choice stays offered.
    const anotherReady = UI_CALL_PURPOSES.some((option) => blockingMissingFields(caseData, option).length === 0);
    const waiting = (
      <p className={styles.waiting}>
        Fill in the missing facts above ({missing.map(labelForServerField).join(", ").toLowerCase()}), then {verb} the call here.
      </p>
    );
    if (!onSaveFacts) {
      if (!anotherReady) return waiting;
      return (
        <section className={styles.card} aria-labelledby={headingId}>
          <h3 id={headingId} className={styles.title}>
            What should the call to {merchant} do?
          </h3>
          {purposePicker}
          {waiting}
        </section>
      );
    }

    // The server says "policyNumber" when neither the policy number nor the name is known: offer both.
    const fields = inlineFields(missing, caseData);
    const value = (field: string) => inline[field] ?? "";
    const filled = (field: string) => value(field).trim().length > 0;
    const complete = fields.every((f) => (f.optional ? true : filled(f.field))) && (!fields.some((f) => f.field === "policyNumber") || filled("policyNumber") || filled("customer.name"));

    const saveInline = async () => {
      if (!complete || inlineSaving) return;
      setInlineSaving(true);
      setInlineError(null);
      try {
        const saved = await onSaveFacts(inlineChanges(fields, inline, caseData), caseData.revision);
        if (saved) setInline({});
        else setInlineError("Could not save these facts. Check the facts card above and try again.");
      } finally {
        setInlineSaving(false);
      }
    };

    return (
      <section className={styles.card} aria-labelledby={headingId} data-testid="approval-missing-facts">
        <h3 id={headingId} className={styles.title}>
          {live ? "Place the call" : "Approve the call"} to {merchant}
          {phone ? (
            <>
              {" "}
              at <Mono>{phone}</Mono>
            </>
          ) : null}
        </h3>
        {purposePicker}
        <p className={styles.inlineLead}>
          To {PURPOSE_LABELS[purpose].toLowerCase()}, the agent still needs {fields.length === 1 ? "one fact" : `${fields.length} facts`}. Add {fields.length === 1 ? "it" : "them"} here and the plan above updates.
        </p>
        <div className={styles.inlineForm}>
          {fields.map((f) => (
            <div key={f.field} className={f.wide ? styles.inlineWide : undefined}>
              {f.kind === "textarea" ? (
                <Field
                  as="textarea"
                  label={f.label}
                  rows={3}
                  value={value(f.field)}
                  hint={f.hint}
                  disabled={inlineSaving || busy}
                  onChange={(event) => setInline((prev) => ({ ...prev, [f.field]: event.target.value }))}
                  data-testid={`approval-missing-${f.field}`}
                />
              ) : (
                <Field
                  label={f.label}
                  type={f.kind}
                  inputMode={f.kind === "number" ? "decimal" : f.kind === "tel" ? "tel" : undefined}
                  step={f.kind === "number" ? "0.01" : undefined}
                  min={f.kind === "number" ? "0" : undefined}
                  autoComplete="off"
                  value={value(f.field)}
                  hint={f.hint}
                  disabled={inlineSaving || busy}
                  onChange={(event) => setInline((prev) => ({ ...prev, [f.field]: event.target.value }))}
                  data-testid={`approval-missing-${f.field}`}
                />
              )}
            </div>
          ))}
        </div>
        {inlineError ? <p className={styles.note}>{inlineError}</p> : null}
        {blockedReason ? <p className={styles.note}>{blockedReason}</p> : null}
        <div className={styles.inlineActions}>
          <Button variant="primary" onClick={saveInline} disabled={!complete || blockedReason !== null} busy={inlineSaving} busyLabel="Saving" data-testid="approval-missing-save">
            Save and continue
          </Button>
          <span className={styles.inlineLead}>Then confirm and {verb} the call here.</span>
        </div>
      </section>
    );
  }

  const authorizedForRevision = caseData.authorization !== null && caseData.authorization.revision === caseData.revision;

  return (
    <section className={styles.card} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.title}>
        {live ? "Place the call" : "Approve the call"} to {merchant}
        {phone ? (
          <>
            {" "}
            at <Mono>{phone}</Mono>
          </>
        ) : null}
      </h3>

      {purposePicker}

      <KeyValueList
        items={[
          { key: "On behalf of", value: caseData.customer.name },
          ...(needsAmount ? [{ key: "Amount", value: amount ? <Mono>{amount}</Mono> : null }] : []),
          { key: "Asking for", value: askingFor(purpose, amount) },
          { key: "Reason", value: caseData.reason },
          { key: "Facts", value: `Revision ${caseData.revision}` },
        ]}
      />

      <p className={styles.destination} data-testid="approval-destination">
        <span className={styles.destinationNumber}>
          Calling <Mono>{phone}</Mono>
        </span>
        <span>{provenance(caseData.merchant.source)}</span>
      </p>

      {live ? (
        <p className={styles.liveNote} data-testid="approval-live-note">
          Placing the call dials <Mono>{phone}</Mono> now from our number, an AI assistant speaks for you, and the call is capped at 5 minutes.
        </p>
      ) : null}

      {authorizedForRevision ? (
        <p className={styles.note}>
          Approved at {formatClock(caseData.authorization!.approvedAt)}. The call has not been placed yet.
        </p>
      ) : null}

      <label className={styles.confirm} htmlFor={checkboxId}>
        <input
          id={checkboxId}
          type="checkbox"
          className={styles.checkbox}
          checked={confirmed}
          disabled={busy}
          onChange={(event) => setConfirmedRevision(event.target.checked ? caseData.revision : null)}
          data-testid="approve-checkbox"
        />
        <span>
          {live
            ? "I confirm these facts are accurate and I want Recourse to dial this number now, with an AI assistant speaking for me"
            : "I confirm these facts are accurate and I authorize this call"}
        </span>
      </label>

      {error ? (
        <Banner
          tone={error.kind === "unreachable" || error.retryable ? "warning" : "danger"}
          role="alert"
          title={error.title}
          testId="error-banner"
          actions={
            error.kind === "mode_mismatch" && onStartNewCase ? (
              <Button size="small" variant="secondary" onClick={onStartNewCase}>
                Start a new case
              </Button>
            ) : null
          }
        >
          {errorBody(error)}
        </Banner>
      ) : null}

      {blockedReason ? <p className={styles.note}>{blockedReason}</p> : null}

      <div className={styles.actions}>
        <Button
          variant="primary"
          onClick={() => onApprove(purpose)}
          disabled={!confirmed || blockedReason !== null}
          busy={busy}
          busyLabel={stage === "dispatching" ? "Placing the call" : "Approving"}
          data-testid="approve-button"
        >
          {error?.retryable ? "Try again" : live ? "Place the call" : "Approve this call"}
        </Button>
        {busy ? (
          <span className={styles.stage} aria-hidden="true">
            {stage === "dispatching" ? "Placing the call" : "Approving"}
          </span>
        ) : null}
      </div>
    </section>
  );
}
