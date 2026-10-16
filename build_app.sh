#!/bin/bash
# Builds "Code Room.app" and installs it (default: on your Desktop).
#
#     ./build_app.sh                    # build + install to ~/Desktop
#     ./build_app.sh ~/Applications     # build + install somewhere else
#
# Needs the Xcode Command Line Tools (swiftc, iconutil) and Python 3 at runtime.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BUILD="$HERE/build"
APP="$BUILD/Code Room.app"
DEST="${1:-$HOME/Desktop}"
BUNDLE_ID="local.coderoom.app"

echo "→ building $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

swiftc -O -swift-version 5 -o "$APP/Contents/MacOS/CodeRoom" "$HERE/app/main.swift" -framework Cocoa -framework WebKit
cp "$HERE/app/Info.plist" "$APP/Contents/Info.plist"
cp "$HERE/server.py" "$HERE/index.html" "$HERE/sound.js" "$HERE/scanner.js" "$APP/Contents/Resources/"
cp -R "$HERE/samples" "$APP/Contents/Resources/samples"   # the CC0 sample pack
cp -R "$HERE/music" "$APP/Contents/Resources/music"       # openly licensed tracker / chiptune music

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
