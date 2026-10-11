# Deploying Recourse

Recourse is a Next.js 16 app with a local SQLite database and private file uploads under `DATA_DIR`.
It needs a host that keeps a disk between restarts, so run it as a container or a Node process on a VM, Fly.io, Railway or Render with a volume.
Serverless platforms such as Vercel are not supported, because the case database would vanish with the function.

## What the server needs

| Variable | Live mode | Purpose |
| --- | --- | --- |
| `REFUND_MODE` | `live` | `simulated` runs with no credentials and labels everything as simulated; `live` fails visibly (503) when anything below is missing and never falls back. |
| `DATA_DIR` | `/data` | Where `refund.sqlite`, `insurers.sqlite` and uploads live; mount a persistent volume here. |
| `LLM_PROVIDER`, `LLM_MODEL`, `OPENAI_API_KEY` | required | Document and request extraction through the OpenAI Responses API; set a model id you have verified (for example `gpt-5.5`). |
| `DIAL_API_KEY`, `DIAL_FROM_NUMBER` | required | Outbound calls through Dial; the from-number must be a ready, calling-enabled number on that account (`GET https://api.getdial.ai/api/v1/numbers`). |
| `DIAL_MAX_CALL_DURATION_SECONDS` | optional | 60 to 3600; free Dial accounts are capped at 300 and allow 2 concurrent calls. |
| `DIAL_WEBHOOK_SECRET` | optional | Enables the signed webhook receiver at `/api/webhooks/dial`; without it the app reads call results from Dial by polling, which is enough for a single instance. |
| `APP_ACCESS_CODE` | strongly recommended when hosted | A shared access code. When set, every `/api` route except `GET /api/capabilities` and the signed Dial webhook answers 401 `ACCESS_REQUIRED` until the browser posts the code to `POST /api/access`, which sets an httpOnly `recourse_access` cookie (Secure in production, SameSite=Lax, 30 days) holding the SHA-256 hash of the code. The app shows an "Access code" prompt and retries. Unset means no gate, which is only safe on localhost. |
| `NODE_ENV` | `production` | Set by `next start`; marks the session and access cookies Secure, so serve the app over HTTPS. |

Keep the secrets out of the repository.
Locally they live in `~/.config/speedhacks/dial.env`, loaded by `npm run dev:live` and `npm run start:live`.

## Build and run as a container

```bash
docker build -t recourse .
```

```bash
docker run -d --name recourse -p 3000:3000 -v recourse-data:/data --env-file ~/.config/speedhacks/dial.env -e DATA_DIR=/data recourse
```

The image builds `better-sqlite3` from source for Node 24, runs as the unprivileged `node` user, exposes port 3000 and reports health through `GET /api/capabilities`.

## Run as a plain Node process

```bash
npm ci && npm run build
```

```bash
REFUND_MODE=live DATA_DIR=/var/lib/recourse npm run start:live
```

Put the process behind HTTPS (Caddy or nginx) and point `DATA_DIR` at a directory on a persistent disk.

## Optional: webhooks instead of polling

1. Deploy with a public HTTPS URL.
2. Create a Dial webhook subscription for `call.ended` and `call.transcribed` pointing at `https://<host>/api/webhooks/dial`.
3. Reveal the subscription's signing secret and set it as `DIAL_WEBHOOK_SECRET`, then restart.

The receiver verifies `X-Dial-Signature` (HMAC-SHA256 over the timestamp and the raw body, 300-second skew), stores each event once by id, and answers 204.

## After deploying

- `GET /api/capabilities` answers 200.
- `GET /api/insurers?name=Farmers` returns the verified claims line with its source and date.
- Open the app, upload a policy document, describe the problem, and check that the facts card says the facts were extracted by your model in live mode.
- The approval block must show the destination number with its provenance before "Place the call" is enabled.

## Safety rules the server enforces

- One call per approval: the frozen authorization is the only thing the agent is told, and a second dispatch for the same authorization is refused.
- The agent discloses that it is an AI assistant at the start of every call and never claims to be the policyholder.
- Facts the user did not approve are never spoken; unknown facts stay unknown.
- A case created in simulated mode can never be dialed live.
- Live mode dials North American numbers only (NANP rule).
  The number must be `+1` followed by a valid 10-digit number whose area code and exchange both start with 2-9.
  The server refuses N11 codes, unassigned N9X area codes, premium area code 900, premium exchange 976, the Caribbean and Atlantic NANP area codes that bill as international calls (242, 246, 264, 268, 284, 345, 441, 473, 649, 658, 664, 721, 758, 767, 784, 809, 829, 849, 868, 869, 876), and the account's own `DIAL_FROM_NUMBER`.
  It checks at case creation, on every edit and again at approval and dispatch, and answers 422 `UNSUPPORTED_DESTINATION` naming the field `supportPhone`.
  A disallowed number found in uploaded documents is dropped with a timeline note instead of being kept.
- Live mode limits dispatches to 3 calls per browser session and 10 calls per server process in any rolling hour, answering 429 `RATE_LIMITED`.
  Retrying the same request is not counted.
  The counters live in memory, so run a single instance (the SQLite database already requires that) and expect them to reset on restart.
- A call whose dispatch result is unknown can be resolved with `POST /api/cases/:id/calls/:callId/reconcile`.
  Within an hour of the attempt it replays the identical request with the same Idempotency-Key, so Dial returns the original call if it exists and never places a second one; the call is adopted, marked failed on a definitive refusal, or left unknown.
  Past that hour no request is sent: the attempt is marked failed with a note to check the Dial dashboard before approving again.
- The access code gate does not apply to `/api/webhooks/dial`, which Dial calls without a browser cookie and which is authenticated by its signature.
- An insurance claim call never reads the free-text summary aloud; only the loss description and claim type are disclosed.
- The summary is capped at 2000 characters (422 `SUMMARY_TOO_LONG` naming `summary`), and an upload body over 51 MB is refused with 413 before it is parsed.
