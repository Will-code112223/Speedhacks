/**
 * Server-renders the resolution plan card: four plain-words sections, the
 * insurer rules with where they were read, and the draft, ready and frozen states.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ResolutionPlanV1 } from "../../../../contracts/case";
import PlanCard from "../PlanCard";

function makePlan(overrides: Partial<ResolutionPlanV1> = {}): ResolutionPlanV1 {
  return {
    version: 1,
    purpose: "file_claim",
    ready: true,
    frozen: false,
    missingFields: [],
    insurerName: "State Farm",
    before: [
      { title: "Policy number", detail: "The agent reads it to find your policy.", status: "done" },
      { title: "Date of loss", detail: "When the water damage happened.", status: "done" },
    ],
    call: {
      goal: "Open a water damage claim on your home policy and get a claim number.",
      steps: ["Confirm the policyholder and policy number", "Describe the water damage and the date it happened"],
      questions: ["What is the claim number?", "When will an adjuster contact you?"],
      readBack: "The agent reads the claim number back to confirm it.",
      willNotDo: ["Agree to a settlement amount", "Cancel or change your policy"],
    },
    after: [
      {
        title: "Expect an adjuster",
        detail: "State Farm usually assigns an adjuster within a few days.",
        source: { label: "State Farm claims", url: "https://www.statefarm.com/claims" },
      },
    ],
    insurerTerms: [
      {
        key: "claim_decision_timeline",
        label: "Claim decision",
        value: "Within 30 days of a complete claim",
        confidence: "verified_official",
        confidenceLabel: "From the insurer's website",
        sourceUrl: "https://www.statefarm.com/claims/home-and-property",
      },
    ],
    ...overrides,
  };
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
}

describe("PlanCard", () => {
  it("renders a ready claim plan with every section, the rules and their sources", () => {
    const html = renderToStaticMarkup(<PlanCard plan={makePlan()} />);
    const body = text(html);
    expect(html).toContain('data-testid="plan-card"');
    expect(body).toContain("How Recourse will resolve this");
    for (const heading of ["Before the call", "On the call", "What the agent will not do", "After the call"]) {
      expect(html).toMatch(new RegExp(`<h4[^>]*>${heading}</h4>`));
    }
    expect(body).toContain("Ready");
    expect(body).toContain("This is what the agent will do if you approve the call.");
    expect(body).toContain("Have it");
    expect(body).toContain("01 Confirm the policyholder and policy number");
    expect(body).toContain("Questions the agent will ask");
    expect(body).toContain("When will an adjuster contact you?");
    expect(body).toContain("Before hanging up");
    expect(body).toContain("Agree to a settlement amount");
    expect(body).toContain("Expect an adjuster");
    expect(body).toContain("Source: State Farm claims");
    expect(body).toContain("Insurer rules");
    expect(body).toContain("Within 30 days of a complete claim");
    expect(body).toContain("From the insurer's website");
    expect(body).toContain("Source: statefarm.com");
    expect(html).toContain('href="https://www.statefarm.com/claims/home-and-property"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).toMatch(/<ol[^>]*data-testid="plan-call-steps"/);
    expect(html).not.toContain("<details");
    expect(body).not.toMatch(/[{}]|"key"|verified_official/);
  });

  it("marks a draft plan and the facts still missing", () => {
    const plan = makePlan({
      ready: false,
      missingFields: ["policyNumber"],
      before: [{ title: "Policy number", detail: "Add it in the facts above.", status: "missing" }],
    });
    const body = text(renderToStaticMarkup(<PlanCard plan={plan} />));
    expect(body).toContain("Draft");
    expect(body).toContain("Draft: add the missing facts above and this plan updates.");
    expect(body).toContain("Missing");
    expect(body).not.toContain("Have it");
  });

  it("says the frozen plan is the one the agent was given", () => {
    const body = text(renderToStaticMarkup(<PlanCard plan={makePlan({ frozen: true })} />));
    expect(body).toContain("Approved plan");
    expect(body).toContain("This is the plan the agent was given when you approved the call.");
  });

  it("leaves out the insurer rules block when there are none", () => {
    const html = renderToStaticMarkup(<PlanCard plan={makePlan({ insurerTerms: [] })} />);
    expect(html).not.toContain('data-testid="plan-insurer-terms"');
    expect(text(html)).not.toContain("Insurer rules");
  });

  it("folds the plan behind a summary when collapsed", () => {
    const html = renderToStaticMarkup(<PlanCard plan={makePlan()} collapsed />);
    expect(html).toContain("<details");
    expect(html).not.toMatch(/<details[^>]*open/);
    expect(text(html)).toContain("Show the plan");
    expect(text(html)).toContain("Before the call");
  });

  it("shows the skeleton while the plan loads", () => {
    const html = renderToStaticMarkup(<PlanCard plan={null} loading />);
    expect(html).toContain('role="status"');
    expect(text(html)).toContain("Preparing the plan");
  });

  it("offers a retry when the plan failed to load", () => {
    const body = text(renderToStaticMarkup(<PlanCard plan={null} error="The server did not answer." onRetry={() => {}} />));
    expect(body).toContain("The server did not answer.");
    expect(body).toContain("Try again");
  });

  it("renders nothing with no plan, no load and no error", () => {
    expect(renderToStaticMarkup(<PlanCard plan={null} />)).toBe("");
  });
});
