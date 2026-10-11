# Recourse — refunds and insurance preparation

Upload evidence, review extracted facts, prepare request documents, and authorize a support call or browser task. Browser tasks use a real, isolated Chromium session, with its current view shown beside the conversation. The agent proposes actions against the actual page; the user reviews each navigation, form edit, upload, or click before it executes. Login stays in the local browser.

The current call workflow requests a refund for a reviewed amount and reason. Browser tasks are bounded assistance, not a guarantee that every merchant or insurer accepts automation. Coverage decisions, claim approval, and payment require provider evidence; completing a browser task does not establish those outcomes.

Team prompts and the shared contract live in `team-prompts/`. `team-prompts/00-shared-contract.txt` is the source of truth for ownership, types and the HTTP API.

## Stack

- Next.js (App Router) + TypeScript, npm, Node runtime for server routes
- Local SQLite (`better-sqlite3`) for persistence — a hackathon setup on local disk, **not** suitable for ephemeral/serverless deployment without changes
- Playwright Chromium for browser execution; OpenAI Responses API for extraction and browser decisions
- Vitest for tests

## Setup

```bash
nvm use            # Node 24 (see .nvmrc; >=20.9 required)
npm install
cp .env.example .env.local   # configure real provider credentials locally
npx playwright install chromium
npm run dev                  # http://localhost:3000
```

Set `OPENAI_API_KEY` and `LLM_MODEL`, then `BROWSER_ENABLED=true` to enable browser tasks. Set `DIAL_API_KEY` and `DIAL_FROM_NUMBER` to enable calls. `npm run dev:live` loads the private Dial environment file from `~/.config/speedhacks/dial.env`; Next.js also reads `.env.local`. No credential is committed or exposed to the browser. See [live setup and limits](docs/handoffs/live-product.txt).

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

## Real execution

`REFUND_MODE=live` is the default. Missing provider configuration fails visibly and never substitutes fabricated records. The application uses the HTTP backend even if an old bookmark contains `?api=fixture`. Offline adapters remain available only for automated tests.

`GET /api/runtime` reports configuration readiness without making calls, launching a browser, or probing provider accounts. `src/contracts/browser.ts` defines the additive browser API; it leaves the shared case and voice contracts unchanged. Browser runs and generated files belong to the same private session cookie as the case. The viewer displays recent real JPEG frames; it is not a recording or an interactive remote desktop.

This is a single-host worker with local storage and local login handoff. Deploying it for multiple users requires durable worker orchestration, stronger account authentication, controlled egress and a remote login handoff. Do not run it on an ephemeral/serverless host unchanged.

## Testing

```bash
npm run typecheck
npm test          # tests/backend (T2 implementation) + tests/integration (verification)
npm run build
```

Tests use temporary SQLite files, synthetic fixtures and no network. See `docs/handoffs/backend.txt` for status, error codes and integration notes.
