#!/usr/bin/env bash
# OpenRCT2 ships a few community-made parks for its title screen. This copies one out to use for tests.
# Usage: scripts/sample-park.sh            (list them)
#        scripts/sample-park.sh "Solar Park"  (copy it to parks/)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
SEQ="$(find runtime/v0.5.5 -name openrct2.parkseq -print -quit 2>/dev/null || true)"
[ -n "$SEQ" ] || { echo "Run scripts/setup.sh first" >&2; exit 1; }
if [ $# -eq 0 ]; then
    unzip -Z1 "$SEQ" | grep '\.park$' | sed 's/\.park$//'
    exit 0
fi
NAME="$(unzip -Z1 "$SEQ" | grep '\.park$' | grep -F "$1" | head -1)"
[ -n "$NAME" ] || { echo "No sample park matching \"$1\"" >&2; exit 1; }
mkdir -p parks
unzip -o -q -j "$SEQ" "$NAME" -d parks
echo "parks/$NAME"
