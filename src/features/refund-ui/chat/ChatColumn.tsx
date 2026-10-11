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
import { AlertIcon, ChevronRightIcon, FileIcon, PhoneIcon } from "../ui/icons";
import { formatClock } from "../ui/format";
import DecisionCard from "../ui/DecisionCard";
import { caseTitle, currentCall, isCallActive, isOutcomeStatus } from "../state/call";
import CaseDocuments from "../documents/CaseDocuments";
import ActivityGraph from "../activity/ActivityGraph";
import type { CaseSessionController } from "../state/controller";
import type { CaseSession, EventTone, ThreadItem } from "../state/session";
import ApprovalCard from "./ApprovalCard";
import Composer from "./Composer";
import FactsCard from "./FactsCard";
import ResultBlock from "./ResultBlock";
import styles from "./ChatColumn.module.css";

export interface ChatColumnProps {
  controller: CaseSessionController;
  fixture: boolean;
  /** Shown under the support phone field, for example the simulated backend's number rules. */
  phoneHint: string | null;
  planCount: number;
  /** The compact call bar shown at the top when the call column is a sheet. */
  callBar: ReactNode;
  /** The metrics strip shown above the composer once a call exists. */
  metrics: ReactNode;
}

const EXAMPLES = [
  {
    text: "Get a refund for a duplicate $49.99 charge from Ridgeline Outfitters",
    title: "Recover a duplicate charge",
    detail: "Ridgeline Outfitters · $49.99 charged twice",
    icon: PhoneIcon,
    fixtureOnly: false,
  },
  {
    text: "File an insurance claim against Northwind for the water damage on Oct 3, about $1,200",
    title: "Explore an insurance claim",
    detail: "Northwind · $1,200 water damage · Fictional policy",
    icon: FileIcon,
    fixtureOnly: true,
  },
  {
    text: "Ridgeline charged me twice but I lost the receipt",
    title: "Start with missing evidence",
    detail: "A duplicate charge with a missing receipt",
    icon: AlertIcon,
    fixtureOnly: false,
  },
];

const ASSISTANT_KINDS: ReadonlySet<ThreadItem["kind"]> = new Set(["assistant", "understood", "approval", "result"]);

export default function ChatColumn({ controller, fixture, phoneHint, planCount, callBar, metrics }: ChatColumnProps) {
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
  useLayoutEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;
    if (stickToBottom.current) {
      node.scrollTop = node.scrollHeight;
    } else if (itemCount > 0) {
      setUnseen(true);
    }
  }, [itemCount]);

  // A different case starts at its newest message.
  useLayoutEffect(() => {
    stickToBottom.current = true;
    setUnseen(false);
    const node = scrollerRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [draftKey]);

  const jumpToLatest = () => {
    const node = scrollerRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    stickToBottom.current = true;
    setUnseen(false);
  };

  const chooseExample = (text: string) => {
    setDraft(text);
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(text.length, text.length);
    });
  };

  const caseData = session?.caseData ?? null;
  const placeholder = caseData
    ? "Add a note to this case…"
    : "Who charged you, what happened, and how much are you owed?";

  const hint =
    caseData
      ? "Notes stay in this browser. Edit the facts above to update the call brief."
      : fixture && planCount > 0
      ? planCount === 1
        ? "Your plan is attached when you describe an insurance claim."
        : "Your plans are attached when you describe an insurance claim."
      : "You review the facts and approve before a call starts.";

  return (
    <section className={styles.column} aria-label="Conversation">
      <h1 className={styles.srOnly}>{session ? caseTitle(caseData, session.summary) : "New case"}</h1>
      {callBar}
      <div className={styles.scroller} ref={scrollerRef} onScroll={onScroll}>
        <div className={styles.thread}>
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
              phoneHint={phoneHint}
              factsDirty={dirtyFacts[session.key] ?? false}
              onFactsDirty={reportFactsDirty}
            />
          ) : (
            <EmptyState onExample={chooseExample} planCount={planCount} fixture={fixture} />
          )}
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
        value={draft}
        onChange={setDraft}
        onSend={controller.send}
        busy={session?.create.busy ?? false}
        busyLabel="Reading your request"
        placeholder={placeholder}
        hint={hint}
        textareaRef={textareaRef}
      />
    </section>
  );
}

