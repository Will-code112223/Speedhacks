# Recourse: an agent that files your claim and gets your money back over the phone

Spec for the SpeedHacks (October 11, 2026) build.
Repo: `Will-code112223/Speedhacks`.
Status: working spec, owned by teammate 1 (frontend), edited by anyone on the team.
It follows SHARED CONTRACT V1 in `team-prompts/00-shared-contract.txt` and the ownership map there.
Each sentence sits on its own line so diffs stay readable.

## 1. Thesis

Insurance claims, refunds and cancellations cost people hours of phone hold time, paperwork and follow-up.
The money is often owed already.
The work between the person and the money is administrative, repetitive and scriptable.
An agent that can place phone calls, hold a scoped authorization, and keep a verifiable case record can do that work while the person does something else.

The product promise is one sentence.
Add your plans once, ask in plain language, approve the call, and watch the agent handle the phone.

## 2. What the user sees

The shell is a help desk inbox, in the manner of Intercom's Help Desk: an icon rail, a navigation column with counts, a case list, the conversation thread, and a details panel of structured fields.
The user is the policyholder; the agent sits in the thread like a support teammate and the details panel shows what it knows and what it is doing.

1. **Onboarding.** Upload insurance plans (PDF or photos). They are listed under Plans in the navigation and ride along as evidence on every case.
2. **Thread.** One composer. "File a claim against Northwind for the water damage on Oct 3, about $1,200." The agent replies in the thread with what it understood as a facts card, asks only for what is missing, and shows the request it will make. Attachments appear as file chips with their size.
3. **Approval.** A confirmation card in the thread: the facts, the number we will call, one checkbox, one button.
4. **Details panel.** Assignee, insurer and status at the top; the call block with the live timer, hold time and the counterpart badge (person, automated agent, not yet known); the claim pipeline with one status per stage; the coverage check; links to the packet, the transcript and the policy documents; the claim data as key and value rows; the time metrics.
5. **Call.** The user can step into the call at any time from the toolbar or the call block. When the agent needs a decision, a prompt appears in the thread and in the call block with a countdown and the default the agent will take.
6. **Case list.** Every case is a row with the insurer monogram, a preview line, the time and a status chip: needs you, in call, done, denied, draft. The navigation counts group them by state and by kind.
7. **Outcome.** A result card in the thread: decision, reference number, next action, supporting quote, approval and payment as separate rows.

Not on screen: tool registries, mandate cards, handshake receipts, savings claims, upsell banners.
The counterpart mode, the step-in control and the pipeline are the memorable parts.

## 3. Judging alignment

| Criterion | Weight | How we score it |
| --- | --- | --- |
| Problem and impact (time saved) | 40% | Active user time measured honestly next to agent phone time, baseline stated in the pitch |
| Technical execution | 25% | Real Dial calls, signed webhooks, one dispatch per authorization, Sparta-graded merchant outcome |
| Market and path forward | 15% | Insurance first, refunds and cancellations on the same engine |
| Originality | 10% | Human or agent counterpart detection, step-in, mid-call approval prompts |
| Product quality and demo | 10% | One polished case from upload to outcome, recorded in under five minutes |

Partner prizes: Dial (core), Sparta (merchant simulation and grading), Alike (team coordination), Keewano (optional metrics).

## 4. Scope for today

In scope.

- One case end to end in the demo: an insurance claim call, with a duplicate charge refund as the second fixture.
- Desktop web app, usable at tablet width, recorded for the video.
- A real Dial outbound call to a consenting test line.
- Frontend fixture mode that plays the whole flow without a backend, labelled as simulated everywhere.

Out of scope today.

- Insurance claim submission to a real insurer portal.
- Payment verification against a bank feed.
- Darwin agent discovery.
- Phone layouts beyond not breaking at 768px.

Legal note.
Compensated negotiation of property insurance settlements can fall under public adjuster regulation in some states, including California.
We stay on filing, status and administrative follow-up and say so in the pitch.

## 5. Counterpart modes: talking to a human, talking to an agent

The agent determines within the first exchanges whether the counterpart is a person or an automated agent.
Signals: an IVR menu, synthetic cadence, instant responses, canned phrasing, the counterpart naming itself a virtual assistant, or a direct question.
It then reports the counterpart and a confidence, and the call screen badge flips live.

Human mode: pace for a person, spell identifiers, confirm numbers in groups, build rapport, persuade with the story then the policy, escalate once if allowed.
Agent mode: state the case in one dense utterance, cite the exact policy clause and the phrases the decision tree responds to, skip rapport, ask for a representative after two failed attempts.

Honest sizing.
The mode switch improves outcomes and shaves time per call.
The large saving comes from the person not being on the call at all.
We pitch it as adaptation, not acceleration.

