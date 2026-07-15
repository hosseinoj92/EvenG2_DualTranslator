# TurnTranslate G2

A bidirectional conversation translator for **Even Realities G2** smart glasses.

Two people speak different languages face to face. The G2 microphone captures
each utterance, a Cloudflare Worker transcribes it, the completed transcript
appears immediately, then the translation follows on both the glasses and the
phone. There is no text-to-speech: when your own sentence is translated, you
read it aloud yourself.

Processing is a **final-utterance two-stage pipeline** — this is _not_ live
transcription:

```text
audio (completed utterance)
  → final transcription (exactly one request per utterance)
  → display the completed transcript ("Translating…")
  → translation
  → display the final direction-specific result
```

- The app **waits for the speaker to finish** (local VAD detects end of
  speech); nothing is transcribed while someone is still talking.
- **Only one transcription request** is made per spoken utterance — never
  partial, periodic or streaming requests.
- **Incoming** final screens show the recognized original speech _and_ its
  translation, so they can be compared.
- **Outgoing** final screens prioritize the translated sentence the user
  should read aloud; the original stays on the phone and in history.
- **History** shows both texts for every completed turn.

Default pair: you speak **English**, the other person speaks **Spanish**.
Both languages are selectable from the phone companion UI (English, Spanish,
German, French, Italian, Portuguese, Dutch, Turkish).

---

## 1. Product overview

|             |                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| Glasses app | Even Hub WebView app (Vite + vanilla TypeScript + `@evenrealities/even_hub_sdk`)                               |
| Backend     | Cloudflare Worker with Workers AI (`whisper-large-v3-turbo` for speech-to-text, `m2m100-1.2b` for translation) |
| Audio       | G2 mic, PCM s16le @ 16 kHz mono, local RMS voice-activity detection, WAV upload of completed utterances only   |
| Display     | 576 × 288 panel, three text containers (header / body / footer)                                                |
| Controls    | R1 ring / touchpad single click (switch speaker), double click (exit), swipe up/down (history), phone buttons  |

## 2. Conversation workflow

The app is a strict state machine with two directions. The glasses display is
speaker- and task-oriented: each screen answers one question (who is speaking?
what did they say? what does it mean? what should I say aloud?). The language
pair is chosen once during setup, so language codes are never repeated per
turn.

**Direction A — the other person speaks** (`LISTENING_TO_THEM`)

1. The other person speaks; local VAD waits for the utterance to finish.
2. The completed WAV is sent for transcription — one request, no streaming.
3. As soon as the transcript is back it appears on the glasses and the phone,
   with `Translating…` underneath.
4. The translation completes the turn: original + translation stay on screen.
5. The app automatically resumes listening to them.

```text
┌ THEM            ┌ THEM               ┌ THEY SAID            ┌ THEY SAID
│                 │                    │                      │
│ Listening…      │ Processing speech… │ ¿Dónde está la       │ ¿Dónde está la
│                 │                    │ estación?            │ estación?
│                 │                    │                      │
│                 │                    │ Translating…         │ → Where is the station?
│                 │                    │                      │
└ R1: your turn   └ Please wait        └                      └ R1: your turn
```

**Direction B — you speak** (single click → `LISTENING_TO_ME`)

1. You speak; capture stops at end-of-speech.
2. Same two stages: transcription first (so you can spot a recognition error),
   then translation.
3. The final screen is dominated by the sentence you need to read aloud — the
   header carries the instruction, the body holds only the translation. The
   microphone is **fully paused** (`READ_ALOUD_PAUSED`) so the app never
   re-processes you reading the translation aloud.
4. The next click returns to Direction A.

```text
┌ YOUR TURN       ┌ YOU                ┌ YOU SAID             ┌ SAY THIS IN SPANISH
│                 │                    │                      │
│ Speak English…  │ Processing speech… │ Where is the         │ ¿Dónde está la
│                 │                    │ station?             │ estación?
│                 │                    │                      │
│                 │                    │ Translating…         │
│                 │                    │                      │
└ R1: cancel      └ Please wait        └                      └ R1: listen to them
```

History browsing (swipe up = older, swipe down = newer, swipe down at the
newest returns to live) always shows both texts, labelled with the speaker and
using the languages stored in each turn:

