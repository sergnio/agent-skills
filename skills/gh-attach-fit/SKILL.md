---
name: gh-attach-fit
description: Attach screenshots, GIFs, and screen recordings to GitHub pull requests, issues, and comments, automatically shrinking any file over GitHub's 10 MB attachment limit first. Use when adding images or videos to a PR or issue body or comment, when a GIF or recording is too large to upload, or when gh --attach fails with a size error.
---

# Attach to GitHub, fitted to the size limit

GitHub CLI 2.99.0+ uploads attachments natively with `--attach`, but it refuses
any image over 10 MB instead of shrinking it. Screen-recording GIFs and Retina
recordings pass that easily. `scripts/fit-attachment.sh` (relative to this
skill's directory) re-encodes oversized files until they fit, then `gh` uploads
them.

## Workflow

1. Confirm `gh --version` is 2.99.0 or newer. If not, stop and ask the user to
   upgrade (`brew upgrade gh`); older versions have no `--attach`.
2. Locate each file and verify it is the one the user means.
3. Fit every file in one call. It prints one path per input, in order, and
   prints files that already fit unchanged:

   ```bash
   scripts/fit-attachment.sh ./before.png ./after.png ./flow.gif
   ```

4. Attach the printed paths, never the originals. Add alt text after `#`:

   ```bash
   gh pr edit 123 --attach '/tmp/tmp.X/flow.gif#Checkout flow' --attach ./before.png
   ```

   The same flag works on `gh pr create`, `gh pr comment`, `gh issue create`,
   `gh issue edit`, and `gh issue comment`.
5. Read the result back (`gh pr view 123 --json body`) and report the uploaded
   asset URLs to the user.

## Placing attachments in a body

Without a body flag, `gh` keeps the existing body and appends the attachments.
To place them, pass a body that references each fitted path, and `gh` rewrites
each reference to the uploaded URL:

```bash
gh pr edit 123 --body-file body.md --attach /tmp/tmp.X/flow.gif
# body.md contains: ![Checkout flow](/tmp/tmp.X/flow.gif)
```

`--body` and `--body-file` replace the whole body. Start from the current body
(`gh pr view 123 --json body --jq .body`) so nothing is lost.

## What fitting does

- **GIF**: steps down width, frame rate, palette, and gifsicle lossiness.
- **PNG / JPEG**: steps down width, keeping the format.
- **MP4 / MOV / WebM**: re-encodes to H.264 MP4, stepping down resolution,
  frame rate, and quality. The output extension becomes `.mp4`.

Each attempt is logged to stderr, so the user can see what quality was traded.
The default target is 10,000,000 bytes, which is safe for every account plan.
Pass `--max-bytes N` to change it, and `--out-dir DIR` to choose where fitted
copies go (never the source directory, which would overwrite the originals).

If a GIF still does not fit, convert it to MP4 and fit that. Videos compress far
better and GitHub renders them as a player:

```bash
ffmpeg -i flow.gif -pix_fmt yuv420p -vf 'scale=trunc(iw/2)*2:trunc(ih/2)*2' flow.mp4
```

If a video still does not fit, trim it and retry.

## Requirements

- Authenticated `gh` 2.99.0+ (`gh auth status`), with access to the target repo.
- `ffmpeg` for any file that needs fitting, plus `gifsicle` for GIFs
  (`brew install ffmpeg gifsicle`). Files that already fit need neither.
- SVGs and WebP files cannot be shrunk, but `gh` still attaches them when they
  are under the limit.
