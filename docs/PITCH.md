# Recourse: how to pitch it

Pitch memo for the SpeedHacks build on October 11, 2026.
Repo: `Will-code112223/Speedhacks`, branch `will/live-product`.
It follows `docs/SPEC.md` and agrees with `docs/SUBMISSION.md`, which is the authority on what is real and what is simulated.
Every number below is either sourced with a link or marked as an assumption.
Anything marked `[VERIFY: ...]` must be confirmed by the lead or cut before it is said on stage.
Each sentence sits on its own line so diffs stay readable.

## 1. Value proposition in one sentence

Recourse makes the phone calls behind insurance claims and refunds, so the hold time belongs to an agent and not to you.
You upload your policy, describe the problem in plain language, check the facts and the number it will call, approve one call, and get back the transcript and an outcome card.

The shorter spoken version is: "You approve one call. The agent says it is an AI, sits on hold, asks what you approved it to ask, and brings back a reference number and the next step. You spend your attention on the approval, not on the hold music."

## 2. Thesis

Money that people are already owed goes unclaimed because the only interface to get it is often a phone call: find the number, get through the menu, wait on hold, repeat the identifiers, write down a reference.
Most insurers and merchants have no API for a claim status, a refund or a cancellation.
For them, the phone call is the API.
An agent that can place a call, hold a scoped approval, and keep a verifiable case record turns that call into a background job.

Three forces make this the right year.

1. The other side of the call is already being automated.
   Sierra raised $950 million at a $15.8 billion valuation in May 2026 to sell AI service agents to companies.
   Consumers are going to be talking to agents whether they like it or not, and they need their own.
2. Managed voice agents can now navigate phone menus and wait through hold music, and an AI voice minute costs roughly $0.07 to $0.30 all in.
   A fifteen-minute call is a few dollars, so a per-case price works.
3. The rule that would have made cancellation a click is gone.
   The Eighth Circuit vacated the FTC's click-to-cancel rule in July 2025, so merchants are not required to offer a cancel button, and someone still has to make the call.

## 3. The numbers

