# Speedhacks — Refund Assistant

Hackathon refund assistant. First scenario: a duplicate charge. Upload evidence, review the extracted facts, authorize one support call, then see the transcript and an evidence-backed outcome. Insurance is a later extension.

Team prompts and the shared contract live in `team-prompts/`. `team-prompts/00-shared-contract.txt` is the source of truth for ownership, types and the HTTP API.

## Stack

- Next.js (App Router) + TypeScript, npm, Node runtime for server routes
- Local SQLite (`better-sqlite3`) for persistence — a hackathon setup on local disk, **not** suitable for ephemeral/serverless deployment without changes
- Vitest for tests

## Setup

```bash
nvm use            # Node 24 (see .nvmrc; >=20.9 required)
npm install
cp .env.example .env.local   # simulated mode works with no credentials
npm run dev                  # http://localhost:3000
```

Scripts: `npm run dev`, `npm run build`, `npm start`, `npm run typecheck`, `npm test`.

## Ownership (from the shared contract)

| Teammate | Owns |
| --- | --- |
| T1 frontend | `src/features/refund-ui/**`, `docs/handoffs/frontend.txt` — exports default `RefundApp` |
| T2 case engine | `src/app/**`, `src/contracts/**`, `src/server/**`, `tests/**`, root config/manifests, `.env.example`, `docs/handoffs/backend.txt` |
| T3 dial | `src/integrations/dial/**`, `docs/handoffs/dial.txt` — exports `createDialAdapter` |

Only T2 edits root dependency files and config. Put dependency/env requests in your own handoff file.

## Canonical contracts

- `src/contracts/case.ts` — `Mode`, `CaseStatus`, `CallState`, `CallV1`, `CaseV1`, `CaseChanges`, `ApiError` (+ additive helpers)
- `src/contracts/voice.ts` — `AuthorizedCallInput`, `StartCallResult`, `VoiceSnapshot`, `VerifiedVoiceEvent`, `VoiceAdapter` (+ `INVALID_WEBHOOK`, `VoiceWebhookError`)

Import with `@/contracts/case` and `@/contracts/voice`. Never change V1 silently; record and coordinate a proposed change first.

## HTTP API (T2 implements, T1 consumes)

See `team-prompts/00-shared-contract.txt` → "SHARED HTTP API". Routes are under `src/app/api/**` and run on the Node runtime.

## Modes

`REFUND_MODE=simulated` (default) runs end to end with no credentials and labels everything as simulated. `REFUND_MODE=live` requires the provider configuration in `.env.example`; a missing value fails visibly (503) and never falls back to simulation.

Simulated call scenarios are chosen by the last four digits of the merchant support number:

| Suffix | Result |
| --- | --- |
| 0001 | rejected before dispatch (503, attempt kept as failed) |
| 0002 | dispatch_unknown (no provider id, no redial) |
| 0003 | completed, refund denied |
| 0004 | completed, support needs more information |
| 0005 | failed |
| 0006 | cancelled |
| other | completed, refund approved with a reference number (payment still unverified) |

## Testing

```bash
npm run typecheck
npm test          # tests/backend (T2 implementation) + tests/integration (verification)
npm run build
```

Tests use temporary SQLite files, synthetic fixtures and no network. See `docs/handoffs/backend.txt` for status, error codes and integration notes.

## Keewano (optional sponsor integration)

[Keewano](https://docs.keewano.com/getting-started/speedhacks-quickstart) stores ordered, typed events per entity and answers questions over MCP. It is an add-on: the refund flow works without it. Code lives in `src/integrations/keewano/`; the case engine only sees a `TransactionHistory` port (`src/server/cases/history.ts`).

Two uses, both one-way and both outside the call:

1. **Case mirror** (`KEEWANO_API_KEY`): every timeline entry, derived status change, merchant, amount, call state, outcome and history-check result is sent to Keewano as it is persisted, keyed by case id, with the entry's own timestamp (REST ingest, batched, best effort — a dead endpoint never breaks a case). Ask Keewano things like "which merchants approve refunds" or "where do cases stall".
2. **Pre-authorization duplicate-charge check** (`KEEWANO_ACCESS_TOKEN`): when a case has a customer, merchant and amount, the server reads that customer's charge history from Keewano (SQL over MCP), looks for charges of the same merchant and amount within 24 hours, writes the finding to the timeline (`history_checked` / `history_unavailable`), and freezes it into the call brief at authorization. The agent may cite the transaction references only when a duplicate was found. Facts never come from Keewano, authorization is never blocked, and nothing is queried mid-call (the brief is immutable once authorized).

Without a token in simulated mode the check reads the same synthetic customers from a local fixture, labeled `fixture` everywhere it appears. `sam@example.com` has the duplicate (`COMPLETE_FIELDS` in the tests); see `src/integrations/keewano/seed/transactions.json`.

```bash
# 1. sign up, send "#SpeedHacks" in the in-app chat, create an API key and an access token, put them in .env.local
npm run keewano:seed                       # backfill the synthetic charge history (idempotent per customer)
npm run keewano:sql -- --tools             # what the MCP server offers (set KEEWANO_SQL_TOOL/ARG if the guess is wrong)
npm run keewano:sql -- --charges sam@example.com   # the exact query the duplicate check runs (--raw to see the tool result)
npm run keewano:sql -- "SELECT count(DISTINCT user_id) AS entities, count(*) AS events FROM events"
```

Verified live on 2026-10-11: the MCP tool is `run_sql_query({ projectId, sqlQuery })` returning `{ columns, rows }`; the project id is read from the SDK key (or `list_projects`), so nothing extra is needed. Keewano numbers custom events by position, so the registry in `events.ts` must stay contiguous from 2000 (append only). Events become queryable a few minutes after ingestion.
