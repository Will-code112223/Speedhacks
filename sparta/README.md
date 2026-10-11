# Sparta Worlds kit for SpeedHacks

This folder holds the Worlds by Sparta hackathon kit, installed per the organizer's START_HERE guide on 2026-10-11.
The kit gives you a synthetic business environment with seeded data, missions, deterministic interruptions and final-state checks for testing an agent.

## Layout

- `docs/` - the organizer packet: START_HERE, AGENT_GUIDE, DEMO_SCRIPT, CHECKLIST and LICENSE.
- `demo/agent-no-retry.mjs` - the deliberately broken teaching agent used in the failure/fix demo.
- `walkthrough-lab/` - the npm workspace with `sparta_worlds@0.9.0-beta.3` pinned and three generated projects under `projects/`.
- `walkthrough-lab/evidence/` - JSON evidence from the verification runs done during setup.

## Verified state

All commands below were run from `walkthrough-lab/` and behaved as the guide says.

| Run | Result |
| --- | --- |
| `urgent-triage` with `agent.mjs` | PASS, exit 0 |
| `urgent-triage --scenario interruption` with `agent-no-retry.mjs` | FAIL, exit 1 (expected) |
| `urgent-triage --scenario interruption` with `agent.mjs` | PASS, exit 0 |
| Browser host, scripted example, grade | all checks pass |

## Everyday commands

Run every command from `walkthrough-lab/`.

Open the browser experience:

```sh
npx --no-install worlds starters open --project ./projects/team-inbox
```

Run a mission in the terminal with the model-free teaching agent:

```sh
npx --no-install worlds starters run --project ./projects/team-inbox --mission urgent-triage --evidence ./evidence/<new-name>.json -- node agent.mjs
```

Run the model-backed agent.
This makes paid Anthropic calls, so fill in `ANTHROPIC_API_KEY` in `projects/team-inbox/.env` first.

```sh
npx --no-install worlds starters run --project ./projects/team-inbox --mission urgent-triage --timeout 180 -- node --env-file=.env real-agent.mjs
```

List every starter and mission:

```sh
npx --no-install worlds starters list
```

## Building your own agent

Read `docs/AGENT_GUIDE.md` and `walkthrough-lab/projects/team-inbox/PROJECT_GUIDE.md`.
Edit `missions.json`, `seed.json` and `checks.json` together, and replace the command after `--` with your own entry point.
Keep `checks.json` out of the agent's planning input.
Evidence filenames are never overwritten, so pick a new name for every run.
