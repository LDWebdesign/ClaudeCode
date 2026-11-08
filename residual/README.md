# Residual

A paranormal field-investigation experience: a **spirit box** that listens to your questions
and a **visual anomaly scanner** that watches your camera feed. It is built around ambiguity —
most questions get nothing back, most scans show nothing, and what does happen is faint enough
that you go back to the recording to check.

Residual synthesizes what it plays and shows. It cannot detect anything, and it says so in its
Calibration sheet and exports. Everything stays on the device.

The build is a single self-contained file, [`../residual.html`](../residual.html) (~2 MB:
code, fonts and voice bank inlined; no network needed).

## Running it

Camera and microphone access require a secure context, so serve the file over **https** (or
`localhost`). Any static host works — GitHub Pages, Netlify, an S3 bucket. On a phone, open the
URL and use *Add to Home Screen* for a full-screen app.

```sh
npm install
npm run dev        # dev server (https needed for phones: use a tunnel or a host)
npm run build      # type-check, build, write ../residual.html
npm test           # unit tests (engines, distributions, environment analysis)
```

End-to-end checks run in Chromium with a fake camera and microphone:

```sh
npm run e2e:media                         # render test scenes + speech (needs espeak-ng, ffmpeg, numpy, Pillow)
npx vite preview --port 4173 &
npm run e2e                               # 14 checks: playback, logging, recording, permissions…
npm run e2e:gallery -- room               # before/after crops of every anomaly type
```

Append `?debug` to the URL to expose `window.residual` for scripting.

## How it works

### Spirit box (`src/spiritbox`, `src/audio`)

| Stage | File | What it does |
|---|---|---|
| Listening | `listener.ts` | Adaptive-floor voice-activity detection on the mic (always works, offline), plus the browser speech recogniser for transcripts where available. Untranscribed speech is still logged as a question. Its own output is suppressed. |
| Question analysis | `concepts.ts` | Lexicon + light stemming → weighted concepts (`death`, `place`, `identity`…) and the kind of answer invited (`yesno`, `who`, `where`…). |
| Memory | `memory.ts` | Every utterance's concepts, decaying with a half-life. Fragments are drawn from memory **when they play**, not when scheduled — so a response can relate to a question asked 30 s earlier. |
| Correlation | `correlation.ts` | Draws a tier — **unrelated 65 / loose 25 / relevant 9 / uncanny 1** — then a fragment from the 483-entry vocabulary (`vocabulary.json`) via concept adjacency, with repetition cooldowns and a hidden per-session persona so rare pointed answers (a name, an age) stay consistent. Uncanny draws include delayed echoes of an earlier question's own words. |
| Timing | `scheduler.ts` | ~42 % of questions get nothing. Otherwise delays of 1–3 s, 5–8 s, 10–16 s or 18–40 s; occasional landings mid-sentence, short bursts, and rare unprompted fragments during long silences. |
| Rendering | `audio/sweep.ts`, `audio/fragments.ts` | Stepped band sweep with hard inter-step mutes, FM capture effect, broadcast bleed (voice slivers, music, heterodyne whistles, hum). Fragments are slices of a pre-rendered voice bank — whole, cut off, single syllables, spliced pseudo-words, reversed — pushed through a band-limited, saturated, bit-reduced receiver chain with dropouts and multipath flutter scaled by clarity. |
| Interpretation | `interpretation.ts` | Log entries are hedged like a reviewer would: clear fragments get a reading, unclear ones get alternates (“…back…” alt. “black”), the faintest get none — and some are never logged at all, only audible on the recording. |

The voice bank (`src/audio/voicebank.bin`) is rendered offline by `tools/build-voicebank.py`
with MBROLA, Festival and eSpeak NG voices, stored as 8 kHz IMA-ADPCM. To use real recorded
voices, run `npm run voicebank -- --recordings path/to/wavs` with files named `<entry>.<n>.wav`.

### Visual scanner (`src/camera`)

| Stage | File | What it does |
|---|---|---|
| Environment analysis | `analysis.ts` | On a ~160 px luminance frame, twice a second: gradient-directed Hough lines → door jambs, door edges, furniture tops, stair runs, hallway vanishing points; connected components → dark corners, shadow pockets, framed bright panes. Each site gets an occluding edge, the side something would be hidden on, a physical scale (a door is ~2 m) and a persistence count. |
| Scheduling | `anomalies.ts` | Each completed scan rolls **normal 85 / subtle 10 / unusual 4 / uncanny 1**. A non-normal roll only happens with a steady camera and a persistent, on-screen, compatible site; then comes a quiet period, and random dormant stretches of minutes. |
| Shapes | `anomalies.ts` | Procedural and physically scaled: a deepening corner, a smudge, the top of a head or a shoulder edge just past a door jamb, a hat brim, a head rising over furniture, a figure far down a hallway, and (rarely, for a fraction of a second) a partial silhouette leaning out from behind an edge. Clipped by the occluder with a hard edge; feathered elsewhere; tiny motion. |
| Rendering | `renderer.ts` | One WebGL pass. Anomalies are composited **before** exposure, tone curve and grain, as an object of its own dim luminance at partial opacity — darker than a lit wall, faintly lit inside a black doorway — so they carry the same noise as the scene. |
| Tracking & logging | `controller.ts` | Small hand movement is compensated per frame; larger movement ends the anomaly. Only some anomalies are logged (with a thumbnail); some last only 2–3 frames and are effectively visible only when stepping through footage. The on-screen irregularity meter is mostly a genuine measure of frame-to-frame change in dark regions. |

### Sessions (`src/session`)

Sessions, events, clips and stills live in IndexedDB. REC records the spirit-box mix plus the
mic (audio) or the processed camera canvas plus audio (video); switching modes splits clips.
Review offers a timeline that jumps into the footage, frame stepping, slow motion, an
*Enhance* brightness lift, and log/JSON export.

## Tuning

Every probability, delay and intensity lives in **`src/config.ts`** (`DEFAULT_CONFIG`) and
nowhere else. All of it is also exposed live in the in-app **Calibration** sheet (persisted to
localStorage), including a *Show engine decisions* diagnostics mode that overlays detected
locations, reveals unlogged events and annotates each fragment with its tier and reasoning.

## Limitations and upgrade paths

- **Transcription** depends on the browser's Web Speech API: Chrome sends audio to Google's
  service; Safari supports it on recent iOS/macOS; Firefox has none. Without it questions are
  detected and logged untranscribed, and fragments draw from the unrelated tier. A local
  recogniser (e.g. a Whisper WASM build) could slot into `listener.ts`.
- **Voices** are synthesized, then degraded. Real recorded fragments would be more convincing;
  the build script accepts them.
- **Environment analysis** is classical image heuristics, not scene understanding. It reliably
  finds strong vertical/horizontal structure and dark regions; it can mislabel things. A
  monocular depth or segmentation model could replace it behind the same `Site` interface.
- **Recordings** are held in memory until REC stops. Very long clips on low-memory phones
  should be split; iOS also stops the camera when the app is backgrounded.
- The single-file build has no service worker; once the page is open it needs no network.
