# Recourse: submission package

Prepared on October 11, 2026 for SpeedHacks.
The deadline is 5:00 PM PDT on October 11, 2026, which is 00:00 UTC on October 12.
This revision was written at about 15:20 PDT, after the product started running live at 15:00.
Claims come from `docs/SPEC.md`, SHARED CONTRACT V1 and the code on branch `will/live-product` at `eb7dc77`, including changes in the working tree that were not yet committed at 15:20.
Other teammates were still editing `src/**` while this was written, so every code claim below should be rechecked against the commit that is finally pushed.

Three kinds of marker need a person before the form is submitted:

- `[VERIFY: ...]` marks a fact the lead must confirm, such as the first real call's insurer, duration and outcome; replace each one with the confirmed fact, or delete the claim.
- `FILL IN` marks something only the team can supply, such as the roster or the video link.
- The "N" in section 4 needs a number from Alike or must be deleted.

## 1. Form fields

### Project name

Recourse

### Description (60 words)

Recourse is an agent that makes the phone calls behind insurance claims and refunds.
Upload your policy, describe the problem, and check the facts it extracted with their sources and the insurer number it proposes from a verified registry.
Approve once, and it places one real call through Dial, discloses it is an AI, and returns the transcript and outcome.

Use this text only once the first real call has been placed and shown in the video [VERIFY: one real call placed on 2026-10-11].

### Description (200 words)

Recourse is an agent that makes the phone calls behind insurance claims, refunds and cancellations.
The money is often already owed; what stands in the way is menus, hold time and repeated identifiers.
You upload your policy documents and describe the problem in plain language.
A language model extracts the facts; each must cite its source or is dropped.
For a known insurer, it proposes the claims or member services number from a registry built from insurers' own websites, with the source page and the date it was checked, for you to confirm.
It then builds a call plan with a purpose, a goal, permitted and forbidden actions, approved questions and a read-back, and freezes the plan when you approve.
One approval allows one real call through Dial.
The agent says it is an AI at the start, uses only approved facts, and never invents an identifier.
The transcript comes back from Dial, and the outcome card shows the decision, reference number and next step, with approval and payment as separate rows.
The app shows your active time next to the agent's phone time and computes no savings figure.
A labelled fixture mode replays a scripted walkthrough.

### Technologies used

Next.js 16, React 19, TypeScript, SQLite via better-sqlite3, OpenAI Responses API, Dial voice API and webhooks, Alike, Vitest

Keep Sparta Worlds off the list unless our own agent has run against Customer Desk by submission time; so far only Sparta's teaching agent has run (section 4).
Keewano is left off because we are not entering for it (section 4), although an optional Keewano integration is now on the branch.

### Repository link

https://github.com/Will-code112223/Speedhacks

Name the branch in the form: `will/live-product`, with the final commit hash [VERIFY: pushed commit hash].
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
Agent phone time is the length of the real call.
For a live call, the figure to quote is the duration in Dial's own record of that call, not a timer we drew [VERIFY: the phone-time figure on screen in live mode matches Dial's record].
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
In the recorded run the meter shows [FILL IN: active time from the recording], while the agent spent [VERIFY: duration of the real call from Dial's record] on a real call to [VERIFY: insurer].
That is one call, so it demonstrates the measurement on a real call, not an average saving.
We do not claim a percentage, hours saved per year or better outcomes, because one call measures none of them.
The calls are capped at `DIAL_MAX_CALL_DURATION_SECONDS`, 300 seconds by default, so a call with a long hold can end before it reaches a person; if that happened, say so.

### The simulated-versus-real sentences

Say these word for word in the video, after filling in the markers, and use the same words if a judge asks:

> This recording runs in live mode, labelled "Live" in the header: the call you just saw was a real outbound call through Dial to [VERIFY: insurer]'s [VERIFY: claims or member services] line, placed at [VERIFY: time] and lasting [VERIFY: duration from Dial's record], and the transcript on screen is the one Dial returned.

