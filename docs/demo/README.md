# Demo video recording

For the real-service Amazon and insurance walkthrough, use
[live-walkthrough.txt](live-walkthrough.txt). The older scripted video below uses
fixtures and is not proof of live browser execution or live calling.

This folder records the submission demo video with [sitereel](https://github.com/iksZ963/sitereel) 0.2.0.
A scripted tour drives the fixture flow at `http://localhost:3000/?api=fixture` in headless Chromium at 1920x1080 and saves an `.mp4` and a `.webm`.
Nothing is added to `package.json`; every command runs sitereel through `npx`.

## Record

Run every command from the repo root.

1. Start the app in its own terminal and wait for `Ready`.

   ```bash
   npm run dev
   ```

2. Load the page once.
   The first request in dev mode compiles the route, and sitereel gives up if the URL does not answer within 15 seconds.

   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' 'http://localhost:3000/?api=fixture'
   ```

   Expect `200`.

3. Record.

   ```bash
   npx -y sitereel@0.2.0 --url 'http://localhost:3000/?api=fixture' --config docs/demo/sitereel.config.mjs --out docs/demo/out --no-build
   ```

   Keep the quotes around the URL.
   In zsh an unquoted `?` is a glob character, so the shell stops with `no matches found` before sitereel starts.
   `--no-build` changes nothing here, because `--url` already skips the build.

While it runs, the terminal prints every beat of the tour with its approximate time in the video, then `Saved:` with the output paths.
The tour's own beats take about 35 seconds of video; the fixture call adds the rest.

## Where the video lands

| File | What it is |
| --- | --- |
| `docs/demo/out/demo-desktop.mp4` | The video to submit: H.264, 1920x1080, yuv420p, fast start |
| `docs/demo/out/demo-desktop.webm` | The raw Playwright recording that the mp4 is encoded from |
| `docs/demo/out/timeline.txt` | Approximate video time of every beat, for placing the voice-over |
| `docs/demo/out/flow-failure.png` | Only after a failed take: the page at the moment the tour stopped |

Each take overwrites the previous one.
`docs/demo/out/` is ignored by git.

## If ffmpeg is missing

sitereel encodes the mp4 with the ffmpeg binary from `ffmpeg-static`, which it downloads on first use, and falls back to an `ffmpeg` on the `PATH`.
If neither works, the take still finishes, the log says `ffmpeg not found, so only .webm was created`, and only the `.webm` is saved.
Install ffmpeg (`brew install ffmpeg` on macOS), then convert that take with the same settings sitereel uses instead of recording it again:

```bash
ffmpeg -y -i docs/demo/out/demo-desktop.webm -c:v libx264 -crf 16 -preset medium -pix_fmt yuv420p -movflags +faststart docs/demo/out/demo-desktop.mp4
```

`npx -y sitereel@0.2.0 doctor` reports which ffmpeg it found and whether Chromium is installed.
On October 11, 2026 it reported Node, Chromium, the bundled ffmpeg and the Next.js project all ok, and a Homebrew ffmpeg 8.1 was on the `PATH` as a fallback.
While `npm run dev` is running, doctor also flags `Something is running on :3000`; that is expected when recording with `--url`.
If doctor says Chromium is not installed, install the build that matches sitereel's own Playwright:

```bash
npx -y -p sitereel@0.2.0 playwright install chromium
```

## Length and voice-over

The submission video must be under five minutes.
The tour stops itself with an error if it is still running at 4:50 of video, so an over-long take is never saved.
Check the length of a finished take:

```bash
ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 docs/demo/out/demo-desktop.mp4
```

The voice-over script is in `docs/SUBMISSION.md` section 7.
Use `docs/demo/out/timeline.txt` to place each line.
Tune the dwell times and typing speed in `PACE` at the top of `sitereel.config.mjs` until the picture matches the script.

## What the tour does

The tour relies only on these `data-testid` hooks.
If one is missing or renamed, the take stops at that step and the error names it.

| Beat | Hooks | Wait limit | Dwell |
| --- | --- | --- | --- |
| Onboarding screen | `plans-dropzone` | 20 s | 2 s |
| Add the two sample plans | `plans-dropzone`, `plans-file-input` | 15 s | 1.5 s |
| Continue | `plans-continue` | 15 s | |
| Type the claim request, 75 ms per key | `composer-input` | 15 s | |
| Send | `composer-send` | 15 s | |
| Facts card | `facts-card` | 30 s | 3 s |
| Tick the approval checkbox | `approve-checkbox` | 15 s | |
| Approve the call | `approve-button` | 15 s | |
| Call screen, cursor rests on the badge | `call-screen`, `call-counterpart` | 30 s | |
| Badge turns automated, then the cursor points at step-in without pressing it | `call-counterpart` containing "Automated", `step-in-button` | 40 s | 1.5 s |
| Decision prompt | `decision-card` | 40 s | 2 s |
| Accept | `decision-option-accept` | 15 s | |
| Outcome | `outcome-card`, `outcome-reference` | 60 s | 2 s |
| Open the transcript and scroll 320 px | `transcript-toggle` | 15 s | |
| Final frame | | | 4 s |

The request typed into the composer is "File a claim with Northwind Mutual for the water damage in my kitchen on October 3, about $1,200."
`call-phase`, `call-timer`, `metrics-active` and `fixture-scenario-select` are only read, for the terminal log and the timeline.
`step-in-button` is only hovered, never clicked, and skipped if it is not on screen.
Where a card can appear more than once in the chat, the tour acts on the newest one.

## Dry run without recording

```bash
npx -y sitereel@0.2.0 preview --url 'http://localhost:3000/?api=fixture' --config docs/demo/sitereel.config.mjs
```

This plays the same tour in a visible browser window at 1280x720 and records no video.
It still writes `docs/demo/out/timeline.txt`.

## Good to know

- The tour refuses to run unless the URL contains `api=fixture`, because it approves a phone call.
- Each take starts from a fresh browser profile, so plans saved in IndexedDB never carry over between takes.
- sitereel hides the Next.js dev indicator and draws a visible cursor with click ripples.
- The first two seconds or so of the video show the page loading.
  Trim them in editing if they bother you.
- If someone saves a file under `src/` during a take, `next dev` can reload the page and the take fails.
  Record while nobody is editing.
  If `npm run build` passes, `npm run build && npm run start` serves the same URL without hot reload.
- After a failed take, `docs/demo/out/` can hold a partial `.webm` with a random name.
  Delete it.
- `node docs/demo/make-samples.mjs` writes the sample PDFs.
  The tour also recreates them before uploading if they are missing or stale.

## Files

| File | Purpose |
| --- | --- |
| `sitereel.config.mjs` | The tour, its pacing (`PACE`), wait limits (`TIMEOUTS`) and the 4:50 guard |
| `make-samples.mjs` | Writes the two sample plan PDFs by hand, with no dependencies |
| `samples/` | `northwind-mutual-home-policy.pdf` and `northwind-mutual-renewal-notice.pdf`, about 3 KB each |
| `.gitignore` | Keeps `out/` out of git |
