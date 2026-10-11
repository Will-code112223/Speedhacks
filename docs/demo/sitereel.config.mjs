/**
 * sitereel 0.2.0 tour for the submission demo video. Commands: docs/demo/README.md.
 *
 * It drives the fixture flow at 1920x1080 from start to finish: onboarding, two plan
 * PDFs, the claim request, the facts card, approval, the live call (counterpart badge,
 * mid-call decision), the outcome and its transcript.
 *
 * Every wait has a timeout and the whole tour has a hard budget below the five minute
 * video limit. A step that cannot finish stops the run with "FAILED: Demo step N/M ..."
 * and a screenshot in docs/demo/out/flow-failure.png, instead of hanging or recording
 * a broken take.
 *
 * What this file relies on, read from the sitereel 0.2.0 sources (src/record.mjs, src/actions.mjs):
 * - flow({ page, base, device, mobile, viewport, helpers, progress }) runs after sitereel
 *   opened `base`, waited for load and tidied the page (Next.js dev overlay hidden).
 * - helpers: sleep(ms), smoothScroll(px, ms), scrollThrough(opts), scrollToTop(), glide(target),
 *   click(target), type(target, text, msPerKey). A target is a selector or a Playwright locator.
 *   glide and click give up after 15 s.
 * - progress is an object, not a function: progress.set(fraction, detail) and progress.log(line).
 * - The page's default timeout is 30 s, and homeDwell only applies to the built-in tour.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSamples } from './make-samples.mjs';

const DEMO_URL = 'http://localhost:3000/?api=fixture';
const OUT_DIR = fileURLToPath(new URL('./out/', import.meta.url));

const CLAIM_REQUEST =
  'File a claim with Northwind Mutual for the water damage in my kitchen on October 3, about $1,200.';

/** Dwell times and typing speed in ms. Tune them to the voice-over in docs/SUBMISSION.md section 7. */
const PACE = {
  onboarding: 2000, // the empty onboarding screen before anything moves
  plansAdded: 1500, // the two plan rows appear before Continue
  keystroke: 75, // per character, about 7 s for the request (sitereel's default is 55)
  factsCard: 3000, // read what the assistant understood
  badgeFlip: 1500, // the flipped counterpart badge before the cursor moves to the step-in control
  decision: 2000, // read the prompt before accepting
  outcome: 2000, // the outcome card before the transcript opens
  transcriptScroll: 320, // px to scroll once the transcript is open
  end: 4000, // the final frame
};

/** Upper bound for each wait in ms. Running out stops the run with an error. */
const TIMEOUTS = {
  firstScreen: 20000, // onboarding after the first page load
  ui: 15000, // the UI reacting to a click or keystroke
  factsCard: 30000,
  callScreen: 30000,
  counterpart: 40000, // the badge reads "Automated ..."
  decision: 40000,
  outcome: 60000,
};

/** Hard stop, measured from the start of the video: room for the 4:40 script, still under five minutes. */
const MAX_VIDEO_MS = (4 * 60 + 50) * 1000;

/**
 * Builds the tour. The default export below uses the values above; the overrides
 * exist so the same tour can be dry-run quickly against a stub page.
 */
