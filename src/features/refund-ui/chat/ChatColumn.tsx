"use client";

/**
 * The chat column: the conversation for the active case and the composer
 * pinned to the bottom.
 *
 * The shared contract has no chat endpoint. The first message creates the
 * case; later messages stay in this browser and get a local acknowledgement.
 * Everything else in the thread renders from the server's case and call.
 */

import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { CallV1, CaseV1 } from "../../../contracts/case";
import { Banner, Button, SkeletonRows } from "../ui/primitives";
import { FileIcon } from "../ui/icons";
import { formatClock } from "../ui/format";
import DecisionCard from "../ui/DecisionCard";
import { caseTitle, currentCall, hasCallOutcome, isCallActive, isOutcomeStatus } from "../state/call";
import CaseDocuments from "../documents/CaseDocuments";
import ActivityGraph from "../activity/ActivityGraph";
import type { CaseSessionController } from "../state/controller";
import type { SummaryController } from "../state/useCaseSession";
import type { CaseSession, EventTone, ThreadItem } from "../state/session";
import { initialPurpose } from "../state/purpose";
import { useResolutionPlan, type ResolutionPlanState } from "../api/plan";
import type { UiCallPurpose } from "../api/types";
import ApprovalCard from "./ApprovalCard";
import PlanCard from "./PlanCard";
import Composer from "./Composer";
import FactsCard from "./FactsCard";
import ResultBlock from "./ResultBlock";
import SummaryCard from "./SummaryCard";
import styles from "./ChatColumn.module.css";

/** The summary actions are optional so views built against the controller alone still render. */
type ChatController = CaseSessionController & Partial<SummaryController>;

export interface ChatColumnProps {
  controller: ChatController;
  fixture: boolean;
  /** True when an approved call dials a real number (server REFUND_MODE=live over http). */
  live?: boolean;
  /** Shown under the support phone field, for example the simulated backend's number rules. */
  phoneHint: string | null;
  planCount: number;
  /** The compact call bar shown at the top when the call column is a sheet. */
  callBar: ReactNode;
  /** The metrics strip shown above the composer once a call exists. */
  metrics: ReactNode;
}

const ASSISTANT_KINDS: ReadonlySet<ThreadItem["kind"]> = new Set(["assistant", "understood", "approval", "result"]);
const SAMPLE_PROMPTS = [
  "File a claim with State Farm for water damage to my kitchen on Oct 3, about $1,200.",
  "Ask Blue Shield of California what I need to file a claim for an out-of-network visit on Oct 3.",
  "Check the status of my Progressive auto claim.",
  "Dispute a duplicate $49.99 charge from Ridgeline Outfitters.",
] as const;

