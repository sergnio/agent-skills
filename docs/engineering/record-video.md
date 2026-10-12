# record-video

An agent skill that records real browser video of a UI interaction and turns it into a labeled
review clip. It's built for before/after comparisons: two builds side by side, played in real time
and then in slow motion, so a 200ms flash nobody can see live becomes obvious.

- `record.mjs` drives Playwright Chromium and captures every painted frame through the CDP
  screencast, keeping the browser's own timestamps. `prepare()` sets up the page off camera,
  `run()` is recorded, and `mark()` notes moments to align on.
- `compose.mjs` stacks clips side by side with labels, adds a slow-motion replay, writes an MP4
  (and optionally a GIF), and makes a contact sheet so the agent can check the frames before
  showing you.
- `ax-caption.mjs` overlays what Chrome's accessibility tree reports (role, name, states like
  `required` or `expanded`) as a caption, so invisible a11y fixes show up on video. Each caption
  stays on screen for 1.5 s during the recording, and its full data is saved as `ax-steps.json`
  (and `<video>-ax.json` after composing) so a PR can link to the raw values.

Labels are rendered by the browser, so it works with ffmpeg builds that don't include `drawtext`.

Requires `node`, `ffmpeg`/`ffprobe`, and Playwright (loaded from the project you run it in).
