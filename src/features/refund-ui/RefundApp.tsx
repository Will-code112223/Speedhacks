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
 * The API mode is read from the URL (?api=fixture or ?api=http, default http),
 * so the shell waits for the browser before rendering the workspace.
 */

import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import type { Mode } from "../../contracts/case";
import { detectApiMode } from "./api/client";
import { setAccessPrompt, submitAccessCode } from "./api/http";
import type { ApiMode } from "./api/types";
import CallBar from "./call/CallBar";
import CallScreen from "./call/CallScreen";
import ChatColumn from "./chat/ChatColumn";
import MetricsStrip from "./metrics/MetricsStrip";
import PlansManager from "./plans/PlansManager";
import { usePlans, type PlansController } from "./plans/usePlans";
import Rail from "./rail/Rail";
import { useDocumentTitle, useLocationSearch, useMediaQuery } from "./state/browser";
import { caseTitle } from "./state/call";
import type { CaseSessionController } from "./state/controller";
import { decisionForCallScreen, type CaseSession } from "./state/session";
import { useCaseSession } from "./state/useCaseSession";
import { CloseIcon, MenuIcon } from "./ui/icons";
import { Banner, Button, Field, SkeletonRows, VisuallyHidden } from "./ui/primitives";
import styles from "./RefundApp.module.css";

export interface RefundAppProps {
  /** Server mode from REFUND_MODE; individual call records carry their provenance. */
  serverMode: Mode;
}

