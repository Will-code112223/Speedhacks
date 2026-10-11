# Team workflow with Alike

We are four people and several coding agents working on one repo for one day. [Alike](https://alike.help) gives every agent the same shared memory. Each session starts with a brief of what teammates decided and what they are working on right now, so no one re-litigates a decision or builds the same thing twice.

## Setup (10 minutes, once per laptop)

1. Open the **team invite link** from the team chat. It is deliberately not in this repo. Sign up at alike.network and join the workspace.
2. Run the setup script and approve the pairing link it prints, within 10 minutes:
   ```bash
   ./scripts/setup-alike.sh
   ```
   This runs `npx @alikeai/setup`, which wires Alike into Claude Code, Cursor, Codex and other supported agents it finds.
3. Restart your agents and approve the **alike** MCP server when prompted.
4. Check it works. Ask your agent:
   > I'm on branch `<your-branch>` in Speedhacks. What does Alike know about this work?

If anything fails, run `npx @alikeai/setup --doctor`.

## How we work today

**One branch per workstream.** Start each agent session by naming the branch. Alike links the session to it and briefs the agent on related work.

| Workstream | Branch | Covers |
| --- | --- | --- |
| Inspect pipeline | `jonathan/factory-ai-demo` | `src/factory_ai/inspect`, `synth`, `cad` |
| Maintain + Monitor | `<name>/maintain-monitor` | `src/factory_ai/maintain`, `monitor`, `spine.py` |
| Demo, report, video | `<name>/demo` | `demo/`, `docs/assets/`, the 5-minute video |
| Pitch and submission | `<name>/submission` | README, the HackerSquad form, the time-saved assumptions |

**Record decisions as you make them**, including the option you rejected:
> Record in Alike that inspection tolerance stays ±0.25 mm for BRK-1042, and that we rejected per-feature tolerances because there isn't time today.

**Check before starting something new:**
> Is anyone else working on the demo report right now?

**Keep one source of truth for the numbers in the pitch.** Record the time-saved assumptions as a decision. When someone changes `src/factory_ai/timesaved.py`, every agent will know.

### Decisions already made

Ask your agent to record these on first use so the workspace starts with them:

- Wedge: geometric inspection of machined parts from CAD-generated synthetic scans. Photoreal image rendering is out of scope for today.
- Verdicts are PASS, REVIEW or FAIL. Uncertain parts go to a person, and nothing is auto-rejected below 60% confidence.
- Time saved is reported with explicit, editable assumptions, and setup and review time are counted (rubric: 40% problem and time saved).
- The demo is honest about what is simulated (see README, "What is real and what is simulated").

## Privacy, briefly

- Raw transcripts, prompts and tool calls are never shared with teammates.
- At the default **High Sharing** level, the workspace sees session summaries, decisions, and the branch and folder of each session.
- To share less, change it under **Settings → Privacy** before pairing.

## For the submission

Alike is a SpeedHacks partner tool, with a $1,000 best-use prize. List it under technologies used, and say in one line how it helped, for example: "4 people, N agent sessions, decisions shared through Alike."
