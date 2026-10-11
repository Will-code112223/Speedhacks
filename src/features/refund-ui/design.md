# Recourse UI design lock

Read this before writing any component under `src/features/refund-ui`.
It follows the Refero skill in `.agents/skills/refero-design` with its bundled craft references, since the live Refero MCP needs a paid token we do not have.

## October 11 visual refinement

### Compact workspace revision

The latest user revision removes the global mode badge, Graph help and extra graph panels.
Keep source provenance with actual call results. The graph
uses a wider 960 × 440 layout, capped at 350px on desktop and 260px on mobile, with pan, zoom, movable nodes and
keyboard selection. Remove the inspector, connection list and timeline below
the canvas, including Graph help; this supersedes the earlier inspector decision below.

New case keeps a two-sentence description of Recourse's insurance and refund
purpose, then three short steps: describe the issue, attach documents, review and
approve. Three sample requests populate the composer without submitting. Provider logos and real document excerpt tiles supply visual interest.
The source is the user's explicit request for less text and useful previews.

### Provider library extension

The Plans view reads the existing insurer knowledge-base API. It uses a provider
picker with locally served official-site marks, sourced in
`public/insurers/sources.json`, and paper-like resource tiles. Tiles show actual
knowledge-base excerpts, not invented document screenshots. The existing Palantir
reference owns crisp borders, monochrome typography and compact information;
the user's request for browsable documents supplies the preview interaction.
Provider marks retain their source colors. GEICO's white official mark uses a blue
backplate for contrast. The name remains visible when any asset fails to load.

| Decision | Source | Role | Reason |
| --- | --- | --- | --- |
| One provider picker backed by GET /api/insurers | Existing canonical API; user request | Navigation | All real providers remain selectable without duplicating the knowledge base |
| Paper tiles contain real excerpts with source dates | User request; Refero craft guidance | Document navigation | Visual interest comes from useful, attributable content |
| Selected resource preview and optional source opening | Existing contacts/terms source URLs | Reference inspection | No remote page is framed or claimed to be a complete document preview |
| Separate uploaded-file preview and blank preparation worksheet | User request; canonical data boundaries | User documents | A policy file and a generated worksheet cannot be mistaken for official coverage or a filed claim |

The generated blank TXT is labeled as a Recourse preparation worksheet, never an
official insurer form. Unknown filing guidance remains unknown. Provider selection
does not change an authorized destination, policy coverage or case facts.

The user requested a parallel improvement pass against the published frontend at
602069a, referencing https://optimizedhq.com and https://www.palantir.com.
The build target is the existing working Recourse UI, not a new marketing site.
Live browser captures of both references and the baseline workspace inform this pass.

Primary direction: Palantir's precise monochrome hierarchy and crisp geometry,
adapted to a light product workspace. Preserve white surfaces, near-black primary
actions, fine rules, direct sans-serif headings and purposeful information density.
Borrow OptimizedHQ's clear statement of the task and ordered explanation of the work.
Keep the existing chat, fact review, authorization and call flow. Do not copy either
site's assets or claims. This pass uses code-native marks and existing icons only.

| Decision | Source | Role | Reason |
| --- | --- | --- | --- |
| Deterministic light workspace with a quiet grey rail | User references; Refero anti-slop guide | Working canvas | Keeps documents readable and avoids the baseline's nearly black empty screen |
| Graphite primary buttons, cobalt focus and links | Palantir reference; existing accessible tokens | Action hierarchy | One clear action without saturating the workspace |
| Larger task heading and numbered workflow | OptimizedHQ reference; user brief | First-use guidance | Explain review, approval and calling before asking for input |
| Compact expandable demo settings | Baseline screenshot critique | Secondary controls | Keep simulation visible while moving test switches out of the primary path |
| Structured call record and explicit result evidence | Shared contract and provider verification | Call and outcome | Do not imply live transcripts, arbitrary takeover or verified payment |

This refinement supersedes the original automatic dark-theme and 13px-everywhere
choices below. The remaining contract, ownership and accessibility rules still apply.

## Brief

Designing a claims and refund assistant for a person who is owed money, on desktop web, usable at tablet width.
Goal: add your insurance plans once, ask in plain language, approve the call, watch the agent on the phone, step in if you want, answer when the agent needs you, see a verifiable outcome.
Tone: precise, calm, trustworthy. A work tool, not a marketing page.
Main risk: the user does not believe an agent on the phone did the right thing. Every state must show evidence.
Must remember: the live call screen with a large tabular timer, a "talking to: human / automated agent" badge, a step-in control, and approval prompts that arrive while the call is live.
Out of scope on screen: tool registries, mandate cards, handshake receipts. The approval is a plain confirmation step in the chat.
Constraints: Next.js App Router, CSS modules only, no Tailwind, light mode baseline with a dark variant via `prefers-color-scheme`, keyboard operable, works at 768px.