export function createFlow({ pace = {}, timeouts = {}, maxVideoMs = MAX_VIDEO_MS, outDir = OUT_DIR } = {}) {
  const P = { ...PACE, ...pace };
  const T = { ...TIMEOUTS, ...timeouts };

  return async function demoFlow({ page, base, mobile, viewport, helpers, progress }) {
    const { sleep, glide, click, type, smoothScroll } = helpers;

    if (new URL(base).searchParams.get('api') !== 'fixture') {
      throw new Error(`Refusing to record ${base}: the tour approves a phone call, so it only runs in fixture mode. Use ${DEMO_URL}`);
    }
    if (mobile) throw new Error('The tour is written for the 1920x1080 desktop video. Record without --mobile or --both.');

    // The recording starts with the page, just before it navigated, so this is the video clock.
    const videoStart = await page.evaluate(() => performance.timeOrigin).catch(() => Date.now());
    const now = () => Date.now() - videoStart;
    const timeline = [];
    const record = (start, end, text) => {
      const stamp = end === undefined ? formatClock(start) : `${formatClock(start)}-${formatClock(end)}`;
      const line = `${stamp.padEnd(13)}  ${text}`;
      timeline.push({ start, line });
      progress.log(`  ${line}`);
    };
    const note = (text) => record(now(), undefined, text);

    const byId = (id) => page.getByTestId(id);
    const visible = (locator, timeout) => locator.waitFor({ state: 'visible', timeout });
    let stopCallWatch = () => {};

    // Cards in the chat can repeat as the case evolves, so those steps act on the newest (last) one.
    const steps = [
      ['Onboarding', async () => {
        await visible(byId('plans-dropzone'), T.firstScreen);
        const scenario = await byId('fixture-scenario-select').first().inputValue({ timeout: 1000 }).catch(() => null);
        if (scenario) note(`fixture scenario: ${scenario}`);
        await sleep(P.onboarding);
      }],
      ['Add the two plan PDFs', async () => {
        const files = ensureSamples();
        await glide(byId('plans-dropzone'));
        await byId('plans-file-input').setInputFiles(files, { timeout: T.ui });
        await sleep(P.plansAdded);
      }],
      ['Continue', () => click(byId('plans-continue'))],
      ['Type the claim request', async () => {
        await visible(byId('composer-input'), T.ui);
        await type(byId('composer-input'), CLAIM_REQUEST, P.keystroke);
      }],
      ['Send', () => click(byId('composer-send'))],
      ['Facts card', async () => {
        const facts = byId('facts-card').last();
        await visible(facts, T.factsCard);
        await facts.scrollIntoViewIfNeeded({ timeout: T.ui });
        await sleep(P.factsCard);
      }],
      ['Tick the approval checkbox', () => tick(page, byId('approve-checkbox').last(), helpers, T.ui)],
      ['Approve the call', async () => {
        const approve = byId('approve-button').last();
        // A trial click waits until the button is enabled, so a gated approval fails with its reason.
        await approve.click({ trial: true, timeout: T.ui }).catch((error) => {
          throw new Error(
            'approve-button is still not clickable after the checkbox was ticked. If the facts card is ' +
              `waiting for a missing item, the tour needs a step that answers it.\n${error.message}`
          );
        });
        await click(approve);
      }],
      ['Call screen', async () => {
        await visible(byId('call-screen').first(), T.callScreen);
        stopCallWatch = watchCall(page, note, progress);
        await glide(byId('call-counterpart').first()); // rest the cursor by the badge before it flips
      }],
      ['Counterpart turns automated', async () => {
        await visible(byId('call-counterpart').filter({ hasText: 'Automated' }).first(), T.counterpart);
        await sleep(P.badgeFlip);
        // Point at the step-in control without pressing it, as the voice-over does. Skipped if absent.
        const stepIn = byId('step-in-button').first();
        if (await stepIn.isVisible()) await glide(stepIn);
      }],
      ['Decision prompt', async () => {
        await visible(byId('decision-card').first(), T.decision);
        await sleep(P.decision);
      }],
      ['Accept', () => click(byId('decision-option-accept').first())],
      ['Outcome', async () => {
        await visible(byId('outcome-card').last(), T.outcome);
        const callTime = await readText(byId('call-timer').first());
        stopCallWatch();
        const reference = await readText(byId('outcome-reference').last());
        note(reference ? `outcome reference: ${reference}` : 'outcome-reference is missing from the outcome card');
        if (callTime) note(`call timer: ${callTime}`);
        await sleep(P.outcome);
      }],
      ['Open the transcript', async () => {
        const insideOutcome = byId('outcome-card').last().getByTestId('transcript-toggle');
        const toggle = (await insideOutcome.count()) > 0 ? insideOutcome.first() : byId('transcript-toggle').last();
        await click(toggle);
        // Park the cursor in the empty right gutter while the transcript scrolls into view.
        await Promise.all([
          scrollNear(toggle, P.transcriptScroll, smoothScroll, T.ui),
          page.mouse.move(viewport.width - 160, Math.round(viewport.height * 0.8), { steps: 40 }),
        ]);
      }],
      ['Final frame', async () => {
        const activeTime = await readText(byId('metrics-active').first());
        if (activeTime) note(`metrics-active: ${activeTime}`);
        await sleep(P.end);
      }],
    ];

    progress.log('Demo tour, approximate video time:');
    let current = 0;
    const run = (async () => {
      for (; current < steps.length; current++) {
        const [label, action] = steps[current];
        progress.set(current / steps.length, label);
        const start = now();
        await action();
        record(start, now(), label);
      }
    })();
    run.catch(() => {}); // the race below reports it; this keeps a late rejection from going unhandled

    let deadlineTimer;
    const deadline = new Promise((_, reject) => {
      deadlineTimer = setTimeout(
        () => reject(new Error(`The tour is still running at ${formatClock(maxVideoMs)} of video. The submission video must stay under five minutes.`)),
        Math.max(0, videoStart + maxVideoMs - Date.now())
      );
    });

    try {
      await Promise.race([run, deadline]);
    } catch (error) {
      const label = steps[Math.min(current, steps.length - 1)][0];
      const shot = path.join(outDir, 'flow-failure.png');
      const saved = await page.screenshot({ path: shot, timeout: 5000 }).then(() => true, () => false);
      throw new Error(
        `Demo step ${current + 1}/${steps.length} "${label}" failed at ${formatClock(now())} of video.` +
          (saved ? ` Screenshot: ${shot}` : '') +
          `\n${error?.message ?? error}`,
        { cause: error }
      );
    } finally {
      clearTimeout(deadlineTimer);
      stopCallWatch();
    }

    progress.set(1, 'tour finished');
    const file = path.join(outDir, 'timeline.txt');
    fs.mkdirSync(outDir, { recursive: true });
    const lines = timeline.sort((a, b) => a.start - b.start).map((entry) => entry.line);
    fs.writeFileSync(file, `Demo tour of ${base}, recorded ${new Date().toISOString()}.\nTimes are approximate video timestamps (m:ss.s), steps as start-end.\n\n${lines.join('\n')}\n`);
    progress.log(`  Timeline saved to ${file}`);
  };
}

