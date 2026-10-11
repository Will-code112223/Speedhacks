# Worlds by Sparta: organizer technical review

Start here to run the same local package builders will use. This short walkthrough installs **`sparta_worlds@0.9.0-beta.3`**, creates a seeded Team Inbox project, and shows a failure and a fix against the same task and checks. The **15–20-minute first-use time is a target for you to measure**, not an observed onboarding result.

The packet has four main documents: [ONE_PAGER.pdf](ONE_PAGER.pdf) introduces the product and project ideas; this file gives setup and the working demo; [AGENT_GUIDE.md](AGENT_GUIDE.md) explains how to build your own agent; [DEMO_SCRIPT.md](DEMO_SCRIPT.md) outlines the three-minute presentation. Use [CHECKLIST.md](CHECKLIST.md) to return brief feedback. The small `demo/` folder contains the deliberately broken teaching agent, and [LICENSE.txt](LICENSE.txt) contains the beta terms.

## 1. Install the pinned public package

You need macOS or Linux, **Node 24+**, npm, a browser, and internet for installation. The model-free walkthrough needs no model API key, real Stripe/Zendesk account, Sparta signup, invitation code, paid team seat, source checkout, pnpm, Python or Docker. Optional model runs use your own Anthropic account and key and incur provider charges; no model credits are included. Local testing has no per-run fee.

Extract the ZIP and open a terminal in the folder containing this file. Run each command individually:

```sh
node --version
npm --version
mkdir walkthrough-lab
cd walkthrough-lab
npm init -y
npm install --registry=https://registry.npmjs.org/ --ignore-scripts --no-audit --no-fund --save-exact sparta_worlds@0.9.0-beta.3
npx --no-install worlds --version
npx --no-install worlds starters list
mkdir evidence
```

Stop if Node's major version is below 24; install Node 24 or later and reopen the terminal before proceeding. Expect Worlds **0.9.0-beta.3** and a catalog containing Customer Desk, Team Inbox and Digital Shop. `npx --no-install` uses the installed local binary without fetching a different version. Use this pinned npm path; the website activation was still pending when this kit was prepared. All commands below run from `walkthrough-lab/`.

The npm package contains the original agents, seeded data, missions, checks and project references for all three experiences. The following `init` command writes the complete editable Team Inbox project locally; no separate project download is needed.

## 2. Run one useful task

```sh
npx --no-install worlds starters init team-inbox --out ./projects/team-inbox
npx --no-install worlds starters run --project ./projects/team-inbox --mission urgent-triage --evidence ./evidence/team-inbox-original.json -- node agent.mjs
```

Expect **PASS / exit 0**. The agent prioritizes a sign-in incident, keeps the ticket open, adds a private investigation note and acknowledges the incident publicly while protecting unrelated tickets. Open the evidence JSON to inspect `grade`, `snapshot` and `execution`. This single-mission export has a different shape from the aggregate export produced by `--all` or repeated runs.

`agent.mjs` is a model-free teaching script, not a live AI agent or a participant submission. The explicit `-- node agent.mjs` selects it. If initialization suggests configuring `.env`, skip that for this path: the default manifest points to the optional model-backed `real-agent.mjs`.

## 3. See a failure, then the fix

Copy the supplied no-retry variant into the generated project. This extra file is included in the packet because npm does not generate it.

```sh
cp ../demo/agent-no-retry.mjs ./projects/team-inbox/
npx --no-install worlds starters run --project ./projects/team-inbox --mission urgent-triage --scenario interruption --evidence ./evidence/before.json -- node agent-no-retry.mjs
```

Expect **FAIL / exit 1**. A deterministic connector interruption returns HTTP 500; the no-retry agent gives up and the required work remains incomplete. This failure is intentional. Preserve `before.json`, then run the original retrying agent:

```sh
npx --no-install worlds starters run --project ./projects/team-inbox --mission urgent-triage --scenario interruption --evidence ./evidence/after.json -- node agent.mjs
```

Expect **PASS / exit 0**. The same route records 500 followed by 200, and the final-state checks pass. Compare `agent-no-retry.mjs` with `agent.mjs`: the broken copy disables the retry condition with `false &&`. The correction is the original agent's bounded retry. Both runs use the **same mission, seed, interruption and checks**, each in a fresh isolated world.

Compare the actual state, checks and request history in `before.json` and `after.json`. This demonstrates a testing workflow, not measured model performance or human time saved. Evidence files are not overwritten; use new filenames for another rehearsal.

## 4. Inspect the browser experience

```sh
npx --no-install worlds starters open --project ./projects/team-inbox --no-open
```

Open the printed loopback URL and keep the terminal running. Select **Triage the sign-in incident**, inspect the task and seed, click **Run scripted example**, then **Grade result**. Inspect the ticket, public reply, private note, unrelated records and state diff. Download **JSON** and **HTML**; open the self-contained HTML locally.

The browser has its **own persistent world**. Terminal runs create separate fresh worlds and do not update browser history. Stop the browser host with **Ctrl-C**. Run the same open command again to reopen the retained project; refresh connection details after a restart because the port may change. Reset returns the selected world to its starting state.

## 5. Build something of your own

Read [AGENT_GUIDE.md](AGENT_GUIDE.md) and the generated `projects/team-inbox/PROJECT_GUIDE.md`, which contains the task/check grammar. Edit the public task and starting data, write separate outcome/protection checks, and replace the command after `--` with your own agent. Keep the check file out of the running agent's planning input. The generated `real-agent.mjs` is an editable Anthropic example; the agent guide explains its optional key, model and spending requirements.

To explore the other templates, initialize them from the same installed package:

```sh
npx --no-install worlds starters init customer-desk --out ./projects/customer-desk
npx --no-install worlds starters init digital-shop --out ./projects/digital-shop
```

Customer Desk uses Stripe and the demo-grade ticket desk. Team Inbox uses that desk's tickets and public/private comments. Digital Shop selects existing products/prices and creates unpaid Stripe draft invoices. This kit includes no Gmail, Shopify, email sending, assignments, calendar, checkout, inventory or fulfillment, and does not use the separate native Zendesk workflow.

## Return your review

Fill in [CHECKLIST.md](CHECKLIST.md) with your observed timing and any blockers. Share selected, inspected JSON/HTML evidence and concise reproduction steps. Exclude `.env`, keys, runtime databases/locks, raw diagnostics and `node_modules/`. Evidence is unsigned and participant-controlled; a local pass covers the explicit checks and process outcome.

For this walkthrough, `--evidence` exports JSON; the browser exports HTML. `worlds starters run` has no `--report` option. Unexpected versions, missing evidence or any nonzero exit except the labeled failure are blockers to record. Preserve the first result when troubleshooting.
