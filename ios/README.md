# Code Room for iPhone

The same room as the Mac app, laid out for the iPhone 11 (414 × 896 points) and other phones in portrait:
a compact top bar (search and ⋯ for the controls), the folders and the view switcher along the bottom
by the thumb, and a bottom sheet for a module's details. It runs on iOS 15 or later.

There is no Python on a phone, so the page scans repositories itself with `scanner.js`, a JavaScript
port of `server.py`'s scanner that produces the same graph (checked on several repos). On the phone
it opens:

- **a folder from the Files app** (iCloud Drive, On My iPhone, or a Git app such as Working Copy). The
  app reads it with a bookmark, so **Update** re-reads it.
- **a public GitHub repository**: type `owner/name` or paste its URL. Files come straight from GitHub,
  and Update only fetches what changed.
- **Code Room's own code**, bundled, for trying it offline.

Everything else is the same as on the Mac: the three views and the morph, the storm and lightning
strikes, the music, melodies and aria, the debug menu (the bug), and the robots. Sound plays with the
ringer switch on silent and mixes with other audio.

## Build and run

You need **Xcode** from the App Store; the Command Line Tools alone can't build iOS apps.

1. Open `ios/CodeRoom.xcodeproj`.
2. Choose the **iPhone 11** simulator, or your iPhone, and press ⌘R. For a real phone, pick your Apple
   ID team under Signing & Capabilities first.

The build copies `index.html`, `sound.js`, `scanner.js`, `samples/` and `music/` from the repository
into the app, so edits to the room show up on the next build. After changing `project.yml`, run
`xcodegen` in `ios/` to regenerate the project (`brew install xcodegen`).

## Files

- `CodeRoom/CodeRoomApp.swift`: the app, and its audio session.
- `CodeRoom/RoomView.swift`: the web view, and the Files folder picker.
- `CodeRoom/RoomScheme.swift`: serves `coderoom://app/…` (the bundled room, picked folders, and the Mod
  Archive classics, fetched once into the app's cache).
- `CodeRoom/RepoStore.swift`: remembers and reads picked folders. It reads only; it never writes.
