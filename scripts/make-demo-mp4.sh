#!/usr/bin/env bash
# Converts the recorded Playwright webm into a shareable H.264 mp4.
#
#   ./scripts/make-demo-mp4.sh
#
# Uses the ffmpeg binary that ships with Playwright, so no system install is
# needed. Output: demo-assets/medimesh-blockchain-demo.mp4
set -euo pipefail

cd "$(dirname "$0")/.."

SRC="demo-assets/medimesh-blockchain-demo.webm"
DST="demo-assets/medimesh-blockchain-demo.mp4"

[ -f "$SRC" ] || { echo "Missing $SRC — run: node scripts/record-demo.mjs"; exit 1; }

# Prefer a full ffmpeg (libx264). Fall back to Playwright's bundled build,
# which only ships the VP9 encoder and so needs a different invocation.
if command -v ffmpeg >/dev/null 2>&1; then
  FF=$(command -v ffmpeg)
  echo "Using system ffmpeg: $FF"
  rm -f "$DST"
  # Playwright records variable frame rate webm; fps filter gives clean CFR.
  "$FF" -y -i "$SRC" \
    -vf "fps=30,scale=1440:-2:flags=lanczos" \
    -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p \
    -movflags +faststart \
    "$DST" >/dev/null 2>&1
else
  FF=$(find "$HOME/Library/Caches/ms-playwright" -type f -name "ffmpeg-mac" 2>/dev/null | head -1)
  [ -n "$FF" ] || FF=$(find "$HOME/Library/Caches/ms-playwright" -type f -name "ffmpeg*" 2>/dev/null | head -1)
  [ -n "$FF" ] || { echo "No ffmpeg found. Install it with: brew install ffmpeg"; exit 1; }

  echo "Using bundled ffmpeg (VP9 only): $FF"
  rm -f "$DST"
  "$FF" -y -i "$SRC" -c:v libvpx-vp9 -b:v 0 -crf 34 -pix_fmt yuv420p \
    "$DST" >/dev/null 2>&1
fi

[ -f "$DST" ] || { echo "Conversion failed — no output written"; exit 1; }

SIZE=$(du -h "$DST" | cut -f1)
DUR=$("$FF" -i "$DST" 2>&1 | grep -oE "Duration: [0-9:.]+" | head -1)
echo ""
echo "✅ $DST  ($SIZE, $DUR)"
