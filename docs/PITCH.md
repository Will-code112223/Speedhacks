# Recourse: how to pitch it

Pitch memo for the SpeedHacks build on October 11, 2026.
Repo: `Will-code112223/Speedhacks`.
It follows `docs/SPEC.md` and SHARED CONTRACT V1 in `team-prompts/00-shared-contract.txt`.
Every number below is either sourced with a link or marked as an assumption.
Each sentence sits on its own line so diffs stay readable.

## 1. Value proposition in one sentence

Recourse gets the money you are already owed back over the phone while you do something else.
You add your plans once, ask in plain language, approve one call, and get an evidence-backed outcome.

The shorter spoken version is: "You approve one call. The agent sits on hold, argues your case, and brings back a reference number. You spend four minutes of your attention per case instead of twenty-five."

## 2. Thesis

Money that people are already owed goes unclaimed because the only interface to get it is a phone call that costs twenty-five minutes of a person's attention.
Most merchants and insurers have no API for a refund, a cancellation or a claim status.
For them, the phone call is the API.
An agent that can place a call, hold a scoped authorization, and keep a verifiable case record turns that call into a background job.

Three forces make this the right year.

1. The other side of the call is already being automated.
   Sierra raised $950 million at a $15.8 billion valuation in May 2026 to sell AI service agents to companies, and Decagon was reported at around $4 billion.
   Consumers are about to be talking to agents whether they like it or not, and they need their own.
2. Managed voice agents can now navigate phone menus and wait through hold music, and a call costs roughly $0.10 to $0.20 a minute all in.
   A fifteen-minute call is a couple of dollars, so a per-case price works.
3. The rules that would have made cancellation a click are not coming soon.
   The FTC's click-to-cancel rule was vacated in July 2025, and only local rules like New York City's (effective October 1, 2026) have replaced it.
   Until merchants are forced to offer a button, someone has to make the call.

## 3. The numbers

