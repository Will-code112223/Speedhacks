"use client";

import { useId, useState } from "react";
import type { CallV1, CaseV1 } from "../../../contracts/case";
import { CheckIcon, ChevronRightIcon, FileIcon, PhoneIcon, SendIcon } from "../ui/icons";
import { activityMode, activityNodes, type ActivityNodeId } from "./model";
import styles from "./ActivityGraph.module.css";

export interface ActivityGraphProps {
  caseData: CaseV1 | null;
  call: CallV1 | null;
  fixture: boolean;
  defaultExpanded?: boolean;
}

/** Connections show workflow dependencies, not network requests or tool execution. */
export default function ActivityGraph({ caseData, call, fixture, defaultExpanded }: ActivityGraphProps) {
  const id = useId();
  const [expanded, setExpanded] = useState(defaultExpanded ?? !caseData);
  const [selected, setSelected] = useState<ActivityNodeId>("brief");
  const nodes = activityNodes(caseData, call, fixture);
  const detail = nodes.find((node) => node.id === selected)!;

  return (
    <section className={styles.root} aria-label="Agent activity map">
      <button type="button" className={styles.toggle} aria-expanded={expanded} aria-controls={`${id}-map`} onClick={() => setExpanded((value) => !value)}>
        <span className={styles.toggleTitle}><MapIcon /> Agent activity <span className={styles.mode}>{activityMode(caseData, call, fixture)}</span></span>
        <span className={styles.chevron} data-open={expanded}><ChevronRightIcon /></span>
      </button>
      {expanded && (
        <div id={`${id}-map`} className={styles.content}>
          <p className={styles.caption}>Follow the case from request to outcome. Select a step to inspect its recorded state.</p>
          <div className={styles.diagram}>
            <svg className={styles.connectors} viewBox="0 0 600 204" preserveAspectRatio="none" aria-hidden="true" focusable="false">
              <path d="M100 51H500V153H100" />
            </svg>
            <div className={styles.nodes}>
              {nodes.map((node, index) => (
                <button key={node.id} type="button" className={styles.node} data-node={node.id} data-tone={node.tone} aria-pressed={selected === node.id} aria-controls={`${id}-detail`} onClick={() => setSelected(node.id)}>
                  <span className={styles.nodeTop}><span className={styles.nodeIcon}><NodeIcon node={node.id} /></span><span className={styles.index}>{String(index + 1).padStart(2, "0")}</span></span>
                  <span className={styles.nodeTitle}>{node.title}</span>
                  <span className={styles.state}><span className={styles.dot} aria-hidden="true" />{node.status}</span>
                </button>
              ))}
            </div>
          </div>
          <div id={`${id}-detail`} className={styles.detail} aria-live="polite" aria-atomic="true">
            <div className={styles.detailTitle}><strong>{detail.title}</strong><span>{detail.status}</span></div>
            <p>{detail.description}</p>
            {detail.facts.length > 0 && <ul>{detail.facts.map((fact, index) => <li key={`${index}-${fact}`}>{fact}</li>)}</ul>}
          </div>
          <p className={styles.footnote}>Lines show the workflow, not a live event trace. No provider browser activity is recorded here.</p>
          {caseData && caseData.timeline.length > 0 && (
            <details className={styles.timeline}>
              <summary>Recorded case events <span>{caseData.timeline.length}</span></summary>
              <ol>{[...caseData.timeline].sort((a, b) => a.at.localeCompare(b.at)).map((entry) => (
                <li key={entry.id}><time dateTime={entry.at}>{entry.at.replace("T", " ").replace(/\.\d{3}Z$/, " UTC")}</time><p>{entry.message}</p></li>
              ))}</ol>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

function NodeIcon({ node }: { node: ActivityNodeId }) {
  if (node === "request") return <SendIcon />;
  if (node === "dial") return <PhoneIcon />;
  if (node === "approval" || node === "outcome") return <CheckIcon />;
  return <FileIcon />;
}

function MapIcon() {
  return <svg width="17" height="17" viewBox="0 0 17 17" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true" focusable="false"><path d="M4 4h9v9H4V4ZM4 8.5h9" /><rect x="2" y="2" width="4" height="4" fill="var(--rc-canvas)" /><rect x="11" y="6.5" width="4" height="4" fill="var(--rc-canvas)" /><rect x="2" y="11" width="4" height="4" fill="var(--rc-canvas)" /></svg>;
}
