#!/usr/bin/env bash
# Wraps a pkg-built bridge binary in a double-clickable macOS app and zips it.
#   scripts/build-mac-app.sh dist/wiz-bridge-arm64 AppleSilicon
# Produces dist/WiZ-Bridge-macOS-AppleSilicon.zip
set -euo pipefail
BIN="$1"; LABEL="$2"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
APP="$ROOT/dist/WiZ Bridge.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cp "$BIN" "$APP/Contents/MacOS/wiz-bridge"
chmod +x "$APP/Contents/MacOS/wiz-bridge"
cat > "$APP/Contents/MacOS/launcher" <<'SH'
#!/bin/bash
# Starts the bridge in the background. It opens the web app in your browser by itself.
DIR="$(cd "$(dirname "$0")" && pwd)"
xattr -d com.apple.quarantine "$DIR/wiz-bridge" 2>/dev/null || true
exec "$DIR/wiz-bridge" "$@"
SH
chmod +x "$APP/Contents/MacOS/launcher"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>WiZ Bridge</string>
  <key>CFBundleDisplayName</key><string>WiZ Bridge</string>
  <key>CFBundleIdentifier</key><string>io.github.realanshuman.wiz-bridge</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>MIT License</string>
  <key>NSLocalNetworkUsageDescription</key><string>WiZ Bridge finds and controls the WiZ bulbs on your Wi-Fi.</string>
</dict></plist>
PLIST

# Icon: render the PNG, build an iconset, convert to icns.
node "$ROOT/scripts/make-icon.js" 1024 "$ROOT/build/icon-1024.png" >/dev/null
ICONSET="$ROOT/build/AppIcon.iconset"; rm -rf "$ICONSET"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$ROOT/build/icon-1024.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s*2)); sips -z $d $d "$ROOT/build/icon-1024.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

# Ad-hoc signature (no developer account needed; keeps Apple silicon from refusing to run it).
codesign --force --deep --sign - "$APP" 2>/dev/null || true

OUT="$ROOT/dist/WiZ-Bridge-macOS-$LABEL.zip"; rm -f "$OUT"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT"
echo "built $OUT"
