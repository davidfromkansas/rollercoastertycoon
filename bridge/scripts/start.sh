#!/usr/bin/env bash
# Opens the bridge's own copy of OpenRCT2 with the plugin loaded.
# Usage: scripts/start.sh --rct2-path "/path/to/RCT2" [--park "/path/to/a park or a COPY of a save"]
#        scripts/start.sh --headless --park "/path/to/a park"   (no window; RCT2 files optional)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [ "$(uname -s)" = "Darwin" ]; then
    APP="runtime/v0.5.5/OpenRCT2.app/Contents/MacOS/OpenRCT2"
else
    APP="runtime/v0.5.5/OpenRCT2/openrct2-cli"
fi

die() { printf 'Not started: %s\n' "$*" >&2; exit 1; }

RCT2_PATH=""
PARK=""
HEADLESS=0
while [ $# -gt 0 ]; do
    case "$1" in
        --rct2-path) RCT2_PATH="${2:-}"; shift 2 ;;
        --park) PARK="${2:-}"; shift 2 ;;
        --headless) HEADLESS=1; shift ;;
        -h|--help) sed -n '2,4p' "$0"; exit 0 ;;
        *) die "unknown option $1" ;;
    esac
done

[ -x "$APP" ] || die "run scripts/setup.sh first"
[ -f bridge.config.json ] || die "run scripts/setup.sh first"
[ "$HEADLESS" = 0 ] || [ -n "$PARK" ] || die "--headless needs --park"
if [ "$HEADLESS" = 0 ] || [ -n "$RCT2_PATH" ]; then
    [ -n "$RCT2_PATH" ] || die "give --rct2-path, the folder that contains Data/g1.dat"
    [ -f "$RCT2_PATH/Data/g1.dat" ] || die "no Data/g1.dat inside \"$RCT2_PATH\". Point to the RCT2 folder itself, not the Data folder."
fi

PORT="$(node -p 'require("./bridge.config.json").port')"
if node -e 'const s=require("net").connect(+process.argv[1],"127.0.0.1",()=>process.exit(0));s.on("error",()=>process.exit(1))' "$PORT"; then
    die "the bridge game is already running. Switch to its window."
fi

ARGS=()
if [ -n "$PARK" ]; then
    [ -f "$PARK" ] || die "park file not found: $PARK"
    ARGS+=("$(cd "$(dirname "$PARK")" && pwd)/$(basename "$PARK")")
fi
ARGS+=(--user-data-path "$ROOT/user-data")
[ -z "$RCT2_PATH" ] || ARGS+=(--rct2-data-path "$RCT2_PATH")
[ "$HEADLESS" = 0 ] || ARGS+=(--headless)

mkdir -p logs user-data/save user-data/screenshot
STAMP="$(date +%Y%m%d-%H%M%S)"
nohup "$APP" "${ARGS[@]}" >"logs/openrct2-$STAMP.out.log" 2>"logs/openrct2-$STAMP.err.log" &
echo "OpenRCT2 started (process $!). Logs: logs/openrct2-$STAMP.*.log"
echo "Check the bridge with: node cli.js hello"
[ "$HEADLESS" = 1 ] || echo "(open or start a park in the game window first)"
