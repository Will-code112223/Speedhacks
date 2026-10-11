# Three-minute demo: fail, fix, verify

**Format:** about one minute introducing the problem and Worlds, then two minutes demonstrating one Team Inbox workflow. This is also the recording outline. **Presenter:** Arya to confirm.

Use the published, pinned `sparta_worlds@0.9.0-beta.3` and **Triage the sign-in incident**. The two agents are model-free teaching scripts: the labeled `agent-no-retry.mjs` disables the shipped agent's retry condition. The demonstration needs no model key.

## Prepare before presenting or recording

Complete sections 1–2 of [START_HERE.md](START_HERE.md). From `walkthrough-lab/`, copy the teaching variant and create an evidence directory:

```sh
cp ../demo/agent-no-retry.mjs ./projects/team-inbox/
mkdir -p demo-evidence
```

Keep a terminal and editor visible. Open `projects/team-inbox/missions.json`, both agent files and the evidence directory. Use fresh evidence filenames for each rehearsal; existing files are never overwritten. Run the commands individually because the first intentionally fails.

Capture the terminal commands and the JSON those commands produce. Keep the entire demonstration on this CLI workflow; the browser's separate world is outside this recording. Rehearse once before recording and keep any previous evidence labeled as a rehearsal.

## 0:00–1:00 — Problem and introduction

Show the mission text while saying:

“An agent can say it handled a support incident while leaving the ticket wrong, exposing a private note or giving up after a temporary API failure. Reading its answer doesn't tell us whether the job is done.

“Worlds by Sparta gives your agent a local business environment with synthetic records, connector APIs and a repeatable starting point. You define the outcome and check the state the agent leaves behind. Grade what the agent did, not what it said.

“Here the job is to prioritize a sign-in incident, keep the investigation note private and acknowledge the issue publicly. The ticket must stay open. I'll run the same task with the same interruption twice, change one behavior and inspect the evidence.”

## 1:00–1:40 — Reproduce the failure

```sh
npx --no-install worlds starters run --project ./projects/team-inbox --mission urgent-triage --scenario interruption --evidence ./demo-evidence/before.json -- node agent-no-retry.mjs
```

Expected: exit **1**. Open the newly written `before.json` and show the failed checks and recorded HTTP 500.

“This version gives up on the temporary failure. The process fails and the required ticket changes are incomplete. The report checks the world, not the agent's claim.”

## 1:40–2:00 — Show the correction

Compare the retry condition in the two agent files. `false &&` disables retry in the labeled broken copy; the original `agent.mjs` retries transient responses within its existing bound.

“The change is bounded retry. The task, starting data, interruption and checks stay the same. Each run gets a fresh isolated world.”

## 2:00–2:40 — Run the same workflow again

```sh
npx --no-install worlds starters run --project ./projects/team-inbox --mission urgent-triage --scenario interruption --evidence ./demo-evidence/after.json -- node agent.mjs
```

Expected: exit **0**. Open this command's `after.json`. Show the recorded 500 followed by a successful retry, then the passing checks and ticket state: urgent and open, one added private note, one added public reply, unrelated records preserved.

“The corrected agent finishes despite the same interruption. These checks cover the requested outcome, comment privacy and allowed changes.”

## 2:40–3:00 — Evidence and next step

Keep `before.json` and `after.json` beside each other. Point to their matching mission and input identity, and their different outcomes.

“This is the build loop: choose a useful task, test a complication, fix the agent and inspect what changed. Start with Team Inbox, Customer Desk or Digital Shop, then build your own agent and checks using the agent guide.”

Link viewers to [START_HERE.md](START_HERE.md) and [AGENT_GUIDE.md](AGENT_GUIDE.md).

## If the live step behaves differently

Preserve the unexpected output. A saved rehearsal can illustrate the intended flow if clearly labeled; it cannot replace the current result. This scripted demonstration shows the testing workflow, not measured human time saved or live model performance.