```text
┌ HISTORY · 3 / 8 · THEM        ┌ HISTORY · 4 / 8 · YOU
│                               │
│ ¿Dónde está la estación?      │ Where is the station?
│                               │
│ → Where is the station?       │ → ¿Dónde está la estación?
│                               │
└ Swipe: browse · R1: live      └ Swipe: browse · R1: live
```

Additional states: `SETUP`, `PROCESSING_THEM`, `PROCESSING_ME`,
`BROWSING_HISTORY` (swipe through the last 20 turns), `OFFLINE`, `ERROR`
(with retry — after a translation failure the recognized transcript is
preserved and retry re-runs only the translation), `EXITING`. The reducer is
pure and exhaustively unit-tested
([conversationMachine.ts](apps/g2-app/src/conversation/conversationMachine.ts)).

## 3. Architecture

```text
┌───────────────  Even App WebView (phone)  ───────────────┐
│  companion UI        conversation controller             │
│  (status, languages, ┌──────────────────────────┐        │
│   history, manual    │ pure state machine       │        │
│   input, diagnostics)│ (reducer + effects)      │        │
│                      └────────────┬─────────────┘        │
│   audio pipeline                  │        display       │
│   VAD → WAV encoder               │        render queue  │
└───────────┬───────────────────────┼─────────────┬────────┘
   PCM s16le│ bridge events         │ HTTPS       │ textContainerUpgrade
            │                       ▼             ▼
     ┌──────┴──────┐      ┌────────────────────┐  ┌─────────┐
     │  G2 glasses │      │ Cloudflare Worker  │  │ G2 576× │
     │  microphone │      │ 1. /api/v1/        │  │ 288 px  │
     └─────────────┘      │    transcribe      │  │ display │
                          │    (whisper-v3-    │  └─────────┘
                          │     turbo)         │
                          │ 2. /api/v1/        │
                          │    translate-text  │
                          │    (m2m100-1.2b)   │
                          └────────────────────┘
```

Each spoken utterance makes exactly two backend calls, in order: final
transcription, then text translation using the returned transcript. The legacy
single-call `/api/v1/interpret` route (transcribe + translate in one request)
remains available for compatibility but is no longer used by the app.

## 4. Repository structure

```text
turntranslate-g2/
├── apps/g2-app/               # Even Hub app (Vite, vanilla TS)
│   ├── app.json               # Even Hub manifest (permissions, whitelist)
│   ├── src/
│   │   ├── main.ts            # bootstrap + cleanup wiring
│   │   ├── config.ts          # ALL tunable values (VAD, geometry, timeouts)
│   │   ├── conversation/      # state machine, controller, history helpers
│   │   ├── even/              # bridge, event router, render queue, display
│   │   ├── audio/             # PCM buffers, VAD, WAV encoder, mic control
│   │   ├── api/               # typed Worker client + error mapping
│   │   ├── ui/                # companion phone UI (textContent only)
│   │   └── utils/             # debounce, text hygiene, abortable fetch, …
│   └── test/                  # 159 unit tests
├── workers/translator-api/    # Cloudflare Worker
│   ├── wrangler.toml          # AI binding + CORS vars (no secrets)
│   ├── src/
│   │   ├── index.ts           # router + CORS + DI factory (createApp)
│   │   ├── env.ts             # bindings + the one backend config module
│   │   ├── errors.ts          # ApiError → ApiErrorResponse mapping
│   │   ├── validation.ts      # multipart/JSON/WAV validation
│   │   ├── routes/            # health, transcribe, interpret, translateText
│   │   └── services/          # transcription/translation/language services
│   └── test/                  # 52 unit tests (mocked services, no real AI)
├── packages/shared/           # language registry + API contracts + guards
└── (root)                     # workspaces, ESLint, Prettier, tsconfig base
```

## 5. Prerequisites

- Node.js ≥ 20 and npm ≥ 10
- A Cloudflare account with Workers AI enabled (free tier is fine for dev)
- The Even Hub companion app on a phone paired with G2 glasses, or the
  `@evenrealities/evenhub-simulator` for desktop testing

## 6. Installation

```bash
npm install
```

## 7. Environment setup

```bash
cp apps/g2-app/.env.example apps/g2-app/.env.local
```

`apps/g2-app/.env.local` holds exactly one value:

```text
VITE_TRANSLATION_API_URL=http://localhost:8787      # wrangler dev
# or, once deployed:
VITE_TRANSLATION_API_URL=https://turntranslate-api.YOUR_SUBDOMAIN.workers.dev
```

