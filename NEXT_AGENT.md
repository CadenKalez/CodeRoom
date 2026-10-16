# Handoff: Code Room — next steps

You're picking up **Code Room**, a Mac app + web page that visualizes any code repository as a 3D
cloud of glowing "code bubbles" joined by swaying strands (inspired by the Code Room scene in
*Wreck-It Ralph*), with procedural sound. Read `README.md` first for what exists and how to run it.

## Where things are

- Project: `~/Downloads/CodeRoom/` (deliberately **outside** the SC4-Decomp repo — the user asked
  for it to be isolated from the game code; never write into scanned repos).
- Installed app: `~/Desktop/Code Room.app` — rebuild + reinstall with `./build_app.sh`
  (it only ever replaces a bundle whose id is `local.coderoom.app`).
- `server.py` scanner/server (Python 3.9+ stdlib), `index.html` (WebGL renderer, layout, strands,
  UI), `sound.js` (Web Audio, everything synthesized), `app/main.swift` (WKWebView shell).
- `wip/ambient_block.js` — already merged into `sound.js`; kept only for reference.

## Done (2026-10-16)

- **Generative music**: `wip/ambient_block.js` is spliced into `sound.js` (the wip file is now only a
  record). `setMusic`/`musicOn` + "♫ Music" toolbar toggle (persisted in `soundPrefs.music`).
  `renderTest(seconds, { sfx, music, boot })` can isolate layers; music sits ≈6 dB under the ambience.
- **Bloom intro**: `startBloom()` / `bloom` in `index.html` (`updateWorld` drives `n.bs`, `n.bl`, `n.bp`);
  sound is `bootAt(t, cues)` in `sound.js`, cues passed from `startBloom()`. Boot peaks ≈ −8 dB.
- **Camera follows the crowd**: `updateFit()` computes `focus` (centroid + mean-shift into the densest
  cluster of visible bubbles); the camera target glides there whenever nothing is selected.
- **Lighting**: god rays + light core live in the background shader (`bgProg`, dithered); `updateLight()`
  moves the core to the focus / selected bubble and flares it with the bloom waves; `drawGlows()` adds
  selection/neighbour halos, bloom-wave halos and the core's pool of light on the floor.
- Measured in Chromium at 60 fps, 6–9 ms JS on SC4-Decomp; **not yet measured in the WebKit app** (press F).

## GitHub copy (CadenKalez/CodeRoom) — read this if you're working from the repo, not the Mac

- The code has moved on since the list above: `sound.js` now also plays a **CC0 sample pack**
  (`samples/` + `samples/manifest.json`) and a far-off **radio** of tracker/chiptune music
  (`music/` + `music/playlist.json`, `.mod` files played by `modPlayer`, sometimes on the felt piano).
- **`samples/` and `music/` were not uploaded to the repo.** They only exist in `~/Downloads/CodeRoom/`
  on the user's Mac. Without them the room stays purely synthesized and the radio stays silent
  (one expected 404 + a "samples unavailable" warning in the console). `build_app.sh` now warns
  and carries on instead of failing when either folder is missing.
- `build/` holds an **old** app bundle (its `index.html`/`sound.js` predate the current sources);
  it's a build artifact, rebuild with `./build_app.sh` rather than trusting it.
- Fixed: `CodeRoomSound.renderTest()` crashed with `piano is not a function` (its `piano` option
  shadowed the `piano()` voice). The option is now bound to `onPiano` internally; the call signature
  (`renderTest(s, { piano: true, track })`) is unchanged.
- Smoke-tested in headless Chromium (software GL, so fps there is meaningless): no page errors,
  JS ≈ 2 ms/frame on this repo; `renderTest(10)` → peak −7 dB, RMS −27 dB, 0 NaN
  (with boot: RMS −22 dB; ambience only: peak −18 dB). Synth-only — no samples — so not the real mix.

- **Layout physics on big repos (sm64, 3,020 modules / 5,760 links):** `tick` was ~145 ms of a
  ~160 ms frame (headless Chromium in a slow cloud box) — ~1 M `repel()` calls per frame, and each
  in-range one cost ~200 ns because node objects come in many hidden-class shapes. `repelGrid()` now
  does the *same* pushes (same 300 grid, same pairs — checked against brute force to 1e-14) on typed
  arrays sorted by cell: one tick 109 → 9.9 ms, settled layout identical (overlaps, NN spacing, Rg,
  group spread). Whole frame: JS 150–170 → 25–38 ms there. This matters for the first ~10 s after
  opening (the bloom) and for every drag (it reheats `alpha` to 0.06). Repos ≤ 300 modules still use
  the plain O(n²) `repel()` loop, unchanged.
- Next-biggest costs on sm64 after a selection: `overlay` (2D rings/labels) ~6 ms, `bubbles` ~6 ms,
  `lines` ~4 ms (container numbers; expect ~3–4× less on an M-series Mac). Not yet measured in WebKit.

## How to verify (do this, don't guess)

- **Visuals/FPS:** run `python3 server.py --port 8765` and use the built-in browser pane at
  `http://127.0.0.1:8765/?fps` (press **F** in the app for the same readout: fps · GL size · JS ms ·
  audio state). Target 60 fps at full Retina res; on the 479-module SC4-Decomp root it was ~8 ms JS
  in Chromium. WebKit (the app) is slower — always re-check in the app.
- **Audio:** `await CodeRoomSound.renderTest(16)` renders offline and returns peak/RMS/NaN count;
  `CodeRoomSound.meter()` reads the live master. Current mix: ambience ≈ −36 dB RMS, select/drag
  peaks ≈ −15…−17 dB, no NaNs. You can't listen — measure, and tell the user it's measured, not heard.
- **App:** `./build_app.sh`, then `osascript -e 'tell application id "local.coderoom.app" to quit'`
  and `open ~/Desktop/"Code Room.app"`; log at `~/Library/Logs/Code Room.log`. The user actively uses
  the app — say before you relaunch it, and don't click around in it while they're working.

## Hard-won gotchas

- WebKit rasterizes canvas-2D on the CPU: keep all bulk drawing in WebGL (`index.html` batches);
  the 2D overlay is only for rings/labels and clears just its dirty rect. No `backdrop-filter` over the
  animated scene (WebKit re-blurs every layer every frame).
- Web Audio `BiquadFilter` lowpass `Q` is resonance **in dB**: inside a feedback loop use `Q = -6`
  (or any value with no bump) or the loop gain passes 1 and the output blows up to NaN.
- A `DelayNode` inside a cycle can't be shorter than one render quantum (128 frames ≈ 2.7 ms), so
  comb "strings" must stay below ~340 Hz (that's why wires/strings live in G2–A3 and bend up ≤ a fifth).
- `renderChoices(container)` must not change the container's class (it once replaced `.pop`, so the
  repo menu could never hide). `[hidden]` is forced to `display:none !important`.
- Don't reference `let/const` declared later in `index.html` from code that runs at load (TDZ).
- The adaptive resolution logic must not react to load hitches (`settle()` after loads/resizes);
  the user notices blur immediately.
- `recent.json` (`~/Library/Application Support/Code Room/`) is shared by the app and browser mode;
  browser tests change which repo the app opens next. Restore the user's repo (`SC4-Decomp/src`)
  after testing.

## About the user

Creative, iterates fast, often sends new requests mid-task (adapt the plan, don't drop earlier asks).
Cares a lot about look and *feel*: smoothness, crisp resolution, satisfying motion, "very good sound
design, not generic" — think like a senior sound designer. Wants things to just open from the Desktop.
