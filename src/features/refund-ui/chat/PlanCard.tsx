"use client";

/**
 * The resolution plan in the chat: what Recourse will do before, on and after
 * the call, in plain words, with the insurer rules it rests on. Read-only.
 * Once a call was approved it shows the frozen plan the agent was given.
 */

import { useId, type ReactNode } from "react";
import type { ResolutionPlanV1, ResolutionStepV1, ResolutionTermV1 } from "../../../contracts/case";
import { Button, Disclosure, Pill, SkeletonRows, type Tone } from "../ui/primitives";
import styles from "./PlanCard.module.css";

export interface PlanCardProps {
  plan: ResolutionPlanV1 | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Folds the plan behind "Show the plan" so the thread stays short. */
  collapsed?: boolean;
}

const TITLE = "How Recourse will resolve this";

function planStatus(plan: ResolutionPlanV1): { tone: Tone; label: string; line: string } {
  if (plan.frozen) {
    return { tone: "neutral", label: "Approved plan", line: "This is the plan the agent was given when you approved the call." };
  }
  if (plan.ready) {
    return { tone: "success", label: "Ready", line: "This is what the agent will do if you approve the call." };
  }
  return { tone: "warning", label: "Draft", line: "Draft: add the missing facts above and this plan updates." };
}

/** The bare host of a source link, e.g. "statefarm.com", or null when the URL does not parse. */
function sourceHost(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    return host.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className={styles.link} href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

function StepList({ items, testId }: { items: ResolutionStepV1[]; testId: string }) {
  return (
    <ul className={styles.stepList} data-testid={testId}>
      {items.map((item) => (
        <li key={`${item.title}-${item.detail}`} className={styles.stepItem}>
          <span className={styles.stepHead}>
            <span className={styles.stepTitle}>{item.title}</span>
            {item.status === "done" ? (
              <Pill tone="success" testId="plan-have-it">
                Have it
              </Pill>
            ) : item.status === "missing" ? (
              <Pill tone="warning" testId="plan-missing">
                Missing
              </Pill>
            ) : null}
          </span>
          {item.detail ? <span className={styles.stepDetail}>{item.detail}</span> : null}
          {item.source ? (
            <span className={styles.stepSource}>
              <ExternalLink href={item.source.url}>Source: {item.source.label}</ExternalLink>
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function TermList({ terms }: { terms: ResolutionTermV1[] }) {
  return (
    <ul className={styles.termList}>
      {terms.map((term) => {
        const host = term.sourceUrl ? sourceHost(term.sourceUrl) : null;
        return (
          <li key={term.key} className={styles.termItem}>
            <span className={styles.termLabel}>{term.label}</span>
            <span className={styles.termValue}>{term.value}</span>
            <span className={styles.termMeta}>
              <span>{term.confidenceLabel}</span>
              {term.sourceUrl ? (
                <ExternalLink href={term.sourceUrl}>Source: {host ?? "insurer website"}</ExternalLink>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function PlanBody({ plan }: { plan: ResolutionPlanV1 }) {
  const { call } = plan;
  return (
    <div className={styles.body}>
      <div className={styles.section}>
        <h4 className={styles.sectionLabel}>Before the call</h4>
        <StepList items={plan.before} testId="plan-before" />
      </div>

      <div className={styles.section}>
        <h4 className={styles.sectionLabel}>On the call</h4>
        {call.goal ? <p className={styles.paragraph}>{call.goal}</p> : null}
        {call.steps.length > 0 ? (
          <ol className={styles.numberedList} data-testid="plan-call-steps">
            {call.steps.map((step, index) => (
              <li key={`${index}-${step}`} className={styles.numberedItem}>
                <span className={styles.number} aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className={styles.numberedText}>{step}</span>
              </li>
            ))}
          </ol>
        ) : null}
        {call.questions.length > 0 ? (
          <div className={styles.subsection}>
            <h5 className={styles.subLabel}>Questions the agent will ask</h5>
            <ul className={styles.bulletList} data-testid="plan-questions">
              {call.questions.map((question) => (
                <li key={question}>{question}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {call.readBack ? (
          <div className={styles.subsection}>
            <h5 className={styles.subLabel}>Before hanging up</h5>
            <p className={styles.paragraph}>{call.readBack}</p>
          </div>
        ) : null}
      </div>

      <div className={styles.section}>
        <h4 className={styles.sectionLabel}>What the agent will not do</h4>
        <ul className={styles.bulletList} data-testid="plan-will-not-do">
          {call.willNotDo.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>

      <div className={styles.section}>
        <h4 className={styles.sectionLabel}>After the call</h4>
        <StepList items={plan.after} testId="plan-after" />
      </div>

      {plan.insurerTerms.length > 0 ? (
        <div className={styles.section} data-testid="plan-insurer-terms">
          <h4 className={styles.sectionLabel}>Insurer rules</h4>
          <TermList terms={plan.insurerTerms} />
        </div>
      ) : null}
    </div>
  );
}

export default function PlanCard({ plan, loading = false, error = null, onRetry, collapsed = false }: PlanCardProps) {
  const headingId = useId();

  if (!plan && !loading && !error) return null;

  const status = plan ? planStatus(plan) : null;

  return (
    <section className={styles.card} aria-labelledby={headingId} data-testid="plan-card">
      <div className={styles.header}>
        <h3 id={headingId} className={styles.title}>
          {TITLE}
        </h3>
        {status ? (
          <Pill tone={status.tone} testId="plan-status">
            {status.label}
          </Pill>
        ) : null}
      </div>

      {plan && status ? (
        <>
          <p className={styles.note} data-testid="plan-status-line">
            {status.line}
          </p>
          {collapsed ? (
            <Disclosure summary="Show the plan" testId="plan-toggle">
              <PlanBody plan={plan} />
            </Disclosure>
          ) : (
            <PlanBody plan={plan} />
          )}
        </>
      ) : loading ? (
        <SkeletonRows label="Preparing the plan" />
      ) : (
        <div className={styles.errorRow} role="alert">
          <p className={styles.note}>The plan could not be loaded. {error}</p>
          {onRetry ? (
            <Button variant="secondary" size="small" onClick={onRetry}>
              Try again
            </Button>
          ) : null}
        </div>
      )}
    </section>
  );
}
