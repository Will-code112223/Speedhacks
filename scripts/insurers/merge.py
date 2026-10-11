"""Merge research JSON (per-category arrays and/or <group>/<id>.json objects) into the insurer seed,
apply phone re-verification verdicts, validate, and print coverage.

Usage: python3 -I scripts/insurers/merge.py <research_dir> <repo_root> [verdicts.json]
The 2026-10-11 research inputs were session-scoped; the committed seed is now the source of truth.
Edit the seed directly for small fixes, or feed new research through this script.
"""
import json, os, re, sys
from collections import OrderedDict

research_dir, repo = sys.argv[1], sys.argv[2]
verdicts_path = sys.argv[3] if len(sys.argv) > 3 else None
VERDICTS = {}  # (insurer id, phone, purpose) -> {confirmed, note}
ABSENT_RE = re.compile(r"does not appear|do not appear|not appear on|unreachable|not on (the|this|that) page|could not be fetched|404|403|not found on", re.I)
if verdicts_path and os.path.exists(verdicts_path):
  for v in json.load(open(verdicts_path)):
    VERDICTS[(v["id"], v["phoneE164"], v["purpose"])] = {"confirmed": bool(v.get("confirmed")), "note": v.get("note") or ""}
E164 = re.compile(r"^\+1\d{10}$")
CONF = {"verified_official", "reported", "regulatory_default", "unknown"}
PURPOSES = {"customer_service", "claims", "billing", "cancellation", "appeals"}
CHANNELS = {"phone", "web", "app", "mail"}
TERM_KEYS = {"free_look_days","cancellation_method","cancellation_refund_method","cancellation_fee","cancellation_notice_days",
  "premium_refund_timeline","billing_dispute_process","grace_period_days","waiting_period_days","claim_filing_method",
  "claim_report_deadline","claim_decision_timeline","appeal_method","appeal_window_days","external_review","external_review_window",
  "identity_verification_on_call","arbitration_clause"}
CATEGORY_FILES = ["auto", "life", "property", "health", "disability-business", "specialty"]
ALIASES = {
  "state-farm": ["State Farm Insurance", "State Farm Mutual", "StateFarm"],
  "geico": ["Geico Insurance", "Government Employees Insurance Company"],
  "progressive": ["Progressive Insurance", "Progressive Casualty"],
  "allstate": ["Allstate Insurance", "All State"],
  "usaa": ["United Services Automobile Association", "USAA Insurance"],
  "liberty-mutual": ["Liberty Mutual Insurance", "Liberty"],
  "northwestern-mutual": ["Northwestern Mutual Life", "NM"],
  "new-york-life": ["New York Life Insurance", "NY Life", "NYL"],
  "prudential": ["Prudential Financial", "Prudential Insurance", "Pru"],
  "lincoln-financial": ["Lincoln Financial Group", "Lincoln National", "LFG", "Lincoln Life"],
  "massmutual": ["Mass Mutual", "Massachusetts Mutual Life"],
  "mutual-of-omaha": ["Mutual of Omaha Insurance", "United of Omaha"],
  "first-american-title": ["First American", "First American Financial", "FATCO"],
  "fidelity-national-financial": ["FNF", "Fidelity National Financial Inc"],
  "chicago-title": ["Chicago Title Insurance", "Chicago Title Company"],
  "commonwealth-land-title": ["Commonwealth Land Title Insurance", "Commonwealth Title"],
  "fidelity-national-title": ["Fidelity National Title Insurance", "Fidelity Title"],
  "travelers": ["Travelers Insurance", "The Travelers Companies", "Travelers Indemnity"],
  "chubb": ["Chubb Insurance", "Chubb Group", "Federal Insurance Company"],
  "unitedhealthcare": ["United Healthcare", "UnitedHealth Group", "UHC", "United Health"],
  "elevance-health": ["Anthem", "Anthem Blue Cross", "Anthem Blue Cross Blue Shield", "Anthem BCBS", "Elevance"],
  "aetna": ["Aetna CVS Health", "CVS Health Aetna", "Aetna Health"],
  "cigna": ["Cigna Healthcare", "The Cigna Group"],
  "kaiser-permanente": ["Kaiser", "KP", "Kaiser Foundation Health Plan"],
  "humana": ["Humana Insurance", "Humana Health"],
  "unum": ["Unum Group", "Unum Insurance"],
  "principal-financial": ["Principal", "Principal Financial Group", "Principal Life"],
  "guardian-life": ["Guardian", "The Guardian Life Insurance Company of America"],
  "the-hartford": ["Hartford", "Hartford Insurance", "Hartford Financial"],
  "cna": ["CNA Financial", "CNA Insurance", "Continental Casualty"],
  "trupanion": ["Trupanion Pet Insurance"],
  "healthy-paws": ["Healthy Paws Pet Insurance", "HealthyPaws"],
  "allianz-global-assistance": ["Allianz", "Allianz Travel", "Allianz Travel Insurance", "Allianz Partners", "AGA"],
}