## 6. Live call surface: V2 API proposal

Contract V1 has no live call record, no counterpart, no step-in and no approval prompt.
The frontend builds them against this additive proposal, feature detected at runtime, and plays them fully in fixture mode.
Teammate 2 decides whether to adopt it; nothing in V1 changes.

| Route | Returns |
| --- | --- |
| `GET /api/capabilities` | `{ liveCall, stepIn, decisions }` booleans |
| `GET /api/cases/:id/calls/:callId/live` | `LiveCallV2` |
| `POST /api/cases/:id/calls/:callId/join` | `LiveCallV2` with `userJoined: true` |
| `POST /api/cases/:id/calls/:callId/decisions/:decisionId` | body `{ optionId }`, returns `LiveCallV2` |

`LiveCallV2` fields: `callId`, `caseId`, `calling { name, phone }`, `phase`, `counterpart`, `counterpartConfidence`, `startedAt`, `endedAt`, `holdSeconds`, `notes[]`, `pendingDecision | null`, `userJoined`, `updatedAt`.
Phases: `dialing`, `ringing`, `navigating_menu`, `on_hold`, `talking`, `waiting_for_user`, `user_joined`, `ended`.
The exact TypeScript is in `src/features/refund-ui/api/types.ts`.

How the backend could feed it.
Dial's managed agent does not stream the transcript during a call.
Progress notes, counterpart and decision prompts arrive through Dial Context MCP tools our server hosts (`set_counterpart`, `report_progress`, `request_user_decision`), scoped to the active call by the `X-Dial-*` headers.
Step-in uses Dial `transferTo` to the user's phone, or a conference once Dial supports it.
Teammate 3's note in `src/integrations/dial/context-mcp-design.txt` lists the binding problem to solve first.

## 6b. Claim pipeline and coverage check

Insurer-side claims agents, Beam AI's insurance claim agent among them, show a claim as a pipeline: intake, data extraction and validation, coverage verification against the policy, adjudication with a payment calculation, then payment.
Recourse shows the same pipeline from the policyholder's side, so the user sees where the claim stands at a glance and what the agent checked before it picked up the phone.

Stages, in order: Intake, Extraction, Coverage check, Approval, Filing call, Decision, Payment.
Each stage carries one status: done, active, needs you, pending, skipped or failed, and one line of detail.
The pipeline is derived on the client from the case, the call, the live record and the coverage check; the derivation lives in `src/features/refund-ui/api/pipeline.ts` and has no backend dependency.

The coverage check reads the uploaded policy against the claim: covered peril and policy section, deductible, limit, claimed amount, estimated payout after the deductible, and the filing deadline.
It is an additive V2 route, `GET /api/cases/:id/coverage` returning `{ coverage: CoverageCheckV2 }`, feature detected through `capabilities.coverage`.
In fixture mode the check is computed from the fictional Northwind Mutual sample policy and labelled simulated; on a V1 backend the stage reads "Not available on this backend".
Fraud screening is an insurer-side concern and is not shown; the policyholder-side analogue is the evidence check inside the coverage card.

Where it appears: a compact pipeline strip at the top of the case in the chat column, the coverage card in the chat after the facts card, and the case list in the rail with the same status words, so the rail reads like a task board.

## 6c. Design sources

The visual direction follows the Refero design method with its bundled craft references: research several references, lock one direction, keep a decision ledger, validate the build against the lock.
The live Refero MCP research tools were not connected in the build session; the lock is recorded in `src/features/refund-ui/design.md`.
Two componentry patterns (harshjdhv/componentry, MIT) are ported by hand into CSS modules because the shared contract keeps Tailwind and Framer Motion out of the manifests: the flight status card pattern becomes the claim status card (two endpoints, a progress track, the next event and its countdown), and the split-flap display pattern becomes the call phase word on the call screen, with a reduced-motion fallback.

## 7. Knowledge base

Plain files under `knowledge/`, loaded into the `outboundInstruction`.
No vector store today.

- `knowledge/merchants/<slug>.md`: support number, menu path in words, hours, policies with quotes, what the bot can do, escalation phrases, identifiers asked for.
- `knowledge/rights/`: short cited notes the agent may invoke: card dispute rights for duplicate charges, automatic renewal laws starting with California, insurance acknowledgement and decision deadlines by state.
- `knowledge/scripts/human.md` and `knowledge/scripts/agent.md`: opening, identification, request, objections, escalation, read-back.
- Case memory per case in the backend database: facts, evidence, authorization, calls, events, transcript, outcome.

## 8. Dial integration facts

Pulled from `docs.getdial.ai` on October 11, 2026, and cross-checked against teammate 3's handoff in `docs/handoffs/dial.txt`.

