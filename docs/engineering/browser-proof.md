# browser-proof

An agent skill that proves what a web page sent, received, or logged. Instead of describing what
happened, the agent runs the flow in a fresh headless browser and hands back raw receipts:
timestamped console lines and network requests, saved to disk so you can check them yourself.

- `capture.mjs` loads the page, runs a small steps module you (or the agent) write with
  Playwright, and records every console message plus each request matching `--match`. Matched
  requests get their query string and POST body decoded line by line, with the response status.
- `mark('label')` in the steps adds a `>>> label` line to the timeline and saves a numbered
  screenshot, so each receipt sits next to the action that caused it.
- Output: `timeline.txt` (the file to quote), `events.jsonl`, `network.har` (opens in Chrome
  DevTools > Network > Import HAR), and one screenshot per mark.

It's built for questions like "does the analytics event actually fire?" or "does unticking this
cookie setting really stop the request?", and includes notes on reading Google Analytics hits.

Requires `node` and Playwright (loaded from the project you run it in, `$PLAYWRIGHT_FROM`, or
`--playwright <dir>`).