EXTRA_DOMAINS = {
  # Subdomains are matched automatically; list only distinct official hosts here.
  "elevance-health": ["anthem.com", "elevancehealth.com"],
  "kaiser-permanente": ["kp.org", "kaiserpermanente.org", "healthy.kaiserpermanente.org"],
  "lincoln-financial": ["lfg.com", "lincolnfinancial.com"],
  "allianz-global-assistance": ["allianztravelinsurance.com", "allianzpartners.com", "allianz.com"],
  "aetna": ["aetna.com", "aetnamedicare.com"],
  "unitedhealthcare": ["uhc.com", "unitedhealthgroup.com", "myuhc.com"],
  "humana": ["humana.com"],
  "cigna": ["cigna.com", "thecignagroup.com"],
  "healthy-paws": ["healthypawspetinsurance.com", "healthypaws.com"],
  "usaa": ["usaa.com"],
  "geico": ["geico.com"],
  # FNF brands: the parent's site is the official source for shared claims-center numbers.
  "chicago-title": ["chicagotitle.com", "fnf.com"],
  "commonwealth-land-title": ["cltic.com", "fnf.com"],
  "fidelity-national-title": ["fntic.com", "fnf.com"],
}
from urllib.parse import urlparse
def is_official(url, domains):
  try: host = (urlparse(url).hostname or "").lower()
  except Exception: return False
  return any(host == d.lower() or host.endswith("." + d.lower()) for d in domains)

log = []
def warn(msg): log.append(msg)

def s(v):
  if v is None: return None
  v = str(v).strip()
  return v if v else None

def num(v):
  if v is None or v == "": return None
  try: return float(v) if not float(v).is_integer() else int(float(v))
  except Exception: return None

# Hand-reviewed scope overrides: (insurer id, phone) -> (scope, region)
SCOPE_OVERRIDES = {
  ("aetna", "+18008723862"): ("corporate_only", None),      # corporate contact center; cannot access member accounts
  ("aetna", "+18887923862"): ("plan_specific", None),       # pharmacy/general member line; billing lives on the ID-card number
  ("first-american-title", "+18008543643"): ("national", None),
}
REGION_RE = re.compile(r"^\s*REGION:\s*([^.]+?)(?:\s+(?:Member|Medicare|main|Membership|Spanish|\(|per|Southern|Mid))", re.I)
def infer_scope(cid, purpose, phone, notes):
  if phone and (cid, phone) in SCOPE_OVERRIDES: return SCOPE_OVERRIDES[(cid, phone)]
  n = (notes or "")
  m = re.match(r"^\s*REGION:\s*(.+?)(?:\.|$)", n, re.I)
  if m:
    region = m.group(1).strip()
    # Keep only the geographic part before descriptors like "Member Services".
    region = re.split(r"\s+(?:Member|Medicare|main|Membership|Spanish|Medicare)", region, 1)[0].strip(" .")
    return ("regional", region or "unspecified")
  low = n.lower()
  if "cannot access member account" in low or "cannot access account" in low: return ("corporate_only", None)
  if "id card" in low and phone is None: return ("plan_specific", None)
  if "state- and plan-specific" in low or "plan-specific number" in low: return ("plan_specific", None)
  return ("national", None)