export default function RefundApp({ serverMode }: RefundAppProps) {
  const search = useLocationSearch();
  const plans = usePlans();
  if (search === null || plans.status === "loading") return <BootShell />;
  const apiMode = detectApiMode(search, "http");
  return <Workspace key={apiMode} apiMode={apiMode} serverMode={serverMode} plans={plans} />;
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

type RunMode = "live" | "simulated" | "fixture";

/** Fixture mode never reaches the server; otherwise the server's REFUND_MODE decides. */
function runModeFor(apiMode: ApiMode, serverMode: Mode): RunMode {
  if (apiMode === "fixture") return "fixture";
  return serverMode === "live" ? "live" : "simulated";
}

const RUN_MODE_LABELS: Record<RunMode, { label: string; title: string }> = {
  live: { label: "Live", title: "Live: approved calls dial real phone numbers" },
  simulated: { label: "Simulated", title: "Simulated: the server simulates calls, no phone is dialed" },
  fixture: { label: "Fixture", title: "Fixture: a scripted demo in this browser, no server" },
};

/** Always visible in the header, so nobody mistakes a real call for a demo or the other way round. */
function ModeBadge({ mode }: { mode: RunMode }) {
  const { label, title } = RUN_MODE_LABELS[mode];
  return (
    <span className={[styles.modeBadge, styles[`mode_${mode}`]].join(" ")} title={title} data-testid="mode-badge">
      <span className={styles.modeDot} aria-hidden="true" />
      <VisuallyHidden>Mode: </VisuallyHidden>
      {label}
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
// Access code (APP_ACCESS_CODE on a hosted server)
// ---------------------------------------------------------------------------

/**
 * Hidden until a request answers 401 ACCESS_REQUIRED. The http client then waits on
 * this prompt; a valid code sets the server's httpOnly cookie and the request is retried.
 */
function AccessCodePrompt() {
  const [waiters, setWaiters] = useState<(() => void)[]>([]);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setAccessPrompt(() => new Promise<void>((resolve) => setWaiters((current) => [...current, resolve])));
    return () => setAccessPrompt(null);
  }, []);

  if (waiters.length === 0) return null;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || code.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await submitAccessCode(code);
      if (result === "wrong") {
        setError("That access code is not correct.");
        return;
      }
      setCode("");
      for (const resolve of waiters) resolve();
      setWaiters([]);
    } catch {
      setError("The server could not be reached. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.accessGate}>
      <Banner tone="accent" title="Access code required" testId="access-code-prompt">
        <form className={styles.accessForm} onSubmit={submit}>
          <Field
            label="Access code"
            type="password"
            autoComplete="current-password"
            value={code}
            error={error}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setCode(e.target.value)}
            autoFocus
          />
          <Button type="submit" variant="primary" busy={busy} busyLabel="Checking">
            Continue
          </Button>
        </form>
      </Banner>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

type View = "chat" | "plans";

interface WorkspaceProps {
  apiMode: ApiMode;
  serverMode: Mode;
  plans: PlansController;
}

function Workspace({ apiMode, serverMode, plans }: WorkspaceProps) {
  const [view, setView] = useState<View>("chat");
  const onboarding = !plans.onboarded;
  const controller = useCaseSession({ apiMode, plans: plans.plans, measuring: !onboarding && view === "chat" });
  const wide = useMediaQuery("(min-width: 1024px)");
  const narrow = useMediaQuery("(max-width: 767px)");

  const railId = useId();
  const menuButtonId = useId();
  const sheetTitleId = useId();
  const [railOpen, setRailOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  const active = controller.active;
  const call = controller.call;
  const caseData = active?.caseData ?? null;
  const hasCall = active !== null && caseData !== null && call !== null;
  const showCallColumn = hasCall && wide;
  const showSheet = hasCall && !wide && sheetOpen && view === "chat";
  const railOverlay = narrow && railOpen && !onboarding;

  // A call placed from this tab opens the call sheet on narrow screens.
  const startedCallId = active?.startedCall?.id ?? null;
  useEffect(() => {
    if (startedCallId !== null) setSheetOpen(true);
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
    controller.selectCase(null);
    openChat();
  };
  const selectCase = (key: string) => {
    controller.selectCase(key);
    openChat();
  };
  const managePlans = () => {
    setView("plans");
    setSheetOpen(false);
    if (railOpen) closeRail();
  };

  const fixture = apiMode === "fixture";
  const runMode = runModeFor(apiMode, serverMode);
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
          setSheetOpen(true);
        }}
      />
    ) : null;

  const metrics = hasCall ? <MetricsStrip activeMs={controller.activeMs} live={controller.live} /> : null;

  return (
    <div className={styles.app}>
      <header className={styles.header}>
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
          <div className={styles.headerRight}>
            <ModeBadge mode={runMode} />
          </div>
        </div>
      </header>
      <AccessCodePrompt />

      {onboarding ? (
        <main className={styles.focused}>
          <PlansManager plans={plans} mode="onboarding" onDone={plans.completeOnboarding} />
        </main>
      ) : (
        <div className={[styles.body, showCallColumn ? styles.bodyWithCall : ""].join(" ")}>
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
                live={runMode === "live"}
                phoneHint={null}
                planCount={plans.plans.length}
                callBar={callBar}
                metrics={metrics}
              />
            )}
          </main>
          {showCallColumn ? (
            <aside className={styles.callColumn} aria-label="Call">
              {callScreen()}
            </aside>
          ) : null}
        </div>
      )}

      {showSheet ? (
        <CallSheet titleId={sheetTitleId} onClose={closeSheet}>
          {callScreen(sheetTitleId)}
        </CallSheet>
      ) : null}

      <Announcer controller={controller} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Call sheet (under 1024px)
// ---------------------------------------------------------------------------

/** The header's demo panel: a disclosure that also closes on Escape and on a pointer press outside it. */
function CallSheet({ titleId, onClose, children }: { titleId: string; onClose: () => void; children: ReactNode }) {
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
      <div className={styles.sheet} role="dialog" aria-labelledby={titleId} ref={panelRef} tabIndex={-1}>
        <div className={styles.sheetHeader}>
          <h2 id={titleId} className={styles.sheetTitle}>
            Call
          </h2>
          <Button variant="ghost" className={styles.iconButton} aria-label="Close call" onClick={onClose}>
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
