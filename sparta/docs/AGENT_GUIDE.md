# Build with Worlds: guide for developers and coding agents

This is the agent-ready companion to the SpeedHacks organizer bundle. First complete the install and Team Inbox setup in the [START_HERE.md](START_HERE.md), using its pinned published npm beta.3 installation and generated projects. **Run every command below from that same `walkthrough-lab/` directory** unless a step says otherwise. An editor's coding assistant can read this file alongside the selected project's AGENTS.md, README.md and PROJECT_GUIDE.md. Package-generated project guides retain older candidate/event-page setup wording; use START_HERE.md for installation.

## The job Worlds does

Your product supplies the user interface, planning and useful workflow. Worlds supplies a synthetic business environment, connector calls, repeatable starting state, deterministic interruptions and explicit final-state checks. Test what your agent changes, including what it should leave untouched.

Use `projects/team-inbox` for the quickest ticket workflow; `projects/customer-desk` adds billing actions; `projects/digital-shop` prepares unpaid proposals from an existing catalog. Data is synthetic and no real connector account is required.

## Start with the model-free path

After the setup has created `walkthrough-lab/projects/team-inbox`, open it from `walkthrough-lab/`:

```sh
npx --no-install worlds starters open --project ./projects/team-inbox
```

Choose a mission, inspect the records, run the scripted example and grade. The terminal must stay running. Ctrl-C and the same open command reopen a retained browser project; refresh connection details after a restart because the local port may change. Reset affects the selected world.

For a terminal run, stop or leave the browser alone and run this from a second terminal in `walkthrough-lab/`:

```sh
npx --no-install worlds starters run --project ./projects/team-inbox   --mission urgent-triage -- node agent.mjs
```

The child agent's working directory is the selected project. Terminal runs create fresh isolated worlds; they do not populate the browser's retained world. Browser evidence and terminal evidence describe their respective runs.

`agent.mjs` is a known-answer teaching script. It is useful for installation checks and the failure/fix demo, but it is not the participant's original agent or evidence of model quality.

## Run the editable model agent

The generated `real-agent.mjs` uses Anthropic's Messages API and Node's built-in fetch. It reads the public task and connector observations, without an answer table. It has no additional npm dependencies.

Copy `projects/team-inbox/.env.example` to `projects/team-inbox/.env`. Set `WORLDS_MODEL_PROVIDER=anthropic`, select `WORLDS_MODEL` explicitly from models your account can use, and supply your `ANTHROPIC_API_KEY`. Keep the generated call/token/time limits in place while experimenting. Your provider bills model use; this kit includes no credits. The model receives the public task and connector observations. Never put real Stripe or Zendesk keys in this project.

Run this only when you intend to make paid model calls:

```sh
npx --no-install worlds starters run --project ./projects/team-inbox   --mission urgent-triage --timeout 180 -- node --env-file=.env real-agent.mjs
```

An agent working on your code should not launch paid runs automatically. Ask it to make and inspect local changes first, then run a bounded model attempt with your chosen provider settings. You can use your own framework or provider with the connection contract below; the supplied agent implements Anthropic only.

## Give your coding assistant a concrete brief

> Read AGENT_GUIDE.md and the selected project's AGENTS.md, README.md and PROJECT_GUIDE.md. Help me build an original time-saving agent in real-agent.mjs (or my own entry point). Start with one narrowly defined task and inspect the existing public records. Update the public mission and starting data alongside separate declarative outcome checks. Keep the checks out of the agent's planning input. Preserve unrelated records and private notes, keep connector calls on the supplied local world, and use bounded retries with stable idempotency keys where supported. Explain each change. Do not run paid model calls without my instruction. Test the resulting workflow normally and under interruption, then help me inspect and export evidence.

## Edit the task and expected outcome together

| Project file | What belongs there |
| --- | --- |
| `project.json` | Template, referenced input files, agent command and timeout |
| `seed.json` | Starting records using the existing seed schema |
| `missions.json` | Public task IDs, prompts and policies |
| `checks.json` | Separate expected outcomes and protections for unrelated data |
| `real-agent.mjs` | Your model agent's prompts, tools and planning behavior |

The browser's Project inputs panel can edit and validate the inputs together. When you edit files in your editor, use **Reload files**. Browser saves may create referenced inputs in `starter-inputs/`; keep those files with the manifest.

A changed task/seed must replace the shipped builtin check binding with declarative assertions. Keep the mission ID aligned with its check set. PROJECT_GUIDE.md includes the exact grammar and a complete example. Available checks include record fields/counts, changed counts, allowed change scope, unchanged records and forbidden requests. Pair the wanted result with protections for unrelated data. A no-op agent should fail an action task. Do not weaken correct checks just to make a failing agent pass.