def clean_contact(cid, c, idx, domains):
  purpose = s(c.get("purpose")); channel = s(c.get("channel")) or "phone"
  if purpose not in PURPOSES: warn(f"{cid} contact[{idx}] purpose {purpose!r} -> customer_service"); purpose = "customer_service"
  if channel not in CHANNELS: warn(f"{cid} contact[{idx}] channel {channel!r} -> phone"); channel = "phone"
  conf = s(c.get("confidence")) or "unknown"
  if conf not in CONF: warn(f"{cid} contact[{idx}] confidence {conf!r} -> reported"); conf = "reported"
  phone = s(c.get("phoneE164")); notes = s(c.get("notes"))
  if phone and not E164.match(phone):
    digits = re.sub(r"\D", "", phone)
    if len(digits) == 10: phone = "+1" + digits
    elif len(digits) == 11 and digits.startswith("1"): phone = "+" + digits
    else:
      warn(f"{cid} contact[{idx}] phone {phone!r} not E.164 -> null (kept in notes)")
      notes = (f"raw number: {phone}. " + (notes or "")).strip(); phone = None
  src = s(c.get("sourceUrl"))
  if conf != "unknown" and not src: warn(f"{cid} contact[{idx}] no sourceUrl -> confidence unknown"); conf = "unknown"
  if conf == "verified_official" and src and not is_official(src, domains):
    warn(f"{cid} contact[{idx}] {purpose} verified_official but source host not official ({src}) -> reported"); conf = "reported"
  purpose_verified = None
  vd = VERDICTS.get((cid, phone, purpose)) if phone else None
  if vd is not None:
    if vd["confirmed"]:
      purpose_verified = True
    elif ABSENT_RE.search(vd["note"]):
      warn(f"{cid} contact[{idx}] {purpose} {phone} not on cited page -> reported, purposeVerified=false"); conf = "reported"; purpose_verified = False
      notes = (f"re-verification 2026-10-11: {vd['note'][:300]} " + (notes or "")).strip()
    else:
      warn(f"{cid} contact[{idx}] {purpose} {phone} digits present but label does not fit purpose -> purposeVerified=false"); purpose_verified = False
      notes = (f"re-verification 2026-10-11 (label mismatch): {vd['note'][:300]} " + (notes or "")).strip()
  if channel == "phone" and phone is None and not notes: notes = "number not published or not verified"
  scope, region = infer_scope(cid, purpose, phone, notes)
  return OrderedDict(purpose=purpose, channel=channel, scope=scope, region=region, purposeVerified=purpose_verified, phoneE164=phone, hours=s(c.get("hours")), url=s(c.get("url")),
    notes=notes, sourceUrl=src, retrievedAt=s(c.get("retrievedAt")) or "2026-10-11", confidence=conf)

def clean_term(cid, t, idx, lines):
  key = s(t.get("key"))
  if key not in TERM_KEYS: warn(f"{cid} term[{idx}] unknown key {key!r} -> dropped"); return None
  conf = s(t.get("confidence")) or "unknown"
  if conf not in CONF: warn(f"{cid} term[{idx}] confidence {conf!r} -> reported"); conf = "reported"
  value = s(t.get("value")); src = s(t.get("sourceUrl"))
  if value is not None and not src and conf != "unknown":
    warn(f"{cid} term[{idx}] {key} value without sourceUrl -> value moved to notes, confidence unknown")
    t["notes"] = (f"unsourced: {value}. " + (s(t.get("notes")) or "")).strip(); value = None; conf = "unknown"
  if conf == "unknown" and value is not None:
    t["notes"] = (f"unconfirmed: {value}. " + (s(t.get("notes")) or "")).strip(); value = None
  quote = s(t.get("sourceQuote"))
  if quote and len(quote.split()) >= 15: warn(f"{cid} term[{idx}] {key} quote too long -> dropped"); quote = None
  line = s(t.get("line")) or "all"
  if line != "all" and line not in lines: warn(f"{cid} term[{idx}] {key} line {line!r} not in lines -> all"); line = "all"
  return OrderedDict(line=line, key=key, value=value, valueNumber=num(t.get("valueNumber")), unit=s(t.get("unit")),
    jurisdictionScope=s(t.get("jurisdictionScope")), notes=s(t.get("notes")), sourceUrl=src, sourceQuote=quote,
    retrievedAt=s(t.get("retrievedAt")) or "2026-10-11", confidence=conf)

ORDER = {
  "auto": ["state-farm","geico","progressive","allstate","usaa","liberty-mutual"],
  "life": ["northwestern-mutual","new-york-life","prudential","lincoln-financial","massmutual","mutual-of-omaha"],
}
def load_group(f):
  """A category array file, or a directory of per-company objects, or both (per-company wins)."""
  out = OrderedDict()
  p = os.path.join(research_dir, f + ".json")
  if os.path.exists(p):
    with open(p) as fh:
      for c in json.load(fh): out[s(c.get("id"))] = c
  d = os.path.join(research_dir, f)
  if os.path.isdir(d):
    for name in sorted(os.listdir(d)):
      # Only <id>.json records; side files such as <id>.verify.json are agent scratch.
      if not name.endswith(".json") or name.count(".") != 1: continue
      with open(os.path.join(d, name)) as fh:
        try: c = json.load(fh)
        except Exception as e: warn(f"{f}/{name} unreadable: {e}"); continue
      if isinstance(c, list): c = c[0] if c else None
      if not c or not s(c.get("id")): warn(f"{f}/{name} has no id -> skipped"); continue
      cid = s(c["id"])
      prev = out.get(cid)
      if prev:
        # Per-company (verified) record wins, but inherit any top-level field it left empty.
        for k in ("name", "legalName", "parentId", "categories", "lines", "eligibility", "website", "officialDomains", "tosUrl", "privacyUrl", "notes"):
          if (c.get(k) in (None, "", [])) and prev.get(k) not in (None, "", []):
            warn(f"{f}/{name}: {k} missing -> inherited from {f}.json"); c[k] = prev[k]
      out[cid] = c
  if not out: warn(f"MISSING research for group {f}"); return []
  if f in ORDER:
    missing = [i for i in ORDER[f] if i not in out]
    if missing: warn(f"{f}: no research for {', '.join(missing)}")
    return [out[i] for i in ORDER[f] if i in out] + [v for k, v in out.items() if k not in ORDER[f]]
  return list(out.values())

