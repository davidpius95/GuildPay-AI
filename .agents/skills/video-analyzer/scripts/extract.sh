#!/usr/bin/env bash
# video-analyzer/scripts/extract.sh
# Extracts keyframes + audio from a video file.
#
# Usage:
#   ./extract.sh <video_path> <output_dir> [interval_override]
#
# The interval (seconds between frames) is chosen automatically based on
# video duration unless overridden.

set -euo pipefail

VIDEO="${1:?Usage: extract.sh <video_path> <output_dir> [interval]}"
OUTDIR="${2:?Usage: extract.sh <video_path> <output_dir> [interval]}"
INTERVAL="${3:-auto}"

# ── prerequisites ────────────────────────────────────────────────────────
command -v ffmpeg  >/dev/null 2>&1 || { echo "❌ ffmpeg not found"; exit 1; }
command -v ffprobe >/dev/null 2>&1 || { echo "❌ ffprobe not found"; exit 1; }

# ── probe video ──────────────────────────────────────────────────────────
DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VIDEO" | cut -d. -f1)
WIDTH=$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$VIDEO")
HEIGHT=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$VIDEO")
HAS_AUDIO=$(ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "$VIDEO" 2>/dev/null || echo "")

echo "📹 Video: ${DURATION}s, ${WIDTH}×${HEIGHT}"
echo "🔊 Audio: ${HAS_AUDIO:-none}"

# ── determine interval ───────────────────────────────────────────────────
if [[ "$INTERVAL" == "auto" ]]; then
  if   (( DURATION < 120 ));  then INTERVAL=3   # < 2 min → every 3s
  elif (( DURATION < 600 ));  then INTERVAL=5   # 2–10 min → every 5s
  elif (( DURATION < 1800 )); then INTERVAL=10  # 10–30 min → every 10s
  else                             INTERVAL=15  # 30+ min → every 15s
  fi
fi

EXPECTED_FRAMES=$(( DURATION / INTERVAL ))
echo "🖼️  Extracting ~${EXPECTED_FRAMES} frames (every ${INTERVAL}s)"

# ── create output dirs ───────────────────────────────────────────────────
mkdir -p "${OUTDIR}/frames"

# ── scale target: 540px wide if wider, keep original if smaller ──────────
SCALE_W=540
if (( WIDTH <= SCALE_W )); then
  SCALE_FILTER=""
else
  SCALE_FILTER=",scale=${SCALE_W}:-1"
fi

# ── extract frames ───────────────────────────────────────────────────────
echo "📸 Extracting frames..."
ffmpeg -i "$VIDEO" \
  -vf "fps=1/${INTERVAL}${SCALE_FILTER}" \
  -q:v 2 \
  "${OUTDIR}/frames/frame_%04d.jpg" \
  -y -loglevel warning 2>&1

FRAME_COUNT=$(ls -1 "${OUTDIR}/frames/"frame_*.jpg 2>/dev/null | wc -l | tr -d ' ')
echo "✅ Extracted ${FRAME_COUNT} frames"

# ── extract audio (if present) ───────────────────────────────────────────
if [[ -n "$HAS_AUDIO" ]]; then
  echo "🎤 Extracting audio..."
  ffmpeg -i "$VIDEO" \
    -vn -acodec pcm_s16le -ar 16000 -ac 1 \
    "${OUTDIR}/audio.wav" \
    -y -loglevel warning 2>&1

  AUDIO_SIZE=$(ls -lh "${OUTDIR}/audio.wav" | awk '{print $5}')
  echo "✅ Audio extracted (${AUDIO_SIZE})"

  # Check if audio is over 25MB (Groq limit) and split if needed
  AUDIO_BYTES=$(wc -c < "${OUTDIR}/audio.wav" | tr -d ' ')
  if (( AUDIO_BYTES > 25000000 )); then
    echo "⚠️  Audio > 25MB — splitting into chunks for transcription..."
    ffmpeg -i "${OUTDIR}/audio.wav" \
      -f segment -segment_time 600 -c copy \
      "${OUTDIR}/audio_chunk_%03d.wav" \
      -y -loglevel warning 2>&1
    CHUNK_COUNT=$(ls -1 "${OUTDIR}/"audio_chunk_*.wav 2>/dev/null | wc -l | tr -d ' ')
    echo "✅ Split into ${CHUNK_COUNT} chunks"
  fi
else
  echo "ℹ️  No audio stream — skipping audio extraction"
fi

# ── output metadata ──────────────────────────────────────────────────────
cat > "${OUTDIR}/metadata.json" <<EOF
{
  "source": "$(basename "$VIDEO")",
  "duration_seconds": ${DURATION},
  "resolution": "${WIDTH}x${HEIGHT}",
  "has_audio": $([ -n "$HAS_AUDIO" ] && echo true || echo false),
  "frame_interval": ${INTERVAL},
  "frame_count": ${FRAME_COUNT},
  "extracted_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo ""
echo "📋 Metadata saved to ${OUTDIR}/metadata.json"
echo "🎉 Done! Output in ${OUTDIR}/"