## Reference lock

Primary direction: utilitarian operations console in the vein of Stripe Dashboard and Linear issue views. White canvas, cool neutral scale, thin 1px borders, dense type, tabular numbers, one blue accent used only for interactive and primary actions.
Preserve: white canvas, cool neutrals, one accent with a strict role, dividers over cards, mono for identifiers, 13px UI text.
Borrow only: a chat composer that stays pinned to the bottom of its column, as in support inboxes, and a call screen laid out like a phone's in-call view: name, number, timer, status, controls.
Role rules: `--rc-accent` is for buttons, links, focus and the active tab. Green is money and approved only. Amber is pending and warnings only. Red is denied, failed and destructive only. Counterpart badge colors: human uses the neutral ink, agent uses the accent tint. No color means nothing.
Media strategy: no imagery. Transcripts, JSON and timelines are the content.
Reject: cream or ivory canvas, indigo or violet, serif display, decorative one-word type swaps, cards for grouping, left accent stripes as decoration, emoji, shadows for depth, `transition: all`.

## Tokens

Defined once on the `.app` wrapper in `RefundApp.module.css` and consumed everywhere as `var(--rc-*)`.

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--rc-canvas` | `#ffffff` | `#0b0c0e` | page |
| `--rc-surface` | `#f7f8fa` | `#141619` | inset panels, code, transcript |
| `--rc-border` | `#e3e6ea` | `#262a30` | all 1px lines |
| `--rc-border-strong` | `#8b9098` | `#5e646d` | resting border of inputs, selects, drop zone, secondary buttons; ink-3 on hover |
| `--rc-ink` | `#141821` | `#f1f3f5` | primary text |
| `--rc-ink-2` | `#4b5563` | `#a7afbb` | secondary text |
| `--rc-ink-3` | `#697282` | `#77808e` | tertiary, placeholders |
| `--rc-accent` | `#2457e6` | `#6f93ff` | buttons, links, focus, active tab |
| `--rc-accent-hover` | `#1d49c4` | `#86a6ff` | hover |
| `--rc-accent-tint` | `#eaf0ff` | `#172349` | agent badge, selected row (always paired with a border or text cue) |
| `--rc-on-accent` | `#ffffff` | `#0b0c0e` | text and icons on accent fills |
| `--rc-success` | `#15803d` | `#4ade80` | money, approved, done |
| `--rc-success-tint` | `#ecfdf3` | `#0f2a1a` | |
| `--rc-warning` | `#b45309` | `#fbbf24` | pending, simulated banner |
| `--rc-warning-tint` | `#fff7e6` | `#2d2008` | |
| `--rc-danger` | `#b91c1c` | `#f87171` | denied, failed |
| `--rc-danger-tint` | `#fef2f2` | `#2b1111` | |
| `--rc-scrim` | `rgb(20 24 33 / 0.32)` | `rgb(0 0 0 / 0.5)` | dims the chat behind the call sheet and the rail menu |

Type: `--rc-font: Inter, system-ui, -apple-system, "Segoe UI", sans-serif`, `--rc-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace`.
Scale, minor second for a dense console: 11, 12, 13 (base UI), 15, 18, 22, 28.
Line height 1.45 for UI, 1.6 for transcript prose.
Numbers that change use `font-variant-numeric: tabular-nums`.
Small caps labels: 12px, weight 500, `letter-spacing: 0.04em`, uppercase, in `--rc-ink-3`.

Spacing on a 4px grid: 4, 8, 12, 16, 24, 32, 48.
Radius: 6px controls, 8px panels. Never larger.
Motion: `--rc-fast: 120ms`, `--rc-default: 200ms`, easing `cubic-bezier(0.2, 0, 0, 1)`. Only transform, opacity, color, border-color, background-color. Respect `prefers-reduced-motion`.
Focus: `:focus-visible { outline: 2px solid var(--rc-accent); outline-offset: 2px; }`.

## Layout

