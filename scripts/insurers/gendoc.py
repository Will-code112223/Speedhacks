"""Render docs/insurer-terms.md from the seed. Usage: python3 -I gendoc.py <repo_root>"""
import json, os, sys
repo = sys.argv[1]
seed_dir = os.path.join(repo, "src", "server", "insurers", "seed")
ins = json.load(open(os.path.join(seed_dir, "insurers.json")))
defaults = json.load(open(os.path.join(seed_dir, "regulatory-defaults.json")))
ORDER = {"verified_official": 0, "reported": 1, "regulatory_default": 2, "unknown": 3}
CAT_TITLES = [("auto","Auto"),("life","Life"),("property","Real estate, title and property"),("health","Health and medical"),
  ("disability","Disability and income protection"),("business","Business and commercial"),("pet","Pet"),("travel","Travel")]
KEY_ORDER = ["free_look_days","cancellation_method","cancellation_refund_method","cancellation_fee","premium_refund_timeline",
  "billing_dispute_process","grace_period_days","waiting_period_days","claim_filing_method","claim_report_deadline",
  "claim_decision_timeline","appeal_method","appeal_window_days","external_review","identity_verification_on_call","arbitration_clause"]

def best(c, purpose):
  cs = sorted([x for x in c["contacts"] if x["purpose"] == purpose and x["phoneE164"] and x["scope"] == "national" and x.get("purposeVerified") is not False], key=lambda x: (ORDER[x["confidence"]], 0 if x.get("purposeVerified") else 1))
  return cs[0] if cs else None
def non_national(c):
  return [x for x in c["contacts"] if x["phoneE164"] and (x["scope"] != "national" or x.get("purposeVerified") is False)]
def fmt_phone(x):
  if not x: return "not verified"
  tag = x['confidence'].replace('_',' ') + (", re-verified" if x.get("purposeVerified") else "")
  return f"{x['phoneE164']} ({tag})"
def md(s): return (s or "").replace("|", "\\|").replace("\n", " ")

out = []
out.append("# Insurer terms knowledge base\n")
out.append("Generated from `src/server/insurers/seed/insurers.json` and `regulatory-defaults.json` (retrieved 2026-10-11). Do not edit by hand; edit the seed and run `python3 -I scripts/insurers/gendoc.py .` from the repo root.\n")
out.append("Confidence: **verified official** = read from the insurer's own site (URL in seed); **reported** = third-party, confirm before dialing; **regulatory default** = legal figure, not the insurer's statement; **unknown** = nothing found, value is null.\n")
tot = len(ins); vo = sum(1 for c in ins if best(c,"customer_service") and best(c,"customer_service")["confidence"]=="verified_official")
rep = sum(1 for c in ins if best(c,"customer_service") and best(c,"customer_service")["confidence"]=="reported")
out.append("## Coverage\n")
out.append("| Metric | Count |\n| --- | --- |")
out.append(f"| Insurers | {tot} |")
out.append(f"| Customer-service number verified on official site | {vo} |")
out.append(f"| Customer-service number only reported (confirm before dialing) | {rep} |")
out.append(f"| No usable customer-service number | {tot - vo - rep} |")
out.append(f"| Term facts with a value | {sum(1 for c in ins for t in c['terms'] if t['value'] is not None)} |")
out.append(f"| Term facts recorded as unknown | {sum(1 for c in ins for t in c['terms'] if t['value'] is None)} |")
out.append(f"| Phone lines re-verified on their cited page | {sum(1 for c in ins for x in c['contacts'] if x.get('purposeVerified'))} |")
out.append(f"| Phone lines failing re-verification (never auto-dialed) | {sum(1 for c in ins for x in c['contacts'] if x.get('purposeVerified') is False)} |")
out.append(f"| Phone lines marked verified official but NOT re-checked | {sum(1 for c in ins for x in c['contacts'] if x['phoneE164'] and x['confidence'] == 'verified_official' and x.get('purposeVerified') is None)} |")
out.append(f"| Regulatory defaults | {len(defaults)} |")
out.append(f"| Open questions | {sum(len(c['openQuestions']) for c in ins)} |\n")

for cat, title in CAT_TITLES:
  group = [c for c in ins if cat in c["categories"] and (c["categories"][0] == cat)]
  if not group: continue
  out.append(f"## {title}\n")
  for c in group:
    out.append(f"### {c['name']}" + (f" (part of {c['parentId']})" if c["parentId"] else "") + "\n")
    out.append(f"- Lines: {', '.join(c['lines'])}" + (f". Eligibility: {md(c['eligibility'])}" if c["eligibility"] else ""))
    out.append(f"- Customer service: {fmt_phone(best(c,'customer_service'))}")
    cl = best(c, "claims")
    if cl: out.append(f"- Claims: {fmt_phone(cl)}")
    for p in ("billing","cancellation","appeals"):
      x = best(c, p)
      if x: out.append(f"- {p.capitalize()}: {fmt_phone(x)}")
    nn = non_national(c)
    if nn:
      out.append("- Other lines (not auto-dialed): " + "; ".join(f"{x['phoneE164']} [{x['scope'].replace('_',' ')}{': ' + x['region'] if x['region'] else ''}, {x['purpose'].replace('_',' ')}{', purpose unconfirmed' if x.get('purposeVerified') is False else ''}]" for x in nn))
    if c["tosUrl"]: out.append(f"- Terms of use: {c['tosUrl']}")
    out.append("")
    terms = sorted(c["terms"], key=lambda t: (KEY_ORDER.index(t["key"]) if t["key"] in KEY_ORDER else 99))
    if terms:
      out.append("| Term | Line | Value | Confidence | Source |\n| --- | --- | --- | --- | --- |")
      for t in terms:
        val = t["value"] if t["value"] is not None else "unknown"
        if t["valueNumber"] is not None and t["unit"]: val = f"{t['valueNumber']} {t['unit']}" + (f" ({md(t['value'])})" if t["value"] else "")
        note = f" — {md(t['notes'])}" if t["notes"] else ""
        src = f"[source]({t['sourceUrl']})" if t["sourceUrl"] else ""
        out.append(f"| {t['key']} | {t['line']} | {md(val)}{note} | {t['confidence'].replace('_',' ')} | {src} |")
      out.append("")
    if c["openQuestions"]:
      out.append("Open questions:")
      for q in c["openQuestions"]: out.append(f"- {md(q['question'])} *(why: {md(q['whyItMatters'])})*")
      out.append("")

out.append("## Regulatory defaults (fallbacks when an insurer publishes nothing)\n")
out.append("| Line | Jurisdiction | Term | Value | Confidence | Source |\n| --- | --- | --- | --- | --- | --- |")
for d in defaults:
  val = d["value"]
  note = f" — {md(d['notes'])}" if d["notes"] else ""
  out.append(f"| {d['line']} | {md(d['jurisdiction'])} | {d['key']} | {md(val)}{note} | {d['confidence'].replace('_',' ')} | [source]({d['sourceUrl']}) |")
out.append("")
open(os.path.join(repo, "docs", "insurer-terms.md"), "w").write("\n".join(out))
print("wrote docs/insurer-terms.md")
