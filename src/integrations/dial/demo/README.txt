TEAMMATE 3 — SYNTHETIC DEMO AND QA KIT

Start with walkthrough.txt. Use acceptance-checklist.txt when teammate 2 has a
reviewable integration ready. These are proposed V1 handoff examples, not an
implemented case engine or an insurer knowledge base.

The three scenario folders contain small text/plain upload documents and a
scenario.txt describing the intended facts, brief, authorized actions, scripted
conversation and acceptable outcomes. Every document is fictional. Example
contacts and phone numbers are fixture data only and must never be dialed.

Scenario index:
- scenarios/duplicate-charge/scenario.txt: one USD 74.90 purchase, two posted
  charges; receipt.txt, statement.txt and customer-note.txt.
- scenarios/fictional-insurance/scenario.txt: request USD 130.00 reimbursement
  under an invented policy; policy.txt, repair-invoice.txt and incident-note.txt.
- scenarios/needs-clarification/scenario.txt: contradictory merchants/amounts
  and missing destination; receipt-fragment.txt, statement-fragment.txt and
  customer-note.txt. This scenario must stop before authorization or calling.
coverage-map.txt records what existing tests cover and why new tests were added.

Verification levels — keep these separate in the demo:
1. Scripted rehearsal: read the scenario documents and expected conversation.
   No model, extraction, authorization endpoint or phone call executes.
2. Explicit adapter simulation: createDialAdapter({mode:"simulated"}) generates
   a deterministic simulated ID and the adapter's one fixed synthetic transcript.
   It does NOT select any of these scenarios or produce their scripted dialogue.
3. Mocked live-mode transport tests: the real adapter normalizes injected fake
   provider responses. A returned mode:"live" describes the selected code path,
   not evidence that the provider was contacted. No voice-agent behavior is proven.
4. Verified live behavior: earlier authenticated read-only account/number checks
   succeeded. No real call, recorded conversation, transfer, claim submission or
   deployed webhook delivery has been verified in this workstream.

Safe QA command from the repository root (Node >=22.18):
  node --test src/integrations/dial/__tests__/*.node-test.mts
The tests inject synthetic transport/configuration. Do not load dial.env or run
live-smoke.mts for this kit. No credentials, application server or dependency on
teammates' branches is needed to run the standalone adapter tests.

Contract boundaries:
- Shared V1 types remain owned by teammate 2. Amounts are integer minor units;
  unknown facts are null. There is no new policy, partial-offer or transfer field.
- Insurance uses only a fictional document supplied with its scenario. It asks
  for review of reimbursement, not a guaranteed coverage decision or payment.
- A partial offer remains unaccepted and requires a customer decision outside
  this kit. Store its quote/next action using existing V1 outcome fields; do not
  invent a new enum or expose unsupported mid-call approval controls.
- Unresolved required facts prevent authorization. The adapter receives only
  a server-prepared approved brief; it cannot validate documents or resolve
  contradictions itself.
- T2 owns extraction, case state, authorization, persistent attempt/event dedup,
  outcome analysis and transcript reconciliation. T1 owns the UI. This kit adds
  neither implementation and does not modify their knowledge-base work.

Use acceptance-checklist.txt to record PASS / FAIL / NOT RUN with a commit and
evidence. Proposed expected dialogue is never evidence of a passing live test.
