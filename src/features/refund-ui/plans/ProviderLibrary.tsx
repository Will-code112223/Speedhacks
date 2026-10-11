"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { InsurerLookup } from "../api/insurer-types";
import { FileIcon, DownloadIcon, CloseIcon } from "../ui/icons";
import { Button } from "../ui/primitives";
import { providerLibrary, type LibraryResource } from "./provider-library";
import { providerUrl } from "./provider-resource";
import styles from "./ProviderLibrary.module.css";

const kindLabel: Record<LibraryResource["kind"], string> = { document: "Source PDF", guidance: "Filing guidance", web: "Source resource", worksheet: "Recourse worksheet" };
const confidenceLabel = { verified_official: "Official source", reported: "Reported · confirm", regulatory_default: "Regulatory reference", unknown: "Unverified" };

export default function ProviderLibrary({ insurer }: { insurer: InsurerLookup }) {
  const resources = useMemo(() => providerLibrary(insurer), [insurer]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "document" | "guidance" | "worksheet">("all");
  const [showAll, setShowAll] = useState(false);
  const selected = resources.find((resource) => resource.id === selectedId) ?? null;
  const matching = resources.filter((resource) => filter === "all" || (filter === "document" ? resource.kind === "document" || resource.kind === "web" : resource.kind === filter));
  const visible = showAll ? matching : matching.slice(0, 4);
  const heading = useId();
  function closePreview() {
    const index = resources.findIndex((resource) => resource.id === selectedId);
    document.getElementById(`${heading}-resource-${index}`)?.focus();
    setSelectedId(null);
  }
  return <section className={styles.library} aria-labelledby={heading}>
    <div className={styles.heading}><h4 id={heading}>Resource library</h4><span>{resources.length} resources</span></div>
    <div className={styles.filters} role="group" aria-label="Filter resources">
      {(["all", "document", "guidance", "worksheet"] as const).map((value) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => { setFilter(value); setShowAll(false); }}>{({ all: "All", document: "Documents", guidance: "Filing", worksheet: "Blank worksheet" })[value]}</button>)}
    </div>
    <div className={styles.tiles}>
      {visible.map((resource) => <button key={resource.id} id={`${heading}-resource-${resources.indexOf(resource)}`} type="button" className={styles.tile} aria-pressed={selectedId === resource.id} onClick={() => setSelectedId(resource.id)}>
        <span className={styles.paper} aria-hidden="true"><span className={styles.paperHeader}><FileIcon /><span>{resource.kind === "document" ? "PDF" : resource.kind === "worksheet" ? "TXT" : "REFERENCE"}</span></span><strong>{resource.title}</strong><span className={styles.excerpt}>{resource.kind === "worksheet" ? "Claimant name:\nPolicy number:\nIncident date:\nEvidence available:" : resource.excerpt || "Open the provider source to review this resource."}</span></span>
        <span className={styles.tileTitle}>{resource.title}</span><span className={styles.kind}>{kindLabel[resource.kind]}</span>
      </button>)}
    </div>
    {!matching.length ? <p className={styles.empty}>No documents or formats are recorded in this category.</p> : null}
    {matching.length > 4 ? <Button variant="ghost" size="small" onClick={() => setShowAll((value) => !value)}>{showAll ? "Show fewer" : `Show all ${matching.length}`}</Button> : null}
    {selected ? <ResourcePreview resource={selected} onClose={closePreview} /> : null}
    <p className={styles.note}>Source excerpts are reference material. Official blank forms are available only where the provider links to them.</p>
  </section>;
}

export function ResourcePreview({ resource, onClose }: { resource: LibraryResource; onClose: () => void }) {
  const heading = useId();
  const previewRef = useRef<HTMLElement>(null);
  useEffect(() => { previewRef.current?.focus(); }, [resource.id]);
  const sourceUrl = providerUrl(resource.url);
  function downloadWorksheet() {
    if (resource.kind !== "worksheet") return;
    const url = URL.createObjectURL(new Blob([resource.excerpt], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = "recourse-preparation-worksheet.txt"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section ref={previewRef} tabIndex={-1} className={styles.preview} aria-labelledby={heading}>
    <header><div><span className={styles.kind}>{kindLabel[resource.kind]}</span><h5 id={heading}>{resource.title}</h5></div><Button size="small" variant="ghost" onClick={onClose} aria-label="Close resource preview"><CloseIcon /></Button></header>
    {resource.kind === "worksheet" ? <p className={styles.boundary}>Preparation worksheet · not an insurer form · not submitted</p> : <p className={styles.boundary}>Knowledge-base excerpt · open the source for the complete document</p>}
    <pre className={styles.body}>{resource.excerpt || "No excerpt is recorded. Open the provider source to review this resource."}</pre>
    <footer>
      {sourceUrl ? <a href={sourceUrl} target="_blank" rel="noreferrer">{resource.kind === "document" ? "Open source PDF ↗" : "Open source ↗"}</a> : null}
      {resource.kind === "worksheet" ? <Button size="small" onClick={downloadWorksheet}><DownloadIcon /> Download blank TXT</Button> : <span>{resource.confidence ? confidenceLabel[resource.confidence] : "Source unverified"}{resource.checkedAt ? ` · Checked ${resource.checkedAt}` : " · Date unknown"}</span>}
    </footer>
  </section>;
}