/** m:ss.s */
function formatClock(ms) {
  const tenths = Math.round(Math.max(0, ms) / 100);
  return `${Math.floor(tenths / 600)}:${((tenths % 600) / 10).toFixed(1).padStart(4, '0')}`;
}

/** Visible text with whitespace collapsed, or null when the element is absent. Never throws. */
function readText(locator, timeout = 1000) {
  return locator.innerText({ timeout }).then((text) => text.replace(/\s+/g, ' ').trim() || null, () => null);
}

/**
 * Checks a checkbox the way a person would, whatever its markup: a native input, a
 * [role=checkbox] element, a label for either, a wrapper around either, or a styled box
 * drawn over a visually hidden input (then the label is what gets clicked).
 * Throws unless the checkbox ends up checked.
 */
async function tick(page, box, { glide, sleep }, timeout) {
  await box.waitFor({ state: 'attached', timeout });
  const checkable = await box.evaluate(
    (el) =>
      (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) ||
      ['checkbox', 'switch', 'radio', 'menuitemcheckbox'].includes(el.getAttribute('role') ?? '') ||
      (el instanceof HTMLLabelElement && el.control !== null),
    undefined,
    { timeout }
  );
  let target = box;
  if (!checkable) {
    target = box.locator('input[type="checkbox"], [role="checkbox"]').first();
    if ((await target.count()) === 0) throw new Error('approve-checkbox is not a checkbox and does not contain one.');
  }

  // Pick what to click before the cursor moves. A trial click only runs Playwright's checks.
  const reachable = await target.click({ trial: true, timeout: 1000 }).then(() => true, () => false);
  if (reachable) {
    await glide(target);
    await target.check({ timeout });
    return;
  }
  const label = (await target.evaluateHandle((el) => el.labels?.[0] ?? el.closest('label'))).asElement();
  const point = label && (await label.isVisible()) ? await clickablePoint(label, timeout) : null;
  if (point) {
    // Same motion as sitereel's click helper, aimed at a point that really lands on the label.
    await page.mouse.move(point.x, point.y, { steps: 35 });
    await sleep(450);
    await page.mouse.click(point.x, point.y);
  } else {
    await target.check({ force: true, timeout });
  }
  if (!(await target.isChecked({ timeout }))) throw new Error('approve-checkbox is still unchecked after clicking it.');
}

