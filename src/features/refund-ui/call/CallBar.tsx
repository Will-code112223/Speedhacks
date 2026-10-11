"use client";

/**
 * A slim bar at the top of the chat when the call screen is a closed sheet
 * (under 1024px): what the call is doing, its timer, and a way back to it.
 */

import type { CallV1, CaseV1 } from "../../../contracts/case";
import type { LiveCallV2 } from "../api/types";
import { Button } from "../ui/primitives";
import { PhoneIcon } from "../ui/icons";
import { formatDuration, secondsBetween, statusWord } from "../ui/format";
import { useNow } from "../state/browser";
import { phaseIsLive, phaseLabel } from "../state/call";
import styles from "./Call.module.css";

export interface CallBarProps {
  caseData: CaseV1;
  call: CallV1;
  live: LiveCallV2 | null;
  needsAnswer: boolean;
  onOpen: () => void;
}

export default function CallBar({ caseData, call, live, needsAnswer, onOpen }: CallBarProps) {
  const running = live !== null && live.startedAt !== null && live.endedAt === null && phaseIsLive(live.phase);
  const now = useNow(running);
  const name = live?.calling.name ?? caseData.merchant.name ?? "Support line";
  const status = live ? phaseLabel(live.phase) : statusWord(call.state);

  return (
    <div className={[styles.callBar, needsAnswer ? styles.callBarAttention : ""].join(" ")}>
      <span className={styles.callBarIcon}>
        <PhoneIcon />
      </span>
      <span className={styles.callBarText}>
        <span className={styles.callBarStatus}>{needsAnswer ? "Needs your answer" : status}</span>
        <span className={styles.callBarName}>{name}</span>
      </span>
      {live?.startedAt ? (
        <span className={styles.callBarTimer}>{formatDuration(secondsBetween(live.startedAt, live.endedAt, now))}</span>
      ) : null}
      <Button size="small" variant={needsAnswer ? "primary" : "secondary"} onClick={onOpen} aria-haspopup="dialog">
        {needsAnswer ? "Answer" : "Show call"}
      </Button>
    </div>
  );
}
