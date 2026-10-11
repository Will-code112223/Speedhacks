# Customer Desk

A small synthetic billing desk with duplicate charges, a renewal request and ambiguous identity.

This project uses synthetic data. agent.mjs is a scripted, model-free teaching example; real-agent.mjs is an editable model agent. Neither a scripted pass nor an agent transcript is evidence of real-world time saved.

## First run

Use Node 24 or later and the Worlds package that created this project.

Commands in this README and PROJECT_GUIDE.md use `worlds` as shorthand for the complete launcher that created this project. Replace only that shorthand; keep all launcher arguments and the same package version.

For a local npm install, use `npx --no-install worlds`. If you initialized with `npx --package <package-spec> worlds`, retain that complete prefix, including the same private tarball or package spec. For a source checkout, keep its source launcher. A bare `worlds` command works only when that executable is already on PATH.

Before changing directories, make relative launcher, checkout or private tarball paths absolute. Run the examples below from this project directory, or replace `--project .` with the absolute project path. The browser also shows a copyable reopen command for the installed runtime.

```sh
worlds starters run --project . --mission duplicate-charge -- node agent.mjs
worlds starters open --project .
```

The browser preserves world state and recorded results in .worlds-dashboard/starters. Close and reopen with the same project command. Changing missions preserves earlier work; Reset restores only the active world. The browser does not execute arbitrary processes: copy its connection details or run your agent from the terminal.

## Make it your own

project.json selects the seed, public missions, separate checks and default agent command. Edit them in the browser Project panel or on disk, then reload. Project runs use these files, not the bundled template. Each terminal run starts an isolated fresh world and runs from this directory.

Change the mission and starting records together with checks.json. Builtin checks are bound to the shipped seed and mission intent; custom targets require declarative assertions. Available checks are record-field, record-count, changed-count, change-scope, unchanged and forbidden-request. Add both the wanted result and protections for unrelated state. Checks are never included in WORLDS_TASK_JSON. Read the local [project guide](PROJECT_GUIDE.md) for their JSON grammar, a complete custom-check example and the persistence/evidence contracts.

Browser saves place immutable inputs in starter-inputs and switch project.json only after all inputs are written. Retain those referenced files with your project. If a save is interrupted, reload to inspect the committed version; previous worlds remain on disk. Never delete a live host lock to open a second host.

## Repeat and share

```sh
worlds starters run --project . --all --runs 3 --scenario interruption --evidence submission.json -- node agent.mjs
```

This command uses the scripted teaching example and the original missions. After customising the task, supply your own agent or use the real agent below. The interruption scenario injects a deterministic connector failure. Each repeat gets a fresh world; a failed, crashed or timed-out agent cannot pass. --evidence writes a new sanitised JSON file and refuses to overwrite one. --json is local diagnostic output and can contain the agent's raw reply; do not use it as your shared report.

In the browser, Grade outcome then download JSON evidence or the offline HTML report. Historical results remain separate from the current verdict; changes clear the current verdict. Inspect exports before sharing. Exported evidence is not signed and does not authenticate a competition submission.

## Agent connection

The runner supplies WORLDS_BASE_URL, WORLDS_API_KEY and public WORLDS_TASK_JSON on stdin and in the environment. Configure your connector SDK with the supplied local base URL. Stripe uses /v1/*; the demo ticket desk uses /api/v2/*. No real Stripe or Zendesk credentials are needed. The local child process is your trusted code, not a sandbox.

## Run a real model agent

real-agent.mjs is an editable, model-backed agent using Anthropic's Messages API and Node's built-in fetch. It has no npm dependencies and no mission answer table. The model receives the public mission, chooses advertised tools, sees their results and decides the next action. It can work with your own mission IDs and changed records. agent.mjs remains the model-free scripted smoke test.

Copy .env.example to .env and set ANTHROPIC_API_KEY to your model-provider key. Set WORLDS_MODEL_PROVIDER=anthropic and choose WORLDS_MODEL explicitly; the example uses claude-haiku-4-5. Do not supply Stripe or Zendesk credentials. Then run:

```sh
worlds starters run --project . --mission duplicate-charge --timeout 180 -- node --env-file=.env real-agent.mjs
```

This sends the mission and connector observations to Anthropic and may incur token charges. Review [provider pricing](https://platform.claude.com/docs/en/about-claude/pricing) and set an account spending limit before running. The agent prints aggregate input/output usage when it finishes; it does not calculate a dollar quote or guarantee a spending cap. Full conversation history is sent on each step. Limits default to 12 model steps, 1024 output tokens per step and 120 seconds total, configurable with WORLDS_AGENT_MAX_STEPS (up to 32), WORLDS_AGENT_MAX_TOKENS (up to 4096), and WORLDS_AGENT_TIMEOUT_MS (up to 600000). Keep the runner's --timeout longer than the agent budget. There is also a fixed 48-tool-call bound, 30-second per-request timeout and response/conversation size limits. Exhaustion and provider failures exit nonzero.

For an Anthropic-compatible local proxy, set WORLDS_MODEL_BASE_URL to an HTTP(S) numeric loopback origin, for example http://127.0.0.1:8000, and optionally WORLDS_LOCAL_MODEL_KEY. The path is always /v1/messages. ANTHROPIC_API_KEY is never forwarded to a proxy. Other remote model endpoints and all redirects are refused. A proxy may itself forward traffic or charge; its configuration is yours to review.

The supplied tools list and read this template's records, then offer the supported ticket, refund, cancellation-at-renewal, or draft-proposal writes. The model cannot supply URLs or admin endpoints. Connector traffic requires a numeric loopback origin and a twin key. Invalid arguments and connector errors return as tool errors for correction. Transient connector responses retry at most twice; identical mutations within a mission reuse an idempotency key, including model retries. Intentional identical writes are therefore deduplicated; express multiple goods with quantity. There is no automatic network-error retry, because a mutation may already have committed. Inspect state before continuing an interrupted run.

Edit the system prompt, tool descriptions and planning behavior in real-agent.mjs. Read AGENTS.md for the boundaries. Tests use a local protocol fixture and real local connector state; that establishes protocol and tool behavior, not live provider access or agent quality. A model's conclusion does not replace the world-state grade. Protocol references: [Messages API](https://platform.claude.com/docs/en/api/messages), [tool definitions](https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use), [tool results and errors](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls).



## Supported boundary

Stripe billing subset with demo-grade Zendesk-shaped tickets. No real accounts or payments.

The ticket API is a demo-grade subset for statuses, priorities, tags and comments. It has no email, calendar, assignments, deadlines or project dependencies.

Forbidden-request checks cover attempts recorded in this world's request log. Requests rejected before world selection are outside that log. Connector qualification is unchanged.
