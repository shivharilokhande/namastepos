#!/usr/bin/env bash
#
# NamastePOS first-time setup — scaffolds the per-machine Flutter files
# (gradle wrapper, local.properties, Xcode project, GeneratedPluginRegistrant)
# without touching the source under lib/.
#
# Usage:
#   chmod +x setup.sh && ./setup.sh

set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

echo "▶ NamastePOS setup — $(pwd)"

# --- 1. Verify Flutter is installed ---
if ! command -v flutter >/dev/null 2>&1; then
  echo "❌ Flutter not found in PATH."
  echo "   Install it from https://docs.flutter.dev/get-started/install"
  exit 1
fi
echo "✓ Flutter detected: $(flutter --version | head -1)"

# --- 2. Back up files we don't want flutter create to touch ---
BACKUP_DIR=".setup-backup-$$"
mkdir -p "$BACKUP_DIR"
cp pubspec.yaml "$BACKUP_DIR/" 2>/dev/null || true
cp -r lib "$BACKUP_DIR/" 2>/dev/null || true
cp analysis_options.yaml "$BACKUP_DIR/" 2>/dev/null || true
cp android/app/src/main/AndroidManifest.xml "$BACKUP_DIR/AndroidManifest.xml" 2>/dev/null || true
cp android/app/build.gradle "$BACKUP_DIR/app-build.gradle" 2>/dev/null || true
cp ios/Runner/Info.plist "$BACKUP_DIR/Info.plist" 2>/dev/null || true
cp ios/Podfile "$BACKUP_DIR/Podfile" 2>/dev/null || true

# --- 3. Run flutter create (auto-decline overwrites) ---
echo "▶ Scaffolding missing Flutter files via 'flutter create .'…"
yes n | flutter create . --org in.namastepos --platforms=android,ios >/dev/null || true

# --- 4. Restore our customised files ---
echo "▶ Restoring customised files…"
cp "$BACKUP_DIR/pubspec.yaml" pubspec.yaml 2>/dev/null || true
cp -r "$BACKUP_DIR/lib"/* lib/ 2>/dev/null || true
cp "$BACKUP_DIR/analysis_options.yaml" analysis_options.yaml 2>/dev/null || true
cp "$BACKUP_DIR/AndroidManifest.xml" android/app/src/main/AndroidManifest.xml 2>/dev/null || true
cp "$BACKUP_DIR/app-build.gradle" android/app/build.gradle 2>/dev/null || true
cp "$BACKUP_DIR/Info.plist" ios/Runner/Info.plist 2>/dev/null || true
cp "$BACKUP_DIR/Podfile" ios/Podfile 2>/dev/null || true
rm -rf "$BACKUP_DIR"

# --- 5. flutter pub get ---
echo "▶ Resolving Dart packages…"
flutter pub get

# --- 6. iOS pod install (best-effort on macOS) ---
if [[ "$(uname)" == "Darwin" ]]; then
  if command -v pod >/dev/null 2>&1; then
    echo "▶ Installing CocoaPods for iOS…"
    (cd ios && pod install) || echo "⚠ pod install failed — run manually if you need iOS."
  else
    echo "ℹ CocoaPods not found. Install with: sudo gem install cocoapods"
  fi
fi

echo ""
echo "✅ Setup complete."
echo ""
echo "Next:"
echo "  flutter run                         # any connected device"
echo "  flutter run -d chrome               # web preview (limited — no BT printer)"
echo ""