Max width 1440px with 32px gutters at that size (24px under 1280px, 16px under 768px).
Inside the chat column, messages and cards keep a 720px reading width while the column itself fills its grid track.
Header: wordmark "Recourse" at 15px weight 600, the current case name when one exists, and on the far right two mode pills: the data source (Fixture or Live backend) and the server mode (Simulated or Live).
In fixture mode the fixture picker (scenario, "Show loading", "V1 backend only") sits before the pills at 1024px and wider, and at the bottom of the rail below that.
Three regions: a narrow left rail for plans and past cases (240px), the chat column, and the call column (360px) that appears only while a call exists. Under 1024px the call column becomes a sheet over the chat; under 768px the rail collapses into a menu.
Group with section headings and 1px dividers.
A bordered panel is allowed only when the user acts inside it: the facts card, the approval step, plan rows, the composer, a decision card.

## Shared primitives

Import from `../ui/primitives`: `Button`, `Pill`, `Field`, `SelectField`, `Select`, `Mono`, `MonoBlock`, `Banner`, `SectionHeading`, `KeyValueList`, `Divider`, `Eyebrow`, `VisuallyHidden`, `Skeleton`, `SkeletonRows`, `Disclosure`, `SourcePill`.
Shared views beside them: `../ui/DecisionCard` (call screen and chat), `../ui/icons` (one 16px outline set), `../ui/format` (money, phone, durations, contract words).
Build nothing that duplicates them.
Add a primitive only if two or more views need it, and keep it in `ui/`.

## Accessibility

Text meets 4.5:1 and UI boundaries meet 3:1 on both the canvas and the surface, in light and dark.
Inline links stay underlined, because the dark accent on ink is only 2.59:1.
Color is never the only cue: selected rows pair the accent tint with a border, and untitled tinted banners carry a visually hidden tone word.
Field ids come from `useId`, a caller's `aria-describedby` is merged rather than replaced, and field errors are not alerts; forms move focus to the first invalid field.
A busy button stays focusable with `aria-disabled`, ignores clicks, keeps full contrast and announces its progress in a visually hidden status region; native `disabled` is only for actions that are truly unavailable.
Pulsing dots stop after four beats, and every animation stops under `prefers-reduced-motion`.
Focusable controls keep `scroll-margin-top: 56px` so the sticky header never hides them, and header controls draw their focus ring inside.
Transcripts sit in a figure with a visually hidden caption, since `aria-label` is not valid on `pre`.

## Copy

Sentence case everywhere.
Buttons name the outcome: "Approve this call", "Step in now", "Hand back to the agent", "Download packet".
Status words come from the contract and are shown as written, never reworded to sound better.
Simulated and fixture modes are always labelled where the data appears.

## Decision ledger

### Activity network correction

The user's requested graph is a spatial node-and-edge network, not numbered cards.
Keep the existing Palantir-derived monochrome workspace and code-native icons.
Place the case agent at a branching junction between request, evidence, brief and
call records. Directed, labeled edges describe relationships in the case snapshot;
solid lines mean recorded relationships, dashed lines mean pending relationships.
Historical calls must not attach to the current approval. No animated traffic is
implied. Use a dotted coordinate canvas, movable circular nodes, pan, zoom, reset,
keyboard controls and a text inspector. This follows the user's graph correction
and Refero's craft guidance for visible focus and non-drag interaction alternatives.

| Decision | Source | Role | Why |
| --- | --- | --- | --- |
| Spatial branches and circular nodes | User graph correction | Relationship visualization | Makes connections inspectable rather than presenting another card sequence |
| Fine lines and graphite agent node | Existing reference lock | Canvas and hierarchy | Preserves the current operations workspace |
| Edge labels and solid/dashed states | Canonical case records | Evidence | Separates available relationships from planned work |
| Keyboard movement, zoom and reset | Refero craft guidance | Interaction | Keeps the graph usable without dragging |

| Decision | Source | Role | Why |
| --- | --- | --- | --- |
| White canvas, cool neutrals | Refero color guide, anti-slop tells 3 and 4 | canvas | work tool, dense data, light baseline |
| One blue accent | Refero anti-slop tell 1, color guide 2.2 | interactive only | avoid indigo fingerprint, keep color rare |
| Semantic green, amber, red pairs | Refero color guide 2.3 | status only | status must be readable at a glance |
| One sans plus mono accent | Refero typography 3, "Mono accent" pairing | identifiers and numbers | phone numbers, ids and money read as data |
| Dividers over cards | Refero anti-slop tell 2 | grouping | cards reserved for interaction |
| Tabular timer readout | craft rule: one memorable detail | live call | the agent on hold is the product |
| Phone-style call screen | user brief, screens research on in-call views | live call | people already know what a call screen means |
| 120 and 200ms transitions | Refero motion guide 2 | feedback and state | product UI stays fast and quiet |


### Real browser execution panel