function EmptyState({ onExample, planCount, fixture }: { onExample: (text: string) => void; planCount: number; fixture: boolean }) {
  return (
    <div className={styles.empty}>
      <p className={styles.eyebrow}>{fixture ? "Your claims & refund assistant" : "Your refund assistant"}</p>
      <h2 className={styles.emptyTitle}>What are you owed?</h2>
      <p className={styles.emptyText}>
        {fixture
          ? "Describe a refund or explore a fictional claim. Recourse prepares the facts, calls with your approval, and keeps the outcome here."
          : "Describe a duplicate charge. Recourse prepares the facts, calls with your approval, and keeps the outcome here."}
      </p>
      <ol className={styles.steps} aria-label="How Recourse works">
        <li><span className={styles.stepNumber}>01</span><span><strong>Review the facts</strong><span>Check the details and evidence.</span></span></li>
        <li><span className={styles.stepNumber}>02</span><span><strong>Approve the call</strong><span>You choose what happens next.</span></span></li>
        <li><span className={styles.stepNumber}>03</span><span><strong>Review the outcome</strong><span>See the transcript and next steps.</span></span></li>
      </ol>
      <div className={styles.examples}>
        <div className={styles.examplesHeading}>
          <span className={styles.examplesLabel}>Start with an example</span>
          <span className={styles.exampleDisclaimer}>Fictional cases</span>
        </div>
        <ul className={styles.exampleList}>
          {EXAMPLES.filter((example) => fixture || !example.fixtureOnly).map(({ text, title, detail, icon: Icon }) => (
            <li key={text}>
              <button type="button" className={styles.example} onClick={() => onExample(text)} aria-label={`${title}. ${text}`}>
                <span className={styles.exampleIcon}><Icon /></span>
                <span className={styles.exampleContent}><strong>{title}</strong><span>{detail}</span></span>
                <span className={styles.exampleArrow}><ChevronRightIcon /></span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {fixture && planCount === 0 ? (
        <p className={styles.emptyNote}><FileIcon /> Have a policy to review? Add it under Plans.</p>
      ) : null}
    </div>
  );
}

function Thread({
  session,
  controller,
  fixture,
  phoneHint,
  factsDirty,
  onFactsDirty,
}: {
  session: CaseSession;
  controller: CaseSessionController;
  fixture: boolean;
  phoneHint: string | null;
  factsDirty: boolean;
  onFactsDirty: (key: string, dirty: boolean) => void;
}) {
  const caseData = session.caseData;
  const call = currentCall(caseData, session.startedCall);
  const lastOpenApproval = [...session.thread].reverse().find((item) => item.kind === "approval" && item.callId === null);

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
            phoneHint={phoneHint}
            factsDirty={factsDirty}
            onFactsDirty={onFactsDirty}
          />
        );
      })}
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
  controller: CaseSessionController;
  fixture: boolean;
  phoneHint: string | null;
  factsDirty: boolean;
  onFactsDirty: (key: string, dirty: boolean) => void;
}

function lockedReason(session: CaseSession, caseData: CaseV1, call: CallV1 | null): string | null {
  if (isOutcomeStatus(caseData.status)) return "The call is over, so these facts are now the record of what was approved.";
  if (call && call.state === "dispatch_unknown") return "Facts are locked until the uncertain call attempt is reconciled.";
  if (caseData.status === "calling" || (call && isCallActive(call))) return "Facts are locked while the call is in progress.";
  if (session.approval.busy) return "Facts are locked while the call is being approved.";
  return null;
}

function ThreadEntry(props: ThreadEntryProps) {
  const { item, grouped, session, caseData, call, currentApprovalId, controller, fixture, phoneHint, factsDirty, onFactsDirty } = props;
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
      return (
        <li className={[styles.assistant, groupedClass].join(" ")}>
          {grouped ? null : <MessageMeta who="Recourse" at={item.at} />}
          <ApprovalCard
            caseData={caseData}
            placedCall={placed}
            current={current}
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
      return (
        <li className={[styles.assistant, groupedClass].join(" ")}>
          {grouped ? null : <MessageMeta who="Recourse" at={item.at} />}
          <ResultBlock
            caseData={caseData}
            call={resultCall ?? (call && call.id === item.callId ? call : null)}
            latest={item.callId === null || item.callId === call?.id}
            fixture={fixture}
            packet={session.packet}
            onDownloadPacket={controller.downloadPacket}
          />
        </li>
      );
    }
    default: {
      const unreachable: never = item;
      return unreachable;
    }
  }
}
