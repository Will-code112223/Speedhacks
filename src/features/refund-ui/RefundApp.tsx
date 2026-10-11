"use client";

/**
 * Recourse: get back what you are owed. Default export mounted by
 * src/app/page.tsx with the server's REFUND_MODE.
 *
 * Layout: a header; a rail for cases and plans (240px); the chat; and the call
 * column (360px) while the case on screen has a call. Under 1024px the call is
 * a sheet over the chat; under 768px the rail opens from a menu button. Tokens
 * live in RefundApp.module.css; see design.md.
 *
 * Runtime requests always use the real HTTP API. Test fixtures are not a
 * user-selectable runtime mode.
 */

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { Mode } from "../../contracts/case";
import type { WorkflowAction } from "../../contracts/workflow";
import BrowserPanel from "./browser/BrowserPanel";
import WorkflowCallPanel from "./workflow/WorkflowCallPanel";
import CallBar from "./call/CallBar";
import CallScreen from "./call/CallScreen";
import ChatColumn from "./chat/ChatColumn";
import MetricsStrip from "./metrics/MetricsStrip";
import PlansManager from "./plans/PlansManager";
import { usePlans, type PlansController } from "./plans/usePlans";
import Rail from "./rail/Rail";
import { useDocumentTitle, useMediaQuery } from "./state/browser";
import { caseTitle } from "./state/call";
import type { CaseSessionController } from "./state/controller";
import { decisionForCallScreen, type CaseSession } from "./state/session";
import { useCaseSession } from "./state/useCaseSession";
import { CloseIcon, MenuIcon } from "./ui/icons";
import { Button, SkeletonRows } from "./ui/primitives";
import styles from "./RefundApp.module.css";

export interface RefundAppProps {
  /** Server mode from REFUND_MODE; individual call records carry their provenance. */
  serverMode: Mode;
}

export default function RefundApp(_props: RefundAppProps) {
  const plans = usePlans();
  if (plans.status === "loading") return <BootShell />;
  return <Workspace plans={plans} />;
}

// ---------------------------------------------------------------------------
// Header pieces
// ---------------------------------------------------------------------------

function Wordmark() {
  return (
    <span className={styles.brand}>
      <svg className={styles.brandMark} viewBox="0 0 28 28" fill="none" aria-hidden="true">
        <path d="M5 22V6h9a6 6 0 0 1 0 12H8M15 18l7 5" stroke="currentColor" strokeWidth="2.5" />
        <path d="M1 6V1h5M22 1h5v5M27 22v5h-5M6 27H1v-5" stroke="currentColor" />
      </svg>
      <span className={styles.wordmark}>Recourse</span>
    </span>
  );
}

