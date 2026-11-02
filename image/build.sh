#!/usr/bin/env bash
# Builds the game image locally.
#   build.sh BRIDGE_FOLDER [RCT2_FOLDER] [TAG]
# With CONTEXT_ONLY=DIR it only fills DIR (for `prime images push --context DIR`) and skips docker.
# Without RCT2_FOLDER you get a headless-only test image (safe to share). With it, the image is PRIVATE.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BRIDGE="${1:?give the bridge folder}"; RCT2="${2:-}"; TAG="${3:-rct-bench:dev}"
if [ -n "${CONTEXT_ONLY:-}" ]; then CTX="$CONTEXT_ONLY"; mkdir -p "$CTX"; else CTX="$(mktemp -d)"; trap 'rm -rf "$CTX"' EXIT; fi
cp "$HERE/Dockerfile" "$HERE/start-game.sh" "$CTX/"
mkdir -p "$CTX/bridge" "$CTX/rct2" "$CTX/certs"
# EXTRA_CA: optional file of extra trusted certificates (for building behind a proxy); split one per file
[ -z "${EXTRA_CA:-}" ] || awk -v d="$CTX/certs" '/BEGIN CERT/{n++} n{print > (d "/extra-" n ".crt")}' "$EXTRA_CA"
tar -C "$BRIDGE" --exclude=runtime --exclude=vendor --exclude=user-data --exclude=dist --exclude=logs \
    --exclude=bridge.config.json --exclude=recordings --exclude=node_modules --exclude=./rct2 --exclude=./parks --exclude=.DS_Store -cf - . | tar -C "$CTX/bridge" -xf -
if [ -n "$RCT2" ]; then
    [ -f "$RCT2/Data/g1.dat" ] || { echo "No Data/g1.dat in $RCT2" >&2; exit 1; }
    cp -a "$RCT2/." "$CTX/rct2/"
fi
[ -z "${CONTEXT_ONLY:-}" ] || { echo "Context ready in $CTX"; exit 0; }
docker build ${BASE:+--build-arg BASE="$BASE"} -t "$TAG" "$CTX"
echo "Built $TAG"
