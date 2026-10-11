"use client";

/**
 * The Recourse landing page at /welcome: a typographic launch page where rolling text is the design.
 * Mechanics ported by hand from componentry.dev (Text Morph, Velocity Scroll, Kinetic Text Reveal).
 * Tokens repeat the values of the .app block in refund-ui/RefundApp.module.css.
 */

import { type CSSProperties, Fragment, useRef } from "react";
import { CheckIcon, ChevronRightIcon } from "@/features/refund-ui/ui/icons";
import { Mono, VisuallyHidden } from "@/features/refund-ui/ui/primitives";
import {
  BAND_ROWS,
  type BandRow,
  EXPLANATION,
  FOOTER,
  HEADLINE_LEAD,
  PROOF,
  ROLLING_WORDS,
  STEPS,
  bandSentence,
} from "./content";
import { BAND_COPIES, THRESHOLD_MATRIX, usePrefersReducedMotion, useTextMorph, useVelocityRow } from "./rolling";
import styles from "./Landing.module.css";

/** Kinetic reveal: each headline word rises 20px out of a blur, 75ms after the one before it. */
const REVEAL_STAGGER_MS = 75;
const LEAD_WORDS = HEADLINE_LEAD.split(" ");

function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ");
}

const revealDelay = (index: number) => ({ "--reveal-delay": `${index * REVEAL_STAGGER_MS}ms` }) as CSSProperties;

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

/** The headline's rolling slot. Screen readers get the first word once; the layers are decoration. */
function MorphWord({ reduced }: { reduced: boolean }) {
  const morph = useTextMorph(ROLLING_WORDS, reduced);
  return (
    <span className={cx(styles.slotLine, styles.reveal)} style={revealDelay(LEAD_WORDS.length)} data-testid="landing-morph">
      <VisuallyHidden>{`${ROLLING_WORDS[0]}.`}</VisuallyHidden>
      <svg className={styles.filterDefs} aria-hidden="true" focusable="false">
        <defs>
          <filter id={morph.filterId} x="-50%" y="-50%" width="200%" height="200%" colorInterpolationFilters="sRGB">
            <feColorMatrix in="SourceGraphic" type="matrix" values={THRESHOLD_MATRIX} result="thresholded" />
            <feComposite in="SourceGraphic" in2="thresholded" operator="atop" />
          </filter>
        </defs>
      </svg>
      <span ref={morph.stageRef} className={styles.stage} aria-hidden="true">
        <span ref={morph.currentRef} className={styles.layer}>
          {morph.current}
        </span>
        <span ref={morph.nextRef} className={cx(styles.layer, styles.layerNext)}>
          {morph.next}
        </span>
      </span>
      <span className={styles.period} aria-hidden="true">
        .
      </span>
    </span>
  );
}

/** One band row: the sentence repeated, rolling on scroll velocity. One readable copy for assistive tech. */
function VelocityRow({ row, reduced }: { row: BandRow; reduced: boolean }) {
  const trackRef = useRef<HTMLDivElement>(null);
  useVelocityRow(trackRef, row.velocity, reduced);
  return (
    <div className={styles.row}>
      <VisuallyHidden>{bandSentence(row)}</VisuallyHidden>
      <div ref={trackRef} className={styles.track} aria-hidden="true">
        {Array.from({ length: BAND_COPIES }, (_, i) => (
          <span key={i} className={styles.copy}>
            {row.lead}
            <span className={styles.accent}>{row.accent}</span>
            <span className={styles.sep}>
              <CheckIcon />
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

export default function LandingPage() {
  const reduced = usePrefersReducedMotion();
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={cx(styles.container, styles.headerInner)}>
          <a className={styles.home} href="/welcome" aria-label="Recourse home">
            <Wordmark />
          </a>
          <a className={styles.textLink} href="/">
            Open the app
          </a>
        </div>
      </header>

      <main className={styles.main}>
        <section className={cx(styles.container, styles.hero)} aria-labelledby="landing-title">
          <h1 id="landing-title" className={styles.headline}>
            <span className={styles.leadLine}>
              {LEAD_WORDS.map((word, i) => (
                <Fragment key={word}>
                  {i > 0 ? " " : null}
                  <span className={styles.reveal} style={revealDelay(i)}>
                    {word}
                  </span>
                </Fragment>
              ))}
            </span>{" "}
            <MorphWord reduced={reduced} />
          </h1>
          <p className={styles.explanation}>{EXPLANATION.join(" ")}</p>
          <div className={styles.actions}>
            <a className={styles.primary} href="/">
              Start a case
            </a>
            <a className={styles.demoLink} href="/?api=fixture">
              See a demo case
              <ChevronRightIcon />
            </a>
          </div>
        </section>

        <div className={styles.band} data-testid="landing-band">
          {BAND_ROWS.map((row) => (
            <VelocityRow key={row.accent} row={row} reduced={reduced} />
          ))}
        </div>

        <div className={styles.container}>
          <ol className={styles.steps} aria-label="How it works">
            {STEPS.map((step, i) => (
              <li key={step.title} className={styles.step}>
                <span className={styles.stepNumber}>{String(i + 1).padStart(2, "0")}</span>
                <span className={styles.stepTitle}>{step.title}</span>
                <span className={styles.stepBody}>{step.body}</span>
              </li>
            ))}
          </ol>
          <p className={styles.proof}>
            <span className={styles.proofIcon}>
              <CheckIcon />
            </span>
            <span>
              {PROOF.lead} <Mono>{PROOF.amount}</Mono> {PROOF.tail}
            </span>
          </p>
        </div>
      </main>

      <footer className={styles.footer}>
        <p className={cx(styles.container, styles.footerInner)}>{FOOTER}</p>
      </footer>
    </div>
  );
}
