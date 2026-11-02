#!/usr/bin/env bash
# One-time setup on a Mac, or on a Linux cloud machine (x86-64, for headless runs). Safe to run again.
#   1. checks Node.js 20+, git and curl
#   2. downloads the pinned OpenRCT2 source (only used to read action and track names)
#   3. builds the plugin with a fresh private token, and runs the tests
#   4. downloads the official OpenRCT2 v0.5.5 app for this system and checks its checksum
#   5. installs the plugin into a separate game profile in user-data/
# It does not launch the game, and it does not touch any other OpenRCT2 install or your RCT2 files.
set -euo pipefail

RELEASE="v0.5.5"
COMMIT="8694e3483690323b6a75fa7264b6c58116f51f31"
RELEASE_URL="https://github.com/OpenRCT2/OpenRCT2/releases/download/${RELEASE}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nSetup stopped: %s\n' "$*" >&2; exit 1; }

say "Checking tools"
case "$(uname -s)" in
    Darwin)
        ASSET="OpenRCT2-${RELEASE}-macos-universal.zip"
        APP="runtime/${RELEASE}/OpenRCT2.app/Contents/MacOS/OpenRCT2" ;;
    Linux)
        [ "$(uname -m)" = "x86_64" ] || die "on Linux only x86-64 is supported"
        ASSET="OpenRCT2-${RELEASE}-Linux-noble-x86_64.tar.gz"
        APP="runtime/${RELEASE}/OpenRCT2/openrct2-cli" ;;
    *) die "this script supports macOS and Linux" ;;
esac
command -v node >/dev/null || die "Node.js 20 or newer is needed (https://nodejs.org)"
command -v git >/dev/null || die "git is needed (run: xcode-select --install)"
command -v curl >/dev/null || die "curl is needed"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js 20 or newer is needed (found $(node --version))"

say "Getting OpenRCT2 ${RELEASE} source"
if [ ! -d vendor/OpenRCT2 ]; then
    git clone --depth 1 --branch "$RELEASE" https://github.com/OpenRCT2/OpenRCT2.git vendor/OpenRCT2
fi
[ "$(git -C vendor/OpenRCT2 rev-parse HEAD)" = "$COMMIT" ] || die "vendor/OpenRCT2 is not at the pinned commit. Move it aside and run again."
[ -z "$(git -C vendor/OpenRCT2 status --porcelain)" ] || die "vendor/OpenRCT2 has local changes. Move it aside and run again."

say "Building the plugin"
node scripts/build.js

say "Running tests"
node --test test/*.test.js >/dev/null || die "tests failed (run: npm test to see why)"
echo "All tests passed"

say "Getting the OpenRCT2 ${RELEASE} app ($ASSET)"
mkdir -p runtime/downloads
SUMS="runtime/downloads/sha256sums.txt"
ZIP="runtime/downloads/${ASSET}"
curl -fsSL "${RELEASE_URL}/OpenRCT2-${RELEASE}-sha256sums.txt" -o "$SUMS"
[ -f "$ZIP" ] || curl -fL --progress-bar "${RELEASE_URL}/${ASSET}" -o "$ZIP"
EXPECTED="$(grep -E "[ /]${ASSET}\$" "$SUMS" | awk '{print $1}')"
[ "$(printf '%s\n' "$EXPECTED" | grep -c .)" = "1" ] || die "checksum for ${ASSET} not found in the release's checksum list"
if command -v shasum >/dev/null; then ACTUAL="$(shasum -a 256 "$ZIP" | awk '{print $1}')"; else ACTUAL="$(sha256sum "$ZIP" | awk '{print $1}')"; fi
[ "$EXPECTED" = "$ACTUAL" ] || die "the download does not match its checksum. Delete $ZIP and run again."
echo "Checksum OK"
if [ ! -x "$APP" ]; then
    mkdir -p "runtime/${RELEASE}"
    case "$ASSET" in
        *.zip) ditto -x -k "$ZIP" "runtime/${RELEASE}" ;;
        *.tar.gz) tar -xzf "$ZIP" -C "runtime/${RELEASE}" ;;
    esac
fi
[ -x "$APP" ] || die "OpenRCT2 app missing after unpacking"

say "Installing the plugin into the bridge's own game profile"
mkdir -p user-data/plugin user-data/save user-data/screenshot
if [ ! -f user-data/config.ini ]; then
    printf '[general]\nlanguage = en-GB\nplay_intro = false\n' > user-data/config.ini
fi
DEST="user-data/plugin/agent-bridge.js"
if [ -f "$DEST" ] && ! cmp -s "$DEST" dist/agent-bridge.js; then
    mkdir -p runtime/plugin-backups
    cp "$DEST" "runtime/plugin-backups/agent-bridge-$(date +%Y%m%d-%H%M%S).js"
fi
cp dist/agent-bridge.js "$DEST"
chmod 600 "$DEST"
cmp -s "$DEST" dist/agent-bridge.js || die "installed plugin does not match the build"

say "Done"
echo "Next: scripts/start.sh --rct2-path \"/path/to/your/RCT2 folder\"   (the folder that contains Data/g1.dat)"
echo "  or: scripts/start.sh --headless --park \"/path/to/a park file\"     (no window, no RCT2 files needed)"
