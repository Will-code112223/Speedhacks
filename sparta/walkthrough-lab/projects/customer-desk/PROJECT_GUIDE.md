# Starter worlds

Commands in this README and PROJECT_GUIDE.md use `worlds` as shorthand for the complete launcher that created this project. Replace only that shorthand; keep all launcher arguments and the same package version.

For a local npm install, use `npx --no-install worlds`. If you initialized with `npx --package <package-spec> worlds`, retain that complete prefix, including the same private tarball or package spec. For a source checkout, keep its source launcher. A bare `worlds` command works only when that executable is already on PATH.

Before changing directories, make relative launcher, checkout or private tarball paths absolute. Run the examples below from this project directory, or replace `--project .` with the absolute project path. The browser also shows a copyable reopen command for the installed runtime.

Customer Desk, Team Inbox and Digital Shop are synthetic business environments for building agents that save people time. Start with the example, then give your own agent a task, inspect the persisted changes and grade the outcome.

Start with the versioned setup on the [hackathon participant guide](https://www.usesparta.co/hackathon#setup). It enables installation only after the release artifact and registry receipt match. A saved beta signup alone does not establish starter availability. The published 0.9.0-beta.1 and 0.9.0-beta.2 packages do not include these starter commands. This guide describes the beta.3 candidate source; use the event setup to confirm a published version includes it before installing.

## First pass

<!-- beta-install:start -->

Use Node 24 or later. First obtain the exact versioned launcher from the event setup linked above. In the examples below, `worlds` means that full launch command, including its pinned package or private tarball arguments. Do not assume a bare `worlds` executable is installed on PATH.

```sh
worlds starters open
```

<!-- beta-install:end -->

Choose a world and a mission, inspect the records, run the clearly labeled scripted example, and grade the outcome. This uses no model key or real connector account. Reset before another attempt. The example demonstrates the mechanics; its success is not an agent-performance or time-savings measurement.

| World | Build around | Supported boundary |
| --- | --- | --- |
| Customer Desk | Billing support, refund review, cancellation and identity escalation | Stripe billing plus the demo ticket desk |
| Team Inbox | Incident triage, helpful replies and clarification | Ticket priority, tags, comments and status |
| Digital Shop | Product selection and a proposal for review | Existing products/prices and quantities saved in one unpaid draft invoice |

The ticket desk has no email, users, assignments, calendar, deadlines or project dependencies. Digital Shop has no orders, fulfillment, inventory, shipping or hosted Checkout. Create invoice items before the draft; do not finalize or pay it. Reset to revise a proposal because item/draft editing is outside this surface. These starters do not use the separately supported native Zendesk profile. See [scope.md](https://www.usesparta.co/docs/scope).

## Make a persistent project

<!-- beta-install:start -->

```sh
worlds starters init team-inbox --out /tmp/my-team-inbox
worlds starters open --project /tmp/my-team-inbox
```

Keep the exact launcher that created your project. If it was an npx command, repeat its full pinned package prefix in place of `worlds`. A local/private install can use its absolute installed bin path. The exported README explains each form; bare `worlds` works only when that installation is on PATH. Export refuses to overwrite existing files.

<!-- beta-install:end -->

| File | Purpose |
| --- | --- |
| `project.json` | Project name, template, input paths and optional default agent command/timeout |
| `seed.json` | Starting records in the existing [seed format](https://www.usesparta.co/docs/seed-format) |
| `missions.json` | Public task IDs, titles, prompts and policies |
| `checks.json` | Separate declarative expectations or the unchanged builtin checks |
| `real-agent.mjs` | Editable model agent; no answer table or npm dependencies |
| `agent.mjs` | Model-free teaching script for the original missions |
| `PROJECT_GUIDE.md` | Offline project and declarative-check reference, copied from this guide |
| `.env.example`, `.gitignore`, `AGENTS.md`, `README.md` | Provider setup, private-file exclusions and development instructions |

Project mode retains worlds and recorded results under `.worlds-dashboard/starters/`. Reopen the same directory after stopping the command. Each mission/input revision keeps its own world; reset affects only the selected world. The runtime chooses a new local port, so refresh connection details after restarting. Historical grades remain visible, but the current world must be graded again.

The Project panel edits the four JSON documents together. A save validates all inputs before writing, places new inputs under `starter-inputs/`, then atomically switches `project.json`. Keep its referenced files when sharing the project. External edits require **Reload files**. A stale browser edit cannot overwrite a newer revision. After a save error or power loss, reload to see which manifest committed; prior worlds remain retained.

Only one host may own a project. A confirmed dead process on the same computer can be recovered automatically. Unknown or foreign ownership, symlinks, corrupt metadata and missing worlds produce errors without silently replacing existing work. Do not delete a live lock. Stop the original host first; preserve the project when investigating corruption.

Without `--project`, the browser keeps its original temporary behavior: selecting another mission discards that temporary world, and closing the command removes the temporary runtime.

## Define your own outcome

Each serialized public task, including its envelope and policies, must fit within 32 KiB. Mission IDs must be unique, and every mission needs exactly one nonempty check set. Builtin checks are tied to the shipped seed and mission intent. If you edit the starting data, prompt or policy, replace the builtin binding with declarative assertions. This prevents an old hard-coded target from passing a new task.

For example, a custom mission asking only to place ticket 2 in pending status can use:

```json
{
  "my-follow-up": {
    "assertions": [
      {
        "id": "pending",
        "label": "Ticket awaits follow-up",
        "type": "record-field",
        "resource": "tickets",
        "recordId": "2",
        "path": ["status"],
        "op": "equals",
        "value": "pending"
      },
      {
        "id": "scope",
        "label": "Only the intended ticket changes",
        "type": "change-scope",
        "allowed": [
          {"resource": "tickets", "kinds": ["updated"], "recordIds": ["2"]}
        ]
      }
    ]
  }
}
```

The public mission must use `id: "my-follow-up"`. Inspect the initial world to find its actual IDs. The project seed schema remains authoritative; do not add unsupported fields to seed rows.

| Assertion type | Required fields beyond `id` and `label` |
| --- | --- |
| `record-field` | `resource`, `recordId`, `path` array, `op` (`equals`, `includes` or array `count`), `value` |
| `record-count` | `resource`, `count` |
| `changed-count` | `resource`, `kind` (`created`, `updated` or `deleted`), `count` |
| `change-scope` | `allowed` rows with `resource`, nonempty `kinds` and optional `recordIds` |
| `unchanged` | `resource`, `recordId`, optional `paths` array of field paths |
| `forbidden-request` | `method` and/or exact `path` |

Missing records/fields do not pass field or unchanged checks. A count of zero explicitly tests absence. Checks contain no executable code or arbitrary regular expressions. Pair desired changes with checks protecting unrelated records. They verify the chosen expectations, not unrestricted agent quality.

Forbidden-request checks inspect attempts in this world's request log, including rejected calls recorded there. Requests rejected before world selection are absent from that log. Path matching strips the query and decodes segments once; it does not treat the whole server as an agent security sandbox.

## Run your agent

<!-- beta-install:start -->

```sh
worlds starters run --project /tmp/my-team-inbox -- node agent.mjs
worlds starters run --project /tmp/my-team-inbox --all --runs 3 --scenario interruption --evidence /tmp/submission.json -- node agent.mjs
```

<!-- beta-install:end -->

These commands run the unchanged teaching sample. Use your own command after `--` for a custom task. The process runs from the project directory. With no command override, project mode uses `project.json`'s agent settings. The generated default is the real agent; configure its private `.env` before using it.

Every run gets a fresh authenticated world. `--all` covers the selected project's missions; without a project/template, it covers all bundled missions. `--runs` repeats each selected mission. Runs are serial and bounded; interruption stops the remaining batch. `--scenario interruption` injects a deterministic connector failure. Repeated mutations should reuse the same idempotency key.

The generated real agent uses Anthropic's Messages API. Set the explicit provider/model and your own key in `.env`; model calls send public task and connector observations to that provider and can incur charges. Read the generated README for provider links, proxy configuration, tool limits and timeout settings. No live-provider success or model-quality result is implied by local protocol tests.

Default runner timeout is 60 seconds for a bundled run and the saved timeout for a project. The generated project uses 180 seconds around the real agent's default 120-second budget. `--timeout` overrides it, up to 3600 seconds. A nonzero, timed-out or interrupted process cannot pass even when some state checks pass.

Exit codes: `0` passing completed run; `1` state or agent failure; `2` invalid configuration/unlaunchable agent; `3` runtime or artifact failure; `124` timeout; `128 + signal` interruption.

## Evidence and submission

`--evidence` writes a new sanitized JSON file, refusing an existing target before running the agent. A single run writes its versioned evidence; a batch also records planned/completed runs, aggregate success and exit code beside `{version: 1, runs: [...] }`. `--json` is local diagnostic output and can include the agent's raw reply; it is not the sharing format.

In the browser, grade the current world, then download JSON or a self-contained HTML report. Changing the world invalidates the current grade. Recorded history keeps captured results separately. Evidence identifies the installed package version, inputs, mission, scenario, checks, state, diff and recorded requests; terminal evidence also records process outcome. It strips runtime bindings, provider credentials and private execution fields.

Each evidence object is bounded to 1 MiB. Larger output produces an explicit error rather than a truncated or passing artifact. Keep hackathon worlds small. Redaction can remove data needed to replay an experiment; keep the original project locally and review exports before sharing. Evidence is unsigned and participant-controlled. Judges should rerun the submitted project rather than treat a reported pass as authentication.

## Connection contract

| Variable | Meaning |
| --- | --- |
| `WORLDS_BASE_URL` | Current local connector origin |
| `WORLDS_API_KEY` | World-scoped twin Bearer key |
| `STRIPE_SECRET_KEY`, `STRIPE_API_KEY` | Aliases of the twin key |
| `WORLDS_WORLD_ID` | Current world identity |
| `WORLDS_TASK_JSON` | `{templateId, mission: {id, title, prompt, policy}}`, without checks |

The runner removes inherited Worlds operator credentials. It launches trusted local code with the remaining environment; this is not an execution sandbox. POSIX cleanup stops the process group; a deliberately detached process can escape it. Supported release platforms are macOS and Linux.

Use your connector's SDK with the supplied local host, or fetch `/v1/*` and `/api/v2/*` directly. Ticket writes accept JSON. The generated agent restricts URLs, tools, retries and model budget. Keep browser hosts running while using their bindings, and stop your external agent before reset, mission selection or project reload.

The browser exposes fixed local operations with Host/Origin and capability checks. It provides no arbitrary shell execution or admin proxy. Its refresh and grading operations refuse changing snapshots. See the [hackathon participant guide](https://www.usesparta.co/hackathon) for the event path and suggested submission format.
