# Recourse UI design lock

Read this before writing any component under `src/features/refund-ui`.
It follows the Refero skill in `.agents/skills/refero-design` with its bundled craft references, since the live Refero MCP needs a paid token we do not have.

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
Buttons name the outcome: "Approve this call", "Step into the call", "Download packet".
Status words come from the contract and are shown as written, never reworded to sound better.
Simulated and fixture modes are always labelled where the data appears.

## Decision ledger

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
