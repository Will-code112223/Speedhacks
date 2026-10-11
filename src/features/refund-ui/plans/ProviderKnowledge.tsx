"use client";

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { createInsurerApi, type InsurerApi } from "../api/insurers";
import type { Confidence, InsurerLookup, InsurerSummary } from "../api/insurer-types";
import { Button } from "../ui/primitives";
import { formatPhone } from "../ui/format";
import { PROVIDER_LOGOS } from "./provider-logos";
import { createProviderResource, providerUrl, type ProviderState } from "./provider-resource";
import styles from "./ProviderKnowledge.module.css";
import ProviderLibrary from "./ProviderLibrary";

export interface ProviderKnowledgeProps {
  api?: InsurerApi;
  /** The chosen provider's name, or null when the choice is cleared; the plans keep it as their insurer. */
  onProviderChange?: (name: string | null) => void;
}

export default function ProviderKnowledge({ api, onProviderChange }: ProviderKnowledgeProps) {
  // Provider reference data remains real in a simulated calling workspace.
  const client = useMemo(() => api ?? createInsurerApi({ mode: "http" }), [api]);
  const resource = useMemo(() => createProviderResource(client), [client]);
  const state = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getServerSnapshot);
  useEffect(() => { void resource.load(); return () => resource.dispose(); }, [resource]);
  const select = (id: string | null) => {
    onProviderChange?.(id === null ? null : (state.list.items.find((item) => item.id === id)?.name ?? null));
    void resource.select(id);
  };
  return <ProviderKnowledgeView state={state} onReload={() => void resource.load()} onSelect={select} />;
}

export function ProviderKnowledgeView({ state, onReload, onSelect }: { state: ProviderState; onReload: () => void; onSelect: (id: string | null) => void }) {
  const heading = useId();
  return <section className={styles.root} aria-labelledby={heading}>
    <div className={styles.heading}><h2 id={heading}>Insurance providers</h2><span>Knowledge base</span></div>
    <ProviderPicker items={state.list.items} selectedId={state.selection.id} loading={state.list.status === "loading"} onSelect={onSelect} />
    {state.list.status === "error" ? <div className={styles.error} role="alert">{state.list.error}<Button size="small" onClick={onReload}>Retry</Button></div> : null}
    {state.list.status === "ready" && !state.list.items.length ? <p className={styles.note}>No providers available.</p> : null}
    <p className={styles.note}>Provider reference only. Your policy determines coverage.</p>
    <div aria-live="polite" aria-busy={state.selection.status === "loading"}>
      {state.selection.status === "loading" ? <p className={styles.note}>Loading provider details…</p> : null}
      {state.selection.status === "missing" ? <p className={styles.note}>No reference found for this provider.</p> : null}
      {state.selection.status === "error" ? <div className={styles.error} role="alert">{state.selection.error}<Button size="small" onClick={() => onSelect(state.selection.id)}>Retry</Button></div> : null}
      {state.selection.insurer ? <ProviderDetails insurer={state.selection.insurer} /> : null}
    </div>
  </section>;
}

function ProviderPicker({ items, selectedId, loading, onSelect }: { items: InsurerSummary[]; selectedId: string | null; loading: boolean; onSelect: (id: string | null) => void }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const selected = items.find((item) => item.id === selectedId);
  useEffect(() => { if (open) list.current?.children[active]?.scrollIntoView({ block: "nearest" }); }, [open, active]);
  function choose(index: number) { const item = items[index]; if (item) onSelect(item.id); setOpen(false); }
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault(); setOpen(true);
      setActive((current) => event.key === "Home" ? 0 : event.key === "End" ? Math.max(0, items.length - 1) : !open ? Math.max(0, items.findIndex((item) => item.id === selectedId)) : Math.max(0, Math.min(items.length - 1, current + (event.key === "ArrowDown" ? 1 : -1))));
    } else if (open && ["Enter", " "].includes(event.key)) { event.preventDefault(); choose(active); }
    else if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
    else if (event.key.length === 1 && event.key !== " ") {
      const found = items.findIndex((item) => item.name.toLowerCase().startsWith(event.key.toLowerCase()));
      if (found >= 0) { event.preventDefault(); setActive(found); setOpen(true); }
    }
  }
  return <div className={styles.picker} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button type="button" className={styles.trigger} role="combobox" aria-label="Insurance provider" aria-expanded={open} aria-controls={`${id}-options`} aria-haspopup="listbox" aria-activedescendant={open && items[active] ? `${id}-${active}` : undefined} disabled={loading || items.length === 0} onClick={() => { setActive(Math.max(0, items.findIndex((item) => item.id === selectedId))); setOpen((value) => !value); }} onKeyDown={onKeyDown}>
      {selected ? <ProviderMark id={selected.id} name={selected.name} /> : null}
      <span>{loading ? "Loading providers…" : selected?.name ?? "Select insurance provider"}</span><span className={styles.chevron} aria-hidden="true">⌄</span>
    </button>
    {open ? <ul className={styles.options} id={`${id}-options`} role="listbox" aria-label="Insurance providers" ref={list}>
      {items.map((item, index) => <li id={`${id}-${index}`} role="option" aria-selected={item.id === selectedId} data-active={index === active} key={item.id} onMouseEnter={() => setActive(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(index)}><ProviderMark id={item.id} name={item.name} /><span>{item.name}</span>{item.id === selectedId ? <span aria-hidden="true">✓</span> : null}</li>)}
    </ul> : null}
  </div>;
}

