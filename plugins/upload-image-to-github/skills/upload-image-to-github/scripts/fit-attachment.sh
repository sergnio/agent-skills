#!/usr/bin/env bash
# Re-encode images and videos until they fit GitHub's attachment size limit.
# Prints one path per input, in order, to stdout. Diagnostics go to stderr.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: fit-attachment.sh [--max-bytes N] [--out-dir DIR] FILE...

For each FILE, prints a path to a version that is at most --max-bytes
(default 10000000, just under GitHub's 10 MB attachment limit). A FILE that
already fits is printed unchanged. An oversized FILE is re-encoded into
--out-dir (default: a new temp directory), keeping its basename so the alt
text gh derives from the filename stays meaningful.

Shrinks GIF, PNG, and JPEG images by stepping down resolution (and, for
GIFs, frame rate and palette). Shrinks MP4, MOV, and WebM videos into H.264
MP4. Exits 1 if any FILE cannot be brought under the limit.
EOF
  exit 2
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1 (brew install ffmpeg gifsicle)"
}

file_size() {
  # macOS and GNU stat disagree on flags.
  stat -f%z "$1" 2>/dev/null || stat -c%s "$1"
}

lowercase_extension() {
  local name=${1##*/}
  [[ $name == *.* ]] || return 0
  printf '%s' "${name##*.}" | tr '[:upper:]' '[:lower:]'
}

report_attempt() {
  printf '  %s -> %s bytes\n' "$1" "$(file_size "$2")" >&2
}

fits() {
  (($(file_size "$1") <= max_bytes))
}

# Settings: width, fps, palette colors, gifsicle lossiness.
fit_gif() {
  local source=$1 out=$2 work width fps colors lossy
  require_command gifsicle
  work=$(mktemp -d)/pass.gif

  for setting in \
    "1200 15 192 30" \
    "1000 12 128 60" \
    "900 12 128 80" \
    "800 10 96 100" \
    "640 8 64 140" \
    "480 8 64 200"; do
    read -r width fps colors lossy <<<"$setting"

    ffmpeg -y -loglevel error -i "$source" \
      -vf "fps=$fps,scale='min($width,iw)':-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=${colors}[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" \
      "$work" || fail "ffmpeg failed to re-encode $source."
    gifsicle -O3 --lossy="$lossy" "$work" -o "$out" 2>/dev/null || cp "$work" "$out"

    report_attempt "${width}px @ ${fps}fps, $colors colors, lossy $lossy" "$out"
    fits "$out" && return 0
  done
  return 1
}

fit_still_image() {
  local source=$1 out=$2 width
  for width in 3200 2560 1920 1600 1280 1024 800; do
    ffmpeg -y -loglevel error -i "$source" -frames:v 1 -q:v 3 \
      -vf "scale='min($width,iw)':-2:flags=lanczos" \
      "$out" || fail "ffmpeg failed to re-encode $source."

    report_attempt "${width}px" "$out"
    fits "$out" && return 0
  done
  return 1
}

# Settings: height, fps, x264 CRF. Audio is kept but compressed.
fit_video() {
  local source=$1 out=$2 height fps crf
  for setting in \
    "1080 30 28" \
    "1080 30 32" \
    "720 30 32" \
    "720 24 36" \
    "540 24 38" \
    "480 15 40"; do
    read -r height fps crf <<<"$setting"

    ffmpeg -y -loglevel error -i "$source" \
      -vf "fps=$fps,scale=-2:'min($height,ih)':flags=lanczos" \
      -c:v libx264 -preset slow -crf "$crf" -pix_fmt yuv420p \
      -c:a aac -b:a 64k -movflags +faststart \
      "$out" || fail "ffmpeg failed to re-encode $source."

    report_attempt "${height}p @ ${fps}fps, crf $crf" "$out"
    fits "$out" && return 0
  done
  return 1
}

max_bytes=10000000
out_dir=''
sources=()

while (($#)); do
  case "$1" in
    --max-bytes) (($# >= 2)) || usage; max_bytes=$2; shift 2 ;;
    --out-dir) (($# >= 2)) || usage; out_dir=$2; shift 2 ;;
    --help | -h) usage ;;
    --) shift; sources+=("$@"); break ;;
    -*) usage ;;
    *) sources+=("$1"); shift ;;
  esac
done

((${#sources[@]})) || usage
[[ $max_bytes =~ ^[1-9][0-9]*$ ]] || fail "--max-bytes must be a positive integer: $max_bytes"

for source in "${sources[@]}"; do
  [[ -f $source ]] || fail "Not a regular file: $source"
done

for source in "${sources[@]}"; do
  size=$(file_size "$source")
  if ((size <= max_bytes)); then
    printf '%s\n' "$source"
    continue
  fi

  require_command ffmpeg
  if [[ -z $out_dir ]]; then
    out_dir=$(mktemp -d)
  fi
  mkdir -p "$out_dir"

  basename=${source##*/}
  extension=$(lowercase_extension "$source")
  printf '%s is %s bytes, over the %s limit. Re-encoding...\n' "$source" "$size" "$max_bytes" >&2

  case $extension in
    gif | png | jpg | jpeg) out="$out_dir/$basename" ;;
    mp4 | mov | webm) out="$out_dir/${basename%.*}.mp4" ;;
    *) fail "Cannot shrink .$extension files: $source" ;;
  esac
  [[ ! $out -ef $source ]] || fail "--out-dir would overwrite the source file: $source"

  case $extension in
    gif)
      fit_gif "$source" "$out" || fail \
        "Could not fit $source. Trim the recording, or convert it to MP4 and fit that instead."
      ;;
    png | jpg | jpeg)
      fit_still_image "$source" "$out" || fail "Could not fit $source even at 800px wide."
      ;;
    mp4 | mov | webm)
      fit_video "$source" "$out" || fail "Could not fit $source. Trim the video and retry."
      ;;
  esac

  printf '%s\n' "$out"
done
