---
name: video-analyzer
description: >
  Analyze demo videos (screen recordings, app walkthroughs, competitor demos) and produce a structured
  implementation reference. Extracts keyframes, transcribes audio, identifies UI components, maps
  interaction flows, and generates an actionable spec the agent can use to build or replicate features.
  Trigger when the user uploads a video file (.mp4, .mov, .webm, .mkv) and wants to understand,
  replicate, or take inspiration from its content. Also trigger on phrases like "analyze this video",
  "build something like this video", "what does this demo show", or "extract the flow from this recording".
---

# Video Analyzer Skill

## Purpose
Turn a demo video into a **structured implementation reference** that an AI coding agent can use
to make informed design and implementation decisions — without needing to re-watch the video.

## When to Use
- User uploads a screen recording of a competitor app (e.g. Xara, Kuda, OPay, Carbon)
- User shares a product demo video and says "build this" or "I want something like this"
- User wants to extract UI patterns, flows, copy, or interaction models from a video
- User wants a transcript of a video walkthrough for documentation

## Prerequisites
- **ffmpeg** must be installed (check: `which ffmpeg`)
- **ffprobe** must be available (ships with ffmpeg)
- For audio transcription: Groq API key (for Whisper) in environment, OR local Whisper installation.
  If neither is available, skip transcription and note it in the output.

## Workflow

### Phase 1: Probe & Plan
1. Run `ffprobe` to get video metadata (duration, resolution, codec, audio presence).
2. Determine extraction parameters dynamically:
   - **Short video (< 2 min):** Extract frames every 3 seconds
   - **Medium video (2–10 min):** Extract frames every 5 seconds
   - **Long video (> 10 min):** Extract frames every 10 seconds
3. Create output directory: `<artifactDir>/video_analysis/` with subdirectories:
   - `frames/` — extracted keyframes as JPG
   - (audio.wav lives at the root of `video_analysis/`)

### Phase 2: Extract
1. **Extract keyframes** using ffmpeg:
   ```bash
   ffmpeg -i <VIDEO> -vf "fps=1/<INTERVAL>,scale=540:-1" -q:v 2 <OUTPUT>/frames/frame_%04d.jpg -y
   ```
   - Scale down to 540px width (sufficient for analysis, saves tokens)
   - Quality level 2 (high quality JPG)

2. **Extract audio** (if audio stream exists):
   ```bash
   ffmpeg -i <VIDEO> -vn -acodec pcm_s16le -ar 16000 -ac 1 <OUTPUT>/audio.wav -y
   ```
   - 16kHz mono WAV optimized for speech recognition

3. **Scene change detection** (optional, for long videos):
   ```bash
   ffmpeg -i <VIDEO> -vf "select='gt(scene,0.3)',showinfo" -vsync vfr <OUTPUT>/scenes/scene_%04d.jpg -y
   ```

### Phase 3: Transcribe Audio
Attempt transcription in this order:
1. **Groq Whisper API** — if `GROQ_API_KEY` is available in the environment:
   ```bash
   # Use the project's STT service or curl directly:
   curl -s https://api.groq.com/openai/v1/audio/transcriptions \
     -H "Authorization: Bearer $GROQ_API_KEY" \
     -F file=@<OUTPUT>/audio.wav \
     -F model=whisper-large-v3-turbo \
     -F response_format=verbose_json \
     -F timestamp_granularities[]=segment
   ```
   Note: Groq Whisper has a 25MB file size limit. For longer audio files, split them first:
   ```bash
   # Split audio into 10-minute chunks (under 25MB at 16kHz mono)
   ffmpeg -i <OUTPUT>/audio.wav -f segment -segment_time 600 -c copy <OUTPUT>/audio_chunk_%03d.wav
   ```
   Then transcribe each chunk separately and concatenate the results.

2. **Local Whisper** — if `whisper` CLI is installed:
   ```bash
   whisper <OUTPUT>/audio.wav --model base --language auto --output_format json
   ```

3. **Skip** — if no transcription tool is available, note in output:
   > ⚠️ Audio transcription unavailable. Install Whisper or set GROQ_API_KEY.

### Phase 4: Analyze Frames
View each extracted frame using the `view_file` tool (which supports images).
For each frame, document:
- **Timestamp**: `frame_NNNN.jpg` → `(N-1) × interval` seconds
- **Screen type**: What kind of screen/state is shown (chat, form, modal, receipt, etc.)
- **UI components**: Buttons, input fields, cards, lists, messages, etc.
- **Text content**: All visible text (messages, labels, values)
- **User action**: What the user is doing or about to do
- **State transition**: What changed from the previous frame

Group consecutive frames showing the same screen to avoid redundancy.

### Phase 5: Produce the Structured Output
Create an artifact: `<artifactDir>/video_analysis_report.md` with these sections:

```markdown
# Video Analysis Report: [Video Name]

## Video Metadata
| Property | Value |
|---|---|
| Duration | ... |
| Resolution | ... |
| Audio | Yes/No |
| Frames extracted | ... |

## Executive Summary
One paragraph: what the video demonstrates, the app shown, key flows.

## Audio Transcript
Full timestamped transcript (if available).

## Screen-by-Screen Flow
For each distinct screen/state:
### Screen N: [Screen Name] (timestamp range)
- **Type**: Chat / Modal / Form / Receipt / etc.
- **Screenshot**: ![description](frame path)
- **UI Components**: list of components
- **Text Content**: all visible text
- **User Action**: what the user does
- **Bot/System Response**: what the system shows

## UI Component Inventory
Table of all unique UI patterns observed.

## Interaction Flow Diagram
Mermaid flowchart of the complete user journey.

## Implementation Notes
Key observations, patterns, and recommendations for building something similar.

## Comparison with Current Implementation
(If analyzing a competitor in the context of an existing project)
What features are present that we lack, and vice versa.
```

## Dynamic Behavior

The skill adapts to:
- **Video type**: Screen recording vs. camera video vs. slideshow
- **App type**: WhatsApp bot, mobile app, web app — adjusts UI taxonomy
- **Context**: If run inside a project (like GuildPay-AI), automatically compares against existing features
- **Length**: Adjusts frame extraction interval based on duration
- **Audio**: Gracefully degrades if no transcription is available
- **Quality**: Uses scene detection for very long videos to find key transitions

## Tips for Best Results
- Use screen recordings at native resolution
- Include audio narration if possible — it provides context the frames can't
- Record the complete flow from start to finish, including error states
- If the video is very long (>30 min), consider splitting it into logical segments first