> What was not real: [VERIFY: whether the policy documents were synthetic or a teammate's own, redacted], payment is never verified, so that row stays "unverified", and the person-or-agent badge, step-in and mid-call prompts from our design run only in the labelled fixture mode, not on this call.

If the recorded call was edited for length, add: "The hold was cut from [VERIFY: real length] to fit the video; nothing else was edited."

## 3. What is real and what is simulated

State of `will/live-product` at `eb7dc77` plus the uncommitted working tree at about 15:20 PDT.
Live mode is `REFUND_MODE=live` with `OPENAI_API_KEY`, `LLM_MODEL`, `DIAL_API_KEY` and `DIAL_FROM_NUMBER` loaded from `~/.config/speedhacks/dial.env` by `npm run dev:live`; a missing value answers HTTP 503 `LIVE_CONFIGURATION_MISSING`, and nothing falls back to simulation (`src/server/config.ts`, `src/server/cases/composition.ts`).

| Part | Real in live mode | Simulated, unverified or not built | Where |
| --- | --- | --- | --- |
| Mode label | The header badge reads Live, Simulated or Fixture: Fixture when the URL has `?api=fixture`, otherwise the server's `REFUND_MODE` | Nothing is unlabelled; a simulated case is never dialed live | `src/features/refund-ui/RefundApp.tsx` |
| Policy upload and fact extraction | Up to 5 files of 10 MB each are stored privately; the documents and the description go to the OpenAI Responses API with the model id from `LLM_MODEL`; a fact is kept only when the model cites a source and, for plain-text input, the quoted excerpt is really in it (for a PDF or image the server can only check that the cited document exists); the timeline names the model | Model used in the recording: [VERIFY: LLM_MODEL value actually used]; extraction accuracy is not measured beyond tests; simulated mode uses a local heuristic extractor with no LLM | `src/server/documents/extractor.ts` |
| Insurer registry and destination | US insurers with each number's source URL, retrieval date and confidence; only a `verified_official` national line is proposed, shown with its source page, and the user confirms or edits it before approval; an insurer whose number depends on plan or region gets no number, and the user enters the one on their ID card | 33 insurers at `eb7dc77` and 37 in the working tree, which adds Blue Shield of California [VERIFY: Blue Shield of California is in the committed registry, and the final count]; Blue Shield of California publishes only plan-specific member lines, so check how its number reaches the plan [VERIFY: how the Blue Shield of California number was chosen in the recording]; numbers were checked on October 11, 2026 and can change | `src/server/insurers/`, `src/server/cases/service.ts` |
| Call plan and approval | `CallPlanV1` is built by the server with a purpose (`file_claim`, `gather_information` or `request_refund`), goal, steps, permitted facts, approved questions, read-back, and permitted and forbidden actions that are server constants for the purpose; approval freezes the plan and the case revision; facts the user did not permit are removed before anything is sent to Dial | How well the plan's wording works on a real line is shown by [VERIFY: number of real calls] call(s) | `src/contracts/voice.ts`, `src/server/cases/` |
| Dial call | Exactly one `POST /api/v1/calls` per attempt with the attempt id as `Idempotency-Key`; an ambiguous reply becomes `dispatch_unknown` and is never redialed; every instruction starts with the mandatory rules: say it is an AI at the start and whenever a new person picks up, use only approved facts, never fabricate an identifier, accept no settlement or payment, read back the reference before hanging up; the call is cut off at `DIAL_MAX_CALL_DURATION_SECONDS`, 300 by default | First real call: [VERIFY: one real call placed on 2026-10-11 to <insurer>, <duration>, outcome <decision and reference or "no reference">]; this is the only evidence of real-world behavior | `src/integrations/dial/index.ts` |
| Transcript and outcome | After Dial reports the call ended, the server reads the transcript from Dial, waiting up to 45 seconds, then rechecks every 30 seconds for 24 hours; outcomes come only from explicit statements on the call; approval and payment are separate fields and rows | Whether the transcript appears during the call or only after it [VERIFY: transcript timing in the recording]; payment is never verified, and every case keeps `paymentStatus` "unverified" because there is no bank feed | `src/server/config.ts`, `src/server/cases/outcome.ts` |
| Webhooks | `X-Dial-Signature` HMAC-SHA256 over the timestamp and exact raw body, 300-second skew limit, event id and type must match the signed payload, 1 MiB body cap, 401 on a bad signature, 204 only after storing the event once | Without `DIAL_WEBHOOK_SECRET` and a public HTTPS receiver registered with Dial, the route answers 503 and results arrive by polling [VERIFY: whether a webhook subscription was used for the recorded call] | `src/integrations/dial/index.ts`, `src/app/api/webhooks/dial/route.ts` |
| Time meter | Active user time, measured in the browser | Agent phone time on screen in live mode [VERIFY: shown, and equal to Dial's duration] | `src/features/refund-ui/metrics/MetricsStrip.tsx` |
| Fixture mode | A scripted walkthrough under `/?api=fixture` that never reaches the server, labelled "Fixture" in the header | Everything after the request is scripted; it is never used as a fallback when the network fails | `src/features/refund-ui/api/` |
| Counterpart badge, step-in, mid-call prompts | The controls on the call screen | Fixture only: `GET /api/capabilities` answers `liveCall`, `stepIn` and `decisions` as false, and the V2 routes behind them are not built | `src/app/api/capabilities/route.ts`, `docs/SPEC.md` sections 5 and 6 |
| Merchant (Sparta synthetic business) | Sparta Worlds kit installed with `sparta_worlds@0.9.0-beta.3` and verified with Sparta's teaching agent on Team Inbox | Our agent has not run against Customer Desk; no Customer Desk evidence; the merchant line as a second Dial number is not built | `sparta/walkthrough-lab/` |

## 4. Partner use

### Dial

Dial is the phone layer, and in live mode it places the real call.
`createDialAdapter` in `src/integrations/dial/index.ts` sends exactly one `POST /api/v1/calls` per attempt with the attempt id as `Idempotency-Key`, turns timeouts and ambiguous replies into `dispatch_unknown` instead of redialing, and verifies `X-Dial-Signature` webhooks by HMAC-SHA256 over the timestamp and exact raw body with a 300-second skew limit.
The instruction sent with each call starts with mandatory rules (AI disclosure, approved facts only, no fabricated identifiers, no settlement or payment, read-back before hanging up), then the purpose's rules, then the approved plan with undisclosed facts removed.
The case engine builds the adapter from validated config in `src/server/cases/composition.ts` for `REFUND_MODE=live`, refuses to dial a case created in simulated mode, reads the call and its transcript back from Dial, and receives signed events at `src/app/api/webhooks/dial/route.ts`.
Simulated mode runs the same adapter code against an in-process fake Dial server, so the request, response and webhook code is the same in both modes.
Real-world evidence: [VERIFY: one real call placed on 2026-10-11 to <insurer>, <duration>, and its outcome].
Adapter test count: [VERIFY: `node --test src/integrations/dial/__tests__/*.node-test.mts` result on the pushed commit].
The Context MCP tools that would feed a live counterpart badge, progress notes and mid-call decisions are a design note (`src/integrations/dial/context-mcp-design.txt`), not code.

### Sparta

Sparta Worlds is our merchant, and it is synthetic by design.
The kit is in `sparta/`, with `sparta_worlds@0.9.0-beta.3` pinned in `sparta/walkthrough-lab/`, and its Customer Desk project has a `duplicate-charge` mission that mirrors our refund case: Ada paid invoice `in_desk_ada` once and has charges `ch_desk_original` and `ch_desk_duplicate`.
The plan in `docs/SPEC.md` section 9 is to grade the merchant-side result with Sparta's checks under the normal and the interruption scenario: refunded once, original charge untouched, ticket solved with one public reply.
So far the kit is installed and verified with Sparta's own teaching agent on Team Inbox, which produced the three files in `sparta/walkthrough-lab/evidence/`: `team-inbox-original.json` passes, `before.json` fails under interruption with the no-retry agent, and `after.json` passes under interruption.
Our own agent has not run against Customer Desk, `tests/sparta/` is not pushed, and the merchant phone line as a second Dial number is not built.
Sparta's guide asks for our own agent entry point, a task or check set we wrote, and a failure, fix and corrected run on the same inputs, so until those exist this paragraph describes a plan, not a result.

### Alike

Alike coordinated three workstreams with separate file ownership.
SHARED CONTRACT V1 in `team-prompts/00-shared-contract.txt` fixes the types, the HTTP API, the voice adapter interface and who owns which paths, and points every agent at one Alike coordination task and one shared coordination decision (both URNs are in that file).
The workstreams are teammate 1 frontend, teammate 2 case engine (Claude Code for implementation, Codex for tests) and teammate 3 Dial.
The contract and handoffs reference five Alike decisions: the shared coordination decision, the scaffold commit, the Claude and Codex split on the case engine, the verified local Dial credentials, and the proposed V1.1 rule for a new attempt after a pre-dispatch refusal.
`docs/SPEC.md` section 13 separately lists seven product decisions with their rejected alternatives; whether those are Alike records is not visible in the repository, and the total number of decisions in Alike is N (FLAG: fill in from Alike or delete this clause).
Two Alike asks show the loop working: teammate 3 asked for the wiring paths (`0ecf15fd`) and sent boundary findings from synthetic probes (`8d31fd06`), and teammate 2 answered both in its handoff and reported the findings fixed in `43d099d`, with a new `tests/backend/boundary.test.ts`.

### Not claimed

We are not entering for Keewano or Darwin.
The branch now carries an optional Keewano integration from the case-engine merge (`src/integrations/keewano/`: a case mirror and a pre-authorization duplicate-charge check), but it is not on the insurance call path shown in the demo and we have no Keewano result of our own to show [VERIFY: the lead still chooses not to enter for Keewano].
Darwin agent discovery is out of scope (`docs/SPEC.md` section 4).

## 5. Originality

This section follows `docs/SPEC.md` sections 2 and 5; section 3 above says which parts run today.

### Running live today

- **Every fact and the number carry their source.** An extracted fact is kept only with the excerpt it came from, and the proposed number shows the insurer page it was read from and the date; the person checks provenance instead of trusting a summary.
- **A purpose-scoped, frozen call plan.** The person approves one plan with one purpose, and the actions the agent may and may not take are server constants for that purpose, so an approval cannot be widened by the model, the plan text or anything said on the call.
- **Honest by construction.** The agent discloses that it is an AI, never invents an identifier, accepts nothing on the person's behalf, and records approval and payment separately, because a yes on the phone is not money in the account.

### Designed, running only in fixture mode

- **Two counterpart modes.** In the first exchanges the agent works out whether the counterpart is a person or an automated agent, from an IVR menu, synthetic cadence, instant replies, canned phrasing, the counterpart calling itself a virtual assistant, or a direct question.
  With a person it paces itself, spells identifiers and confirms numbers in groups; with an automated agent it states the case in one dense utterance with the exact policy clause and asks for a representative after two failed attempts.
  We pitch this as adaptation, not acceleration: the large saving is that the person is not on the call at all.
- **Step-in.** The user can step into the call at any time; the design uses Dial `transferTo` to the user's phone.
- **Mid-call approval prompts.** When the agent needs a decision, such as accepting an adjuster visit, a prompt appears with a countdown and the default the agent will take.

## 6. Market and path forward

### Insurance claims first

The first use is filing, status checks and administrative follow-up on insurance claims, where the registry of official insurer numbers already applies.

### Refunds and cancellations on the same engine

The `request_refund` purpose already exists with its own permitted and forbidden actions, and the simulated mode exercises it end to end.
Sparta's Customer Desk already models a duplicate charge and a cancellation at renewal, so both can be graded against the same synthetic merchant.

### The boundary we respect

Compensated negotiation of property insurance settlements can fall under public adjuster regulation in some states, including California.
Recourse stays on filing, status and administrative follow-up, does not negotiate or accept settlement amounts, and we say so in the pitch.

### Next steps

- More real calls, so the time measurement covers more than one call, with the outcomes recorded as they come.
- A deployed webhook receiver with a registered Dial subscription, so results arrive by signed event instead of polling.
- The additive V2 live-call API (`GET /api/capabilities`, `GET /api/cases/:id/calls/:callId/live`, `POST /api/cases/:id/calls/:callId/join`, `POST /api/cases/:id/calls/:callId/decisions/:decisionId`), fed by Dial Context MCP tools our server hosts, to bring the counterpart badge, step-in and mid-call prompts from fixture to live; the frontend already detects whether the backend offers them.
- More insurers in the registry, each number with its official source, and our own agent graded on Sparta's Customer Desk for the refund path.

## 7. Demo video script

Target length is 4:40, under the five-minute limit, and the call shown is a real one.

Setup:

- Load the keys from `~/.config/speedhacks/dial.env` with `npm run dev:live`, open `http://localhost:3000`, and keep the "Live" badge in the header visible in every shot.
- Never show the env file, a terminal with keys, or the Dial dashboard's key page.
- Use policy documents that are synthetic or the caller's own, and blur the name, policy number, date of birth, address and member id in every shot [VERIFY: which documents were used].
- Choose the purpose honestly: use `gather_information` for a question the policyholder really has, and use `file_claim` only for a real loss; do not open a test claim on a real insurer's line.
- The recording of the call's audio or transcript includes a real representative: blur their name, and do not play the audio unless they agreed to be recorded (California requires the consent of everyone on a recorded call) [VERIFY: consent or audio left out].
- Record the whole session, then cut only the hold, and say so on screen with a caption such as "hold cut: [VERIFY: real length]".

### 0:00-0:30, the problem

Screen: the empty app with the "Live" badge.
Say: [FILL IN: one true hold-time story from someone on the team, in one or two sentences; do not invent one.]
Say: "In a 2023 test of 140 calls to large UK companies, the average wait for an insurer was almost 8 minutes, and our working baseline for a claim call made by hand is about 20 minutes."
Say: "Recourse is built so that the phone time belongs to an agent, not to you."

### 0:30-0:50, upload the policy

Screen: drop the policy documents into the app.
Say: "I upload my policy once."

### 0:50-1:30, the request and the extracted facts

Screen: type the request in plain language [VERIFY: exact request text], then show the facts card, opening the source excerpt behind one or two facts.
Say: "I describe the problem in plain language."
Say: "A language model read my documents, and every fact you see keeps the line it came from; anything it could not tie to a source was dropped, not guessed."

### 1:30-2:00, the destination and the plan

Screen: the proposed number with its source page and the date it was checked, then the call plan: purpose, goal, what the agent may and may not do, the questions it will ask, and what it will read back.
Say: "It found [VERIFY: insurer]'s [VERIFY: claims or member services] number in our registry, which we built from insurers' own websites; here is the page and the date we checked it, and I confirm it."
Say: "This is the plan the agent gets: one purpose, the facts it may say, and what it must never do, like invent an identifier or accept a settlement."

### 2:00-3:30, approve and the live call

Screen: tick the box and approve; the plan locks; the call starts and the timer runs; cut the hold with the caption; the transcript appears [VERIFY: during or after the call].
Say: "Nothing is dialed until I approve, and one approval allows exactly one call."
Say: "This is a real call through Dial to [VERIFY: insurer]."
Say: "Listen to the first line: it says it is an AI calling with my authorization." (Show the transcript line if the audio is left out.)
Say: "Now I can walk away; the agent is on hold, not me."
Say: "Here is the transcript Dial returned, and at the end the agent reads back what the call produced."

### 3:30-4:00, the outcome

Screen: the outcome card with the decision, the reference number or its absence, the next step, and approval and payment on separate rows.
Say: "The outcome is [VERIFY: decision, reference number and next step, exactly as on the card]."
Say: "Approval and payment are separate rows, and payment stays unverified, because a yes on the phone is not money in the account."

### 4:00-4:20, time

Screen: active user time next to the agent's phone time.
Say: "My active time on this case: [FILL IN from the meter]."
Say: "The agent's time on the phone: [VERIFY: duration from Dial's record]; by our stated baseline, a call like this takes about 20 minutes when you make it yourself, and we compute no percentage from one call."

### 4:20-4:40, what was real and what was not

Say the two sentences from section 2 word for word, with every marker filled in.
End on the outcome card at 4:40; the remaining 20 seconds are margin.

## 8. Pre-submission checklist

State as of about 15:20 PDT; branches and the working tree are moving, so recheck each item.

- [ ] Judges can open the repository.
  It is private.
  Ask the organizers how to grant judge access, grant it, and confirm with them before 5:00 PM PDT.
- [ ] `will/live-product` is committed, pushed and named in the form with its final commit hash.
  At 15:20 it was at `eb7dc77` with uncommitted changes in `src/**`, including the insurer registry, and was not visible on the remote [VERIFY: pushed, and the hash in the form].
  The repository link opens `main`, so the form must name the branch, or the code must reach `main` through the team's normal handoff.
- [ ] Open PR #1 (`jonathan/factory-ai-demo`, "Factory AI demo + Alike team setup") is a different project aimed at `main`, if it is still open.
  Merging it would replace the README judges see first, so keep it out of whatever branch judges review.
- [ ] No env file or key is tracked.
  `git ls-files | grep -E '(^|/)\.env'` should print only `.env.example` files.
  The root `.gitignore` ignores `.env` and `.env.*` except `.env.example`.
  Live keys stay in `~/.config/speedhacks/dial.env`, outside the repository, loaded by `npm run dev:live`.
- [ ] No key, env file or Dial dashboard key page appears anywhere in the video.
- [ ] The video is under 5:00 by the exported file's duration, plays without signing in (check in a private window), keeps the "Live" badge visible, shows a real call, and includes the two sentences from section 2 with every marker filled in.
- [ ] Personal data is blurred in the video: the policyholder's name, policy number, member id, date of birth and address, and the representative's name.
- [ ] No real claim was opened for the demo unless there was a real loss, and the call's audio is played only with the representative's consent.
- [ ] Every `[VERIFY: ...]` marker in this file, `docs/PITCH.md` and the video narration is replaced with a confirmed fact or the claim is deleted.
  `grep -n "VERIFY" docs/SUBMISSION.md docs/PITCH.md README.md` should print nothing when done.
- [ ] Test counts quoted anywhere match a fresh run on the pushed commit [VERIFY: `npm test` count, `npm run typecheck` clean, and the Dial `node --test` count].
  The counts in the earlier version of this file (39 engine tests and 189 adapter tests) were measured on `codex/case-engine` at `43d099d` and `codex/voice` at `9b6ce92` and do not describe this branch.
- [ ] Every form field is filled: project name, description, repository link with branch, technologies, team roster and demo video.
  Save, then submit: saving a draft does not submit.
  Keep the confirmation screen or email, and finish before 5:00 PM PDT.
- [ ] Sparta evidence is committed only if it is ours or clearly labelled as Sparta's teaching agent.
  `sparta/` must not carry `node_modules/`, `.env`, `.worlds/` or `.worlds-dashboard/`, and, per Sparta's guide, no lock files or raw `--json` output.
- [ ] The Alike decision count in section 4 is filled in from Alike or removed.
- [ ] The hold-time story in the first 30 seconds of the video is true and comes from someone on the team.
- [ ] Nothing in the form or the video claims Keewano, Darwin, a deployed webhook, a measured average saving, a percentage, live counterpart detection, live step-in, live mid-call prompts, or more real calls than were placed.

## Sources

- Repository: `docs/SPEC.md`, `docs/handoffs/`, `team-prompts/00-shared-contract.txt`, `src/server/config.ts`, `src/server/cases/composition.ts`, `src/server/cases/service.ts`, `src/server/documents/extractor.ts`, `src/server/insurers/`, `src/contracts/voice.ts`, `src/integrations/dial/index.ts`, `src/app/api/capabilities/route.ts`, `sparta/README.md` and `sparta/docs/AGENT_GUIDE.md`, read on `will/live-product` at `eb7dc77` with its working tree at about 15:20 PDT.
- Hold times: the Microsoft UK News Centre article of July 5, 2023 and Foran et al. 2023 (PMC10939813), both linked in section 2.
