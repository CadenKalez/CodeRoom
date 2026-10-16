# Code Room

A walk through any codebase, inspired by the Code Room in *Wreck-It Ralph*: every module is a
glowing bubble (bigger = more functions), every reference a swaying strand to the module it uses.
A repository blooms open like a rose; god rays fall through the void and a light core glows where
the modules are densest (the camera drifts to follow it), swinging to whatever you select.

Three views, switched from the corner (or **1 / 2 / 3**, **V** to cycle). Every bubble flies along a
curve to its new place, and in the city it lands and swells into its building:

- **Cloud**: the force layout, modules floating where their references pull them.
- **Branches**: the folder tree drawn like Gource. Folders are bright nodes, files are buds in
  dandelion balls around them, and branches grow outward from the root.
- **City**: a 3D treemap. Folders are districts raised a step above their parent, modules are
  buildings (footprint = lines, height = functions) with code on their roofs, and references arch
  over the rooftops.

Now and then a storm passes far off: light flickers inside clouds behind the room (a bolt only
rarely), and real thunder rolls in seconds later, sooner and deeper as the storm comes closer.

## Open it

- **Mac app:** double-click `Code Room.app` (on your Desktop). Open a repository with
  **File › Open Repository…** (⌘O), the repo button in the header, or by dropping a folder on the
  window or the Dock icon.
- **Any browser:** `python3 server.py --open` (add `--src ~/code/repo` to jump straight in).

Rebuild and reinstall the app after editing anything here:

```bash
./build_app.sh            # installs to ~/Desktop; pass another folder to install elsewhere
```

Code Room only **reads** the folders you open. The single file it writes is the recent-repos list
(`~/Library/Application Support/Code Room/recent.json`); the app logs to `~/Library/Logs/Code Room.log`.
The radio downloads a few scene classics (keygen and cracktro tunes that may not be bundled) from
The Mod Archive the first time it picks them, into `~/Library/Caches/Code Room/modules/`.

## Languages

C / C++ / Objective-C, JavaScript / TypeScript, Python, Go, Rust, Java / Kotlin / Scala, C#, Swift,
Ruby, PHP, Lua, Dart. Files come from `git ls-files` when the folder is a git repo (so `.gitignore`
is respected), otherwise from a walk that skips `node_modules`, `build`, `vendor` and friends.

## Controls

| | |
|---|---|
| drag empty space / scroll | orbit / zoom |
| click a bubble | select it: its dependencies (cyan) and users (pink) light up |
| drag a bubble | pull its wires |
| **Tree** | highlight everything the selection depends on, transitively |
| **Size / Spread** | shrink bubbles / push them apart (double-click to reset) |
| **Update** (U) · **Auto** | rescan for changes · rescan every 4 s |
| **♪ Sound** · **Vol** | ambience and effects on/off · volume |
| **♫ Music** | melodies over the ambience (felt piano, violin, flute), far-off chip tunes and keygen music |
| **ϟ Storm** | let distant storms pass now and then (lightning in the clouds, thunder) |
| `1` `2` `3` · `V` | Cloud / Branches / City · next view |
| `/` · `O` · `F` · `Esc` | search · open repo · FPS readout · deselect |

## Files

- `server.py`: scanner + local web server (Python 3.9+, standard library only)
- `index.html`: the room (WebGL renderer, layout, strands physics, UI)
- `sound.js`: the sound: recorded instruments and places (`samples/`), played and processed live with
  Web Audio, plus ProTracker (.mod) and FastTracker 2 (.xm) players for the radio (`music/`)
- `app/`: the Mac app shell (`main.swift`), its `Info.plist` and the icon generator
