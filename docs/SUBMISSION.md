# Recourse: submission package

Prepared on October 11, 2026 for SpeedHacks.
The deadline is 5:00 PM PDT on October 11, 2026, which is 00:00 UTC on October 12.
Claims come from `docs/SPEC.md`, the three handoffs and SHARED CONTRACT V1, checked against the repository at 13:09 PDT, plus the test runs and the two public sources named below.
Test counts were rerun on clean clones of `codex/case-engine` at `43d099d` and `codex/voice` at `9b6ce92`.
Anything marked FILL IN, and the "N" in section 4, needs a person before the form is submitted.

## 1. Form fields

### Project name

Recourse

### Description (60 words)

Recourse is an agent built to make the phone calls behind insurance claims and refunds.
Add your plans once, describe the problem in chat, approve one call, then watch it: hold time, whether a person or an automated agent answered, a step-in control and mid-call approval prompts.
Calls go through Dial's voice API.
The demo's call is a labelled simulation.

### Description (200 words)

Recourse is an agent built to make the phone calls behind insurance claims, refunds and cancellations.
The money is often already owed; what stands in the way is menus, hold time and repeated identifiers.
You upload your insurance plans once, describe the problem in chat, and approve one call.
The call screen shows who is being called, hold time, and whether a person or an automated agent answered, since the agent should talk differently to each.
You can step into the call, and when the agent needs a decision, a prompt appears with a countdown and the default it will take.
The outcome card shows the decision, reference number and next step, with approval and payment as separate rows.
Underneath are a Next.js case engine on SQLite that freezes what you approved and allows one call per approval, and a Dial adapter that sends each call request once and verifies signed webhooks; 39 engine tests and 189 adapter tests pass.
The app shows your active time next to the agent's phone time and computes no savings figure.
The demo runs in a labelled fixture mode: everything after the request is scripted, and no real insurer or merchant has been called.

### Technologies used

Next.js 16, React 19, TypeScript, SQLite via better-sqlite3, Dial voice API and webhooks, Sparta Worlds Customer Desk, Alike

Keewano is left out because nothing in the repository, on any branch, uses it; `docs/SPEC.md` only names it as an optional partner.
Keep Sparta Worlds on the list only if our own agent has run against Customer Desk by submission time; so far only Sparta's teaching agent has run (section 4).
The repository also uses the OpenAI Responses API for live-mode fact extraction and Vitest for tests, which can be added if the form allows.

### Repository link

https://github.com/Will-code112223/Speedhacks

The repository is private, so ask the organizers how judges should get access, then grant it before 5:00 PM PDT.

### Team roster

FILL IN: names and roles for teammate 1 (frontend), teammate 2 (case engine) and teammate 3 (Dial).

### Demo video

FILL IN: link to the video recorded from section 7, playable without signing in.

## 2. The problem and the time-saved claim

### The problem

Insurance claims, refunds and cancellations are phone work: find the number, get through the menu, wait on hold, repeat the same identifiers, write down a reference and call back later.
The money is often already owed.
The work between the person and the money is administrative, repetitive and scriptable.

### How we measure

Active user time is measured in the browser as the seconds the page is focused and has seen a pointer or key event in the last 10 seconds (`docs/handoffs/frontend.txt`, METRICS).
Agent phone time is the call timer on the call screen.
In fixture mode that timer runs on the scenario's simulated clock, so it measures nothing.
For a live Dial call, the phone time to quote is the duration in Dial's own record of that call.
The app shows the two numbers side by side and computes no savings figure anywhere.

### The baseline

Our baseline rule is an assumption: a person placing the same call by hand spends at least the agent's phone time on it, because the menu, the hold and the conversation are the same.
The rule leaves out the time to find the number, gather identifiers and take notes, so it understates the manual cost.
These are the closest public figures we found, cited for scale only:

