#!/usr/bin/env bash
# Starts the game with the bridge plugin loaded.
#   start-game.sh PARK_FILE           -> with graphics on a pretend screen (needs RCT2 files in /opt/rct2)
#   start-game.sh --headless PARK_FILE -> no graphics (no RCT2 files needed)
set -euo pipefail
cd "$BRIDGE"
if [ "${1:-}" = "--headless" ]; then
    exec scripts/start.sh --headless --park "$2"
fi
PARK="$1"
[ -f "$RCT2_PATH/Data/g1.dat" ] || { echo "No RCT2 files in $RCT2_PATH" >&2; exit 1; }
pgrep -x Xvfb >/dev/null || { Xvfb :99 -screen 0 1280x720x24 >/tmp/xvfb.log 2>&1 & sleep 2; }
grep -q edge_scrolling user-data/config.ini || printf 'edge_scrolling = false\n' >> user-data/config.ini
mkdir -p logs
nohup runtime/v0.5.5/OpenRCT2/openrct2 "$(realpath "$PARK")" --user-data-path "$BRIDGE/user-data" \
    --rct2-data-path "$RCT2_PATH" >logs/openrct2.out.log 2>logs/openrct2.err.log &
for i in $(seq 1 60); do node cli.js hello >/dev/null 2>&1 && { echo "Game ready"; exit 0; }; sleep 1; done
echo "Game did not answer within 60 s; see $BRIDGE/logs" >&2; exit 1