| Claim | Number | Source | Freshness |
| --- | --- | --- | --- |
| Average wait on calls to UK insurers, from 140 test calls to large UK organisations | 7 min 49 s (retail 12 min 50 s, finance 8 min 27 s) | [Microsoft UK News Centre, July 5, 2023](https://ukstories.microsoft.com/?p=79024) | 2023 |
| Median length of a call to a US insurer about coverage, 44 calls to 11 insurers | 17.5 minutes, interquartile range 11.5 to 45, about two transfers per call | [Foran et al., American Journal of Otolaryngology, 2023](https://pmc.ncbi.nlm.nih.gov/articles/PMC10939813/) | 2023 |
| Share of US consumers who had a product or service problem in the last 12 months | 77%, a record | [ASU W. P. Carey, 2025 Customer Rage Survey](https://news.wpcarey.asu.edu/20251128-american-customers-are-madder-ever) | 2025 |
| Share who say complaining takes high or very high effort | 68% | same | 2025 |
| Time lost per problem, self-reported | one to two days on average, for the 56% who said the problem wasted their time | [2023 Customer Rage Survey summary](https://sogolytics.com/blog/analyzing-the-2023-customer-rage-survey) | 2023 |
| Money lost per problem, self-reported | $1,261 average, for the 43% who lost money | same | 2023 |
| Hours Americans spend on the phone with health insurers | about 12 million hours a week | [Pfeffer and Gallup, via KFF Health News](https://kffhealthnews.org/news/article/an-arm-and-a-leg-hello-we-spend-12-million-hours-a-week-on-the-phone-with-insurers/) | 2021, stale but uncontested |
| Wages lost to those calls | $21.6 billion on the clock plus $26 billion in time off | [Becker's summary of the same study](https://www.beckerspayer.com/payer/americans-spend-12m-hours-a-week-on-the-phone-with-health-insurers.html) | 2021 |
| In-network claims denied by HealthCare.gov insurers | 19% of 425 million claims | [KFF, January 2025](https://www.kff.org/private-insurance/healthcare-gov-insurers-denied-nearly-1-in-5-in-network-claims-in-2023-but-information-about-reasons-is-limited-in-public-data/) | 2023 data |
| Denied in-network claims that consumers appeal | about 1% | same | 2023 data |
| Appeals where the insurer upheld its own denial | 56%, so roughly 44% were overturned | same | 2023 data |
| Homeowners claim, filing to final payment | 40.7 days on average | [J.D. Power 2026 Property Claims Study, via Claims Journal](https://www.claimsjournal.com/news/national/2026/03/18/336327.htm) | 2026 |
| Global card disputes per year | 261 million in 2025, 324 million forecast for 2028 | [Mastercard and Datos Insights, via Chargeback Gurus](https://www.chargebackgurus.com/blog/mastercard-case-for-coordination) | 2025 forecast |
| Value of those disputes | about $34 billion in 2025 | [TechRadar on the same report](https://www.techradar.com/pro/businesses-globally-set-to-lose-usd15-billion-in-2025-because-of-fraudulent-chargebacks-says-mastercard-heres-how-it-impacts-you-me-and-everyone) | 2025 forecast |
| Dormant subscription spend per subscriber | $205 a year, on $90 a month of subscriptions | [CNET and YouGov, April 2025, via Cord Cutters News](https://cordcuttersnews.com/americans-now-pay-over-200-in-subscriptions-they-dont-use/) | 2025 |
| Paid subscriptions the vacated FTC rule would have covered | more than 1 billion in the US | [Eighth Circuit coverage, JD Supra](https://www.jdsupra.com/legalnews/eighth-circuit-blocks-click-to-cancel-2366443) | 2025 |
| Shoppers who do nothing about a bad purchase because it is not worth the hassle | 29% | [LegalShield survey](https://www.legalshield.com/newsroom/new-legalshield-study-americans-forgo-returns-on-broken-unwanted-products-citing-barriers-from-retailers) | vendor survey |
| People who stopped trying to get a refund they were owed | 59% of those who did not get a full refund | [Bankrate, 2020](https://www.bankrate.com/credit-cards/news/canceled-events-survey-summer-2020/) | 2020, stale |
| Mean US service call length | 7 minutes 3 seconds | [ContactBabel 2025, via Kayako](https://kayako.com/blog/average-handle-time-aht/) | 2025 |
| First-call resolution across industries | 70%, so 30% of calls need another contact | [SQM Group 2025, via Sobot](https://www.sobot.io/article/measure-improve-first-contact-resolution-2025/) | 2025 |
| All-in cost of an AI voice agent minute | $0.07 to $0.30, bundled platforms $0.10 to $0.18 | [Speechify comparison, 2026](https://speechify.ai/blog/best-voice-agent-platforms-2026) | 2026 |
| Dial free tier | 5 minutes per call, 2 concurrent calls, lifted on first top-up | [Dial usage and limits](https://docs.getdial.ai/documentation/reference/usage-and-limits) | current |
| Rocket Money bill negotiation fee | 35% to 60% of first-year savings, Premium $7 to $14 a month | [CNBC Select](https://www.cnbc.com/select/best-bill-negotiation-services/) | 2026 |
| Rocket Money (Truebill) acquisition | $1.275 billion, December 2021, at about $100 million of recurring revenue | [eMarketer](https://www.emarketer.com/content/rocket-will-acquire-pfm-app-truebill-1-275b-deal) | 2021 |
| Sierra funding | $950 million at a $15.8 billion valuation | [PYMNTS, May 2026](https://www.pymnts.com/news/investment-tracker/2026/openai-veteran-raises-950-million-for-ai-customer-service-agents/) | 2026 |
| DoNotPay FTC settlement | $193,000, for overstating what its AI could do | [ABA Journal](https://www.abajournal.com/news/article/robot-lawyer-website-donotpay-settles-ftc-claims-it-couldnt-deliver-on-promises) | 2024 to 2025 |

Numbers to avoid on stage.
The "13 hours a year on hold" figure comes from a 2013 texting-company poll.
The "2.8 billion hours" figure is a hold-music vendor's extrapolation.
The 2025 hold-time benchmarks are contact-center metrics, not what a consumer experiences, and they conflict with each other.
Any savings percentage, including the 85% in an earlier draft of this memo: we have one real call at most, and a percentage needs many.

## 4. How much time it saves

The judging rubric weights problem, impact and time saved at 40%, so this is the headline, and it has to survive a sceptical question.
The app measures time instead of claiming it.
Active user time (seconds the window is focused with a pointer or key event in the last ten seconds) is shown next to the agent's phone time, and the app computes no savings figure.
For a live call, the phone time to quote is the duration in Dial's own record of the call.

### The baseline is an assumption

Our baseline rule: a person placing the same call by hand spends at least the agent's phone time on it, because the menu, the hold and the conversation are the same.
That rule leaves out finding the number, gathering identifiers and taking notes, so it understates the manual cost.
The per-call figures we state are assumptions, informed by the two closest public sources we found:

- A manual insurance claim call takes about 20 minutes of phone time.
- A manual duplicate-charge refund call takes about 15 minutes of phone time.

The sources, for scale only: Microsoft UK's 2023 test of 140 calls found an average wait of 7 min 49 s for insurers, and Foran et al. 2023 found a median of 17.5 minutes for calls to US insurers about coverage, with about two transfers per call (both in section 3).
Neither measures a US claim call or a US refund call, so say "our working baseline", never "studies show".

### What we can say

The real call: [VERIFY: one real call placed on 2026-10-11 to <insurer>, <duration>].
The person's active time on that case: [FILL IN: active time from the meter in the recording].
The claim to make on stage: "On this real call the agent spent [VERIFY: duration] on the phone and I spent [FILL IN: active time] in the app. By our working baseline, a call like this takes about twenty minutes when you make it yourself. That is one call, so we show both numbers instead of a percentage."

The claim not to make: a percentage, a tenfold speedup, hours saved per year, or better outcomes.
The counterpart modes (person versus automated agent) are designed to trim time per call, but the large saving is that the person is not on the call at all; pitch them as adaptation, not acceleration, as `docs/SPEC.md` section 5 decides.

For insurance the bigger time pool is the follow-up.
A homeowners claim takes 40.7 days from filing to final payment on average, with status calls along the way.
Recourse does not shorten the insurer's cycle; it takes the person off the filing and status calls.
Say exactly that.

### Scale, with assumptions visible

About 260 million US adults, 77% with a product or service problem in the last year, is about 200 million people.
If each of them handles one money problem by phone a year at our 20-minute baseline, that is about 67 million hours of phone time a year; the one-problem-per-person rate is our assumption.
Health insurance alone is 12 million hours a week by the Pfeffer and Gallup estimate, which is about 620 million hours a year.

## 5. Market and path forward

First: insurance claim filing, status checks and administrative follow-up, which is the big time pool, the one in the demo, and where our registry of official insurer numbers applies.
Second, on the same engine: duplicate charges and cancellations, which are scriptable and low stakes; the `request_refund` purpose already exists, and Sparta's Customer Desk world models both cases for grading.
Later: card disputes, medical bill errors, and subscription cancellations at scale.

Sizing anchors.
620 million hours a year on the phone with US health insurers.
261 million card disputes a year globally, which is what a refund request becomes when the merchant call fails.
More than 1 billion paid US subscriptions, with $205 a year of dormant spend per subscriber.

Business model, a proposal to test, not a result.
A per-case fee of about $9, or a success fee of 15% of money recovered, whichever the user prefers.
Comparable: Rocket Money charges 35% to 60% of first-year savings on bill negotiation and $7 to $14 a month for Premium, and was bought as Truebill for $1.275 billion at about $100 million of recurring revenue.
Unit cost per case, as an estimate: a 15-minute call at $0.10 to $0.18 a minute on a bundled platform is $1.50 to $2.70, plus the extraction call, so a $9 case would carry a positive margin if call lengths hold.

Legal note to say out loud.
Compensated negotiation of property insurance settlements can fall under public adjuster regulation in some states, including California.
Recourse stays on filing, status and administrative follow-up, and the agent is forbidden from accepting any settlement or amount.

## 6. Competition and why Recourse is different

The descriptions below are from the team's research on October 11, 2026 and are not linked in this memo [VERIFY: a source for each row before quoting it on stage].

| Who | What they do | What they do not do |
| --- | --- | --- |
| Google Gemini "Call for Me" (Pixel, US, paid Gemini, beta) | Dials from your number, navigates menus, waits on hold, live transcript, you can take over | No source-checked facts, no purpose-scoped approval, no outcome record separating approval from payment |
| Apple Hold Assist (iOS 26) | Waits on hold and alerts you | Does not place the call or talk |
| Rocket Money | Cancels subscriptions and negotiates bills for 35% to 60% of savings | Humans do the calling, no insurance, no claims |
| DoNotPay | Templates and letters | Paid $193,000 to settle FTC claims about what its AI could do |
| Counterforce Health, Fight Health Insurance | AI-written appeal letters for health denials | Letters only, no phone, no status follow-up |
| Sierra, Decagon, Parloa | AI agents for the company's side of the call | The other side of the table |

What Recourse does live today that none of them shows:

- Every extracted fact keeps the excerpt it came from, and the number it will call shows the insurer page it was read from and the date it was checked.
- The person approves one frozen plan with one purpose (`file_claim`, `gather_information` or `request_refund`), and what the agent may and may not do is fixed by the server for that purpose, so nothing said on the call can widen it.
- The agent says it is an AI at the start, never invents an identifier, accepts nothing on the person's behalf, and the outcome card keeps approval and payment as separate rows.

What is designed and runs only in the labelled fixture mode, so present it as the roadmap:

- A badge that flips between "talking to a person" and "talking to an automated agent", with the agent changing its approach to match.
- A step-in control that puts the person into their own call.
- Decision prompts that arrive mid-call with a countdown and a stated default.

## 7. Technical execution to claim, and what not to claim

Claim.

- A real outbound call through Dial: [VERIFY: one real call placed on 2026-10-11 to <insurer>, <duration>].
- One `POST` per approval with an idempotency key, and never a redial on an ambiguous dispatch.
- Live fact extraction through the OpenAI Responses API with the model set in `LLM_MODEL` [VERIFY: the model id used], keeping a fact only when the model cites its source, and checking the quoted excerpt where the source is plain text (for a PDF or image, only that the cited document exists).
- A registry of US insurers whose numbers carry a source URL, a retrieval date and a confidence, where only an official national line is proposed and the person confirms it [VERIFY: the final registry count, and Blue Shield of California in the committed registry].
- A `CallPlanV1` built by the server and frozen at approval, with server-owned permitted and forbidden actions per purpose, and undisclosed facts stripped before anything reaches Dial.
- Mandatory call rules first in every instruction: AI disclosure at the start and whenever a new person picks up, approved facts only, no fabricated identifiers, no settlement or payment, read-back before hanging up, and a hard duration cap (300 seconds by default).
- Webhooks verified with HMAC-SHA256 over the exact raw bytes with a five-minute skew window and stored once per event id.
- Live mode fails visibly with HTTP 503 when a key is missing and never falls back to simulation; the header badge says Live, Simulated or Fixture.
- Tests: [VERIFY: `npm test` count, clean `npm run typecheck`, and the Dial `node --test` count on the pushed commit].

Do not claim.

- More real calls than were placed, or any measured average.
- That Sparta graded our agent: only Sparta's teaching agent has run, on Team Inbox.
- That the transcript streams live from Dial unless the recording shows it [VERIFY: whether the transcript appears during the call or after it].
- That the counterpart badge, step-in or mid-call prompts run on a live call: `GET /api/capabilities` answers false for all three.
- That a deployed webhook received the call's events, unless one did [VERIFY: webhook or polling for the recorded call].
- That the knowledge base in `knowledge/` (state claim deadlines, insurer menus) is loaded into calls: no code loads it yet.
- Keewano or Darwin.

## 8. Pitch script, three minutes, insurance first

About 420 words, which is three minutes at a normal speaking pace.
Sources for every figure are in section 3.

0:00 to 0:35, the problem.
"Raise your hand if you have been on hold with an insurance company this year. Americans spend twelve million hours a week on the phone with health insurers. That is a Stanford and Gallup estimate, and it comes to nearly forty-eight billion dollars a year in wages, on the clock and in time off. On HealthCare.gov plans, insurers deny nearly one in five in-network claims. About one percent of those denials are ever appealed, and of the ones that are, about forty-four percent win. The money is there. What stands in the way is a phone call."

0:35 to 1:00, who it hurts.
"Seventy-seven percent of Americans had a product or service problem last year, a record, and sixty-eight percent say complaining is high effort. For a homeowner it is forty-one days from filing to final payment, with status calls the whole way. In one study, the median call to a US insurer ran seventeen and a half minutes, with two transfers."

1:00 to 1:45, what Recourse does.
"Recourse makes that call for you. You upload your policy once and describe the problem in plain language. A language model pulls out the facts, and every fact keeps the line of your document it came from; anything it cannot source, it drops instead of guessing. It finds your insurer's claims or member services number in a registry we built from insurers' own websites, and shows you the page and the date. Then it writes a plan: one purpose, the facts it may say, the questions it will ask, and what it must never do."

1:45 to 2:25, the person stays in charge.
"Nothing dials until you approve, and one approval is one call. The agent opens by saying it is an AI calling with your authorization. It never invents a policy number or a date, never accepts a settlement, and never authorizes a payment. Today we placed a real call: [VERIFY: one real call placed on 2026-10-11 to <insurer>, <duration>]. The transcript came back from Dial, and the outcome card shows approval and payment as separate rows, because a yes on the phone is not money in your account."

2:25 to 2:50, the number.
"On that call the agent spent [VERIFY: duration] on the phone, and I spent [FILL IN: active time] in the app. Our working baseline for a claim call made by hand is about twenty minutes. That is one call, so we show both numbers instead of a percentage."

2:50 to 3:00, close.
"We file and we follow up. We do not negotiate settlements, which is a licensed job. Insurance first, refunds and cancellations on the same engine. Recourse: approve one call, and let the agent wait on hold."

If any `[VERIFY]` in this script cannot be confirmed, cut that sentence rather than rounding it.

## 9. Judging alignment

| Criterion | Weight | What carries it |
| --- | --- | --- |
| Problem and impact, time saved | 40% | Section 4: active time measured next to the agent's real phone time on a real call, against a stated 20-minute assumption with two cited sources, and no percentage |
| Technical execution | 25% | Section 7: live extraction with checked sources, a registry with provenance, a frozen purpose-scoped plan, one Dial dispatch per approval, signed webhooks, no fallback to simulation |
| Market and path forward | 15% | Section 5: insurance first, refunds and cancellations on the same engine, sizing anchors, a proposed price and unit cost |
| Originality | 10% | Section 6: provenance on every fact and number, a purpose-scoped frozen plan, and the counterpart modes, step-in and mid-call prompts as the designed next step |
| Product quality and demo | 10% | One real case from upload to outcome in under five minutes, with the Live badge on screen and the simulated parts named |

Partner prizes: Dial is the phone layer of the live call; Alike coordinated the three workstreams; Sparta and Keewano are not claimed (see `docs/SUBMISSION.md` section 4).

## 10. Questions judges will ask, with answers

"Was that a real call?"
[VERIFY: Yes: one real call placed on 2026-10-11 to <insurer>, <duration>; the transcript is Dial's.]
Only that call is claimed; everything under `?api=fixture` is scripted and labelled "Fixture".

"What if the insurer refuses to talk to an AI?"
The agent says it is an AI at the start, so a refusal happens openly.
It is recorded as the outcome with a next step, and the person can call themselves with the reference the case already holds.
Step-in, where the person joins the agent's call, is designed and runs only in fixture mode today.

"How do you stop it from agreeing to something I did not want?"
Approval freezes the plan, and the permitted and forbidden actions are server constants for the call's purpose, so the model cannot widen them.
The agent is told never to accept a settlement, payment or account change, and to say the policyholder will review anything else directly.
Mid-call decision prompts that ask the person in real time are designed and run only in fixture mode today.

"Where does the phone number come from?"
From a registry of US insurers built from the insurers' own websites, where each number carries its source URL and retrieval date.
Only an official national line is proposed, and the person confirms it; when the right number depends on the plan or the region, the person enters the one on their ID card.

"Could it make up a policy number?"
The extraction drops any fact the model cannot cite a source for, checks the quoted excerpt where the source is plain text, and the person reviews every fact before approving; the call rules forbid stating any identifier, date or amount that is not in the approved facts.

"Is the money real when the call ends?"
No, and the app never says so.
The outcome shows approval and payment as separate rows, and payment stays "unverified" because there is no bank feed.

"What is the cost per case?"
By the sourced per-minute range, a 15-minute call is about $1.50 to $2.70 on a bundled platform, plus one extraction call.
At a proposed $9 a case or 15% of recovery, that would be margin positive if call lengths hold; this is an estimate, not a measured cost.
