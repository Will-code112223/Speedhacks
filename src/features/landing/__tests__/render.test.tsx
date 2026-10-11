/**
 * Server-renders the landing page so a missing claim, link or demo region fails here, without a browser.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import LandingPage, { EXPLANATION, HEADLINE } from "../LandingPage";
import { INITIAL_STATE, LINES, LOOP_MS, PLAN_STEPS, TIMELINE, stateAt, typedChars } from "../demo";

const html = renderToStaticMarkup(<LandingPage />);

describe("landing page", () => {
  it("states what Recourse is in a headline and two sentences", () => {
    expect(HEADLINE.split(" ").length).toBeLessThanOrEqual(7);
    expect(html.replace(/<[^>]+>/g, "")).toContain(HEADLINE);
    expect(html).toContain("<h1");
    expect(EXPLANATION).toHaveLength(2);
    for (const sentence of EXPLANATION) expect(html).toContain(sentence);
  });

  it("links the primary action to the app's first page", () => {
    expect(html).toMatch(/<a [^>]*href="\/"[^>]*>Start a case<\/a>/);
    expect(html).toMatch(/<a [^>]*href="\/\?api=fixture"[^>]*>See a demo case<\/a>/);
  });

  it("renders the demo call as decoration with a described alternative", () => {
    expect(html).toContain('data-testid="landing-demo"');
    expect(html).toMatch(/aria-hidden="true" inert=""/);
    expect(html).toContain("A sample call, simulated");
    expect(html).toContain("Demo calls are simulated.");
  });

  it("uses no em dashes", () => {
    expect(html).not.toContain("\u2014");
  });
});

describe("demo timeline", () => {
  it("is in time order and ends inside the loop", () => {
    const times = TIMELINE.map((beat) => beat.atMs);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times.at(-1)).toBeLessThan(LOOP_MS);
  });

  it("starts dialing and finishes with every step done and every line typed", () => {
    expect(stateAt(0)).toEqual(INITIAL_STATE);
    const end = stateAt(LOOP_MS);
    expect(end.phase).toBe("Call ended");
    expect(end.step).toBe(PLAN_STEPS.length);
    expect(end.counterpart).toBe(true);
    expect(end.lineStarts).toHaveLength(LINES.length);
    LINES.forEach((line, i) => expect(typedChars(end, i, LOOP_MS)).toBe(line.text.length));
  });
});