This is a public URL, not a secret. **Never put API keys in any `VITE_*`
variable** — everything prefixed `VITE_` is embedded in the shipped bundle.
The Worker needs no `.env` at all; its only credential-like resource is the
Workers AI binding, which Cloudflare injects at runtime.

## 8. Running the Worker locally

```bash
npm run dev:worker        # wrangler dev → http://localhost:8787
```

`wrangler dev` proxies `env.AI` calls to Cloudflare, so you need to be logged
in (`npx wrangler login`) even for local development, and Workers AI usage is
billed/metered normally. Verify with:

```bash
curl http://localhost:8787/health
# {"status":"ok","service":"turntranslate-api"}
```

## 9. Running the G2 app locally

```bash
npm run dev:g2            # Vite on http://localhost:5173 (LAN-exposed)
```

In a plain browser the Even bridge is absent; the app detects this and runs in
phone-only mode (companion UI + manual text translation, no mic/glasses).

## 10. Even Hub simulator

```bash
npm run dev:g2            # terminal 1
npm run simulate          # terminal 2 → evenhub-simulator http://localhost:5173
```

## 11. Testing on real G2 glasses (QR workflow)

1. Phone and computer on the same network.
2. `npm run dev:g2`
3. `cd apps/g2-app && npx evenhub qr --url http://<your-lan-ip>:5173`
4. Scan the QR with the Even Hub companion app; the app opens in its WebView
   and renders on the paired glasses.

## 12. Updating the Worker URL

After deploying the Worker you must update the URL in **two places**:

1. `apps/g2-app/.env.local` → `VITE_TRANSLATION_API_URL` (rebuild afterwards).
2. `apps/g2-app/app.json` → the `network` permission `whitelist` entry
   (replace `https://turntranslate-api.YOUR_SUBDOMAIN.workers.dev`).
   Packing rejects an empty whitelist, which is why a placeholder is present.

For browser-context testing also add your dev origins to `ALLOWED_ORIGINS` in
`wrangler.toml` (localhost is already allowed while `ALLOW_LOCAL_DEV = "true"`).

## 13. Cloudflare Workers AI binding

`wrangler.toml` declares:

```toml
[ai]
binding = "AI"
```

Nothing else is needed — no API token in the code. The Worker calls
`env.AI.run("@cf/openai/whisper-large-v3-turbo", …)` and
`env.AI.run("@cf/meta/m2m100-1.2b", …)`. Base64 audio encoding uses the
Workers-native `btoa` (chunked), so **no Node compatibility flag is required**.

## 14. Deployment (manual, never automatic)

```bash
npx wrangler login                                   # once
npm run deploy --workspace workers/translator-api    # deploys turntranslate-api
```

Then set `ALLOW_LOCAL_DEV = "false"` and a real `ALLOWED_ORIGINS` for
production, and follow section 12.

## 15. Packing the app into .ehpk

```bash
npm run pack:g2
# → apps/g2-app/turntranslate.ehpk  (build + evenhub pack app.json dist)
```

Upload the `.ehpk` through the Even Hub developer portal. Update `package_id`
in `app.json` first if `com.hosseinostovar.turntranslate` is taken
(`npx evenhub pack --check app.json dist` verifies availability).

## 16. Privacy behaviour

- Completed utterances (WAV) are sent to **your** Cloudflare Worker and from
  there to Cloudflare Workers AI **for processing only**; audio is held in
  memory for the duration of the request and never persisted or logged.
- Transcripts and translations are not stored server-side; conversation
  history lives only in the phone's memory (max 20 turns) and disappears when
  the app closes.
- Only the selected language pair is persisted (app-scoped storage).
- No analytics, no third-party requests, no credentials in the frontend.
- Structured technical logging happens only in development builds.

## 17. Cost control

- Audio leaves the phone **only after** local VAD detects a complete utterance
  — silence and background chatter are never uploaded, and exactly **one
  transcription request** is made per utterance (no partial or periodic
  transcription).
- Utterances are capped at 12 s locally (`maximumUtteranceMs`) and 15 s
  server-side, bounding per-request Workers AI cost.
- One voice-processing chain may exist at a time; toggling direction aborts
  whichever stage is in flight (transcription or translation) instead of
  stacking new ones. If translation fails, retry reuses the saved transcript
  rather than paying for a second transcription.