- `POST /api/v1/calls` with `to`, `fromNumber`, `outboundInstruction`, `language`, `maxCallDurationSeconds`, and an `Idempotency-Key`; teammate 3 sends exactly one POST per attempt and never redials on ambiguity.
- The managed agent navigates menus by pressing digits from a goal stated in words and waits through hold music.
- `transferTo` cold-transfers to a human once a person is on the line.
- `call.ended` fires once with `status` in `completed | busy | no-answer | failed | canceled`; the transcript arrives later with `call.transcribed`, so the backend reconciles after the end event.
- Webhooks are signed with `X-Dial-Signature: t=<unix>,v1=<hmac>` over `"{t}.{raw body}"`, rejected beyond five minutes of skew, retried up to six times, deduplicated on `X-Dial-Event-ID`.
- Context MCP connects a server we host to the account's voice agent; every request carries `X-Dial-Direction`, `X-Dial-User-Number`, `X-Dial-Agent-Number`.
- Free accounts: five minutes per call, two concurrent calls, one call per number; the first top-up lifts the caps. Verify whether the $100 event credits count.
- Coupon `DIAL_FOR_SPEEDHACKS` through the quickstart form; unused credit expires at the end of the day.

## 9. Sparta integration

The Sparta kit is under `sparta/` with the Customer Desk project.
Its `duplicate-charge` mission matches our refund fixture: Ada paid invoice `in_desk_ada` once and has charges `ch_desk_original` and `ch_desk_duplicate`.
Teammate 2 uses it to grade the merchant-side outcome: refunded once, original untouched, ticket solved with one public reply, also under the interruption scenario.
The merchant's support line can be a second Dial number whose inbound agent reaches the Customer Desk world through Context MCP tools, which makes the agent-to-agent mode real.

## 10. Architecture and ownership

From SHARED CONTRACT V1.

| Teammate | Owns |
| --- | --- |
| 1, frontend | `src/features/refund-ui/**`, `docs/handoffs/frontend.txt`; exports default `RefundApp` |
| 2, case engine | `src/app/**`, `src/contracts/**`, `src/server/**`, tests, root manifests, `.env.example`, `docs/handoffs/backend.txt` |
| 3, Dial | `src/integrations/dial/**`, `docs/handoffs/dial.txt`; exports `createDialAdapter` |

Frontend internals.

| Folder | Responsibility |
| --- | --- |
| `api/` | `CaseApi` interface, `http` client for V1, `fixture` scenario engine, React hooks, `pipeline.ts`, insurer lookup client |
| `plans/` | onboarding and plan storage in IndexedDB |
| `chat/` | thread, bubbles, facts card, approval step, coverage card, outcome card, composer |
| `call/` | the call block in the details panel and the call sheet on narrow screens |
| `metrics/` | active user time next to agent phone time |
| `rail/`, `shell/`, `details/` | icon rail, navigation column, case list, details panel, fixture picker |
| `state/` | the session controller that sequences the API calls |
| `ui/` | shared primitives and tokens |

## 11. Demo script, under five minutes

1. Thirty seconds: the problem, one real hold time story, the time framing.
2. Drop two plan documents in, continue.
3. Type the claim request. Show what the assistant understood and the one missing item.
4. Approve the call.
5. The call screen: dialing, menu, hold timer, then the badge flips to "Automated agent".
6. A prompt arrives: the claims line proposes an adjuster visit. Accept in one tap.
7. The outcome card: claim reference, next step, approval and payment as separate rows.
8. Show active user time next to agent phone time.
9. Say what is simulated and what is real.

## 12. Risks

| Risk | Mitigation |
| --- | --- |
| Backend lacks V2 live routes by demo time | Fixture mode plays the full flow; the UI degrades to V1 state and transcript when live is missing |
| Context MCP tool timeout too short for approval prompts | Verify first; fall back to callback decisions |
| Five minute call cap | Tight instructions; confirm credits lift the cap |
| Duplicate calls | One attempt per authorization, never redial on ambiguity |
| Judges need repo access | Private repo, ask organizers before the deadline |

## 13. Decisions

- Insurance claim first on screen, refund as the second fixture. Rejected: refund-first framing.
- Chat as the single input surface. Rejected: a multi-step form wizard.
- Approval as a confirmation step in chat. Rejected: a mandate card UI.
- Live call surface as an additive V2 proposal, feature detected. Rejected: changing contract V1.
- Fixture mode explicit and labelled, never a fallback. Rejected: silent mock on network failure.
- Counterpart modes pitched as adaptation. Rejected: pitching a tenfold speedup.
- Managed Dial agent plus Context MCP. Rejected for today: self-hosted LLM protocol.
