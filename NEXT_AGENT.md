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

## Done (2026-10-16, later)

- **Views**: `setMode()` in `index.html` (Cloud / Branches / City, corner switcher `#views`, keys 1-3/V).
  `buildDirs()` + `layoutTree()` (balloon tree, Gource-like) + `layoutCity()` (squarified treemap) put
  each node's place in `n.lt` / `n.lc`; `updateWorld()` flies nodes between views (`morph`, per-node
  delay `n.md`, curved path), `n.mb` is how much a node is a building. Buildings and district platforms
  are box faces in the sprite batch (`quad4`, shader modes 7-9, needs `OES_standard_derivatives`).
  Strands arch upward over the city (`GRAV` follows `modeW.city`).
- **Storm**: `stormStep()` / `lightning()` in `index.html` (phases calm → approach → peak → recede);
  the lit cloud is drawn into the atmosphere emit target's alpha (`u_flash`) and scattered by
  `atmScatterProg`; bolts are rare (`makeBolt`). `CR_debug.storm(lv)`, `CR_debug.flash(lv, hold, [x, y])`
  with `?fps`. Sound: `SFX.storm(level)` / `SFX.thunder({delay, dist, power, pan})` in `sound.js`;
  thunder takes are decoded lazily (`bank.lazy.thunder`, at most 5 in memory).
- **Melodies**: `compose()` / `playPhrase()` / `melody()` in `sound.js` (piano, Iowa violin + flute).
  `CodeRoomSound.phrase("violin")` plays one now.
- **Keygen radio**: `parseXM()` / `xmPlayer()` (FastTracker 2). Bundled PD Drozerix tracks; scene
  classics are `"remote"` playlist entries fetched by `server.py` (`/music/remote/<id>`) into the cache.

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
- In WebKit a GPU-backed 2D canvas used as a WebGL texture source is read back from the GPU process
  synchronously, waiting for the frame in flight (~4 ms a call). Canvases that feed `texSubImage2D`
  are made with `{ willReadFrequently: true }` (CPU-backed, ~2 ms).
- The code atlases hold 144 + 64 slots, fewer than the bubbles that want code on big repos.
  `rankCode()` gives slots to the biggest bubbles on screen, and `codeSlot()` never takes a slot from a
  bubble drawn in the last frame. The plain LRU used to evict bubbles still on screen and redraw 3
  slots every frame (9–12 ms of JS in WebKit, Cloud only).
- Strands are instanced (`ANGLE_instanced_arrays`): `STRAND_VS` rebuilds on the GPU the same curve
  `drawStrandsCPU()` draws (the fallback). Change both together; they render within 1 level per pixel.
  After an instanced draw, reset `vertexAttribDivisorANGLE(loc, 0)`: WebGL1 has no VAOs, so a leftover
  divisor breaks the next batch that uses that attribute slot.
- `recent.json` (`~/Library/Application Support/Code Room/`) is shared by the app and browser mode;
  browser tests change which repo the app opens next. Restore the user's repo (`SC4-Decomp/src`)
  after testing.

## About the user

Creative, iterates fast, often sends new requests mid-task (adapt the plan, don't drop earlier asks).
Cares a lot about look and *feel*: smoothness, crisp resolution, satisfying motion, "very good sound
design, not generic" — think like a senior sound designer. Wants things to just open from the Desktop.