export default function ChatColumn({ controller, fixture, live = false, phoneHint, callBar, metrics }: ChatColumnProps) {
  const session = controller.active;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftKey = session?.key ?? "new";
  const draft = drafts[draftKey] ?? "";
  const setDraft = useCallback((value: string) => setDrafts((current) => ({ ...current, [draftKey]: value })), [draftKey]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Unsaved edits in a case's facts card hold back its approval step.
  const [dirtyFacts, setDirtyFacts] = useState<Record<string, boolean>>({});
  const reportFactsDirty = useCallback(
    (key: string, dirty: boolean) => setDirtyFacts((current) => (Boolean(current[key]) === dirty ? current : { ...current, [key]: dirty })),
    [],
  );

  // The purpose chosen on the approval step, per case, so the plan card above it follows the choice.
  const [purposes, setPurposes] = useState<Record<string, UiCallPurpose>>({});
  const choosePurpose = useCallback(
    (key: string, purpose: UiCallPurpose) => setPurposes((current) => (current[key] === purpose ? current : { ...current, [key]: purpose })),
    [],
  );

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const [unseen, setUnseen] = useState(false);
  const itemCount = (session?.thread.length ?? 0) + (session?.create.busy ? 1 : 0) + (session?.create.error ? 1 : 0);

  const onScroll = () => {
    const node = scrollerRef.current;
    if (!node) return;
    stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64;
    if (stickToBottom.current) setUnseen(false);
  };

  // New items keep the view pinned to the bottom unless the person scrolled up to read.
  // The empty state has nothing to follow, so it stays at the top.
  useLayoutEffect(() => {
    const node = scrollerRef.current;
    if (!node || itemCount === 0) return;
    if (stickToBottom.current) {
      node.scrollTop = node.scrollHeight;
    } else if (itemCount > 0) {
      setUnseen(true);
    }
  }, [itemCount]);

  // A different case starts at its newest message; a new case starts at the top.
  useLayoutEffect(() => {
    stickToBottom.current = true;
    setUnseen(false);
    const node = scrollerRef.current;
    if (node) node.scrollTop = draftKey === "new" ? 0 : node.scrollHeight;
  }, [draftKey]);

  const jumpToLatest = () => {
    const node = scrollerRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    stickToBottom.current = true;
    setUnseen(false);
  };

  const caseData = session?.caseData ?? null;
  const placeholder = caseData
    ? "Add a note to this case…"
    : "Which insurer or company, what happened, and when?";

  const hint = caseData ? "Notes are local. Edit the facts to update the call brief." : null;

  return (
    <section className={styles.column} aria-label="Conversation">
      <h1 className={styles.srOnly}>{session ? caseTitle(caseData, session.summary) : "New case"}</h1>
      {callBar}
      <div className={styles.scroller} ref={scrollerRef} onScroll={onScroll}>
        <div className={styles.thread}>
          {!session ? (
            <div className={styles.gettingStarted}>
              <h2 className={styles.emptyTitle}>New case</h2>
              <p className={styles.emptyText}>Recourse helps automate insurance claims and refund requests. Prepare your documents, check provider requirements, and approve support calls in one place.</p>
              <ol className={styles.steps} aria-label="How to start a case">
                <li><span className={styles.stepNumber} aria-hidden="true">01</span><span>Describe the issue</span></li>
                <li><span className={styles.stepNumber} aria-hidden="true">02</span><span>Attach supporting documents</span></li>
                <li><span className={styles.stepNumber} aria-hidden="true">03</span><span>Review details and approve the action</span></li>
              </ol>
            </div>
          ) : null}
          <ActivityGraph
            key={caseData?.id ?? "new-case-graph"}
            caseData={caseData}
            call={controller.call}
            fixture={fixture}
            defaultExpanded
          />
          {session ? (
            <Thread
              session={session}
              controller={controller}
              fixture={fixture}
              live={live}
              phoneHint={phoneHint}
              factsDirty={dirtyFacts[session.key] ?? false}
              onFactsDirty={reportFactsDirty}
              purpose={session.caseData ? (purposes[session.key] ?? initialPurpose(session.caseData, session.summary)) : null}
              onPurposeChange={choosePurpose}
            />
          ) : null}
        </div>
        {unseen ? (
          <div className={styles.jump}>
            <Button size="small" variant="secondary" onClick={jumpToLatest}>
              Jump to latest
            </Button>
          </div>
        ) : null}
      </div>
      {metrics}
      <Composer
        suggestions={!session ? (
          <div className={styles.prompts} role="group" aria-label="Sample requests">
            {SAMPLE_PROMPTS.map((prompt) => <button className={styles.prompt} type="button" key={prompt} onClick={() => { setDraft(prompt); textareaRef.current?.focus(); }}>{prompt}</button>)}
          </div>
        ) : null}
        value={draft}
        onChange={setDraft}
        onSend={controller.send}
        busy={session?.create.busy ?? false}
        busyLabel="Reading your request"
        placeholder={placeholder}
        hint={hint}
        textareaRef={textareaRef}
        pendingFiles={session ? undefined : controller.pendingFiles}
        onAttach={!session || session.caseId !== null ? controller.attachFiles : undefined}
        onRemovePending={controller.removePendingFile}
        uploadsImmediately={session !== null}
      />
    </section>
  );
}

function Thread({
  session,
  controller,
  fixture,
  live,
  phoneHint,
  factsDirty,
  onFactsDirty,
  purpose,
  onPurposeChange,
}: {
  session: CaseSession;
  controller: ChatController;
  fixture: boolean;
  live: boolean;
  phoneHint: string | null;
  factsDirty: boolean;
  onFactsDirty: (key: string, dirty: boolean) => void;
  purpose: UiCallPurpose | null;
  onPurposeChange: (key: string, purpose: UiCallPurpose) => void;
}) {
  const caseData = session.caseData;
  const call = currentCall(caseData, session.startedCall);
  const lastOpenApproval = [...session.thread].reverse().find((item) => item.kind === "approval" && item.callId === null);
  // Once the current revision is authorized the server answers with the frozen plan, whatever the choice.
  const authorized = caseData?.authorization && caseData.authorization.revision === caseData.revision ? caseData.authorization : null;
  const planPurpose = authorized ? (authorized.purpose ?? "request_refund") : purpose;
  const hasApproval = session.thread.some((item) => item.kind === "approval");
  // Before any approval step is offered (facts still missing), the plan stands on its own at the
  // end of the thread so the person sees what to gather; once a step exists it sits above it.
  const standalonePlan = caseData !== null && lastOpenApproval === undefined && caseData.calls.length === 0 && session.startedCall === null && !authorized;
  const plan = useResolutionPlan(hasApproval || standalonePlan ? caseData : null, planPurpose, fixture);

  return (
    <ol className={styles.items}>
      {session.thread.map((item, index) => {
        const previous = index > 0 ? session.thread[index - 1] : undefined;
        const grouped = previous !== undefined && ASSISTANT_KINDS.has(previous.kind) && ASSISTANT_KINDS.has(item.kind);
        return (
          <ThreadEntry
            key={item.id}
            item={item}
            grouped={grouped}
            session={session}
            caseData={caseData}
            call={call}
            currentApprovalId={lastOpenApproval?.id ?? null}
            controller={controller}
            fixture={fixture}
            live={live}
            phoneHint={phoneHint}
            factsDirty={factsDirty}
            onFactsDirty={onFactsDirty}
            plan={plan}
            purpose={purpose}
            onPurposeChange={(next) => onPurposeChange(session.key, next)}
          />
        );
      })}
      {standalonePlan && (plan.plan || plan.loading || plan.error) ? (
        <li className={[styles.assistant, styles.grouped].join(" ")}>
          <PlanCard plan={plan.plan} loading={plan.loading} error={plan.error} onRetry={plan.retry} />
        </li>
      ) : null}
      {session.create.busy ? (
        <li className={styles.assistant}>
          <MessageMeta who="Recourse" at={null} />
          <SkeletonRows rows={4} label="Reading your request" />
        </li>
      ) : null}
      {session.create.error ? (
        <li className={styles.assistant}>
          <Banner
            tone="danger"
            role="alert"
            title={session.create.error.title}
            testId="error-banner"
            actions={
              session.create.error.retryable ? (
                <Button size="small" variant="secondary" onClick={controller.retryCreate}>
                  Try again
                </Button>
              ) : null
            }
          >
            {session.create.error.message}
            {session.create.error.retryable ? " Your message is kept here, so you can try again." : null}
          </Banner>
        </li>
      ) : null}
      {session.pollError ? (
        <li className={styles.assistant}>
          <Banner
            tone={session.pollError.retryable ? "warning" : "danger"}
            role="alert"
            title={session.pollError.retryable ? "Updates paused" : session.pollError.title}
            testId="error-banner"
            actions={
              <Button size="small" variant="secondary" onClick={controller.retryUpdates}>
                Try again
              </Button>
            }
          >
            {session.pollError.message} What you see here may be out of date.
          </Banner>
        </li>
      ) : null}
    </ol>
  );
}

function MessageMeta({ who, at }: { who: string; at: string | null }) {
  return (
    <div className={styles.meta}>
      <span className={styles.who}>{who}</span>
      {at ? (
        <time dateTime={at} className={styles.time}>
          {formatClock(at)}
        </time>
      ) : null}
    </div>
  );
}

const eventToneClass: Record<EventTone, string | undefined> = {
  neutral: styles.dotNeutral,
  accent: styles.dotAccent,
  warning: styles.dotWarning,
  danger: styles.dotDanger,
};

function EventLine({ text, tone, at }: { text: string; tone: EventTone; at: string }) {
  return (
    <div className={styles.eventLine}>
      <span className={[styles.dot, eventToneClass[tone] ?? ""].join(" ")} aria-hidden="true" />
      <span className={styles.eventText}>{text}</span>
      <time dateTime={at} className={styles.time}>
        {formatClock(at)}
      </time>
    </div>
  );
}

interface ThreadEntryProps {
  item: ThreadItem;
  grouped: boolean;
  session: CaseSession;
  caseData: CaseV1 | null;
  call: CallV1 | null;
  currentApprovalId: string | null;
  controller: ChatController;
  fixture: boolean;
  live: boolean;
  phoneHint: string | null;
  factsDirty: boolean;
  onFactsDirty: (key: string, dirty: boolean) => void;
  /** The server's resolution plan for this case (fixture: built locally). */
  plan: ResolutionPlanState;
  purpose: UiCallPurpose | null;
  onPurposeChange: (purpose: UiCallPurpose) => void;
}

function lockedReason(session: CaseSession, caseData: CaseV1, call: CallV1 | null): string | null {
  if (isOutcomeStatus(caseData.status)) return "The call is over, so these facts are now the record of what was approved.";
  if (call && call.state === "dispatch_unknown") return "Facts are locked until the uncertain call attempt is reconciled.";
  if (caseData.status === "calling" || (call && isCallActive(call))) return "Facts are locked while the call is in progress.";
  if (session.approval.busy) return "Facts are locked while the call is being approved.";
  return null;
}

function ThreadEntry(props: ThreadEntryProps) {
  const { item, grouped, session, caseData, call, currentApprovalId, controller, fixture, live, phoneHint, factsDirty, onFactsDirty, plan, purpose, onPurposeChange } = props;
  const startNewCase = () => controller.selectCase(null);
  const groupedClass = grouped ? styles.grouped : "";

  switch (item.kind) {
    case "user":
      return (
        <li className={styles.user}>
          <MessageMeta who="You" at={item.at} />
          <div className={styles.bubble}>{item.text}</div>
          {item.attachments.length > 0 ? (
            <ul className={styles.attachments} aria-label="Attached plans">
              {item.attachments.map((name) => (
                <li key={name}>
                  <FileIcon />
                  <span>{name}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      );
    case "assistant":
      return (
        <li className={[styles.assistant, groupedClass].join(" ")}>
          {grouped ? null : <MessageMeta who="Recourse" at={item.at} />}
          <p className={styles.text}>{item.text}</p>
        </li>
      );
    case "understood":
      if (!caseData) return null;
      return (
        <li className={[styles.assistant, groupedClass].join(" ")}>
          {grouped ? null : <MessageMeta who="Recourse" at={item.at} />}
          <p className={styles.text}>Here is what I understood.</p>
          <FactsCard
            key={session.reloads}
            caseData={caseData}
            fixture={fixture}
            lockedReason={lockedReason(session, caseData, call)}
            saving={session.save.busy}
            saveError={session.save.error}
            conflict={session.conflict}
            reloading={session.reload.busy}
            reloadError={session.reload.error}
            flaggedFields={session.approval.error?.kind === "missing_facts" ? session.approval.error.fieldKeys : []}
            phoneHint={phoneHint}
            onSave={controller.saveFacts}
            onReload={controller.reloadCase}
            onDirtyChange={(dirty) => onFactsDirty(session.key, dirty)}
            onStartNewCase={startNewCase}
          />
          <CaseDocuments
            caseData={caseData}
            fixture={fixture}
            packet={session.packet}
            onDownloadPacket={controller.downloadPacket}
          />
        </li>
      );
    case "approval": {
      if (!caseData) return null;
      const placed = item.callId
        ? (caseData.calls.find((candidate) => candidate.id === item.callId) ??
          (session.startedCall?.id === item.callId ? session.startedCall : null))
        : null;
      if (item.callId && !placed) return null;
      const current = item.callId === null && item.id === currentApprovalId;
      if (!placed && !current) return null;
      // The open step shows the plan the approval covers; a placed call keeps the frozen plan it ran with, folded.
      const showPlan = current || (placed !== null && plan.plan?.frozen === true && placed.authorizationId === caseData.authorization?.id);
      return (
        <li className={[styles.assistant, groupedClass].join(" ")}>
          {grouped ? null : <MessageMeta who="Recourse" at={item.at} />}
          {showPlan ? (
            <PlanCard plan={plan.plan} loading={plan.loading} error={plan.error} onRetry={plan.retry} collapsed={placed !== null} />
          ) : null}
          <ApprovalCard
            caseData={caseData}
            placedCall={placed}
            current={current}
            live={live}
            requestText={session.summary}
            {...(purpose ? { purpose } : {})}
            onPurposeChange={onPurposeChange}
            busy={session.approval.busy}
            stage={session.approval.stage}
            error={current ? session.approval.error : null}
            blockedReason={
              session.conflict
                ? "Reload the case above before approving the call."
                : factsDirty
                  ? "Save or discard your changes to the facts above before approving the call."
                  : null
            }
            onApprove={controller.approve}
            onSaveFacts={controller.saveFacts}
            onStartNewCase={startNewCase}
          />
        </li>
      );
    }
    case "event":
      return (
        <li className={styles.event}>
          <EventLine text={item.text} tone={item.tone} at={item.at} />
        </li>
      );
    case "decision": {
      const record = session.decisions[item.decisionId];
      if (!record) return null;
      return (
        <li className={styles.decision}>
          <EventLine text="The agent needs your decision" tone="warning" at={item.at} />
          <DecisionCard
            record={record}
            variant="inline"
            canAnswer={controller.capabilities?.decisions ?? false}
            onAnswer={(optionId) => controller.answerDecision(record.decision.id, optionId)}
          />
        </li>
      );
    }
    case "result": {
      if (!caseData) return null;
      const resultCall = item.callId ? (caseData.calls.find((candidate) => candidate.id === item.callId) ?? null) : null;
      const shownCall = resultCall ?? (call && call.id === item.callId ? call : null);
      const latest = item.callId === null || item.callId === call?.id;
      const { sendSummary, editSummaryDestination, resetSummary } = controller;
      return (
        <li className={[styles.assistant, groupedClass].join(" ")}>
          {grouped ? null : <MessageMeta who="Recourse" at={item.at} />}
          <ResultBlock
            caseData={caseData}
            call={shownCall}
            latest={latest}
            fixture={fixture}
            packet={session.packet}
            onDownloadPacket={controller.downloadPacket}
          />
          {latest && shownCall && hasCallOutcome(caseData, shownCall) && sendSummary && editSummaryDestination && resetSummary ? (
            <SummaryCard
              state={session.summaryShare}
              fixture={fixture}
              simulated={caseData.mode === "simulated"}
              onSend={sendSummary}
              onEdit={editSummaryDestination}
              onReset={resetSummary}
            />
          ) : null}
        </li>
      );
    }
    default: {
      const unreachable: never = item;
      return unreachable;
    }
  }
}