export function ProviderMark({ id, name }: { id: string; name: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [id]);
  const src = PROVIDER_LOGOS[id];
  // A missing official asset stays a plain provider name, never an invented logo.
  return src && !failed ? <img className={styles.logo} data-provider={id} src={src} alt="" title={`${name} official provider mark`} onError={() => setFailed(true)} /> : null;
}

const confidence: Record<Confidence, string> = { verified_official: "Official source", reported: "Reported · confirm", regulatory_default: "Regulatory reference", unknown: "Unverified" };
const guidanceKeys = new Set(["claim_filing_method", "claim_report_deadline", "claim_decision_timeline", "identity_verification_on_call", "appeal_method", "appeal_window_days"]);

export function ProviderDetails({ insurer }: { insurer: InsurerLookup }) {
  const contacts = Array.isArray(insurer.contacts) ? insurer.contacts : [];
  const terms = (Array.isArray(insurer.terms) ? insurer.terms : []).filter((term) => guidanceKeys.has(term.key) && term.value);
  const questions = Array.isArray(insurer.openQuestions) ? insurer.openQuestions : [];
  return <div className={styles.details}>
    <div className={styles.providerHeading}><ProviderMark key={insurer.id} id={insurer.id} name={insurer.name} /><h3>{insurer.name}</h3>{providerUrl(insurer.website) ? <a href={providerUrl(insurer.website)} target="_blank" rel="noreferrer">Website ↗</a> : null}</div>
    {insurer.needsPlanOrRegion ? <p className={styles.notice}>Confirm your plan and region before choosing a contact.</p> : null}
    <ProviderLibrary key={insurer.id} insurer={insurer} />
    <details className={styles.section}><summary>Contacts <span>{contacts.length}</span></summary>
      {contacts.length ? <ul>{contacts.map((contact, index) => <li key={index}>
        <strong>{words(contact.purpose)}</strong><span className={styles.scope}>{words(contact.scope)}{contact.region ? ` · ${contact.region}` : ""}</span>
        {contact.phoneE164 ? <p>{formatPhone(contact.phoneE164)}</p> : null}
        {providerUrl(contact.url) ? <a href={providerUrl(contact.url)} target="_blank" rel="noreferrer">{contact.channel === "web" ? "Open contact page ↗" : "Contact instructions ↗"}</a> : null}
        {contact.notes ? <p>{contact.notes}</p> : null}{contact.hours ? <p>{contact.hours}</p> : null}
        {contact.purposeVerified === false ? <p className={styles.notice}>Contact purpose is unverified.</p> : null}
        <Source url={contact.sourceUrl} date={contact.retrievedAt} confidence={contact.confidence} />
      </li>)}</ul> : <p className={styles.note}>No contacts recorded. Check the provider website or your policy.</p>}
    </details>
    <details className={styles.section}><summary>Claim guidance <span>{terms.length}</span></summary>
      {terms.length ? <ul>{terms.map((term, index) => <li key={index}><strong>{words(term.key)}</strong><span className={styles.scope}>{words(term.line)}{term.jurisdictionScope ? ` · ${term.jurisdictionScope}` : ""}</span><p>{term.value}</p>{term.notes ? <p>{term.notes}</p> : null}<Source url={term.sourceUrl} date={term.retrievedAt} confidence={term.confidence} /></li>)}</ul> : <p className={styles.note}>No claim guidance recorded. Check your policy or contact the provider.</p>}
    </details>
    {questions.length ? <details className={styles.section}><summary>To confirm <span>{questions.length}</span></summary><ul>{questions.map((question, index) => <li key={index}><strong>{question.question}</strong><p>{question.whyItMatters}</p></li>)}</ul></details> : null}
  </div>;
}

function Source({ url, date, confidence: level }: { url: string | null; date: string | null; confidence: Confidence }) {
  return <p className={styles.source}>{providerUrl(url) ? <a href={providerUrl(url)} target="_blank" rel="noreferrer">{confidence[level] ?? "Unverified"} ↗</a> : <span>{confidence[level] ?? "Unverified"}</span>}<span>{date ? `Checked ${date}` : "Date unknown"}</span></p>;
}
function words(value: string) { const text = value.replaceAll("_", " "); return text.charAt(0).toUpperCase() + text.slice(1); }