As a project author you may inspect checks to diagnose a failure. The running agent should decide from the public task and connector observations, not read `checks.json`, import grading code or copy the sample answer table.

## Connect your own agent

The runner injects:

| Binding | Meaning |
| --- | --- |
| `WORLDS_BASE_URL` | Current numeric loopback connector origin |
| `WORLDS_API_KEY` | World-scoped twin Bearer key |
| `WORLDS_TASK_JSON` | `{templateId, mission: {id, title, prompt, policy}}`; no checks |
| `WORLDS_WORLD_ID` | Current world identity |
| `STRIPE_SECRET_KEY`, `STRIPE_API_KEY` | Aliases of the twin key, not real Stripe credentials |

Use the actual connector SDK with its base URL pointed at the local world, or Node fetch with `Authorization: Bearer <WORLDS_API_KEY>`. Stripe paths start `/v1/`; starter ticket paths start `/api/v2/`. For the persistent browser world, follow **Connect your agent** and keep that host running. Refresh bindings after restart and stop external agents before resetting or switching worlds.

Ticket reads and comment history are separate:

- `GET /api/v2/tickets.json` returns `{tickets: [...]}`.
- `GET /api/v2/tickets/{id}.json` returns `{ticket: {...}}`.
- `GET /api/v2/tickets/{id}/comments.json` returns `{comments: [...], count, next_page, previous_page}`.
- `PUT /api/v2/tickets/{id}.json` accepts JSON `{ticket: {status, priority, tags, comment: {body, public}}}`. Send only fields authorized by the task. Append a singular `comment`; do not replace the history with a `comments` array. Preserve existing tags and keep private notes private.

The browser inspector combines ticket/history for display; do not assume that is the connector response shape. Inspect the live response and support the paging you need. The generated agent provides template-specific tools and bounded transient retries. Read state before retrying an uncertain mutation.

## Test a complication and save evidence

Create an output directory once, then use new filenames for every run. These commands use the model-free teaching sample; substitute your own command after `--` when ready:

```sh
mkdir -p evidence
npx --no-install worlds starters run --project ./projects/team-inbox   --mission urgent-triage --evidence ./evidence/normal.json -- node agent.mjs
npx --no-install worlds starters run --project ./projects/team-inbox   --mission urgent-triage --scenario interruption   --evidence ./evidence/interruption.json -- node agent.mjs
```

After a single custom workflow is correct, add `--runs 3` for fresh-world repeats. Use `--all` only when your agent supports every mission in that project. Each extra real-model attempt may add cost. A nonzero/timed-out process cannot pass a terminal run even if some state checks pass.

`--evidence` refuses an existing filename. `--json` is raw local diagnostics and can include the agent's reply; it is not the sharing format. In the browser, **Grade result** enables **Download JSON** and **Download HTML**. State changes clear the current grade; retained historical results are separate. Evidence is unsigned, so reviewers should rerun the project rather than trust a pass label alone.

For a submission, share your source, project manifest and its referenced public inputs, exact runtime/provider/dependency instructions, normal and interruption evidence, and a brief explanation of what you built. Exclude `.env`, provider keys, runtime databases, lock files and raw diagnostic output. Review even sanitized exports before sharing. This is technical evidence guidance; the organizers set competition eligibility and submission rules.

## Show testing and improvement in your final demo

Use your own agent entry point and at least one task or check set that you authored. Explain the repeated manual work your project addresses. Show a baseline failure or controlled interruption, the agent change, and a corrected run on the same inputs and checks. Point to the changed record, relevant request/retry and protections for unrelated data. Include exact reproduction instructions and selected sanitized before/after evidence. Keep the original failure alongside later results. If you claim time saved, explain your baseline and how you measured it.

## Boundaries and recovery

The starter desk is demo grade and has no email, assignments, deadlines or calendar. Digital Shop selects existing products/prices and creates one unpaid draft invoice; no inventory, shipping, fulfillment, hosted Checkout or purchase. Create invoice items before the draft; reset to revise a proposal. These starters do not exercise the separate native Zendesk profile.

Use Node 24+ on macOS/Linux. If a command is missing, confirm this kit's pinned runtime is installed; older public betas lack starter commands. Stop the original host if a project is already owned; do not delete a live lock. Preserve the project on corruption or save errors and reload the committed files. The local child agent is trusted code on your computer, not a shell sandbox. The model-free walkthrough can work offline after installation; provider runs need network access.
