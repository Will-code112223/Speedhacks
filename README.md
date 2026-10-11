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
