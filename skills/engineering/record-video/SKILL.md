---
name: record-video
description: Record real browser video of a UI interaction and turn it into a labeled review clip (MP4 + optional GIF), including side-by-side before/after comparisons with a slow-motion replay. Use when the user asks for a video, recording, screen capture, or GIF of web app behavior, wants to "see" a flicker, flash, animation, transition, or timing bug, needs motion evidence comparing two builds (e.g. main vs a PR branch), or needs to show an invisible accessibility fix (dialog names, required, expanded) on video.
---

# Record video

Two scripts, relative to this skill's directory:

- `scripts/record.mjs` drives Playwright Chromium and captures every painted frame through the
  CDP screencast with its real timestamp. Frame durations come from the browser, not a guessed fps.
- `scripts/compose.mjs` lays one or more recordings side by side with labels, plays them in real
  time, replays them in slow motion, and writes a contact sheet so you can check the result.

Both need `node`, `ffmpeg`/`ffprobe`, and Playwright. They load Playwright from the current
directory, so run them from a project that has it, or pass `--playwright <dir>`. Run
either one with `--help` to see every flag.

## Workflow

1. **One server per build.** For before/after, check out the base (e.g. `origin/main`) and the
   change in separate worktrees and start each on its own port. Keep each server's PID so you
   can stop exactly that process later.
2. **Write a scenario** as an ES module in a scratch dir (not in the repo):

   ```js
   // prepare() is not recorded: dismiss banners, get to the starting state.
   export async function prepare({ page }) {
     await page.getByRole('button', { name: 'Accept' }).click({ timeout: 5000 }).catch(() => {});
     await page.getByRole('combobox').click();
     await page.keyboard.type('minn', { delay: 80 });
     await page.getByText('Minnetonka', { exact: true }).waitFor();
   }

   // run() is recorded. mark() records a moment that compose --align can line up.
   export async function run({ page, mark }) {
     await page.keyboard.type('eapolis', { delay: 80 });
     await page.getByText('search for').waitFor();
     mark('results');
   }
   ```

   Type with a `delay` so it looks like a real user. Keep `run()` focused on the moment that
   matters. The clip should be a few seconds long, not a whole walkthrough.
3. **Record each build** with the same scenario and viewport:

   ```bash
   node scripts/record.mjs --url http://localhost:3001/ --scenario /tmp/x/scenario.mjs --out /tmp/x/before
   node scripts/record.mjs --url http://localhost:3002/ --scenario /tmp/x/scenario.mjs --out /tmp/x/after
   ```

   Check `averageFps` in the output. Below about 20 means the machine was too busy to catch
   short animations, so record again.
4. **Compose:**

   ```bash
   node scripts/compose.mjs --clip /tmp/x/before='BEFORE (main)' --clip /tmp/x/after='AFTER (PR 123)' \
     --crop 396:340:0:0 --align results --slow 4 --gif --out /tmp/x/review.mp4
   ```

   - `--crop W:H:X:Y` is in frame pixels (CSS px × dpr). Crop to the region of interest. To size
     it, use `page.locator(...).boundingBox()` or a screenshot.
   - `--align MARK` trims the start of each clip so a network-dependent moment happens at the same
     time in every pane. Without it, a slower API response on one side looks like a difference.
   - A single `--clip` also works if you only need a labeled recording.
5. **Verify before you show anything.** Read the `*-sheet.png` contact sheet with your
   image-viewing tool and confirm the behavior you're claiming is actually visible in the
   frames. A clip that encoded cleanly but doesn't show the bug is a failure.
6. **Deliver.** Run `open <video>` so the user sees it, and report the paths. Uploading is a
   separate step. Use the GitHub/Jira attachment skills only when asked, and keep GIFs
   under 10 MB.
7. **Clean up.** Stop the dev servers by their exact PIDs. Delete scratch frames once the
   user has the video.

## Accessibility captions

For a11y fixes, the change is often invisible (a dialog name, `required`, `aria-expanded`).
`scripts/ax-caption.mjs` reads Chrome's accessibility tree over CDP and overlays what a
screen reader would get as a caption bar, so the video shows the proof:

```js
import { axCaption } from '/abs/path/to/record-video/scripts/ax-caption.mjs';

export async function prepare({ page }) {
  await axCaption(page, 'Home page');
}

export async function run({ page, mark }) {
  await page.getByTestId('navHamburger').tap();
  await page.getByRole('dialog').waitFor();
  mark('open');
  await axCaption(page, '1. Opened menu'); // In dialog dialog: "Navigation Menu"
}
```

- With no third argument it shows the focused element and the dialog that contains it.
- Pass `[{ label: 'Full name', target: page.locator('#fullName') }]` to show specific
  elements and states like `required=true` or `expanded=false`.
- Wait for the UI to settle before each caption, since it reads the tree at that moment.
- In `run()`, each caption holds for 1.5 s so it can be read, so don't add your own
  `waitForTimeout`. Change it with a fourth argument: `axCaption(page, step, undefined, { holdMs: 800 })`.
  Captions in `prepare()` don't hold, since that part isn't recorded.
- Call `mark()` before `axCaption()`, or the mark lands after the hold.
- `record.mjs` writes every caption to `ax-steps.json` in its `--out` dir: the step, `seconds`
  into the recording, and the full untruncated role, name, description, value, and states.
  `compose.mjs` copies all clips' steps next to the video as `<video>-ax.json`, with times
  shifted for `--align` and a `slowMotionSeconds` for the replay. Link or attach that file in the
  PR as the raw data behind the captions.
- The caption is `aria-hidden`, so it doesn't change what it measures. Label it as the
  accessibility tree in the PR, not as real VoiceOver output.

## Rules

- Record real pixels only. Don't pause animations, inject CSS, or fabricate frames to make an
  effect look bigger. The `axCaption` overlay is the one allowed addition, since it reports
  real data. The slow-motion section replays the real frames. If a flash is too quick
  to see in real time, the slow-motion replay is the evidence.
- Use the same viewport, scenario, and starting state on both sides. A comparison that differs in
  two ways proves nothing.
- Playwright locators are strict. `getByText('Foo')` fails if 'Foo Bar' also matches, and app-wide
  `data-testid`s (loaders, spinners) are often duplicated. Use `{ exact: true }`, roles, or text
  that only exists once.
- Labels are rendered by the browser, not by ffmpeg `drawtext`, because many ffmpeg builds
  don't include freetype. Don't "fix" this by switching to `drawtext`.