/**
 * A viewport point that hit-tests to `handle` or a descendant, or null. Playwright aims at
 * an element's first layout box, which for a plain inline label can be a 1px hidden input.
 */
async function clickablePoint(handle, timeout) {
  await handle.scrollIntoViewIfNeeded({ timeout });
  return handle.evaluate((el) => {
    const boxes = [el, ...el.querySelectorAll('*')].flatMap((node) => [node.getBoundingClientRect(), ...node.getClientRects()]);
    for (const r of boxes) {
      if (r.width < 4 || r.height < 4) continue;
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === el || el.contains(hit))) return { x: Math.round(x), y: Math.round(y) };
    }
    return null;
  });
}

/**
 * Smoothly scrolls whatever scrolls `anchor` by `px`: its nearest scrollable ancestor, such as
 * a chat column with overflow: auto, or else the page through sitereel's smoothScroll.
 */
async function scrollNear(anchor, px, smoothScroll, timeout, duration = 1700) {
  const scrolledInside = await anchor.evaluate(
    (el, { px, duration }) => {
      let node = el.parentElement;
      while (node && node !== document.body && node !== document.documentElement) {
        const { overflowY } = getComputedStyle(node);
        if (/(auto|scroll|overlay)/.test(overflowY) && node.scrollHeight > node.clientHeight + 1) break;
        node = node.parentElement;
      }
      if (!node || node === document.body || node === document.documentElement) return false;
      const scroller = node;
      const start = scroller.scrollTop;
      const t0 = performance.now();
      const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2); // same curve as sitereel
      return new Promise((resolve) => {
        const step = () => {
          const t = Math.min((performance.now() - t0) / duration, 1);
          scroller.scrollTo({ top: start + px * ease(t), behavior: 'instant' });
          if (t < 1) setTimeout(step, 16);
          else resolve(true);
        };
        step();
      });
    },
    { px, duration },
    { timeout }
  );
  if (!scrolledInside) await smoothScroll(px, duration);
}

/**
 * While the call runs, logs each change of phase or counterpart with its video time and shows
 * the live phase and timer on the progress bar. Read-only: it never throws or moves the cursor.
 */
function watchCall(page, note, progress) {
  const read = (id) => readText(page.getByTestId(id).first(), 250);
  let last = '';
  let busy = false;
  let stopped = false;
  const timer = setInterval(async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const [phase, counterpart, elapsed] = await Promise.all([read('call-phase'), read('call-counterpart'), read('call-timer')]);
      if (stopped) return;
      const state = [phase, counterpart].filter(Boolean).join(', ');
      if (state && state !== last) {
        last = state;
        note(`call: ${state}`);
      }
      if (phase || elapsed) progress.set(undefined, `on the call: ${[phase, elapsed].filter(Boolean).join(' ')}`);
    } finally {
      busy = false;
    }
  }, 500);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export default {
  url: DEMO_URL, // --url wins; set here so a bare run records the running app instead of building one
  device: 'desktop',
  viewport: { width: 1920, height: 1080 },
  out: OUT_DIR, // --out wins
  flow: createFlow(),
};