- A Microsoft UK study published on July 5, 2023 placed 140 calls to large UK organisations between December 2022 and May 2023 and found average waits of 7 min 49 s for insurance, 12 min 50 s for retail and 8 min 27 s for finance ([Microsoft UK News Centre](https://ukstories.microsoft.com/?p=79024)).
- In Foran et al., American Journal of Otolaryngology, 2023, a researcher placed 44 calls to 11 US insurers about coverage for tracheostomy equipment; the median call lasted 17.5 minutes, the interquartile range was 11.5 to 45 minutes, and calls averaged about two transfers ([PMC10939813](https://pmc.ncbi.nlm.nih.gov/articles/PMC10939813/)).

Neither source measures a US insurance claim call or a US duplicate-charge call: the first covers UK waiting time only, and the second covers total call length for coverage questions.
The per-call baselines we state are therefore our assumptions, informed by those figures:

- A manual insurance claim call takes about 20 minutes of phone time.
- A manual duplicate-charge refund call takes about 15 minutes of phone time.

### The claim

The person's time on a case is the active time in the app, not the phone time.
In the recorded run the meter shows [FILL IN: active time from the recording], against our stated baseline of about 20 minutes on the phone for an insurance claim call made by hand.
The phone time in the recording is simulated, so the recording demonstrates the measurement, not a measured saving.
We do not claim a percentage, hours saved per year or better outcomes, because none of them has been measured on a real call.
The counterpart modes are pitched as adaptation, not acceleration: the saving comes from the person not being on the call.

### The simulated-versus-real sentence

Say this word for word in the video, and use the same words if a judge asks:

> This recording runs in fixture mode, labelled in the header: everything the app returns after my request, including the facts, the call, the insurer, the hold time, the automated-agent badge, the adjuster prompt and the outcome, is scripted, and no real insurer or merchant was called.

Follow it with:

> What is real is the interface and the active-time meter you just saw, plus, in the repository, a Dial calling adapter with signed-webhook checks that passes 189 tests and a case engine that allows one call per approval and passes 39.

If a live Dial call to our consenting test line is placed and shown before recording, replace "and no real insurer or merchant was called" with "and the only live call, to our own consenting test line, is the one shown at [timestamp]".

## 3. What is real and what is simulated

Branches: `codex/case-engine` at `43d099d` holds the case engine with the Dial adapter merged.
`codex/voice` at `9b6ce92` holds the Dial adapter plus a QA kit that is not merged anywhere yet.
`codex/frontend` is local and unpushed at `db5f311`, the scaffold, with no teammate branch merged and its frontend files still uncommitted.

| Part | Real today | Simulated or not built | Where |
| --- | --- | --- | --- |
| Dial call | The adapter sends exactly one `POST /api/v1/calls` per attempt with an `Idempotency-Key` and never redials on ambiguity; the case engine builds it from validated config for `REFUND_MODE=live`; adapter tests pass on a synthetic transport; read-only account and number lookups against the real Dial API succeeded (Dial handoff) | No live call has been placed; `live-smoke.mts` (60-second cap, named consenting recipient) is prepared and not run; the demo call is fixture | `src/integrations/dial/index.ts`, `src/server/cases/composition.ts` |
| Webhook verification | `X-Dial-Signature` HMAC-SHA256 over the timestamp and exact raw body, 300-second skew limit, event ID and type must match the signed payload; the route caps the body at 1 MiB, answers 401 on a bad signature and 204 only after storing the event once by event ID | Tested only with synthetic signed events; no public HTTPS deployment and no Dial subscription; `DIAL_WEBHOOK_SECRET` is unset, so the route answers 503 and call results arrive by polling instead | `src/integrations/dial/index.ts`, `src/app/api/webhooks/dial/route.ts` |
| Merchant (Sparta synthetic business) | Sparta Worlds kit installed with `sparta_worlds@0.9.0-beta.3` and verified with Sparta's teaching agent on Team Inbox | Synthetic by design; our agent has not run against Customer Desk; its mission and checks are the shipped ones; no Customer Desk evidence; the merchant line as a second Dial number is not built | `sparta/walkthrough-lab/projects/customer-desk/`, `sparta/walkthrough-lab/evidence/` |
| Frontend fixture mode | The interface, plan storage in the browser and the active-time meter | Every case, call and outcome under `/?api=fixture` is scripted, labelled "Fixture" in the header, with mode "simulated"; it is never used as a fallback when the network fails | `src/features/refund-ui/api/`, per `docs/handoffs/frontend.txt` |
| Counterpart detection | The badge on the call screen | Scripted in the fixture; no live detection; the backend has no V2 routes; the `set_counterpart` Context MCP tool is not built | `docs/SPEC.md` sections 5 and 6 |
| Step-in | The control on the call screen | Scripted in the fixture; `POST /api/cases/:id/calls/:callId/join` with Dial `transferTo` is a V2 proposal, not built | `docs/SPEC.md` section 6 |
| Approval prompts | The prompt with its countdown and default option | Frontend fixture now; the backend side is the V2 proposal `POST /api/cases/:id/calls/:callId/decisions/:decisionId`, fed by `request_user_decision`, not built | `docs/SPEC.md` section 6 |
| Case engine | V1 routes, SQLite, revision checks, frozen authorization, one call attempt per authorization enforced by unique constraints, no live dial for a case created in simulated mode, outcomes only from explicit support statements; tests pass and typecheck is clean | Not joined to the frontend on any branch, and the frontend handoff says the UI was verified against fixture mode only; its own simulated mode uses a scripted voice adapter chosen by the phone number's last digits | `src/app/api/**`, `src/server/**` |
| Payment | Approval and payment are separate fields and separate rows | Never verified: every case keeps `paymentStatus` as "unverified", and there is no bank feed | `src/server/cases/outcome.ts` |

## 4. Partner use

### Dial

Dial is the phone layer.
`createDialAdapter` in `src/integrations/dial/index.ts` sends exactly one `POST /api/v1/calls` per attempt with the attempt ID as `Idempotency-Key`, turns timeouts and ambiguous replies into `dispatch_unknown` instead of redialing, and verifies `X-Dial-Signature` webhooks by HMAC-SHA256 over the timestamp and exact raw body with a 300-second skew limit.
The case engine builds it from validated config in `src/server/cases/composition.ts` for `REFUND_MODE=live`, refuses to dial a case created in simulated mode, and receives events at `src/app/api/webhooks/dial/route.ts`, which stores each event once by event ID before answering 204.
The adapter's 189 tests pass on a synthetic transport (`codex/voice` at `9b6ce92`), and `src/integrations/dial/demo/` adds three fictional scenarios and an acceptance checklist for QA.
Read-only account and number lookups against the real Dial API succeeded (Dial handoff), but no live call has been placed, no webhook subscription exists, and the Context MCP tools that would feed the live call screen are a design note (`src/integrations/dial/context-mcp-design.txt`), not code.

### Sparta

Sparta Worlds is our merchant, and it is synthetic by design.
The kit is in `sparta/`, with `sparta_worlds@0.9.0-beta.3` pinned in `sparta/walkthrough-lab/`, and its Customer Desk project has a `duplicate-charge` mission that mirrors our refund case: Ada paid invoice `in_desk_ada` once and has charges `ch_desk_original` and `ch_desk_duplicate`.
The plan in `docs/SPEC.md` section 9 is to grade the merchant-side result with Sparta's checks under the normal and the interruption scenario: refunded once, original charge untouched, ticket solved with one public reply.
So far the kit is installed and verified with Sparta's own teaching agent on Team Inbox, which produced the three files in `sparta/walkthrough-lab/evidence/`: `team-inbox-original.json` passes, `before.json` fails under interruption with the no-retry agent, and `after.json` passes under interruption.
Our own agent has not run against Customer Desk, `tests/sparta/` is not pushed, and the merchant phone line as a second Dial number is not built.
Sparta's guide asks for our own agent entry point, a task or check set we wrote, and a failure, fix and corrected run on the same inputs, so until those exist this paragraph describes a plan, not a result.

### Alike

Alike coordinated three workstreams with separate file ownership.
SHARED CONTRACT V1 in `team-prompts/00-shared-contract.txt` on `main` fixes the types, the HTTP API, the voice adapter interface and who owns which paths, and points every agent at one Alike coordination task and one shared coordination decision (both URNs are in that file).
The workstreams are teammate 1 frontend on `codex/frontend`, teammate 2 case engine on `codex/case-engine` (Claude Code for implementation, Codex for tests) and teammate 3 Dial on `codex/voice`.
The contract and handoffs reference five Alike decisions: the shared coordination decision, the scaffold commit, the Claude and Codex split on the case engine, the verified local Dial credentials, and the proposed V1.1 rule for a new attempt after a pre-dispatch refusal.
`docs/SPEC.md` section 13 separately lists seven product decisions with their rejected alternatives; whether those are Alike records is not visible in the repository, and the total number of decisions in Alike is N (FLAG: fill in from Alike or delete this clause).
Two Alike asks show the loop working: teammate 3 asked for the wiring paths (`0ecf15fd`) and sent boundary findings from synthetic probes (`8d31fd06`), and teammate 2 answered both in its handoff and reports the findings fixed in `43d099d`, whose new `tests/backend/boundary.test.ts` passes.

### Not claimed

We are not entering for Keewano or Darwin: Keewano is named in the spec but not wired, and Darwin agent discovery is out of scope (`docs/SPEC.md` section 4).

## 5. Originality

This section follows `docs/SPEC.md` sections 2 and 5; section 3 above says which parts run today.

### Two counterpart modes

In the first exchanges the agent works out whether the counterpart is a person or an automated agent, from an IVR menu, synthetic cadence, instant replies, canned phrasing, the counterpart calling itself a virtual assistant, or a direct question.
It reports the counterpart with a confidence, and the badge on the call screen flips live.
With a person it paces itself, spells identifiers, confirms numbers in groups, builds rapport, argues from the story and then the policy, and escalates once if allowed.
With an automated agent it states the case in one dense utterance, cites the exact policy clause and the phrases the decision tree responds to, skips rapport, and asks for a representative after two failed attempts.
We pitch this as adaptation, not acceleration: the mode switch should help the outcome and trim time per call, but the large saving is that the person is not on the call at all.

### Step-in

The user can step into the call at any time.
The design uses Dial `transferTo` to the user's phone, or a conference once Dial supports one.

### Mid-call approval prompts

When the agent needs a decision, such as accepting an adjuster visit, a prompt appears with a countdown and the default the agent will take.

### Approval and payment shown separately

A completed call is not an approval, and an approval is not a payment.
The outcome card shows approval and payment as separate rows, and the case engine records payment as unverified on every case because payment verification against a bank feed is out of scope.

### What runs today

The counterpart badge, step-in and mid-call prompts run only in the frontend fixture.
The separation of approval and payment is also enforced in the case engine.

## 6. Market and path forward

### Insurance claims first

The first use is filing, status checks and administrative follow-up on insurance claims.

### Refunds and cancellations on the same engine

The case engine's V1 contract is already built around a refund: a merchant, an amount, evidence, one approved call and an evidence-backed outcome.
Sparta's Customer Desk already models the next two cases, a duplicate charge and a cancellation at renewal, so both can be graded against the same synthetic merchant.

### The boundary we respect

Compensated negotiation of property insurance settlements can fall under public adjuster regulation in some states, including California.
Recourse stays on filing, status and administrative follow-up, does not negotiate settlement amounts, and we say so in the pitch.

### Next step: the V2 live-call API

Contract V1 has no live call record, counterpart, step-in or approval prompt.
The additive V2 proposal adds `GET /api/capabilities`, `GET /api/cases/:id/calls/:callId/live`, `POST /api/cases/:id/calls/:callId/join` and `POST /api/cases/:id/calls/:callId/decisions/:decisionId`, and the frontend already detects whether the backend offers them.
The backend would feed it from Dial Context MCP tools our server hosts (`set_counterpart`, `report_progress`, `request_user_decision`) once a secure per-call binding is agreed, as `src/integrations/dial/context-mcp-design.txt` requires.
Alongside it: one real Dial call to a consenting test line, a deployed webhook receiver with a registered subscription, and our own agent graded on Sparta's Customer Desk.
Later: loading the plain-file knowledge base of `docs/SPEC.md` section 7 (merchant menus, cited consumer rights and call scripts) into each call's instructions; drafts are being written under `knowledge/`, untracked as of 13:09, and no pushed code loads them yet.

## 7. Demo video script

Target length is 4:40, under the five-minute limit, following `docs/SPEC.md` section 11 step by step.

Setup:

- On the demo branch, run `npm install && npm run dev`, open `http://localhost:3000/?api=fixture`, and keep the default `insurance_claim` scenario.
- Upload only synthetic documents, such as the two fictional Northwind Mutual PDFs in `docs/demo/samples/`, which `node docs/demo/make-samples.mjs` regenerates.
- Keep the "Fixture" label in the header visible in every shot, and show no real names, policy numbers or account details.

### 0:00-0:30, the problem (step 1)

Screen: the empty app.
Say: [FILL IN: one true hold-time story from someone on the team, in one or two sentences; do not invent one.]
Say: "In a 2023 test of 140 calls to large UK companies, the average wait for an insurer was almost 8 minutes, and our working baseline for a claim call made by hand is about 20 minutes."
Say: "Recourse is built so that the phone time belongs to an agent, not to you."

### 0:30-0:50, plans (step 2)

Screen: drop the two sample plan PDFs into the left rail and continue.
Say: "I add my insurance plans once, and they ride along as evidence on every case."

### 0:50-1:30, the request (step 3)

Screen: type "File a claim against Northwind for the water damage on Oct 3, about $1,200.", show what the assistant understood, and answer the one missing item it asks for.
Say: "I ask in plain language."
Say: "It shows what it understood and asks only for what is missing."

### 1:30-1:50, approval (step 4)

Screen: the confirmation step with the facts, the number it will call, one checkbox and one button; approve.
Say: "Nothing is dialed until I approve this exact request to this exact number."

### 1:50-2:50, the call (step 5)

Screen: dialing, the menu, the hold timer running, then the badge flips to "Automated agent"; point at the step-in control without pressing it.
Say: "Now I can walk away."
Say: "It is dialing, working through the menu and waiting on hold."
Say: "The badge just flipped: the claims line is an automated agent."
Say: "In that mode Recourse is designed to skip rapport and state the case in one turn with the exact policy clause; with a person it slows down, spells identifiers and confirms numbers in groups."
Say: "That is adaptation, not a speed trick, and I can step in at any time."

### 2:50-3:15, a decision mid-call (step 6)

Screen: the prompt with its countdown and default; accept in one tap.
Say: "The claims line proposes an adjuster visit."
Say: "The agent asks me, shows what it will do if I don't answer, and I accept in one tap."

### 3:15-3:45, the outcome (step 7)

Screen: the outcome card with the claim reference, the next step, and approval and payment on separate rows.
Say: "A claim reference, the next step, and approval and payment on separate rows, because a yes on the phone is not money in the account."

### 3:45-4:10, time (step 8)

Screen: active user time next to agent phone time.
Say: "My active time on this case: [FILL IN from the meter]."
Say: "The phone time next to it is simulated in this recording; by our baseline, this call takes about 20 minutes when you make it yourself."

### 4:10-4:40, what is simulated and what is real (step 9)

Say the two sentences from section 2 word for word, starting with: "This recording runs in fixture mode, labelled in the header: everything the app returns after my request, including the facts, the call, the insurer, the hold time, the automated-agent badge, the adjuster prompt and the outcome, is scripted, and no real insurer or merchant was called."
End on the outcome card at 4:40; the remaining 20 seconds are margin.

## 8. Pre-submission checklist

State as of 13:09 PDT; branches are moving, so recheck each item.

- [ ] Judges can open the repository.
  It is private (checked on GitHub).
  Ask the organizers how to grant judge access, grant it, and confirm with them before 5:00 PM PDT.
- [ ] One demo branch is chosen, pushed and named in the form with its commit.
  No branch holds all three workstreams: `codex/frontend` is local only, at `db5f311` with `src/features/` uncommitted; `codex/case-engine` at `43d099d` has the engine and the Dial adapter; `codex/voice` at `9b6ce92` adds the QA kit and 189 adapter tests.
  The fixture-mode video can be recorded from `codex/frontend` once its UI is committed, but the code judges review should be one pushed branch with all three.
  The repository link opens `main` at `a8d0895`, which has only the prompts and the contract, so either the demo code reaches `main` through the team's normal handoff or the form names the branch.
- [ ] Open PR #1 (`jonathan/factory-ai-demo`, "Factory AI demo + Alike team setup") is a different project aimed at `main`.
  Merging it would replace the README judges see first, so keep it out of whatever branch judges review.
- [ ] The video is under 5:00 by the exported file's duration, plays without signing in (check in a private window), keeps the "Fixture" label visible, and includes the two sentences from section 2.
- [ ] Every form field is filled: project name, description, repository link, technologies, team roster and demo video.
  Save, then submit: saving a draft does not submit.
  Keep the confirmation screen or email, and finish before 5:00 PM PDT.
- [ ] No `.env` file is tracked.
  `git ls-files | grep -E '(^|/)\.env'` should print only `.env.example` files.
  The root `.gitignore` ignores `.env` and `.env.*` except `.env.example`, and each Sparta project ignores its own `.env`; one exists at `sparta/walkthrough-lab/projects/team-inbox/.env` and is ignored.
  Dial credentials stay outside the repository in `~/.config/speedhacks/dial.env`, which `npm run dev:live` loads.
- [ ] Sparta evidence is committed.
  `sparta/` is untracked today; commit it without `node_modules/`, `.env`, `.worlds/` and `.worlds-dashboard/`, and, per Sparta's guide, without lock files or raw `--json` output.
  The three files in `sparta/walkthrough-lab/evidence/` are Team Inbox runs of Sparta's teaching agent, not ours.
  For the Sparta prize, add normal and interruption evidence from our own agent on Customer Desk `duplicate-charge` with a check set we wrote, and keep the failing run next to the fixed one.
- [ ] The duplicate-charge amount is consistent wherever it appears: Sparta's mission refunds $29.00, the frontend fixture uses $49.99, and the Dial QA kit uses $74.90.
- [ ] `docs/PITCH.md`, untracked and being drafted as of 13:09, agrees with this file before recording.
  At 13:09 it states a 25-minute attention baseline and an 85% figure where this file states about 20 and 15 minutes of phone time and no percentage.
  It also puts refunds before insurance, where `docs/SPEC.md` puts insurance first, and its technical claims and script mention real Dial calls and a Sparta grade, neither of which has happened.
- [ ] Test counts in the form match a fresh run on the demo branch.
  Verified for this file: `npm test` passed 39 tests in 6 files and `npm run typecheck` was clean at `43d099d`; `node --test src/integrations/dial/__tests__/*.node-test.mts` passed 189 at `9b6ce92` and 183 at `43d099d`.
  The backend handoff's "14 files, 109 tests" does not match the pushed code, so do not quote it until the rest is pushed.
- [ ] The empty TESTS section in `docs/handoffs/frontend.txt` is filled in by its owner, or frontend tests stay out of the submission.
- [ ] The root `README.md`, owned by teammate 2, still describes a refund assistant with insurance as "a later extension"; align it with the insurance-first pitch or accept the mismatch.
- [ ] The Alike decision count in section 4 is filled in from Alike or removed.
- [ ] The hold-time story in the first 30 seconds of the video is true and comes from someone on the team.
- [ ] Nothing in the form or the video claims Keewano, Darwin, a deployed webhook, a measured saving, or a live call that was not placed and shown.

## Sources

- Repository: `docs/SPEC.md`, `docs/handoffs/frontend.txt`, `docs/handoffs/backend.txt` at `db5f311` and `43d099d`, `docs/handoffs/dial.txt` at `9b6ce92`, `team-prompts/00-shared-contract.txt` at `a8d0895`, `sparta/README.md`, `sparta/docs/AGENT_GUIDE.md`, and the Customer Desk `missions.json` and `seed.json`.
- Hold times: the Microsoft UK News Centre article of July 5, 2023 and Foran et al. 2023 (PMC10939813), both linked in section 2.
