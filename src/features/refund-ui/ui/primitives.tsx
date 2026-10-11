"use client";

/**
 * Shared primitives for the Recourse UI. Styles consume the --rc-* tokens set
 * on the RefundApp wrapper. See ../design.md for roles and rules.
 */

import { useId } from "react";
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  InputHTMLAttributes,
  MouseEvent,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { ChevronRightIcon } from "./icons";
import styles from "./primitives.module.css";

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

const toneClass: Record<Tone, string> = {
  neutral: styles.pillNeutral ?? "",
  accent: styles.pillAccent ?? "",
  success: styles.pillSuccess ?? "",
  warning: styles.pillWarning ?? "",
  danger: styles.pillDanger ?? "",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "default" | "small";
  /**
   * In flight. The button keeps its focus and full contrast (aria-disabled,
   * not native disabled), ignores clicks, shows a 12px spinner and announces
   * `busyLabel`. Use `disabled` only for actions that are truly unavailable.
   */
  busy?: boolean;
  /** Announced to screen readers while busy, for example "Saving". */
  busyLabel?: string;
}

export function Button({
  variant = "secondary",
  size = "default",
  busy = false,
  busyLabel,
  disabled,
  className,
  children,
  onClick,
  ...rest
}: ButtonProps) {
  const classes = [styles.button, styles[variant], size === "small" ? styles.small : "", className ?? ""].join(" ");
  const guardedClick = (event: MouseEvent<HTMLButtonElement>) => {
    // Also stops a busy submit button from submitting its form again.
    if (busy) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };
  return (
    <>
      <button
        type="button"
        {...rest}
        className={classes}
        disabled={disabled}
        aria-disabled={busy || undefined}
        aria-busy={busy || undefined}
        onClick={guardedClick}
      >
        {busy ? <span className={styles.spinner} aria-hidden="true" /> : null}
        {children}
      </button>
      <span className={styles.visuallyHidden} role="status">
        {busy ? (busyLabel ?? "Working") : ""}
      </span>
    </>
  );
}

export interface PillProps {
  tone?: Tone;
  /** Adds a leading status dot; `pulse` animates it for live states. */
  dot?: boolean;
  pulse?: boolean;
  title?: string;
  testId?: string;
  children: ReactNode;
}

