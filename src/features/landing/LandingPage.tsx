"use client";

/**
 * The Recourse landing page at /welcome. One claim, one proof: the hero is a
 * code-native replica of the app's call column that runs a simulated call.
 * Tokens repeat the values of the .app block in refund-ui/RefundApp.module.css.
 */

import type { CSSProperties } from "react";
import { formatDuration } from "@/features/refund-ui/ui/format";
import { CheckIcon, PhoneIcon } from "@/features/refund-ui/ui/icons";
import { Button, Mono, VisuallyHidden } from "@/features/refund-ui/ui/primitives";
import { LINES, MERCHANT, OUTCOME_FIGURE, PLAN_STEPS, REFERENCE, typedChars, useDemoCall } from "./demo";
import styles from "./Landing.module.css";

export const HEADLINE_LINES = ["Owed money?", "Recourse makes the call."] as const;
export const HEADLINE = HEADLINE_LINES.join(" ");
export const EXPLANATION = [
  "Recourse is an AI agent that phones a merchant or insurer to get your money back.",
  "You approve the call before anything is dialed, you can step in at any time, and every outcome comes with a transcript.",
] as const;

const STEPS = [
  { title: "Review the facts", body: "Check the details and evidence." },
  { title: "Approve the call", body: "Nothing is dialed until you approve." },
  { title: "Recourse makes the call", body: "Listen in or step in. The outcome and transcript are kept." },
] as const;

function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ");
}

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

const DIGITS = "0123456789";
const LETTERS = "abcdefghijklmnopqrstuvwxyz";
/** Glyphs shown before the real one; the CSS steps(4) matches it. */
const FLAP_DECOYS = 4;

/** The glyphs a split-flap cell passes through before it lands on `ch`. Deterministic, so server and client agree. */
function flapGlyphs(ch: string, index: number): string[] {
  const pool = /\d/.test(ch) ? DIGITS : /[a-z]/.test(ch) ? LETTERS : "$.#";
  const glyphs: string[] = [];
  for (let k = 0; k < FLAP_DECOYS; k += 1) glyphs.push(pool[(index * 7 + k * 3 + 5) % pool.length] ?? ch);
  glyphs.push(ch);
  return glyphs;
}

