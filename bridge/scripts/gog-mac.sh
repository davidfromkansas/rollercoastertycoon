#!/usr/bin/env bash
# Unpacks your GOG RollerCoaster Tycoon 2 installer (in ~/Downloads) into ./rct2 using innoextract.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v innoextract >/dev/null || brew install innoextract
EXE=$(ls ~/Downloads/setup_rollercoaster_tycoon_2_*.exe | head -1)
innoextract -s -d rct2 "$EXE"
test -f rct2/Data/g1.dat && echo "Game files ready in $(pwd)/rct2"
