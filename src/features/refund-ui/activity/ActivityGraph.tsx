"use client";

import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { CallV1, CaseV1 } from "../../../contracts/case";
import { CheckIcon, ChevronRightIcon, FileIcon, PhoneIcon, SendIcon } from "../ui/icons";
import { activityMode } from "./model";
import { activityGraph, type GraphNode } from "./graph";
import styles from "./ActivityGraph.module.css";

export interface ActivityGraphProps {
  caseData: CaseV1 | null;
  call: CallV1 | null;
  fixture: boolean;
  defaultExpanded?: boolean;
}

type Point = { x: number; y: number };
type View = Point & { zoom: number };
const initialView: View = { x: 0, y: 0, zoom: 1 };
const center = { x: 480, y: 295 };
const movement: Record<string, Point> = {
  ArrowLeft: { x: -20, y: 0 }, ArrowRight: { x: 20, y: 0 },
  ArrowUp: { x: 0, y: -20 }, ArrowDown: { x: 0, y: 20 },
};

/** A movable relationship graph of recorded case state, not a network-traffic trace. */
export default function ActivityGraph({ caseData, call, fixture, defaultExpanded }: ActivityGraphProps) {
  const id = useId();
  const [expanded, setExpanded] = useState(defaultExpanded ?? true);
  const [selected, setSelected] = useState<GraphNode["id"]>("agent");
  const [view, setView] = useState<View>(initialView);
  const [positions, setPositions] = useState<Partial<Record<GraphNode["id"], Point>>>({});
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ pointerId: number; start: Point; origin: Point; node?: GraphNode["id"]; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const graph = activityGraph(caseData, call, fixture);
  const nodes = graph.nodes.map((node) => ({ ...node, ...positions[node.id] }));
  const detail = nodes.find((node) => node.id === selected) ?? nodes[0]!;
  const connected = graph.edges.filter((edge) => edge.source === selected || edge.target === selected);

  function reset() { setView(initialView); setPositions({}); }
  function zoomBy(amount: number) {
    setView((current) => {
      const zoom = Math.max(0.65, Math.min(3, Math.round((current.zoom + amount) * 100) / 100));
      const ratio = zoom / current.zoom;
      return { zoom, x: center.x - (center.x - current.x) * ratio, y: center.y - (center.y - current.y) * ratio };
    });
  }
  function point(event: PointerEvent<SVGElement>): Point | null {
    const matrix = svgRef.current?.getScreenCTM();
    if (!matrix) return null;
    const result = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: result.x, y: result.y };
  }
  function startDrag(event: PointerEvent<SVGElement>, node?: GraphNode) {
    if (event.button !== 0 || !event.isPrimary) return;
    const start = point(event);
    if (!start) return;
    event.stopPropagation();
    suppressClick.current = false;
    drag.current = { pointerId: event.pointerId, start, origin: node ? { x: node.x, y: node.y } : view, node: node?.id, moved: false };
    svgRef.current?.setPointerCapture(event.pointerId);
  }
  function moveDrag(event: PointerEvent<SVGSVGElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const now = point(event);
    if (!now) return;
    const dx = now.x - current.start.x;
    const dy = now.y - current.start.y;
    if (Math.abs(dx) + Math.abs(dy) < 5 && !current.moved) return;
    current.moved = true;
    if (current.node) {
      const nodeId = current.node;
      setPositions((previous) => ({ ...previous, [nodeId]: boundedNode({ x: current.origin.x + dx / view.zoom, y: current.origin.y + dy / view.zoom }) }));
    } else {
      setView((previous) => ({ ...previous, x: current.origin.x + dx, y: current.origin.y + dy }));
    }
  }
  function endDrag(event: PointerEvent<SVGSVGElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    if (event.type === "pointerup" && !drag.current.moved && drag.current.node) setSelected(drag.current.node);
    suppressClick.current = drag.current.moved;
    drag.current = null;
    if (svgRef.current?.hasPointerCapture(event.pointerId)) svgRef.current.releasePointerCapture(event.pointerId);
  }
  function nodeKey(event: KeyboardEvent<SVGGElement>, node: GraphNode) {
    const delta = movement[event.key];
    if (delta) {
      event.preventDefault(); event.stopPropagation();
      setPositions((previous) => ({ ...previous, [node.id]: boundedNode({ x: node.x + delta.x, y: node.y + delta.y }) }));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault(); event.stopPropagation(); setSelected(node.id);
    }
  }
  function canvasKey(event: KeyboardEvent<SVGSVGElement>) {
    if (event.target !== event.currentTarget) return;
    const delta = movement[event.key];
    if (delta) { event.preventDefault(); setView((current) => ({ ...current, x: current.x + delta.x, y: current.y + delta.y })); }
    else if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomBy(0.2); }
    else if (event.key === "-") { event.preventDefault(); zoomBy(-0.2); }
    else if (event.key === "Home") { event.preventDefault(); reset(); }
  }
  function reveal(node: GraphNode) {
    // Keep a keyboard-focused node visible even after panning away from it.
    const x = node.x * view.zoom + view.x;
    const y = node.y * view.zoom + view.y;
    if (x < 100 || x > 860 || y < 70 || y > 480) {
      setView((current) => ({ ...current, x: center.x - node.x * current.zoom, y: center.y - node.y * current.zoom }));
    }
  }

  return (
    <section className={styles.root} aria-label="Agent activity map">
      <button type="button" className={styles.toggle} aria-expanded={expanded} aria-controls={`${id}-map`} onClick={() => setExpanded((value) => !value)}>
        <span className={styles.toggleTitle}><NetworkIcon /> Activity graph <span className={styles.mode}>{activityMode(caseData, graph.call, fixture)}</span></span>
        <span className={styles.chevron} data-open={expanded}><ChevronRightIcon /></span>
      </button>
      {expanded && (
        <div id={`${id}-map`}>
          <div className={styles.toolbar}>
            <span className={styles.legend}><span className={styles.solid} /> Recorded <span className={styles.dashed} /> Pending</span>
            <div className={styles.controls} role="group" aria-label="Graph view controls">
              <button type="button" onClick={() => zoomBy(-0.2)} disabled={view.zoom <= 0.65} aria-label="Zoom out">−</button>
              <output aria-label="Graph zoom">{Math.round(view.zoom * 100)}%</output>
              <button type="button" onClick={() => zoomBy(0.2)} disabled={view.zoom >= 3} aria-label="Zoom in">+</button>
              <button type="button" className={styles.reset} onClick={reset}>Reset view</button>
            </div>
          </div>
          <div className={styles.canvas}>
            <svg ref={svgRef} className={styles.network} viewBox="0 0 960 590" role="group" aria-label="Interactive case relationship graph" aria-describedby={`${id}-help`} tabIndex={0} onKeyDown={canvasKey} onPointerDown={(event) => startDrag(event)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={() => { drag.current = null; }}>
              <defs>
                <pattern id={`${id}-dots`} width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.8" className={styles.gridDot} /></pattern>
                <marker id={`${id}-arrow`} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0L7 3.5L0 7" fill="none" stroke="context-stroke" strokeWidth="1.3" /></marker>
              </defs>
              <rect width="960" height="590" fill={`url(#${id}-dots)`} aria-hidden="true" />
              <g transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
                <g aria-hidden="true" className={styles.edges}>
                  {graph.edges.map((edge) => {
                    const from = nodes.find((node) => node.id === edge.source)!;
                    const to = nodes.find((node) => node.id === edge.target)!;
                    const line = connection(from, to);
                    return <g key={edge.id} data-state={edge.state} data-connected={edge.source === selected || edge.target === selected}>
                      <path d={line.path} markerEnd={`url(#${id}-arrow)`} />
                      <text x={line.label.x} y={line.label.y} textAnchor="middle">{edge.label}</text>
                    </g>;
                  })}
                </g>
                {nodes.map((node) => (
                  <g key={node.id} transform={`translate(${node.x} ${node.y})`} className={styles.node} data-node={node.id} data-tone={node.tone} role="button" tabIndex={0} aria-label={`${node.title}: ${node.status}`} aria-pressed={selected === node.id} aria-controls={`${id}-detail`} onFocus={() => reveal(node)} onKeyDown={(event) => nodeKey(event, node)} onPointerDown={(event) => startDrag(event, node)} onClick={(event) => { if (event.detail === 0 || !suppressClick.current) setSelected(node.id); suppressClick.current = false; }}>
                    <title>{`${node.title}: ${node.status}`}</title>
                    <circle className={styles.focusRing} r={node.id === "agent" ? 49 : 39} />
                    <circle className={styles.nodeBody} r={node.id === "agent" ? 40 : 30} />
                    <g transform="translate(-12 -12) scale(1.5)" className={styles.nodeIcon}><NodeIcon node={node.id} /></g>
                    <circle className={styles.statusDot} cx={node.id === "agent" ? 29 : 22} cy={node.id === "agent" ? -29 : -22} r="5" />
                    <text className={styles.nodeTitle} textAnchor="middle" y={node.id === "agent" ? 66 : 56}>{node.title}</text>
                    <text className={styles.nodeStatus} textAnchor="middle" y={node.id === "agent" ? 86 : 76}>{shortStatus(node.status)}</text>
                  </g>
                ))}
              </g>
            </svg>
          </div>
          <div className={styles.content}>
            <p id={`${id}-help`} className={styles.hint}>Drag the canvas to pan; drag nodes to arrange. Tab to a node, Enter to inspect, arrows to move. On the canvas, use + / − to zoom and Home to reset.</p>
            <label className={styles.inspectorSelect}>Inspect node
              <select value={selected} onChange={(event) => {
                const node = nodes.find((item) => item.id === event.target.value);
                if (node) { setSelected(node.id); reveal(node); }
              }}>{nodes.map((node) => <option key={node.id} value={node.id}>{node.title} · {node.status}</option>)}</select>
            </label>
            <div id={`${id}-detail`} className={styles.detail} aria-live="polite" aria-atomic="true">
              <div className={styles.detailTitle}><strong>{detail.title}</strong><span>{detail.status}</span></div>
              <p>{detail.description}</p>
              {detail.facts.length > 0 && <ul>{detail.facts.map((fact, index) => <li key={`${index}-${fact}`}>{fact}</li>)}</ul>}
              <div className={styles.relationships} aria-label="Selected node connections">
                {connected.map((edge) => <span key={edge.id}>{nodes.find((node) => node.id === edge.source)?.title} → {nodes.find((node) => node.id === edge.target)?.title}: {edge.label} ({edge.state})</span>)}
              </div>
            </div>
            <p className={styles.footnote}>Connections describe case records, not a live event trace. No provider browser activity is recorded here.</p>
            {caseData && caseData.timeline.length > 0 && (
              <details className={styles.timeline}>
                <summary>Recorded case events <span>{caseData.timeline.length}</span></summary>
                <ol>{[...caseData.timeline].sort((a, b) => a.at.localeCompare(b.at)).map((entry) => (
                  <li key={entry.id}><time dateTime={entry.at}>{entry.at.replace("T", " ").replace(/\.\d{3}Z$/, " UTC")}</time><p>{entry.message}</p></li>
                ))}</ol>
              </details>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function boundedNode(position: Point): Point {
  return { x: Math.max(95, Math.min(865, position.x)), y: Math.max(65, Math.min(490, position.y)) };
}
function shortStatus(status: string) { return status.length > 29 ? `${status.slice(0, 27)}…` : status; }
function connection(from: GraphNode, to: GraphNode) {
  const dx = to.x - from.x; const dy = to.y - from.y;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const ux = dx / distance; const uy = dy / distance;
  const start = { x: from.x + ux * (from.id === "agent" ? 48 : 38), y: from.y + uy * (from.id === "agent" ? 48 : 38) };
  const end = { x: to.x - ux * (to.id === "agent" ? 48 : 38), y: to.y - uy * (to.id === "agent" ? 48 : 38) };
  const midpoint = { x: (start.x + end.x) / 2 - uy * 18, y: (start.y + end.y) / 2 + ux * 18 };
  return { path: `M${start.x} ${start.y} Q${midpoint.x} ${midpoint.y} ${end.x} ${end.y}`, label: { x: midpoint.x - uy * 8, y: midpoint.y + ux * 8 - 5 } };
}
function NodeIcon({ node }: { node: GraphNode["id"] }) {
  if (node === "agent") return <NetworkIcon />;
  if (node === "request") return <SendIcon />;
  if (node === "dial") return <PhoneIcon />;
  if (node === "approval" || node === "outcome") return <CheckIcon />;
  return <FileIcon />;
}
function NetworkIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true" focusable="false"><path d="m5 5 6-2M5 5l6 7M5 5l-2 7m8-9v9M3 12h8" /><circle cx="5" cy="5" r="2" fill="var(--rc-canvas)" /><circle cx="11" cy="3" r="2" fill="var(--rc-canvas)" /><circle cx="11" cy="12" r="2" fill="var(--rc-canvas)" /><circle cx="3" cy="12" r="2" fill="var(--rc-canvas)" /></svg>;
}
