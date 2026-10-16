#!/bin/bash
# Builds "Code Room.app" and installs it (default: on your Desktop).
#
#     ./build_app.sh                    # build + install to ~/Desktop
#     ./build_app.sh ~/Applications     # build + install somewhere else
#
# Needs the Xcode Command Line Tools (swiftc, iconutil) and Python 3 at runtime.
# Release builds (see .github/workflows/release.yml) also set:
#     UNIVERSAL=1      one app for Apple silicon and Intel Macs
#     VERSION=1.2.0    stamped into the app's Info.plist
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BUILD="$HERE/build"
APP="$BUILD/Code Room.app"
DEST="${1:-$HOME/Desktop}"
BUNDLE_ID="local.coderoom.app"
UNIVERSAL="${UNIVERSAL:-0}"
VERSION="${VERSION:-}"

echo "→ building $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

if [ "$UNIVERSAL" = 1 ]; then
  for arch in arm64 x86_64; do
    swiftc -O -swift-version 5 -target "$arch-apple-macos13" -o "$BUILD/CodeRoom-$arch" "$HERE/app/main.swift" -framework Cocoa -framework WebKit
  done
  lipo -create -output "$APP/Contents/MacOS/CodeRoom" "$BUILD/CodeRoom-arm64" "$BUILD/CodeRoom-x86_64"
  rm -f "$BUILD/CodeRoom-arm64" "$BUILD/CodeRoom-x86_64"
else
  swiftc -O -swift-version 5 -o "$APP/Contents/MacOS/CodeRoom" "$HERE/app/main.swift" -framework Cocoa -framework WebKit
fi
cp "$HERE/app/Info.plist" "$APP/Contents/Info.plist"
if [ -n "$VERSION" ]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" -c "Set :CFBundleVersion $VERSION" "$APP/Contents/Info.plist"
fi
cp "$HERE/server.py" "$HERE/index.html" "$HERE/sound.js" "$APP/Contents/Resources/"
# the CC0 sample pack and the openly licensed tracker / chiptune music; without them the room
# falls back to pure synthesis and the radio stays silent, so a missing folder is a warning, not an error
for d in samples music; do
  if [ -d "$HERE/$d" ]; then cp -R "$HERE/$d" "$APP/Contents/Resources/$d"
  else echo "  ! $d/ not found — building without it"; fi
done

echo "→ drawing the icon"
swiftc -O -o "$BUILD/make_icon" "$HERE/app/make_icon.swift" -framework Cocoa
"$BUILD/make_icon" "$BUILD/icon_1024.png"
ICONSET="$BUILD/AppIcon.iconset"
rm -rf "$ICONSET"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$BUILD/icon_1024.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$BUILD/icon_1024.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || echo "  (ad-hoc signing skipped)"

# install — only ever replaces a previous Code Room build
TARGET="$DEST/Code Room.app"
if [ -e "$TARGET" ]; then
  existing="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$TARGET/Contents/Info.plist" 2>/dev/null || true)"
  if [ "$existing" != "$BUNDLE_ID" ]; then
    echo "✗ $TARGET exists and isn't a Code Room build — leaving it alone." >&2
    exit 1
  fi
  rm -rf "$TARGET"
fi
mkdir -p "$DEST"
cp -R "$APP" "$TARGET"
touch "$TARGET"
echo "✓ installed: $TARGET"
