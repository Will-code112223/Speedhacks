/**
 * Server-renders the landing page so a missing claim, link or rolling region fails here, without a browser.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import LandingPage from "../LandingPage";
import { BAND_ROWS, EXPLANATION, FOOTER, HEADLINE, ROLLING_WORDS, bandSentence } from "../content";
import { BAND_COPIES, wrap } from "../rolling";

const html = renderToStaticMarkup(<LandingPage />);
const text = html.replace(/<[^>]+>/g, "");

describe("landing page", () => {
  it("states the headline with the first rolling word as one sentence", () => {
    expect(HEADLINE).toBe("Get your money back from duplicate charges.");
    expect(html).toContain("<h1");
    expect(text).toContain(HEADLINE);
  });

  it("rolls through the five kinds of money owed, starting with the first two", () => {
    expect(ROLLING_WORDS).toEqual(["duplicate charges", "denied claims", "subscription traps", "cancelled bookings", "overbilling"]);
    expect(html).toContain('data-testid="landing-morph"');
    expect(text).toContain(ROLLING_WORDS[0]);
    expect(text).toContain(ROLLING_WORDS[1]);
  });

  it("explains the product in both sentences", () => {
    expect(EXPLANATION).toEqual([
      "Recourse is an AI agent that phones the merchant or insurer and gets your money back.",
      "You approve before anything is dialed, you can step in at any time, and every outcome comes with a transcript.",
    ]);
    expect(text).toContain(EXPLANATION.join(" "));
  });

  it("rolls both band sentences, with one readable copy and the repeats hidden", () => {
    expect(html).toContain('data-testid="landing-band"');
    expect(BAND_ROWS.map(bandSentence)).toEqual([
      "You approve. Recourse makes the call.",
      "Step in at any time. Every outcome keeps its transcript.",
    ]);
    for (const row of BAND_ROWS) {
      expect(html).toContain(`>${bandSentence(row)}</span>`);
      expect(html.split(`>${row.accent}</span>`).length - 1).toBe(BAND_COPIES);
    }
    expect(BAND_ROWS[0]!.velocity).toBe(-BAND_ROWS[1]!.velocity);
  });

  it("links the actions to the app", () => {
    expect(html).toMatch(/<a [^>]*href="\/"[^>]*>Start a case<\/a>/);
    expect(html).toMatch(/<a [^>]*href="\/\?api=fixture"[^>]*>See a demo case<svg/);
    expect(html).toMatch(/<a [^>]*href="\/"[^>]*>Open the app<\/a>/);
  });

  it("keeps the proof and footer honest about the simulation", () => {
    expect(text).toContain("Simulated outcome: Approved, $49.99 refund, reference and transcript kept with the case.");
    expect(text).toContain(FOOTER);
    expect(FOOTER).toContain("Demo calls are simulated.");
  });

  it("names no merchant and uses no em dashes", () => {
    expect(html).not.toContain("Ridgeline");
    expect(html).not.toContain("\u2014");
  });
});

describe("velocity wrap", () => {
  it("keeps the offset inside one copy, as framer-motion's wrap does", () => {
    expect(wrap(-12.5, 0, 0)).toBe(-12.5);
    expect(wrap(-12.5, 0, 3)).toBeCloseTo(-9.5);
    expect(wrap(-12.5, 0, -15)).toBeCloseTo(-2.5);
    expect(wrap(-12.5, 0, 40)).toBeCloseTo(-10);
  });
});
