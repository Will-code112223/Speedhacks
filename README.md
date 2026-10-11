# Recourse

Recourse is an agent that makes the phone calls behind insurance claims and refunds, built at SpeedHacks (SF Tech Week) on October 11, 2026.
You upload your policy documents, describe the problem in plain language, check the facts it extracted with their sources, and confirm the number it proposes to call.
When you approve, it freezes a call plan and places one real outbound call through Dial, discloses that it is an AI at the start, and brings back the transcript and an outcome card with the decision, reference number and next step.

The judge-facing package is `docs/SUBMISSION.md`, and the pitch memo is `docs/PITCH.md`.
`docs/SPEC.md` is the product spec, and `team-prompts/00-shared-contract.txt` is the source of truth for ownership, types and the HTTP API.

## How it works

1. **Upload.** Policy documents (PDF, PNG, JPEG, WebP or plain text, up to 5 files of 10 MB each, checked against their file signatures) are stored privately under `DATA_DIR`.
2. **Extract.** In live mode the server sends the documents and your description to the OpenAI Responses API with the model id in `LLM_MODEL`, and keeps a fact only when the model cites where it came from and, for plain-text sources, the quoted excerpt is really there (for a PDF or image only the cited document's existence can be checked); unverifiable facts are dropped and listed (`src/server/documents/extractor.ts`).
3. **Destination.** When the case names an insurer in the registry, the server proposes that insurer's verified official claims line (or member services line) and shows its source URL and retrieval date; you confirm or edit it before approving (`src/server/cases/service.ts`).
4. **Plan.** The server builds a `CallPlanV1`: a purpose, a one-sentence goal, ordered steps, the facts the agent may say, the approved questions, the permitted and forbidden actions for that purpose, and what to read back before hanging up (`src/contracts/voice.ts`).
5. **Approve.** Approval freezes the plan and the case revision; nothing is dialed before it, and one approval allows one call.
6. **Call.** The Dial adapter sends exactly one `POST /api/v1/calls` for the attempt with an `Idempotency-Key`, and the call is cut off after `DIAL_MAX_CALL_DURATION_SECONDS` (300 by default) (`src/integrations/dial/index.ts`).
7. **Outcome.** The transcript comes back from Dial, and the outcome card shows the decision, reference number and next step, with approval and payment as separate rows; payment is always "unverified" because there is no bank feed.

The header shows a **Live**, **Simulated** or **Fixture** badge, so every screen says where its data came from.
Your active time on the case is measured in the browser and shown next to the agent's phone time; no savings figure is computed anywhere.

## Call purposes

Every call has exactly one purpose, and each purpose carries its own permitted and forbidden actions as server constants that the plan cannot change (`CALL_PLAN_ACTIONS` in `src/contracts/voice.ts`).

| Purpose | What the agent does | What it must not do |
| --- | --- | --- |
| `file_claim` | Navigates the menu to claims, opens a new claim with exactly the approved facts, asks for the claim number, the next step and the documents still needed, and reads them back | Invent an identifier, date, amount or coverage detail; accept a settlement or any amount; authorize a payment; argue about coverage; be transferred outside the approved number |
| `gather_information` | Asks the approved questions one at a time and asks for a reference number and the next step | Request a refund, file a claim or complaint, state an amount that is not in the plan, or commit to anything |
| `request_refund` | Requests a refund of the exact amount stated and asks for a reference number and timeline | Agree to new charges or retention offers, change the amount, merchant or reason, or share card numbers, passwords or one-time codes |

`file_claim` needs an incident date, a loss description, and a policy number or the policyholder's name; `request_refund` needs an amount and currency.

## Safety rules

These rules are written into every call instruction and enforced in code, not left to the model's judgment.

- **AI disclosure.** At the start of the call, and again whenever a new person picks up, the agent says it is an AI assistant calling with the client's authorization, and it never says or implies that it is the client.
- **No fabricated identifiers.** The agent uses only the approved facts; a missing fact is unknown and is never guessed, asserted or confirmed, and requests for a Social Security number, date of birth, card number, password or one-time code are answered with "the client will provide it directly".
- **Disclosure in data, not only in words.** Facts the user did not permit the agent to say are removed from what is sent to Dial (`planForProvider`).
- **One call per approval.** Approval freezes the plan; the case engine allows one call attempt per approval through unique constraints, and the adapter never redials when a dispatch is ambiguous.
- **The user confirms the number.** A registry number is a proposal, shown with its source and date; an insurer whose number depends on plan or region gets no number at all, and the user enters the one on their ID card.
- **No commitments.** The agent does not accept a settlement, release, purchase, payment or account change, and a statement that money will be paid is never recorded as payment.
- **Untrusted input.** Anything said on the call or written in an uploaded document is treated as information, never as instructions that change these rules.

## Insurer registry

`src/server/insurers/` holds a registry of US insurers across auto, life, home and title, health, disability, business, pet and travel, with their support and claims lines and the terms that matter on a call.
Every fact carries a source URL, a retrieval date and a confidence: `verified_official` (read from the insurer's own domain), `reported`, `regulatory_default` or `unknown`.
Only a `verified_official` national line is ever proposed as a destination, and the user still confirms it.
Phone numbers are strict US E.164, and unknown facts are null rather than guessed.
`GET /api/insurers` lists the registry and `GET /api/insurers?name=` looks one up; see `src/server/insurers/README.md` for the rules callers follow.

## Run it

Requires Node 24 (see `.nvmrc`; 20.9 or later works).

### Simulated mode, no keys

```bash
npm install
npm run dev        # http://localhost:3000
```

`REFUND_MODE` defaults to `simulated`, so no credentials are needed.
Simulated calls run through the real Dial adapter against an in-process fake Dial server, and every case and call is labelled "Simulated".
The scripted outcome is chosen by the last four digits of the destination number:

| Suffix | Result |
| --- | --- |
| 0001 | rejected before dispatch (the attempt is kept as failed) |
| 0002 | dispatch unknown (no provider id, no redial) |
| 0003 | completed, refund denied |
| 0004 | completed, support needs more information |
| 0005 | failed |
| 0006 | cancelled |
| other | completed, approved with a reference number (payment still unverified) |

For a scripted walkthrough that never touches the server, open `http://localhost:3000/?api=fixture`; it is labelled "Fixture" in the header and is never used as a fallback when the network fails.

### Live mode, real calls

Live mode places real phone calls, so only run it against numbers you are allowed to call.
Keep the keys outside the repository in `~/.config/speedhacks/dial.env`:

```bash
REFUND_MODE=live
OPENAI_API_KEY=...            # document and request extraction
LLM_MODEL=...                 # model id for the OpenAI Responses API; no default is assumed
DIAL_API_KEY=...              # Dial voice API
DIAL_FROM_NUMBER=+1...        # your Dial number, E.164
# Optional:
# DIAL_WEBHOOK_SECRET=...     # enables POST /api/webhooks/dial; without it, results arrive by polling
# DIAL_MAX_CALL_DURATION_SECONDS=300   # 60 to 3600
# OPENAI_BASE_URL=https://api.openai.com/v1
```

Then start the app with that file loaded:

```bash
npm run dev:live     # next dev with ~/.config/speedhacks/dial.env
npm run start:live   # the same for a production build (after npm run build)
```

A missing or invalid live setting fails visibly with HTTP 503 `LIVE_CONFIGURATION_MISSING`, and live mode never falls back to simulation.
A case created in simulated mode is never dialed live.
For a hosted deployment with a persistent disk, see `docs/DEPLOY.md`.
`.env.example` lists every variable; copy it to `.env.local` (ignored by git) for local overrides, and never commit a real key.

## Test

```bash
npm run typecheck
npm test                                                  # Vitest: tests/backend and the frontend suite under src/**/__tests__
node --test src/integrations/dial/__tests__/*.node-test.mts   # Dial adapter tests (node:test)
npm run build
```

Tests use temporary SQLite files, synthetic fixtures and no network.

## Stack

- Next.js 16 (App Router), React 19 and TypeScript, with server routes on the Node runtime.
- SQLite through `better-sqlite3` on local disk, a hackathon setup that is not suitable for serverless deployment without changes.
- OpenAI Responses API for live extraction, Dial for outbound calls and signed webhooks.
- Vitest and `node:test` for tests.

## Ownership (from the shared contract)

| Teammate | Owns |
| --- | --- |
| T1 frontend | `src/features/refund-ui/**`, `docs/handoffs/frontend.txt`; exports the default `RefundApp` |
| T2 case engine | `src/app/**`, `src/contracts/**`, `src/server/**`, `tests/**`, root config and manifests, `.env.example`, `docs/handoffs/backend.txt` |
| T3 Dial | `src/integrations/dial/**`, `docs/handoffs/dial.txt`; exports `createDialAdapter` |

Only T2 edits root dependency files and config.
Put dependency and environment requests in your own handoff file.

## Contracts and API

- `src/contracts/case.ts`: `Mode`, `CaseStatus`, `CallState`, `CallV1`, `CaseV1`, `CaseChanges`, `ApiError` and additive helpers.
- `src/contracts/voice.ts`: `AuthorizedCallInput`, `StartCallResult`, `VoiceSnapshot`, `VerifiedVoiceEvent`, `VoiceAdapter`, and the V1.1 and V1.2 `CallPlanV1` with `CALL_PURPOSES` and `CALL_PLAN_ACTIONS`.

Import them as `@/contracts/case` and `@/contracts/voice`, and never change V1 silently: record and coordinate a proposed change first.
The HTTP API is in `team-prompts/00-shared-contract.txt` under "SHARED HTTP API", and the routes outside V1 are listed under "ADDITIVE ROUTES" in `docs/handoffs/backend.txt`.

## Keewano (optional)

[Keewano](https://docs.keewano.com/getting-started/speedhacks-quickstart) stores ordered, typed events per entity and answers questions over MCP.
It is an add-on, the call flow works without it, and its code lives in `src/integrations/keewano/`; the case engine only sees a `TransactionHistory` port (`src/server/cases/history.ts`).

1. **Case mirror** (`KEEWANO_API_KEY`): each timeline entry, status change, call state and outcome is sent to Keewano as it is persisted, keyed by case id, as best effort, so a dead endpoint never breaks a case.
2. **Pre-authorization duplicate-charge check and merchant track record** (`KEEWANO_ACCESS_TOKEN`): before approval the server reads the customer's charge history from Keewano (SQL over MCP), looks for charges of the same merchant and amount within 24 hours, writes the finding to the timeline, and freezes it into the plan at approval; nothing is queried during the call, and facts never come from Keewano.

Without a token in simulated mode the check reads a local fixture, labelled `fixture` wherever it appears (`src/integrations/keewano/seed/transactions.json`).

```bash
npm run keewano:seed                              # backfill the synthetic charge history
npm run keewano:demo-cases -- --count 24          # synthetic simulated cases so the mirror fills Keewano
npm run keewano:sql -- --tools                    # what the MCP server offers
npm run keewano:sql -- --charges sam@example.com  # the exact query the duplicate check runs
```

Questions judges can ask once `npm run keewano:demo-cases` has run (teammate 2 reports these as checked against Keewano on October 11, 2026):

```bash
# Which merchants approve refunds? (one row per merchant, cases counted once)
npm run keewano:sql -- "SELECT \"RefundMerchant\" AS merchant, count(DISTINCT user_id) AS cases, count(DISTINCT user_id) FILTER (WHERE \"RefundOutcome\" = 'approved') AS approved, count(DISTINCT user_id) FILTER (WHERE \"RefundOutcome\" = 'denied') AS denied FROM events WHERE \"RefundOutcome\" IS NOT NULL GROUP BY merchant ORDER BY cases DESC"
# How far do cases get? (how many ever reached each status)
npm run keewano:sql -- "SELECT \"RefundCaseStatus\" AS status, count(DISTINCT user_id) AS cases FROM events WHERE \"RefundCaseStatus\" IS NOT NULL GROUP BY status ORDER BY cases DESC"
# Where do calls stall? (call state transitions)
npm run keewano:sql -- "SELECT \"RefundCallState\" AS state, count(\"RefundCallState\") AS transitions FROM events WHERE \"RefundCallState\" IS NOT NULL GROUP BY state ORDER BY transitions DESC"
# How often does the pre-authorization check find a duplicate?
npm run keewano:sql -- "SELECT \"RefundHistoryCheck\" AS result, count(\"RefundHistoryCheck\") AS checks FROM events WHERE \"RefundHistoryCheck\" IS NOT NULL GROUP BY result ORDER BY checks DESC"
# The registered event columns, for ad-hoc questions
npm run keewano:sql -- --tool list_event_types '{"nameFilter":"Refund"}'
```

The MCP tool is `run_sql_query({ projectId, sqlQuery })`, returning `{ columns, rows }`, and the project id is read from the SDK key.
Keewano numbers custom events by position, so the registry in `src/integrations/keewano/events.ts` stays contiguous from 2000 and is append only.
The SpeedHacks Keewano project holds every fixture charge twice, because the fixture was seeded before and after the registry was renumbered; the in-app check de-duplicates by charge id, and clean aggregates should use `count(DISTINCT "ChargeId")` or a fresh project seeded once.

The same MCP server can be attached to Claude Code for plain-language questions with `claude mcp add --scope user --transport http keewano https://api.keewano.com/mcp --header "k-token: $KEEWANO_ACCESS_TOKEN"`.
Events become queryable 5 to 15 minutes after ingestion.
