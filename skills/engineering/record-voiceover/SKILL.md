---
name: record-voiceover
description: Record what real macOS VoiceOver announces during a browser interaction, as a labeled MP4 that shows the page, each key step, and VoiceOver's caption panel (plus spoken audio when the Mac isn't muted), with a timestamped text transcript. Use when the user wants screen reader evidence, a VoiceOver video or recording, "what VoiceOver says", or before/after proof of an accessibility fix (dialog names, labels, roles, live regions) that the accessibility tree alone can't prove. macOS only.
---

# Record VoiceOver

`scripts/record.mjs` opens a dedicated Playwright Chromium window and runs your scenario's key
steps while VoiceOver is on. It records the screen with ScreenCaptureKit, showing only that
browser and VoiceOver, and writes:

- `voiceover.mp4`: title, browser window, a "Step:" strip, and VoiceOver's caption panel, plus
  audio when it was captured.
- `voiceover-sheet.png`: a contact sheet to check the result.
- `transcript.json`: the caption panel text over time, read with macOS Vision OCR.
- `frames.txt` and `meta.json`: lets record-video's `compose.mjs` put runs side by side.

It reuses `../record-video/scripts/lib.mjs`, so install both skills together. It needs macOS,
`node` 22 or later, `ffmpeg`/`ffprobe`, Xcode command line tools (`swiftc`), and Playwright
(loaded from the current directory or `--playwright <dir>`). Run it with `--help` for every flag.

## Before you start: ask the user

VoiceOver speaks out loud and takes over the machine. The script brings the browser to the front
and the recording needs it to stay there. Before any run:

- Tell the user, and get an explicit go-ahead and a time when they won't be using the Mac.
- Ask whether to keep audio. If the Mac is muted, the video has captions only. Never change the
  volume yourself.
- Batch every run into that window. Don't open test browsers repeatedly while they're working.

Permissions:

- **Screen Recording** for the app that runs the agent (e.g. the terminal) is required. If it's
  missing, macOS shows a prompt that only the user can approve.
- **Accessibility is not needed.** Keys go to the page over CDP, and VoiceOver announces the
  resulting focus and value changes.
- On a Mac where VoiceOver has never run, its welcome dialog appears once. The user dismisses it
  and checks "Do not show this message again".

## Workflow

1. **Serve each build** on its own port and keep each server's PID.
2. **Write a scenario** in a scratch dir:

   ```js
   // prepare() is not recorded: get to the starting state.
   export async function prepare({ page }) {
     await page.getByRole('button', { name: 'Accept' }).click({ timeout: 3000 }).catch(() => {});
   }

   // run() is recorded. step() labels the video and then waits for VoiceOver to finish speaking.
   export async function run({ page, step, mark }) {
     await step('Tab', () => page.keyboard.press('Tab'));
     await step('Enter (open dialog)', () => page.keyboard.press('Enter'));
     mark('dialog');
     await step('Type "3" in the select', () => page.keyboard.type('3'));
   }
   ```

   - Drive with the keyboard (`Tab`, `Shift+Tab`, `Enter`, `Escape`, typing), the way a screen
     reader user would.
   - `step()` waits `--hold-ms` (default 3000) afterwards. Pass `{ holdMs }` for long announcements.
   - **Never press ArrowUp/ArrowDown, Space, or Enter on a focused `<select>`.** That opens the
     native macOS menu, which CDP can't close, and the run hangs. To change the value, type the
     first character of the option instead.
3. **Record:**

   ```bash
   node scripts/record.mjs --url http://localhost:3001/ --scenario /tmp/x/scenario.mjs \
     --out /tmp/x/before --title 'BEFORE (main)' --start-voiceover
   ```

   - `--start-voiceover` starts VoiceOver if it's off. It quits only the VoiceOver it started,
     by PID, and resets `voiceOverOnOffKey`, even if the run fails.
   - The browser window is moved onto the main display. VoiceOver's caption panel must be on
     the main display too.
4. **Verify before you show anything.** Read `voiceover-sheet.png` and `transcript.json`. Confirm
   that VoiceOver actually said the thing you're claiming, at the step you expect. Check `audio`
   in the output: `captured`, `silent`, `muted`, or `off`.
5. **Before/after** (optional), with the same scenario and `--width`/`--height` for both runs:

   ```bash
   node ../record-video/scripts/compose.mjs --clip /tmp/x/before='BEFORE' --clip /tmp/x/after='AFTER' \
     --slow 1 --fps 30 --out /tmp/x/review.mp4
   ```

   `compose.mjs` drops audio. Share the single-run MP4s if the audio matters.
6. **Deliver.** Run `open <video>` and report the paths, plus what VoiceOver said, quoted from the
   transcript. Uploading is a separate step.
7. **Clean up.** Stop servers by exact PID. Confirm `pgrep -x VoiceOver` is empty if you started it.

## Rules

- Everything in the caption panel is VoiceOver's own output. The only text added is the title
  and the "Step:" labels, which name the key that was pressed. Never add or edit what
  VoiceOver said.
- Describe it as "real VoiceOver output (caption panel)" and say whether audio is included.
- OCR can misread a word. Quote the transcript, but check it against the video frames.
- For tree-level proof without VoiceOver, use record-video's `ax-caption.mjs` instead, and
  label that as the accessibility tree, not VoiceOver.