The existing Palantir/Optimized reference lock supplies the quiet, divided workspace,
compact controls and document-like hierarchy. Refero's bundled craft guidance supplies
visible keyboard focus and disclosure for advanced settings. The browser is a real
side panel alongside chat, with a wider image area on desktop and a dismissible sheet
on smaller screens. Browser and Call support are explicit separate actions; selecting
a browser task never authorizes a call.

| Decision | Source | Role | Why |
| --- | --- | --- | --- |
| Browser-first case tools, explicit Call support tab | User request for non-call refund and form tasks | Task selection | Browser work is available without a support phone or amount; calls retain their existing approval step |
| Actual server JPEG plus exact page URL and action history | BrowserRun contract | Execution evidence | Shows the real controlled browser rather than a generated preview or replay |
| Stop polling when hidden; clear failed frames | Frame availability and document visibility | State honesty | An old screenshot cannot masquerade as a current successful browser view |
| Review exact action target/value before approval | BrowserPendingAction contract | Authorization | Every approval names the pending action and observation; ambiguous responses require a status refresh |
| Session-scoped request ID, read-only reload recovery | HTTP browser contract | Recovery | Reloads never launch or repeat a browser task; explicit retries reuse the original instructions |
| Compact setup and sign-in handoffs | Runtime readiness and backend status | Required intervention | Missing configuration is shown plainly; password screens are not captured |

Verification for this addition is unit, HTTP-transport stubs and server-rendered markup.
No live browser/provider action or visual browser inspection is implied by those checks.
The app runtime now always uses HTTP; fixtures remain isolated to development tests.

### Call plan and step-in

The call screen shows the agent's plan as a map of ordered steps and a one-line dashboard of the step it is on.
The plan is the agent's intent; a step reads as done only when the backend reports it done.
The user can step in at any point of a live call, dialing included, and the agent pauses until they hand back.
The step-in controls stay pinned to the bottom of the call column so they are reachable without scrolling.

| Decision | Source | Role | Why |
| --- | --- | --- | --- |
| Plan map and dashboard line | user brief (October 11: see what the agent will do and which step it is on), dividers over cards | live call | the plan is a numbered list between dividers, no card, so it reads as status and not as a control |
| Progress bar token roles | October 11 lock: graphite primary, cobalt for the active item, amber pending | live call | done steps in ink, the current step in the accent, a paused step in warning, upcoming in the border tone; no green, since nothing has been paid or approved |
| Step in at any time | user brief (October 11: interrupt the agent at any time), buttons name the outcome | live call | "Step in now" is enabled in every live phase and "Hand back to the agent" resumes it; the plan marks the interrupted step "Paused - you are on the line" |

### Landing page

The public page at `/welcome` (src/features/landing) says what Recourse is in a headline and two sentences, then proves it with a replica of the call column that runs a simulated call on its own.
It repeats the token values of the `.app` block on its own root, imports the icons and primitives, and links "Start a case" to the app's first page.
The replica is decoration for sighted users: it is `aria-hidden` and `inert`, and a visually hidden sentence describes it; under `prefers-reduced-motion` it shows the finished call without motion.

| Decision | Source | Role | Why |
| --- | --- | --- | --- |
| The product is the hero | Refero craft rule: one memorable detail; anti-slop tells on stock imagery and card grids | landing hero | a call that runs itself (status, timer, plan, transcript, outcome) explains the product faster than any illustration |
| Split-flap outcome figure | componentry split-flap pattern, ported by hand in CSS; motion guide level 4 | landing outcome | each character steps through a glyph strip with `transform` only, and green appears only on the approved refund |
| One timeline, layout reserved | Refero motion guide (transform and opacity only, reduced motion not optional) | landing animation | beats in `demo.ts` drive every change; untyped text stays in the layout as transparent glyphs, so nothing reflows while the call plays |

#### Landing page, round 2

The first landing page read as a wireframe, so `/welcome` became a typographic launch page where rolling text is the design.
The call replica, the split-flap figure and the merchant name are gone; the mechanics are ported by hand from componentry.dev into plain React and CSS modules.

| Decision | Source | Role | Why |
| --- | --- | --- | --- |
| Morphing word in the headline | componentry Text Morph (threshold filter, 2600ms rest, 680ms morph) | landing headline | one sentence names five kinds of money owed, and the stage animates its width so the line never jumps |
| Velocity band of the two promises | componentry Velocity Scroll (5 percent per second, spring on scroll velocity) | landing centerpiece | "You approve" and "Step in at any time" are the product's guarantees, so they get the motion and the size |
| Still, finished state under reduced motion | Refero motion guide 6 (reduced motion is not optional) | landing animation | the first word stays put and each band sentence shows once and wraps |