/** Painted at once on the server and while the browser state loads, so nothing jumps. */
function BootShell() {
  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Wordmark />
        </div>
      </header>
      <div className={styles.boot}>
        <div className={styles.bootInner}>
          <SkeletonRows rows={4} label="Loading Recourse" />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

type View = "chat" | "plans";

interface WorkspaceProps {
  plans: PlansController;
}

function Workspace({ plans }: WorkspaceProps) {
  const [view, setView] = useState<View>("chat");
  const onboarding = !plans.onboarded;
  const controller = useCaseSession({ apiMode: "http", plans: plans.plans, measuring: !onboarding && view === "chat" });
  const wide = useMediaQuery("(min-width: 1024px)");
  const narrow = useMediaQuery("(max-width: 767px)");

  const railId = useId();
  const menuButtonId = useId();
  const sheetTitleId = useId();
  const [railOpen, setRailOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [browserPreset, setBrowserPreset] = useState<{ caseId: string; revision: number; action: WorkflowAction } | null>(null);
  const [callPreset, setCallPreset] = useState<{ caseId: string; actionId: string } | null>(null);
  const [sideTab, setSideTab] = useState<"browser" | "call">("browser");

  const active = controller.active;
  const call = controller.call;
  const caseData = active?.caseData ?? null;
  const intakeKind = controller.workflow?.workflow?.kind;
  const callsSupported = caseData?.mode !== "live" || (controller.workflow?.workflow?.analysisStatus === "complete" && controller.workflow.workflow.caseRevision === caseData.revision && (intakeKind === "refund" || intakeKind === "duplicate_charge"));
  const hasCall = active !== null && caseData !== null && call !== null;
  const hasBrowserCase = caseData?.mode === "live";
  const selectedTool = hasBrowserCase ? sideTab : "call";
  const hasTool = hasBrowserCase || hasCall;
  const showToolColumn = hasTool && wide && view === "chat";
  const showSheet = hasTool && !wide && sheetOpen && view === "chat";
  const railOverlay = narrow && railOpen && !onboarding;
  const defaultedInsuranceCase = useRef<string | null>(null);

  // Insurance starts with its information call. Later analysis and evidence
  // revisions must not switch away from a browser task the person selected.
  useEffect(() => {
    if (!caseData) { defaultedInsuranceCase.current = null; return; }
    if (intakeKind === "auto_insurance" && defaultedInsuranceCase.current !== caseData.id) {
      defaultedInsuranceCase.current = caseData.id;
      setSideTab("call");
    }
  }, [caseData?.id, intakeKind]);

  const requestEvidence = () => {
    setSheetOpen(false);
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>("[data-evidence-input]");
      input?.scrollIntoView({ block: "center", behavior: "smooth" });
      input?.focus();
    });
  };

  // A call placed from this tab opens the call sheet on narrow screens.
  const startedCallId = active?.startedCall?.id ?? null;
  useEffect(() => {
    if (startedCallId !== null) { setSideTab("call"); setSheetOpen(true); }
  }, [startedCallId]);

  const closeRail = useCallback(() => {
    setRailOpen(false);
    document.getElementById(menuButtonId)?.focus();
  }, [menuButtonId]);
  const closeSheet = useCallback(() => setSheetOpen(false), []);
  const toggleRail = () => {
    if (railOpen) {
      closeRail();
      return;
    }
    setSheetOpen(false);
    setRailOpen(true);
  };

  // Escape closes whichever overlay is open.
  useEffect(() => {
    if (!showSheet && !railOverlay) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (showSheet) closeSheet();
      else closeRail();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showSheet, railOverlay, closeSheet, closeRail]);

  // The opened rail takes focus, so keyboard users land inside it.
  useEffect(() => {
    if (!railOverlay) return;
    document.getElementById(railId)?.querySelector<HTMLElement>("button")?.focus();
  }, [railOverlay, railId]);

  const pending = controller.pendingDecision;
  useDocumentTitle(pending ? `Needs you: ${pending.decision.question}` : null);

  // Leaving the rail menu returns focus to the button that opened it.
  const openChat = () => {
    setView("chat");
    if (railOpen) closeRail();
  };
  const startNewCase = () => {
    defaultedInsuranceCase.current = null;
    controller.selectCase(null);
    setSheetOpen(false);
    setSideTab("browser");
    openChat();
  };
  const selectCase = (key: string) => {
    defaultedInsuranceCase.current = null;
    controller.selectCase(key);
    setSheetOpen(false);
    setSideTab(key === active?.key && intakeKind === "auto_insurance" ? "call" : "browser");
    openChat();
  };
  const managePlans = () => {
    setView("plans");
    setSheetOpen(false);
    if (railOpen) closeRail();
  };

  const fixture = false;
  const crumb = onboarding ? null : view === "plans" ? "Plans" : active ? caseTitle(caseData, active.summary) : null;

  const callScreen = (headingId?: string) =>
    hasCall && active && caseData && call ? (
      <CallScreen
        caseData={caseData}
        call={call}
        live={controller.live}
        liveError={controller.liveError}
        capabilities={controller.capabilities}
        fixture={fixture}
        decision={decisionForCallScreen(active, call.id)}
        join={active.join}
        handedBack={controller.live ? Boolean(active.handedBack[controller.live.callId]) : false}
        headingId={headingId}
        onAnswer={controller.answerDecision}
        onDismissDecision={controller.dismissDecision}
        onStepIn={controller.stepIn}
        onLeave={controller.leaveCall}
        onRetryUpdates={controller.retryUpdates}
      />
    ) : null;

  const callBar =
    hasCall && !wide && caseData && call ? (
      <CallBar
        caseData={caseData}
        call={call}
        live={controller.live}
        needsAnswer={pending !== null}
        onOpen={() => {
          setRailOpen(false);
          setSideTab("call");
          setSheetOpen(true);
        }}
      />
    ) : null;

  const metrics = hasCall ? <MetricsStrip activeMs={controller.activeMs} live={controller.live} /> : null;
  const toolContent = <>
    <div className={styles.toolTabs} role="group" aria-label="Case tools">
      {hasBrowserCase ? <Button variant="ghost" size="small" aria-pressed={selectedTool === "browser"} onClick={() => setSideTab("browser")}>Browser</Button> : null}
      {hasTool ? <Button variant="ghost" size="small" aria-pressed={selectedTool === "call"} onClick={() => setSideTab("call")}>Call support</Button> : null}
    </div>
    {selectedTool === "browser" && hasBrowserCase && caseData ? <BrowserPanel preset={browserPreset?.caseId === caseData.id && browserPreset.revision === caseData.revision ? browserPreset.action.browser ?? undefined : undefined} key={caseData.id} caseData={caseData} visible={view === "chat" && (wide || sheetOpen)} /> : hasCall ? callScreen() : hasBrowserCase && caseData ? <WorkflowCallPanel key={caseData.id} caseData={caseData} workflow={controller.workflow?.workflow ?? null} actionId={callPreset?.caseId === caseData.id ? callPreset.actionId : undefined} visible={view === "chat" && (wide || sheetOpen)} onRequestEvidence={requestEvidence} /> : <div className={styles.callGuide}><h2>Call support</h2><p>{callsSupported ? "Review the contact and request in chat, then approve the call when you are ready." : intakeKind === "auto_insurance" ? "Your call plans are in the action list. Calling additional insurance contacts requires a separate recipient-specific authorization flow." : "Finish preparing the case before reviewing its call contact and request."}</p></div>}
  </>;


  return (
    <div className={styles.app}>
      <header className={styles.header} inert={showSheet || undefined}>
        <div className={styles.headerInner}>
          {!onboarding ? (
            <Button
              id={menuButtonId}
              variant="ghost"
              className={[styles.menuButton, styles.iconButton].join(" ")}
              aria-label={railOpen ? "Close cases and plans" : "Open cases and plans"}
              aria-expanded={railOpen}
              aria-controls={railId}
              onClick={toggleRail}
            >
              {railOpen ? <CloseIcon /> : <MenuIcon />}
            </Button>
          ) : null}
          <Wordmark />
          {crumb ? (
            <span className={styles.crumb}>
              <span className={styles.crumbSeparator} aria-hidden="true">
                /
              </span>
              <span className={styles.caseName} title={crumb}>
                {crumb}
              </span>
            </span>
          ) : null}
          {!onboarding && hasBrowserCase && view === "chat" ? <div className={styles.headerRight}><Button size="small" onClick={() => { setRailOpen(false); setSideTab("browser"); setSheetOpen(true); }}>Browser task</Button></div> : null}
        </div>
      </header>

      {onboarding ? (
        <main className={styles.focused}>
          <PlansManager plans={plans} mode="onboarding" onDone={plans.completeOnboarding} />
        </main>
      ) : (
        <div className={[styles.body, showToolColumn ? selectedTool === "browser" ? styles.bodyWithBrowser : styles.bodyWithCall : ""].join(" ")}>
          {railOverlay ? <div className={styles.scrim} onClick={closeRail} aria-hidden="true" /> : null}
          <nav
            id={railId}
            className={[styles.rail, railOpen ? "" : styles.railClosed].join(" ")}
            aria-label="Cases and plans"
            inert={showSheet || undefined}
          >
            <Rail
              sessions={controller.sessions}
              activeKey={active?.key ?? null}
              view={view}
              plans={plans.plans}
              onNewCase={startNewCase}
              onSelectCase={selectCase}
              onManagePlans={managePlans}
            />
          </nav>
          <main className={styles.main} inert={showSheet || railOverlay || undefined}>
            {view === "plans" ? (
              <PlansManager plans={plans} mode="manage" onDone={openChat} />
            ) : (
              <ChatColumn
                controller={controller}
                fixture={fixture}
                phoneHint={null}
                allowCallApproval={Boolean(callsSupported && (selectedTool === "call" || hasCall))}
                onWorkflowAction={action => { if (!caseData) return; if (action.type === "browser" && action.browser) { setBrowserPreset({ caseId: caseData.id, revision: caseData.revision, action }); setSideTab("browser"); } else if (action.type === "call" && action.call) { setCallPreset({ caseId: caseData.id, actionId: action.id }); setSideTab("call"); } else return; setSheetOpen(true); setRailOpen(false); }}
                planCount={plans.plans.length}
                callBar={callBar}
                metrics={metrics}
              />
            )}
          </main>
          {showToolColumn ? (
            <aside className={styles.callColumn} aria-label="Case tools">
              {toolContent}
            </aside>
          ) : null}
        </div>
      )}

      {showSheet ? (
        <ActionSheet titleId={sheetTitleId} title={selectedTool === "browser" ? "Browser task" : "Call"} browser={selectedTool === "browser"} onClose={closeSheet}>
          {toolContent}
        </ActionSheet>
      ) : null}

      <Announcer controller={controller} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Call sheet (under 1024px)
// ---------------------------------------------------------------------------

function ActionSheet({ titleId, title, browser, onClose, children }: { titleId: string; title: string; browser: boolean; onClose: () => void; children: ReactNode }) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Focus moves into the sheet and returns where it was when the sheet closes.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    return () => {
      if (previous && previous.isConnected) previous.focus();
    };
  }, []);

  return (
    <>
      <div className={styles.scrim} onClick={onClose} aria-hidden="true" />
      <div className={[styles.sheet, browser ? styles.browserSheet : ""].join(" ")} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={panelRef} tabIndex={-1} onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]') ?? []);
        const first = controls[0]; const last = controls.at(-1);
        if (!first || !last) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
        <div className={styles.sheetHeader}>
          <h2 id={titleId} className={styles.sheetTitle}>
            {title}
          </h2>
          <Button variant="ghost" className={styles.iconButton} aria-label={`Close ${title.toLowerCase()}`} onClick={onClose}>
            <CloseIcon />
          </Button>
        </div>
        <div className={styles.sheetBody}>{children}</div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Screen reader announcements
