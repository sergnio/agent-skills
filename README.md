# gh-attach-fit

An agent skill that attaches screenshots, GIFs, and screen recordings to GitHub
pull requests, issues, and comments, and automatically shrinks anything over
GitHub's 10 MB attachment limit first.

`gh` 2.99.0+ can upload attachments with `--attach`, but it refuses an image over
10 MB rather than shrinking it. A few seconds of Retina screen recording as a
GIF passes that easily. This skill re-encodes the file until it fits, then lets
`gh` do the upload.

```text
$ scripts/fit-attachment.sh "Big Recording.gif" huge.png clip.mov
Big Recording.gif is 27910610 bytes, over the 10000000 limit. Re-encoding...
  1200px @ 15fps, 192 colors, lossy 30 -> 7187002 bytes
/tmp/tmp.xmOx17su2p/Big Recording.gif
huge.png is 29091235 bytes, over the 10000000 limit. Re-encoding...
  3200px -> 11865130 bytes
  2560px -> 7460305 bytes
/tmp/tmp.xmOx17su2p/huge.png
clip.mov is 496970939 bytes, over the 10000000 limit. Re-encoding...
  1080p @ 30fps, crf 28 -> 3342261 bytes
/tmp/tmp.xmOx17su2p/clip.mp4
```

## What it shrinks

| Input | How |
|---|---|
| GIF | Steps down width, frame rate, palette, and gifsicle lossiness |
| PNG, JPEG | Steps down width, keeping the format |
| MP4, MOV, WebM | Re-encodes to H.264 MP4, stepping down resolution, frame rate, and quality |

Files already under the limit are passed through untouched.

## Install

Claude Code:

```text
/plugin marketplace add sergnio/gh-attach-fit
/plugin install gh-attach-fit@gh-attach-fit
```

Codex, Cursor, Gemini CLI, OpenCode, and other agents:

```bash
npx skills add sergnio/gh-attach-fit
```

## Requirements

- [GitHub CLI](https://cli.github.com) 2.99.0 or newer, authenticated
- `ffmpeg` and `gifsicle` for files that need shrinking: `brew install ffmpeg gifsicle`

## Using the script directly

The script is standalone and works without an agent:

```bash
fitted=$(skills/gh-attach-fit/scripts/fit-attachment.sh ./demo.gif)
gh pr comment 123 --attach "$fitted#Demo of the new flow"
```

Options: `--max-bytes N` (default 10000000) and `--out-dir DIR` (default: a new
temp directory).

## License

MIT
