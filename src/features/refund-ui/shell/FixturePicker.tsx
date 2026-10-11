"use client";

/**
 * Fixture mode only: what the next case plays. A scenario (or "Auto", which
 * infers it from the first message), plus two switches that change how the
 * fixture backend behaves: added latency so loading states stay visible, and
 * V1 only, which drops live call data, step-in and decisions.
 */

import { useId } from "react";
import { FIXTURE_SCENARIOS, type FixtureScenario } from "../api/types";
import type { FixtureSettings } from "../state/controller";
import { Select } from "../ui/primitives";
import styles from "./FixturePicker.module.css";

export const SCENARIO_LABELS: Record<FixtureScenario, string> = {
  insurance_claim: "Insurance claim",
  duplicate_charge: "Duplicate charge",
  needs_evidence: "Needs evidence",
  uncertain_dispatch: "Uncertain dispatch",
  call_complete_unconfirmed: "Call done, unconfirmed",
};

const AUTO = "auto";

export interface FixturePickerProps {
  scenario: FixtureScenario | null;
  settings: FixtureSettings;
  onScenarioChange: (scenario: FixtureScenario | null) => void;
  onSettingsChange: (settings: FixtureSettings) => void;
  /** "inline" sits in the header; "stacked" fills the rail on narrow screens. */
  layout: "inline" | "stacked";
}

export default function FixturePicker({ scenario, settings, onScenarioChange, onSettingsChange, layout }: FixturePickerProps) {
  const titleId = useId();
  const noteId = useId();
  const stacked = layout === "stacked";

  return (
    <div
      className={[styles.picker, stacked ? styles.stacked : styles.inline].join(" ")}
      role="group"
      aria-labelledby={titleId}
      aria-describedby={noteId}
    >
      <span id={titleId} className={stacked ? styles.title : styles.srOnly}>
        Fixture
      </span>
      <Select
        compact
        className={styles.select}
        aria-label="Fixture scenario"
        value={scenario ?? AUTO}
        onChange={(event) => onScenarioChange(FIXTURE_SCENARIOS.find((candidate) => candidate === event.target.value) ?? null)}
        data-testid="fixture-scenario-select"
      >
        <option value={AUTO}>Auto scenario</option>
        {FIXTURE_SCENARIOS.map((candidate) => (
          <option key={candidate} value={candidate}>
            {SCENARIO_LABELS[candidate]}
          </option>
        ))}
      </Select>
      <div className={styles.toggles}>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={settings.showLoading}
            onChange={(event) => onSettingsChange({ ...settings, showLoading: event.target.checked })}
            data-testid="fixture-loading-toggle"
          />
          <span>Show loading</span>
        </label>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={settings.v1Only}
            onChange={(event) => onSettingsChange({ ...settings, v1Only: event.target.checked })}
            data-testid="fixture-v1-toggle"
          />
          <span>V1 backend only</span>
        </label>
      </div>
      <span id={noteId} className={stacked ? styles.note : styles.srOnly}>
        Applies to the next case.
      </span>
    </div>
  );
}