- Whisper-large-v3-turbo and m2m100 are metered in Cloudflare "neurons"; both
  are among the cheapest models in the catalog and the free daily allocation
  covers typical development use. Watch usage in the Cloudflare dashboard
  under Workers AI.

## 18. Troubleshooting

| Symptom                                      | Fix                                                                                                                                                 |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phone UI says "No glasses"                   | You are in a plain browser, or the bridge timed out — open through the Even Hub app / simulator.                                                    |
| Mic chip stays "Mic off" in LISTENING states | The startup page must exist before `audioControl(true)` works; check the `g2-microphone` permission in `app.json`, and reopen the app.              |
| `CONNECTION ERROR` on glasses                | Worker not running / wrong `VITE_TRANSLATION_API_URL` / origin missing from `app.json` whitelist. `curl <url>/health` to isolate.                   |
| Browser console shows CORS errors            | Add your origin to `ALLOWED_ORIGINS` in `wrangler.toml` (or keep `ALLOW_LOCAL_DEV="true"` for localhost).                                           |
| `NO SPEECH DETECTED` errors on real speech   | Lower `appConfig.vad.rmsThreshold` in [config.ts](apps/g2-app/src/config.ts); watch the live RMS value in the phone Diagnostics panel to calibrate. |
| VAD triggers on background noise             | Raise `rmsThreshold` or `speechStartFrameCount`.                                                                                                    |
| Display updates lag                          | Expected: writes are debounced 120 ms and serialized because the BLE queue is slow. Don't lower `renderDebounceMs` below ~100 ms.                   |
| `evenhub pack` fails on the whitelist        | The `network` permission whitelist must contain your real Worker origin (empty lists are rejected).                                                 |

## 19. Adding languages

1. Confirm the ISO 639-1 code is supported by **both** models:
   - Whisper large-v3-turbo's `language` input (see the model page in the
     Cloudflare Workers AI catalog);
   - m2m100-1.2b's `source_lang`/`target_lang` (M2M-100 covers 100 languages;
     check the list on the model card).
2. Add one entry to `SUPPORTED_LANGUAGES` in
   [packages/shared/src/languages.ts](packages/shared/src/languages.ts).
3. Run `npm test` — registry tests, backend validation and the frontend
   selector all derive from that single entry.
4. Verify end-to-end with a real utterance in that language before shipping;
   transcription quality varies by language even when a code is "accepted".

## 20. Known limitations

- **No speaker diarization**: in Direction A the mic hears everyone; the
  turn-based design (explicit R1 toggling) is what keeps the pipeline sane.
- **Reading aloud is manual** by design — the G2 has no speaker and the app
  deliberately ships no TTS.
- Whisper hallucinates occasionally on very short/noisy clips; utterances
  under `minimumSpeechMs` are rejected locally to reduce this.
- `m2m100-1.2b` is a compact model: translations are solid for conversational
  sentences, weaker for idioms. `TranslationService` is an interface so a
  stronger provider can be swapped in without touching the routes.
- The R1-ring-only input policy (`ringOnlyPolicy`) exists but is not the
  default: `eventSource` shares protobuf's zero-value omission, so "no
  metadata" and "dummy source" are indistinguishable and older firmware may
  omit the field. The default accepts any click and logs the classified source.
- History browsing shows one turn per screen; very long turns are truncated
  with a pixel-accurate ellipsis rather than paginated.
- Offline mode preserves settings/history but does not queue utterances for
  later — deliberate, to avoid translating stale context.

## Scripts reference

```bash
npm run dev:g2         # Vite dev server for the glasses app
npm run dev:worker     # wrangler dev for the API
npm run build          # build both (Vite build + wrangler dry-run)
npm run build:g2       # frontend only
npm run build:worker   # worker dry-run bundle only
npm run typecheck      # tsc --noEmit in all workspaces
npm run lint           # ESLint (flat config, type-aware rules off for speed)
npm run format         # Prettier write
npm run test           # all workspace test suites (232 tests)
npm run test:watch     # vitest watch for the g2 app
npm run simulate       # Even Hub simulator against localhost:5173
npm run pack:g2        # build + pack into apps/g2-app/turntranslate.ehpk
```

## License

MIT — see [LICENSE](LICENSE).