| Claim | Number | Source | Freshness |
| --- | --- | --- | --- |
| Share of US consumers who had a product or service problem in the last 12 months | 77%, a record | [ASU W. P. Carey, 2025 Customer Rage Survey](https://news.wpcarey.asu.edu/20251128-american-customers-are-madder-ever) | 2025 |
| Share who say complaining takes high or very high effort | 68% | same | 2025 |
| Time lost per problem, self-reported | one to two days on average, for the 56% who said the problem wasted their time | [2023 Customer Rage Survey summary](https://sogolytics.com/blog/analyzing-the-2023-customer-rage-survey) | 2023 |
| Money lost per problem, self-reported | $1,261 average, for the 43% who lost money | same | 2023 |
| Hours Americans spend on the phone with health insurers | about 12 million hours a week | [Pfeffer and Gallup, via KFF Health News](https://kffhealthnews.org/news/article/an-arm-and-a-leg-hello-we-spend-12-million-hours-a-week-on-the-phone-with-insurers/) | 2021, stale but uncontested |
| Wages lost to those calls | $21.6 billion on the clock plus $26 billion in time off | [Becker's summary of the same study](https://www.beckerspayer.com/payer/americans-spend-12m-hours-a-week-on-the-phone-with-health-insurers.html) | 2021 |
| In-network claims denied by HealthCare.gov insurers | 19% of 425 million claims | [KFF, January 2025](https://www.kff.org/private-insurance/healthcare-gov-insurers-denied-nearly-1-in-5-in-network-claims-in-2023-but-information-about-reasons-is-limited-in-public-data/) | 2023 data |
| Denied in-network claims that consumers appeal | about 1% | same | 2023 data |
| Appeals where the insurer upheld its own denial | 56%, so roughly 44% were overturned | same | 2023 data |
| Global card disputes per year | 261 million in 2025, 324 million forecast for 2028 | [Mastercard and Datos Insights, via Chargeback Gurus](https://www.chargebackgurus.com/blog/mastercard-case-for-coordination) | 2025 forecast |
| Value of those disputes | about $34 billion in 2025 | [TechRadar on the same report](https://www.techradar.com/pro/businesses-globally-set-to-lose-usd15-billion-in-2025-because-of-fraudulent-chargebacks-says-mastercard-heres-how-it-impacts-you-me-and-everyone) | 2025 forecast |
| Dormant subscription spend per subscriber | $205 a year, on $90 a month of subscriptions | [CNET and YouGov, April 2025, via Cord Cutters News](https://cordcuttersnews.com/americans-now-pay-over-200-in-subscriptions-they-dont-use/) | 2025 |
| Paid subscriptions the vacated FTC rule would have covered | more than 1 billion in the US | [Eighth Circuit coverage, JD Supra](https://www.jdsupra.com/legalnews/eighth-circuit-blocks-click-to-cancel-2366443) | 2025 |
| Shoppers who do nothing about a bad purchase because it is not worth the hassle | 29% | [LegalShield survey](https://www.legalshield.com/newsroom/new-legalshield-study-americans-forgo-returns-on-broken-unwanted-products-citing-barriers-from-retailers) | vendor survey |
| People who stopped trying to get a refund they were owed | 59% of those who did not get a full refund | [Bankrate, 2020](https://www.bankrate.com/credit-cards/news/canceled-events-survey-summer-2020/) | 2020, stale |
| Mean US service call length | 7 minutes 3 seconds | [ContactBabel 2025, via Kayako](https://kayako.com/blog/average-handle-time-aht/) | 2025 |
| First-call resolution across industries | 70%, so 30% of calls need another contact | [SQM Group 2025, via Sobot](https://www.sobot.io/article/measure-improve-first-contact-resolution-2025/) | 2025 |
| Callers who hang up after two minutes on hold | up to 60% | [Giva, via LiveAgent](https://liveagent.com/blog/call-center-statistics) | undated |
| Homeowners claim, filing to final payment | 40.7 days on average | [J.D. Power 2026 Property Claims Study, via Claims Journal](https://www.claimsjournal.com/news/national/2026/03/18/336327.htm) | 2026 |
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
Use the Customer Rage Survey, the Pfeffer and Gallup study, KFF, and Datos.

## 4. How much time it saves

The judging rubric weights time saved at 40%, so this is the headline, and it has to survive a sceptical question.
The app measures it instead of claiming it.
Active user time (seconds the window is focused with a pointer or key event in the last ten seconds) is shown next to agent phone time, and the UI computes no savings figure.
The pitch supplies the baseline.

Baseline: a person handling one duplicate charge by phone themselves.

| Step | Minutes | Basis |
| --- | --- | --- |
| Find the support number, dig out the receipts, dial | 5 | assumption |
| Phone menu and hold | 3 to 10 | contact centers report 2 to 3 minute holds for banking, consumers report far longer, and 60% hang up after 2 minutes |
| Talking, including identity verification | 7 | ContactBabel 2025 mean service call of 7 minutes 3 seconds |
| Chance of needing a second contact | 30% | SQM 2025 first-call resolution of 70% |
| Checking the statement and chasing a reference afterwards | 3 | assumption |

Expected active human time: about 25 minutes, with a plausible range of 15 to 35 minutes.
The arithmetic is 5 plus 6.5 plus 7 plus 3, which is 21.5 minutes, times 1.3 for the repeat contacts, which is 28 minutes, rounded down to stay conservative.

With Recourse, the person's active time is:

| Step | Minutes |
| --- | --- |
| Upload the plans, once, amortized over cases | 1 |
| Type the request and review the extracted facts | 2 |
| Approve the call | under 1 |
| Answer one mid-call decision prompt | under 1 |
| Read the outcome card | 1 |

That is about 3 to 5 minutes of active time per case.
The 10 to 20 minutes of phone time still happen, but they are the agent's, not the person's.

The claim to make on stage: "About 25 minutes of a person's attention becomes about 4, and the hold time goes to zero. That is roughly 85% of the active time, and we show both numbers live rather than asserting them."

The claim not to make: a tenfold speedup.
The counterpart modes (human versus automated agent) shave time per call and improve outcomes, but the large saving comes from the person not being on the call at all.
Pitch the modes as adaptation, not acceleration, as `docs/SPEC.md` section 5 decides.

For the insurance case, the baseline is different and bigger.
A homeowners claim takes 40.7 days to final payment, with several status calls along the way.
Recourse does not shorten the insurer's cycle.
It removes the person from the filing call and the follow-up calls.
Say exactly that.

Scale, with assumptions visible.
About 260 million US adults, 77% with a problem in the last year, is about 200 million people.
If each handles one money problem by phone per year at 25 minutes, that is about 83 million hours of attention a year.
At $25 an hour that is about $2 billion of time, on top of the money that 29% to 59% of people give up on entirely.
Health insurance alone is 12 million hours a week, which is about 620 million hours a year.

## 5. Market and path forward

Wedge: duplicate charges and cancellations, because they are scriptable, low stakes, and graded by Sparta's Customer Desk world today.
Second: insurance claim filing and status follow-up, which is the big time pool and the one on screen in the demo.
Later: card disputes, medical bill errors, subscription cancellations at scale.

Sizing anchors.
Top down: 261 million card disputes a year globally is the floor, because a dispute is what a refund request becomes only after the merchant call fails.
More than 1 billion paid US subscriptions, with $205 a year of dormant spend per subscriber.
620 million hours a year on the phone with health insurers in the US.
Bottom up: 200 million US adults with a problem each year, at one phone-handled money problem each, is 200 million cases a year.
Capturing 0.1% of those in year one is 200,000 cases.

Business model, pick one and say it.
Per-case fee of about $9, or a success fee of 15% of money recovered, whichever the user prefers.
Comparable: Rocket Money charges 35% to 60% of first-year savings on bill negotiation and $7 to $14 a month for Premium, and was bought as Truebill for $1.275 billion at about $100 million of recurring revenue.
Unit cost per case: a 15-minute call at $0.10 to $0.20 a minute is $1.50 to $3.00, plus pennies of document extraction, so gross margin is positive at $9 a case.

Legal note to say out loud.
Compensated negotiation of property insurance settlements can fall under public adjuster regulation in some states, including California.
Recourse stays on filing, status and administrative follow-up.

## 6. Competition and why Recourse is different

| Who | What they do | What they do not do |
| --- | --- | --- |
| Google Gemini "Call for Me" (Pixel 11, US, paid Gemini, beta) | Dials from your number, navigates menus, waits on hold, live transcript, you can take over | No evidence packet, no scoped authorization, no outcome record, no counterpart adaptation, one phone model |
| Apple Hold Assist (iOS 26) | Waits on hold and alerts you | Does not place the call or talk |
| Rocket Money | Cancels subscriptions and negotiates bills for 35% to 60% of savings | Humans do the calling, no insurance, no claims |
| DoNotPay | Templates and letters | Paid $193,000 to settle FTC claims about what its AI could do |
| Counterforce Health, Fight Health Insurance | AI-written appeal letters for health denials | Letters only, no phone, no status follow-up |
| Sierra, Decagon, Parloa | AI agents for the company's side of the call | The other side of the table |

Three things only Recourse shows on screen.
A badge that flips live between "talking to a person" and "talking to an automated agent", with the agent changing its script to match.
A step-in control that drops the person into their own call for twenty seconds.
Decision prompts that arrive mid-call with a countdown and a stated default.

## 7. Technical execution to claim, and what not to claim

Claim.
Real outbound calls through Dial, one POST per authorization with an idempotency key, never a redial on an ambiguous dispatch.
Webhooks verified with HMAC-SHA256 over the exact raw bytes, five-minute skew window, duplicate delivery deduplicated durably.
Authorization freezes the case revision, destination number, amount and permitted actions before any call.
A completed call never implies an approved refund, and approval never implies payment: the outcome card shows them as separate rows.
Merchant-side outcome graded by Sparta's Customer Desk world, including under an injected HTTP 500.
The Dial adapter has 122 isolated tests passing under `node --test`.

Do not claim.
That the transcript streams live from Dial, because it does not; progress notes come through Context MCP tools or the fixture.
That the demo is live unless it is: say what is simulated and what is real, which the UI labels anyway.

Fix before judges open the repo.
`npm test` currently reports "No test suite found" because the Dial tests use `node:test` and vitest does not collect them, and `npm run typecheck` fails inside `src/integrations/dial/**` under `noUncheckedIndexedAccess`.
Both are credibility problems if a judge runs the scripts, and both touch files owned by teammates 2 and 3.
The refund fixture amount is $49.99 in the frontend and $29.00 in Sparta's duplicate-charge mission; pick one so the screen and the Sparta grade agree.

## 8. Pitch script, four minutes

0:00 to 0:30, the problem.
"Seventy-seven percent of Americans had a product or service problem last year, a record. Sixty-eight percent say complaining is high effort. Americans spend twelve million hours a week on the phone with health insurers alone. And the companies on the other end are buying AI agents from Sierra and Decagon to take those calls. People need their own."

0:30 to 0:50, the promise.
"Recourse gets the money you are already owed back over the phone while you do something else. You add your plans once, ask in plain language, approve one call, and get an evidence-backed outcome."

0:50 to 2:50, the demo.
Drop two plan documents in.
Type the claim: "File a claim against Northwind for the water damage on October 3, about $1,200."
Show what it understood and the one missing item.
Approve the call.
Call screen: dialing, menu, hold timer, then the badge flips to "automated agent" and the script changes.
A decision prompt arrives: the claims line proposes an adjuster visit. Accept in one tap.
Outcome card: claim reference, next step, approval and payment as separate rows, transcript one click away.

2:50 to 3:20, the number.
"Doing that yourself is about twenty-five minutes of your attention, and a third of the time you call twice. Here it was four. The agent spent fourteen minutes on the phone. We measure both and show both. We do not compute a savings figure for you."

3:20 to 3:45, how it is built.
"Real Dial calls, one dispatch per authorization, signed webhooks, a frozen authorization snapshot, and the merchant side graded in Sparta's world, including when the API throws a 500 mid-run."

3:45 to 4:00, the path and the honesty line.
"Duplicate charges and cancellations first, insurance filing and follow-up second, nine dollars a case or fifteen percent of what comes back. We stay on filing and status, not settlement negotiation, which is regulated. Here is what was simulated today and what was live."

## 9. Judging alignment

| Criterion | Weight | What carries it |
| --- | --- | --- |
| Problem and impact, time saved | 40% | Section 4: measured active time next to agent phone time, with a stated 25-minute baseline |
| Technical execution | 25% | Section 7: Dial dispatch and webhook rigor, Sparta grading under interruption |
| Market and path forward | 15% | Section 5: wedge, sizing anchors, price and unit cost |
| Originality | 10% | Section 6: counterpart detection, step-in, mid-call decisions |
| Product quality and demo | 10% | Section 8: one polished case, under five minutes, simulated parts labelled |

## 10. Questions judges will ask, with answers

"What if the merchant refuses to talk to an AI?"
The agent says who it is, asks for a representative after two failed attempts in agent mode, and the person can step in at any time.
Refusals are recorded as an outcome with a next action, not hidden.

"How do you stop it from agreeing to something I did not want?"
Authorization freezes the amount, destination and permitted actions before dispatch.
Anything outside that scope becomes a decision prompt with a default and a countdown.

"Is the refund real when the call ends?"
No, and the UI never says so.
The outcome shows approval and payment as separate rows, and payment stays unverified until there is separate evidence.

"Why will Google not do this?"
Google's Call for Me waits and talks; it does not hold a scoped authorization, carry an evidence packet, adapt to an automated counterpart, or leave a verifiable case record.
It also needs a Pixel 11 and a paid Gemini plan.

"What is the cost per case?"
A 15-minute call at $0.10 to $0.20 a minute plus extraction is $2 to $4.
At $9 a case or 15% of recovery, it is margin positive on the first case.

## 11. Three-minute script, insurance first

This script supersedes section 8 for the live pitch.
It uses the baseline in `docs/SUBMISSION.md`: about 20 minutes of phone time for a claim call made by hand, and no percentage.
Sources for every figure are in section 3, plus Foran et al. 2023 for the 17.5-minute median insurer call.
About 450 words, which is three minutes at a normal speaking pace.

0:00 to 0:35, the problem.
"Raise your hand if you have been on hold with an insurance company this year. Americans spend twelve million hours a week on the phone with health insurers. That is a Stanford and Gallup number, and it costs nearly forty-eight billion dollars a year in wages, on the clock and in time off. On HealthCare.gov plans, insurers deny nearly one in five in-network claims. About one percent of those denials are ever appealed. Of the ones that are, about forty-four percent win. The money is there. People do not have the twenty minutes, two transfers and three callbacks it takes to go get it."

0:35 to 1:00, who it hurts.
"Seventy-seven percent of Americans had a product or service problem last year, a record. Sixty-eight percent say complaining is high effort. For a homeowner it is forty-one days from filing to final payment, with status calls the whole way. For a parent with a denied claim it is a call on a lunch break that ends in 'please hold'. The median call to an insurer runs seventeen and a half minutes. Most people make one attempt, then give up."

1:00 to 1:45, what Recourse does.
"Recourse is an agent that files and follows up on your claim over the phone while you do something else. You upload your plan documents once. You type what happened in plain language. The agent reads your policy and pulls the clause that covers you. Then it pulls from our knowledge base: the state's claim-handling deadlines, like California's fifteen days to acknowledge and forty days to decide, and the identifiers and phrases the insurer's line actually responds to. From that it forms the most complete, policy-grounded filing the call can carry, so the claim goes through the first time instead of bouncing for missing proof. Then it dials, gets through the menu, sits on hold, and when it hears an automated agent instead of a person, it switches scripts: dense, clause first, and it asks for a representative if it stalls."

1:45 to 2:25, human in the loop.
"Here is where we differ from everyone else. The insurer side is being automated end to end. Sierra just raised nine hundred fifty million dollars to do exactly that, and algorithms already deny claims at scale. The consumer tools either mail a letter or run fully autonomous. We do not think a machine should spend your claim without you. So nothing dials until you approve the exact facts, number and amount. During the call you can step in at any time. When the insurer proposes something, an adjuster visit, a different date, the prompt comes to you with a countdown and a stated default. And the outcome card shows approval and payment as separate rows, because a finished call is not a paid claim, and we will never pretend it is."

2:25 to 2:50, the number.
"Doing this yourself is about twenty minutes on the phone per call, by our stated baseline. In the app, your time is measured live: the seconds you were actually typing and clicking, shown next to the agent's phone time. We do not compute a percentage for you. We show both numbers and let you judge."

2:50 to 3:00, close.
"We file and we follow up. We do not negotiate settlements, which is a licensed job. Insurance first, refunds and cancellations on the same engine. Recourse: approve one call, get your money back."

If the demo runs in fixture mode, add the simulated-versus-real sentence from `docs/SUBMISSION.md` section 2 before the close.