// ---------------------------------------------------------------------------

/** The newest call event line of the case on screen. */
function latestEvent(session: CaseSession | null): { id: string; text: string } | null {
  if (!session) return null;
  for (let index = session.thread.length - 1; index >= 0; index -= 1) {
    const item = session.thread[index];
    if (item?.kind === "event") return { id: item.id, text: item.text };
  }
  return null;
}

/**
 * Speaks call progress politely and a new decision assertively. Switching
 * cases sets a new baseline instead of reading out that case's history.
 */
function Announcer({ controller }: { controller: CaseSessionController }) {
  const session = controller.active;
  const event = latestEvent(session);
  const [spoken, setSpoken] = useState<{ key: string | null; eventId: string | null; text: string }>({
    key: session?.key ?? null,
    eventId: event?.id ?? null,
    text: "",
  });

  const key = session?.key ?? null;
  const eventId = event?.id ?? null;
  if (spoken.key !== key) {
    setSpoken({ key, eventId, text: "" });
  } else if (eventId !== spoken.eventId) {
    setSpoken({ key, eventId, text: event?.text ?? "" });
  }

  const question = controller.pendingDecision?.decision.question ?? null;
  return (
    <>
      <div className={styles.srOnly} role="status" aria-live="polite">
        {spoken.text}
      </div>
      <div className={styles.srOnly} aria-live="assertive">
        {question ? `The agent needs your decision: ${question}` : ""}
      </div>
    </>
  );
}
