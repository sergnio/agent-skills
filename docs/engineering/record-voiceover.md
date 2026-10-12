# record-voiceover

An agent skill that records what real macOS VoiceOver announces while an agent drives a web page
with the keyboard. It's built for accessibility evidence: the video shows the page, which key was
pressed, and VoiceOver's own caption panel, so reviewers see exactly what a screen reader user hears.

- `record.mjs` opens a dedicated Playwright Chromium window and runs a scenario of labeled key
  steps. It records the screen showing only that browser and VoiceOver. It writes a labeled MP4,
  a contact sheet, and a timestamped transcript of the caption panel, read with macOS Vision OCR.
- `vo-helper.swift` handles the ScreenCaptureKit recording and the OCR. It is compiled once on
  first use and cached.
- For before/after, its output plugs into [record-video](record-video.md)'s `compose.mjs`.

VoiceOver talks out loud and takes over the Mac while it runs, so the agent asks before
recording. The video includes spoken audio unless the Mac is muted. It needs Screen Recording
permission for the terminal, but not Accessibility.

Requires macOS, `node` 22+, `ffmpeg`/`ffprobe`, `swiftc` (Xcode command line tools), Playwright,
and the record-video skill.