companies = []
for f in CATEGORY_FILES:
  data = load_group(f)
  for c in data:
    cid = s(c.get("id"))
    lines = [s(x) for x in (c.get("lines") or []) if s(x)]
    cats = [s(x) for x in (c.get("categories") or []) if s(x)]
    domains = sorted(set([s(x) for x in (c.get("officialDomains") or []) if s(x)] + EXTRA_DOMAINS.get(cid, [])))
    contacts = []
    seen = set()
    for i, x in enumerate(c.get("contacts") or []):
      cc = clean_contact(cid, x, i, domains)
      sig = (cc["purpose"], cc["channel"], cc["phoneE164"], cc["url"])
      if sig in seen: warn(f"{cid} contact[{i}] duplicate {sig[0]}/{sig[2] or sig[3]} -> dropped"); continue
      seen.add(sig); contacts.append(cc)
    terms = [t for t in (clean_term(cid, x, i, lines) for i, x in enumerate(c.get("terms") or [])) if t]
    qs = [OrderedDict(question=s(q.get("question")), whyItMatters=s(q.get("whyItMatters")) or "unspecified")
          for q in (c.get("openQuestions") or []) if s(q.get("question"))]
    companies.append(OrderedDict(id=cid, name=s(c.get("name")), legalName=s(c.get("legalName")), parentId=s(c.get("parentId")),
      categories=cats, lines=lines, aliases=ALIASES.get(cid, []), eligibility=s(c.get("eligibility")), website=s(c.get("website")),
      officialDomains=domains, tosUrl=s(c.get("tosUrl")), privacyUrl=s(c.get("privacyUrl")),
      notes=s(c.get("notes")), contacts=contacts, terms=terms, openQuestions=qs))

defaults = []
p = os.path.join(research_dir, "regulatory.json")
if os.path.exists(p):
  with open(p) as fh: data = json.load(fh)
  for i, d in enumerate(data):
    key = s(d.get("key"))
    if key not in TERM_KEYS: warn(f"regulatory[{i}] unknown key {key!r} -> dropped"); continue
    conf = s(d.get("confidence")) or "reported"
    if conf not in CONF: conf = "reported"
    if not s(d.get("value")) or not s(d.get("sourceUrl")): warn(f"regulatory[{i}] {key} missing value/source -> dropped"); continue
    quote = s(d.get("sourceQuote"))
    if quote and len(quote.split()) >= 15: quote = None
    defaults.append(OrderedDict(line=s(d.get("line")) or "all", jurisdiction=s(d.get("jurisdiction")) or "US", key=key, value=s(d.get("value")),
      valueNumber=num(d.get("valueNumber")), unit=s(d.get("unit")), notes=s(d.get("notes")), sourceUrl=s(d.get("sourceUrl")), sourceQuote=quote,
      retrievedAt=s(d.get("retrievedAt")) or "2026-10-11", confidence=conf))
else:
  warn("MISSING regulatory.json")

seed_dir = os.path.join(repo, "src", "server", "insurers", "seed")
with open(os.path.join(seed_dir, "insurers.json"), "w") as fh: json.dump(companies, fh, indent=2, ensure_ascii=False); fh.write("\n")
with open(os.path.join(seed_dir, "regulatory-defaults.json"), "w") as fh: json.dump(defaults, fh, indent=2, ensure_ascii=False); fh.write("\n")

print(f"companies: {len(companies)}  regulatory defaults: {len(defaults)}")
print("\nWARNINGS:"); print("\n".join(log) if log else "(none)")
print("\nCOVERAGE (support/claims phone confidence; terms with values / total; open questions):")
for c in companies:
  def best(purpose):
    cs = [x for x in c["contacts"] if x["purpose"] == purpose and x["phoneE164"] and x["scope"] == "national" and x["purposeVerified"] is not False]
    order = {"verified_official": 0, "reported": 1, "regulatory_default": 2, "unknown": 3}
    cs.sort(key=lambda x: order[x["confidence"]])
    return cs[0]["confidence"] if cs else "-"
  filled = sum(1 for t in c["terms"] if t["value"] is not None)
  print(f"  {c['id']:<30} support={best('customer_service'):<17} claims={best('claims'):<17} terms={filled}/{len(c['terms'])}  q={len(c['openQuestions'])}")
