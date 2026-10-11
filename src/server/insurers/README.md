# Insurer knowledge base (T2 / case engine)

Reference data for the refund/claims voice agent: 33 US insurers (auto, life,
title/property, health, disability, business, pet, travel) with their support
lines and the terms that matter on a call — cancellation and refund method,
free-look, billing-dispute route, grace period, claim filing and timelines,
appeal process, identity checks, arbitration clause.

Every fact carries `sourceUrl`, `retrievedAt` and a confidence:

| confidence | meaning | may the agent dial / state it? |
| --- | --- | --- |
| `verified_official` | read from a page on the insurer's own domain | review customer applicability and authorization first |
| `reported` | third-party source | only after the customer confirms it |
| `regulatory_default` | a legal/regulatory figure, not the insurer's statement | state it as "typically" |
| `unknown` | nothing found; `value` is `null` | no — ask the customer or the rep |

Unknown facts are null, never guessed. Phone numbers are strict US E.164 and the
loader rejects the whole seed if one is not.

## Use it

```ts
import { lookupInsurer, getRegulatoryDefaults, listInsurers, listOpenQuestions } from "@/server/insurers";

const hit = lookupInsurer("Anthem Blue Cross"); // exact name, alias or token match; null when unknown or ambiguous
if (hit) {
  hit.supportPhone;            // national customer-service line in E.164, or null
  hit.supportPhoneConfidence;  // "verified_official" | "reported" | null
  hit.claimsPhone;             // national claims line, or null
  hit.needsPlanOrRegion;       // true => the right number is on the member's ID card or depends on state; ask before dialing
  hit.contacts;                // every line incl. regional/plan_specific/corporate_only ones (scope + region fields)
  hit.terms;                   // [{ line, key, value, valueNumber, unit, jurisdictionScope, notes, sourceUrl, confidence }]
  hit.openQuestions;           // what a human still needs to confirm for this insurer
}
getRegulatoryDefaults("health"); // fallbacks: ACA 180-day appeal window, Medicare Advantage 65 days, Medigap 30-day free look, Reg E 60-day card dispute...
```

Rules for callers:

- Treat `supportPhone` as a review candidate, not authorization to call. Confirm the exact insurer, product/plan, region and contact purpose before including it in the case's approved destination. `supportPhoneConfidence === "verified_official"` establishes source provenance, not applicability to the customer.
- Multiple equally ranked, distinct national numbers produce a null phone and `needsPlanOrRegion=true`. Unknown or regulatory-default confidence never supplies a phone candidate. A false flag is not proof that a contact fits the customer's plan; read the contact notes and confirm applicability.
- Never pick a number out of `contacts` whose `scope` is not `"national"` without the customer's region/plan.
- When building the call brief, include each relevant term's `value` with its confidence; a `regulatory_default` is a "typically" statement, not the insurer's policy.
- Treat `openQuestions` as the to-do list for sharpening the data.

The read-only API does not automatically populate case facts or call briefs.
Customer review and the existing frozen case authorization remain required.
The source seed is preserved; `national` may describe geographic reach while
contact notes still restrict the product or plan. Name/alias collisions and
token matches spanning multiple insurers return null (HTTP 404) for clarification.

## Files

- `seed/insurers.json` — source of truth (human-editable). `seed/regulatory-defaults.json` — legal fallbacks by line.
- `db.ts` — builds `insurers.sqlite` under `DATA_DIR` on first use; reloads only when the seed changes.
- `index.ts` — the API above. `types.ts` — shapes and enums.
- `tests/backend/insurers.test.ts` — seed validation, lookup behaviour, no auto-fill of regional numbers.
- `docs/insurer-terms.md` — generated human-readable coverage report (do not edit by hand; run `python3 -I scripts/insurers/gendoc.py .`).
- `scripts/insurers/merge.py` — rebuilds the seed from research JSON and applies phone re-verification verdicts (`scripts/insurers/verdicts-2026-10-11.json`).
- `src/app/api/insurers/route.ts` — `GET /api/insurers` (list) and `GET /api/insurers?name=` (lookup, 404 when unknown or ambiguous).

HTTP: `GET /api/insurers` returns `{ insurers: InsurerSummary[] }` for the plan-onboarding pick-list; `GET /api/insurers?name=Geico` returns `{ insurer: InsurerLookup }` (the shape above), 404 `NOT_FOUND` when unknown or ambiguous.