function SplitFlap({ text }: { text: string }) {
  return (
    <span className={styles.flap}>
      {[...text].map((ch, i) => {
        if (ch === " ") return <span key={i} className={styles.flapSpace} />;
        const glyphs = flapGlyphs(ch, i);
        const vars = { "--n": glyphs.length, "--i": i } as CSSProperties;
        return (
          <span key={i} className={styles.flapCell}>
            <span className={styles.flapStrip} style={vars}>
              {glyphs.map((g, k) => (
                <span key={k}>{g}</span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}

function DemoCall() {
  const { state, elapsedMs, run } = useDemoCall();
  const live = state.phase !== "Call ended";
  const seconds = Math.floor((state.endedAtMs ?? elapsedMs) / 1000);
  const current = Math.min(state.step, PLAN_STEPS.length - 1);
  const lastLine = state.lineStarts.length - 1;
  const dotClass = !live ? styles.dotEnded : state.phase === "On hold" ? styles.dotHold : styles.dotLive;

  return (
    <div className={styles.demoWrap} data-testid="landing-demo">
      <VisuallyHidden>
        A sample call, simulated: Recourse phones {MERCHANT} about a duplicate $49.99 charge, follows a five-step
        plan, and records an approved $49.99 refund with reference {REFERENCE} and the transcript.
      </VisuallyHidden>
      <div className={styles.demo} aria-hidden="true" inert>
        <div className={styles.identity}>
          <div className={styles.identityTop}>
            <p className={styles.status}>
              <span key={state.phase} className={cx(styles.dot, dotClass)} />
              <span key={`${state.phase}-label`} className={styles.statusWord}>
                {state.phase}
              </span>
            </p>
            <span className={styles.simTag}>Simulated</span>
          </div>
          <p className={styles.name}>{MERCHANT}</p>
        </div>

        <div className={styles.clock}>
          <span className={cx(styles.timer, !live && styles.timerEnded)}>{formatDuration(seconds)}</span>
          <span className={cx(styles.badge, state.counterpart && styles.badgeIn)}>
            <span className={styles.badgeDot} />
            {live ? "Talking to: a person" : "Spoke with: a person"}
          </span>
        </div>

        <div className={styles.plan}>
          <p className={styles.planNow}>
            {live ? `Step ${current + 1} of ${PLAN_STEPS.length} - ${PLAN_STEPS[current]}` : "All 5 steps done"}
          </p>
          <div className={styles.planBar}>
            {PLAN_STEPS.map((step, i) => (
              <span
                key={step}
                className={cx(styles.segment, i < state.step && styles.segmentDone, i === state.step && styles.segmentNow)}
              />
            ))}
          </div>
          <ol className={styles.planList}>
            {PLAN_STEPS.map((step, i) => (
              <li
                key={step}
                className={cx(styles.planItem, i < state.step && styles.planDone, i === state.step && styles.planNowItem)}
              >
                <span className={styles.planMark}>
                  <span className={styles.planNumber}>{i + 1}</span>
                  <span className={styles.planTick}>
                    <CheckIcon />
                  </span>
                </span>
                <span className={styles.planTitle}>{step}</span>
              </li>
            ))}
          </ol>
        </div>

        <div className={styles.transcript}>
          <p className={styles.eyebrow}>Transcript</p>
          <ol className={styles.lines}>
            {LINES.map((line, i) => {
              const typed = typedChars(state, i, elapsedMs);
              const started = state.lineStarts[i] !== undefined;
              return (
                <li key={line.text} className={cx(styles.line, started && styles.lineIn)}>
                  <span className={styles.speaker}>{line.speaker}</span>
                  <span className={styles.lineText}>
                    {line.text.slice(0, typed)}
                    {live && i === lastLine ? <span className={styles.cursor} /> : null}
                    <span className={styles.untyped}>{line.text.slice(typed)}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        </div>

        <div className={styles.foot}>
          <div className={cx(styles.footLayer, live && styles.footLayerIn)}>
            <Button variant="secondary" size="small" tabIndex={-1}>
              <PhoneIcon />
              Step in now
            </Button>
            <span className={styles.footNote}>The agent pauses while you talk.</span>
          </div>
          <div className={cx(styles.footLayer, !live && styles.footLayerIn)}>
            <p className={styles.outcome}>
              <CheckIcon />
              <span>Approved -</span>
              {!live ? <SplitFlap key={run} text={OUTCOME_FIGURE} /> : <span className={styles.flapPlaceholder} />}
            </p>
            <p className={styles.footNote}>
              Reference <Mono>{REFERENCE}</Mono>. Transcript saved to the case.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LandingPage() {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <a className={styles.home} href="/welcome" aria-label="Recourse home">
            <Wordmark />
          </a>
          <a className={styles.textLink} href="/">
            Open the app
          </a>
        </div>
      </header>

      <main className={styles.main}>
        <section className={styles.hero} aria-labelledby="landing-title">
          <div className={styles.copy}>
            <h1 id="landing-title" className={styles.headline}>
              <span>{HEADLINE_LINES[0]}</span> <span>{HEADLINE_LINES[1]}</span>
            </h1>
            <p className={styles.explanation}>{EXPLANATION.join(" ")}</p>
            <div className={styles.actions}>
              <a className={styles.primary} href="/">
                Start a case
              </a>
              <a className={styles.textLink} href="/?api=fixture">
                See a demo case
              </a>
            </div>
          </div>
          <DemoCall />
        </section>

        <ol className={styles.steps} aria-label="How it works">
          {STEPS.map((step, i) => (
            <li key={step.title} className={styles.step}>
              <span className={styles.stepNumber}>{String(i + 1).padStart(2, "0")}</span>
              <span className={styles.stepTitle}>{step.title}</span>
              <span className={styles.stepBody}>{step.body}</span>
            </li>
          ))}
        </ol>

        <p className={styles.trust}>
          You approve before any call. You can step in at any time. Every outcome comes with its transcript.
        </p>
      </main>

      <footer className={styles.footer}>
        <p className={styles.footerInner}>Built at SpeedHacks, San Francisco, October 11, 2026. Demo calls are simulated.</p>
      </footer>
    </div>
  );
}