export function Pill({ tone = "neutral", dot = false, pulse = false, title, testId, children }: PillProps) {
  return (
    <span className={[styles.pill, toneClass[tone], pulse ? styles.pillPulse : ""].join(" ")} title={title} data-testid={testId}>
      {dot || pulse ? <span className={styles.pillDot} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

interface FieldBaseProps {
  label: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
}

export type FieldProps = FieldBaseProps &
  (
    | ({ as?: "input" } & InputHTMLAttributes<HTMLInputElement>)
    | ({ as: "textarea" } & TextareaHTMLAttributes<HTMLTextAreaElement>)
  );

export function Field(props: FieldProps) {
  const { label, hint, error, required, id, ...rest } = props as FieldBaseProps & { id?: string; as?: "input" | "textarea" } & Record<string, unknown>;
  const autoId = useId();
  const controlId = id ?? autoId;
  const { as, "aria-describedby": callerDescribedBy, ...controlProps } = rest as {
    as?: "input" | "textarea";
    "aria-describedby"?: string;
  } & Record<string, unknown>;
  const describedBy =
    [callerDescribedBy, hint ? `${controlId}-hint` : null, error ? `${controlId}-error` : null].filter(Boolean).join(" ") ||
    undefined;
  const inputClass = [styles.input, error ? styles.inputInvalid : ""].join(" ");
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={controlId}>
        {label}
        {required ? <span className={styles.fieldRequired} aria-hidden="true">*</span> : null}
      </label>
      {as === "textarea" ? (
        <textarea
          {...(controlProps as TextareaHTMLAttributes<HTMLTextAreaElement>)}
          id={controlId}
          className={inputClass}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          required={required}
        />
      ) : (
        <input
          {...(controlProps as InputHTMLAttributes<HTMLInputElement>)}
          id={controlId}
          className={inputClass}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          required={required}
        />
      )}
      {hint ? (
        <span id={`${controlId}-hint`} className={styles.fieldHint}>
          {hint}
        </span>
      ) : null}
      {/* No role="alert" per field: forms move focus to the first invalid field instead. */}
      {error ? (
        <span id={`${controlId}-error`} className={styles.fieldError}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** Inline monospace for identifiers, phone numbers and amounts. */
export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <code className={styles.mono} title={title}>
      {children}
    </code>
  );
}

/** Block monospace for transcripts and JSON. A caption names it for assistive technology. */
export function MonoBlock({ children, caption }: { children: ReactNode; caption?: string }) {
  const block = <pre className={styles.monoBlock}>{children}</pre>;
  if (!caption) return block;
  return (
    <figure className={styles.monoFigure}>
      <figcaption className={styles.visuallyHidden}>{caption}</figcaption>
      {block}
    </figure>
  );
}

export interface BannerProps {
  tone?: Tone;
  title?: string;
  children?: ReactNode;
  role?: "status" | "alert";
  /** Controls shown at the end of the banner, for example a retry button. */
  actions?: ReactNode;
  testId?: string;
}

/** Spoken before an untitled banner so its tone is never carried by color alone. */
const bannerToneWord: Record<Tone, string | null> = {
  neutral: null,
  accent: "Note:",
  success: "Done:",
  warning: "Warning:",
  danger: "Error:",
};

export function Banner({ tone = "neutral", title, children, role, actions, testId }: BannerProps) {
  const cls = {
    neutral: "",
    accent: styles.bannerAccent,
    success: styles.bannerSuccess,
    warning: styles.bannerWarning,
    danger: styles.bannerDanger,
  }[tone];
  const toneWord = bannerToneWord[tone];
  return (
    <div className={[styles.banner, cls ?? ""].join(" ")} role={role} data-testid={testId}>
      <div className={styles.bannerBody}>
        {title ? (
          <span className={styles.bannerTitle}>{title}</span>
        ) : toneWord ? (
          <span className={styles.visuallyHidden}>{toneWord} </span>
        ) : null}
        {children}
      </div>
      {actions ? <div className={styles.bannerActions}>{actions}</div> : null}
    </div>
  );
}

export function SectionHeading({ title, description, actions, eyebrow }: { title: string; description?: string; actions?: ReactNode; eyebrow?: string }) {
  return (
    <div className={styles.sectionHeading}>
      <div>
        {eyebrow ? <div className={styles.eyebrow}>{eyebrow}</div> : null}
        <h2 className={styles.sectionTitle}>{title}</h2>
        {description ? <p className={styles.sectionDescription}>{description}</p> : null}
      </div>
      {actions ? <div>{actions}</div> : null}
    </div>
  );
}

export interface KeyValueItem {
  key: string;
  value: ReactNode;
}

/** Definition list with hairline rows. Null or empty values render as a muted dash. */
export function KeyValueList({ items }: { items: KeyValueItem[] }) {
  return (
    <dl className={styles.kv}>
      {items.map((item) => (
        <div className={styles.kvRow} key={item.key}>
          <dt className={styles.kvKey}>{item.key}</dt>
          <dd className={styles.kvValue}>
            {item.value === null || item.value === undefined || item.value === "" ? <span className={styles.kvEmpty}>Not provided</span> : item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Divider() {
  return <hr className={styles.divider} />;
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className={styles.eyebrow}>{children}</div>;
}

/** Text for assistive technology only. */
export function VisuallyHidden({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <span className={styles.visuallyHidden} id={id}>
      {children}
    </span>
  );
}

/** A placeholder bar while content loads. Pair with SkeletonRows for a labelled region. */
export function Skeleton({ width = "100%", height = 12 }: { width?: CSSProperties["width"]; height?: number }) {
  return <span className={styles.skeleton} style={{ width, height }} aria-hidden="true" />;
}

const skeletonWidths = ["72%", "88%", "54%", "80%", "64%"];

/** Loading rows with an announced label. No spinner larger than 16px anywhere. */
export function SkeletonRows({ rows = 3, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <div className={styles.skeletonRows} role="status" aria-live="polite">
      <VisuallyHidden>{label}</VisuallyHidden>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} width={skeletonWidths[index % skeletonWidths.length]} />
      ))}
    </div>
  );
}

/** Native details and summary with the shared chevron. Keyboard operable by default. */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  testId,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  testId?: string;
}) {
  return (
    <details className={styles.disclosure} open={defaultOpen || undefined}>
      <summary className={styles.disclosureSummary} data-testid={testId}>
        <span className={styles.disclosureChevron}>
          <ChevronRightIcon />
        </span>
        {summary}
      </summary>
      <div className={styles.disclosureBody}>{children}</div>
    </details>
  );
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** 28px tall, for headers and dense rows. */
  compact?: boolean;
}

/** Styled native select. Give it a label with htmlFor, or aria-label. */
export function Select({ compact = false, className, children, ...rest }: SelectProps) {
  return (
    <span className={[styles.selectWrap, compact ? styles.selectCompact : "", className ?? ""].join(" ")}>
      <select {...rest} className={styles.select}>
        {children}
      </select>
      <span className={styles.selectChevron} aria-hidden="true">
        <ChevronRightIcon />
      </span>
    </span>
  );
}

export interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  id: string;
  label: string;
  hint?: string;
  error?: string | null;
}

/** A labelled select with the same anatomy as Field. */
export function SelectField({ id, label, hint, error, children, "aria-describedby": callerDescribedBy, ...rest }: SelectFieldProps) {
  const describedBy =
    [callerDescribedBy, hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={id}>
        {label}
      </label>
      <Select {...rest} id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy}>
        {children}
      </Select>
      {hint ? (
        <span id={`${id}-hint`} className={styles.fieldHint}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={`${id}-error`} className={styles.fieldError}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Labels data that did not come from a live backend, where the data appears.
 * Both browser fixtures and simulated cases retain a compact provenance label.
 */
export function SourcePill({ fixture, simulated }: { fixture: boolean; simulated: boolean }) {
  if (fixture || simulated) {
    return (
      <Pill tone="warning" title="Simulated data; no real call was placed">
        Simulated
      </Pill>
    );
  }
  return null;
}
