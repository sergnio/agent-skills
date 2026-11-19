---
name: browser-proof
description: Raw console and network receipts proving what a web page sent, received, or logged. Use when asked for proof, hard evidence, or logs that a request, analytics event, or console message did or did not happen.
---

# Browser proof

The deliverable is **receipts**: raw, timestamped console lines and network requests, captured in one run of an isolated browser and saved to disk. A summary, chart, or screenshot of a summary is a claim, not a receipt; it comes after the receipts, and only when asked.

## Steps

1. **Pick the out dir** - `/tmp/<ticket-or-topic>-proof`. Use the user's running dev server when the target is local; check it responds before starting another.
2. **Write a steps module** - `/tmp/<ticket-or-topic>-proof/steps.mjs`, default-exporting `async ({ page, mark, context }) => {}`. Drive the page with Playwright locators (`getByRole`, `getByPlaceholder`), and call `await mark('label')` before each action that matters. Each mark lands in the timeline as `>>> label` and saves a numbered screenshot. A fresh profile shows first-visit UI (cookie banners, location prompts); handle it in the steps.
3. **Capture** - one command, one page load:

   ```bash
   node scripts/capture.mjs \
     --url http://localhost:3000 --steps "$out/steps.mjs" --out "$out" \
     --match 'google-analytics\.com/g/collect'
   ```

   `--match` is a regex, repeatable; matched requests get their query and every POST body line decoded into the timeline, plus their status. Add `--headed` to watch. Playwright loads from the current project, `$PLAYWRIGHT_FROM`, or `--playwright <dir>`.
4. **Read `timeline.txt`** and confirm every mark ran and the behaviour under test actually happened (the event fired, the search returned). A run where the action silently did not happen is a failed capture: fix the steps and rerun.
5. **Report** - every claim quotes its receipt verbatim (timestamp, kind, text, and for requests the status) and names the file it came from. State what the receipts cannot show, such as whether a third party stored the data.

## Output files

- `timeline.txt` - marks, console messages, and matched requests/responses, merged in time order. The file to quote.
- `events.jsonl` - the same events as JSON, for filtering.
- `network.har` - every request in the run; opens in Chrome DevTools > Network > Import HAR, so a human can verify independently.
- `NN-<mark>.png` - page state at each mark.

## Reading analytics receipts

- A response `204` on `/g/collect` means Google accepted the hit; it does not prove it was stored or shown in reports.
- `en=` is the event name, `tid=` the property, `gcs=G1-1` analytics consent granted, `G1-0` denied (cookieless ping).
- GA batches hits, so a request a few seconds after a mark can carry events recorded before it. Attribute each `en=` to the console line that produced it, not to the nearest mark.
