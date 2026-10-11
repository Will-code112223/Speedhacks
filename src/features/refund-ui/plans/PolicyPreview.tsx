"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { PlanRecord } from "./store";
import { Button } from "../ui/primitives";
import { CloseIcon } from "../ui/icons";
import styles from "./PolicyPreview.module.css";

export function policyPreviewKind(type: string): "pdf" | "image" | "download" {
  if (type === "application/pdf") return "pdf";
  return ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(type) ? "image" : "download";
}

export default function PolicyPreview({ plan, onClose }: { plan: PlanRecord; onClose: () => void }) {
  const heading = useId();
  const [url, setUrl] = useState<string | null>(null);
  const previewRef = useRef<HTMLElement>(null);
  useEffect(() => { previewRef.current?.focus(); }, []);
  const kind = policyPreviewKind(plan.fileType);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(new Blob([plan.file], { type: kind === "download" ? "application/octet-stream" : plan.fileType }));
    setUrl(objectUrl);
    return () => { URL.revokeObjectURL(objectUrl); };
  }, [plan.file, plan.fileType, kind]);
  return <section ref={previewRef} tabIndex={-1} className={styles.preview} aria-labelledby={heading}>
    <header><div><span>Your uploaded document</span><h3 id={heading}>{plan.fileName}</h3></div><Button variant="ghost" size="small" onClick={onClose} aria-label="Close policy preview"><CloseIcon /></Button></header>
    {url && kind === "image" ? <img className={styles.image} src={url} alt={`Uploaded policy: ${plan.fileName}`} /> : null}
    {url && kind === "pdf" ? <iframe className={styles.pdf} src={url} title={`Policy preview: ${plan.fileName}`} sandbox="" /> : null}
    {!url ? <p>Loading document…</p> : kind === "download" ? <p>This file format cannot be previewed here.</p> : <p>If the preview is unavailable, open the original document.</p>}
    {url ? <div className={styles.actions}>{kind !== "download" ? <a href={url} target="_blank" rel="noreferrer">Open document ↗</a> : null}<a href={url} download={plan.fileName}>Download original</a></div> : null}
  </section>;
}
