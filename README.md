# Code Room

A walk through any codebase, inspired by the Code Room in *Wreck-It Ralph*: every module is a
glowing bubble (bigger = more functions), every reference a swaying strand to the module it uses.
A repository blooms open like a rose; god rays fall through the void and a light core glows where
the modules are densest (the camera drifts to follow it), swinging to whatever you select.

## Open it

- **Mac app:** double-click `Code Room.app` (on your Desktop). Open a repository with
  **File › Open Repository…** (⌘O), the repo button in the header, or by dropping a folder on the
  window or the Dock icon.
- **Any browser:** `python3 server.py --open` (add `--src ~/code/repo` to jump straight in).

Rebuild and reinstall the app after editing anything here:

```bash
./build_app.sh            # installs to ~/Desktop; pass another folder to install elsewhere
```

## Build from GitHub

Needs the Xcode Command Line Tools once (`xcode-select --install`). Paste into Terminal:

```bash
cd ~/Downloads
git clone -b claude/admiring-bell-17x2fh https://github.com/CadenKalez/CodeRoom.git CodeRoom-git
cd CodeRoom-git
cp -R ~/Downloads/CodeRoom/samples ~/Downloads/CodeRoom/music .
osascript -e 'tell application id "local.coderoom.app" to quit'
bash build_app.sh
open ~/Desktop/"Code Room.app"
```

- The sample pack (`samples/`) and music (`music/`) aren't in the repo; the `cp` line brings them in
  from an existing local copy. Without them the app still builds, with synthesized sound only.
- To update later: `cd ~/Downloads/CodeRoom-git && git pull`, then the last three lines again.
- Paste the lines without `#` comments: zsh doesn't treat them as comments when pasted, and an
  apostrophe in one leaves the shell waiting at `quote>` (press Control + C to get out).

Code Room only **reads** the folders you open. The single file it writes is the recent-repos list
(`~/Library/Application Support/Code Room/recent.json`); the app logs to `~/Library/Logs/Code Room.log`.

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
| **♫ Music** | generative music over the ambience (felt piano, distant chip tunes) on/off |
| `/` · `O` · `F` · `Esc` | search · open repo · FPS readout · deselect |

## Files

- `server.py`: scanner + local web server (Python 3.9+, standard library only)
- `index.html`: the room (WebGL renderer, layout, strands physics, UI)
- `sound.js`: procedural sound, all synthesized with Web Audio (no samples)
- `app/`: the Mac app shell (`main.swift`), its `Info.plist` and the icon generator
