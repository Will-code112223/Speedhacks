"use client";

/**
 * The left rail: start a case, move between this tab's cases, and reach the
 * stored plans. The contract has no endpoint that lists cases, so the rail
 * shows the cases created in this tab.
 */

import { useId, type ReactNode } from "react";
import type { PlanRecord } from "../plans/store";
import { caseTitle, currentCall, isCallActive } from "../state/call";
import { pendingDecision, type CaseSession } from "../state/session";
import { fileKindLabel, formatMoney, statusWord } from "../ui/format";
import { PlusIcon } from "../ui/icons";
import { Button } from "../ui/primitives";
import styles from "./Rail.module.css";

export interface RailProps {
  /** Newest first. */
  sessions: readonly CaseSession[];
  activeKey: string | null;
  view: "chat" | "plans";
  plans: readonly PlanRecord[];
  onNewCase: () => void;
  onSelectCase: (key: string) => void;
  onManagePlans: () => void;
  /** Shown at the bottom, for example the fixture picker on narrow screens. */
  footer?: ReactNode;
}

type RowTone = "neutral" | "accent" | "warning" | "danger";

function caseStatus(session: CaseSession): { text: string; tone: RowTone; dot: boolean } {
  const caseData = session.caseData;
  if (caseData === null) {
    if (session.create.busy) return { text: "Reading your request", tone: "neutral", dot: false };
    return { text: "Not created", tone: "danger", dot: false };
  }
  if (pendingDecision(session)) return { text: "Needs your answer", tone: "warning", dot: true };
  const call = currentCall(caseData, session.startedCall);
  if (call && isCallActive(call)) return { text: "On the call", tone: "accent", dot: true };
  if (call && call.state === "dispatch_unknown") return { text: "Call outcome unknown", tone: "warning", dot: false };
  return { text: statusWord(caseData.status), tone: "neutral", dot: false };
}

const toneClass: Record<RowTone, string | undefined> = {
  neutral: undefined,
  accent: styles.toneAccent,
  warning: styles.toneWarning,
  danger: styles.toneDanger,
};

export default function Rail(props: RailProps) {
  const { sessions, activeKey, view, plans, onNewCase, onSelectCase, onManagePlans, footer } = props;
  const casesHeadingId = useId();
  const plansHeadingId = useId();
  const newCaseCurrent = view === "chat" && activeKey === null;

  return (
    <div className={styles.rail}>
      <div className={styles.workspace}>
        <span className={styles.workspaceLabel}>Personal workspace</span>
        <span className={styles.workspaceTitle}>Your cases</span>
      </div>
      <Button
        variant="primary"
        className={styles.newCase}
        onClick={onNewCase}
        aria-current={newCaseCurrent ? "page" : undefined}
        data-testid="rail-new-case"
      >
        <PlusIcon />
        New case
      </Button>

      <section className={styles.section} aria-labelledby={casesHeadingId}>
        <div className={styles.headingRow}>
          <h2 id={casesHeadingId} className={styles.heading}>
            Cases
          </h2>
          <span className={styles.count}>{sessions.length.toString().padStart(2, "0")}</span>
        </div>
        {sessions.length === 0 ? (
          <p className={styles.empty}>A place for every request.<br />Start a case to keep it in view.</p>
        ) : (
          <ul className={styles.list}>
            {sessions.map((session) => {
              const selected = view === "chat" && session.key === activeKey;
              const status = caseStatus(session);
              const amount = session.caseData ? formatMoney(session.caseData.amountMinor, session.caseData.currency) : null;
              return (
                <li key={session.key}>
                  <button
                    type="button"
                    className={[styles.row, selected ? styles.rowSelected : ""].join(" ")}
                    aria-current={selected ? "page" : undefined}
                    onClick={() => onSelectCase(session.key)}
                    data-testid="rail-case"
                  >
                    <span className={styles.rowTitle}>{caseTitle(session.caseData, session.summary)}</span>
                    <span className={styles.rowMeta}>
                      <span className={[styles.status, toneClass[status.tone] ?? ""].join(" ")}>
                        {status.dot ? <span className={styles.dot} aria-hidden="true" /> : null}
                        <span className={styles.statusText}>{status.text}</span>
                      </span>
                      {amount ? <span className={styles.amount}>{amount}</span> : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className={styles.section} aria-labelledby={plansHeadingId}>
        <div className={styles.headingRow}>
          <h2 id={plansHeadingId} className={styles.heading}>
            Plans
          </h2>
          <Button variant="ghost" size="small" className={styles.addPlan} onClick={onManagePlans} data-testid="rail-add-plan">
            <PlusIcon />
            Add plan
          </Button>
        </div>
        {plans.length === 0 ? (
          <p className={styles.empty}>Keep your policy documents ready for your next case.</p>
        ) : (
          <ul className={styles.list}>
            {plans.map((plan) => {
              const title = plan.name.trim() || plan.insurer.trim() || plan.fileName;
              const meta = [plan.name.trim() && plan.insurer.trim() ? plan.insurer.trim() : null, fileKindLabel(plan.fileName, plan.fileType)]
                .filter(Boolean)
                .join(" · ");
              return (
                <li key={plan.id}>
                  <button
                    type="button"
                    className={[styles.row, view === "plans" ? styles.rowOpen : ""].join(" ")}
                    onClick={onManagePlans}
                    data-testid="rail-plan"
                  >
                    <span className={styles.rowTitle}>{title}</span>
                    <span className={styles.rowMeta}>
                      <span className={styles.statusText}>{meta}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className={styles.footer}>
        {footer}
        <p className={styles.controlNote}>You approve. Then we call.</p>
        <p className={styles.localNote}>Cases stay in this tab.<br />Plans stay in this browser.</p>
      </div>
    </div>
  );
}
