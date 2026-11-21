# Emily: fall-detection watch

Emily is a watch that detects when an older adult falls, asks out loud if they are OK, and alerts their family. Sensors only, no cameras.

Built from scratch during McGill CodeJam 16 (Nov 20-22, 2026).

## Repo layout

| Folder | What |
|---|---|
| `watch/` | Arduino sketch for the LilyGO T-Watch S3 (C++) |
| `convex/` | Backend: HTTP routes, AI service, family alerts |
| `src/` | Family web portal (Vite + React + TypeScript) |
| `ml/` | Random Forest training (Python) |

## Setup

```bash
npm install
npx convex dev
```

In a second terminal:

```bash
npm run dev
```

For the watch, copy `watch/secrets.example.h` to `watch/secrets.h` and fill it in.

API keys live only in Convex environment variables, never in this repo:
`ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `PUSHOVER_APP_TOKEN`.

Project notes and the full plan are in `HANDOFF.md` (Spanish).
