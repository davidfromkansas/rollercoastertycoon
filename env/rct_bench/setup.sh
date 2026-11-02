#!/usr/bin/env bash
# Runs as root inside the game image before the AI starts.
#   setup.sh PARK_FILE
# Opens the park, arms the bridge, pauses the game, and makes a clean folder for the AI
# (user `agent`, who cannot read the bridge's own folder, old runs or notes).
set -euo pipefail
PARK="$1"
B=/home/player/bridge
A=/home/agent/play
as_player() { runuser -u player -- env HOME=/home/player DISPLAY=:99 SDL_AUDIODRIVER=dummy RCT2_PATH=/opt/rct2 BRIDGE=$B "$@"; }

id agent >/dev/null 2>&1 || useradd -m -s /bin/bash agent
# the sandbox may have made /home/agent/play (the work folder) as root before the user existed
mkdir -p /home/agent && chown agent:agent /home/agent && chmod 750 /home/agent

pkill -9 -x openrct2 2>/dev/null || true
sleep 1
cp "$PARK" /home/player/park.sc6 && chown player:player /home/player/park.sc6
as_player bash /home/player/start-game.sh /home/player/park.sc6 >/dev/null

cd $B
as_player node cli.js arm >/dev/null
if [ "$(as_player node -p 'JSON.parse(require("child_process").execSync("node cli.js park")).result.paused')" != "true" ]; then
    echo '{"op":"action.execute","args":{"maxCost":0,"action":"pausetoggle","args":{}}}' > /tmp/pause.json
    chmod 644 /tmp/pause.json
    as_player node cli.js request /tmp/pause.json >/dev/null
fi

rm -rf "$A"; mkdir -p "$A"
cp cli.js bridge.config.json README.md AGENTS.md package.json "$A/"
cp -R examples generated wiki "$A/"
# The handbook is in the prompt (and saved as wiki/rct2-guide.md); the word-for-word manual is not given.
rm -f "$A/wiki/rct2-manual.md"
sed -i "/wiki\/rct2-manual.md/d" "$A/AGENTS.md"
cp park/wait.js "$A/"
mkdir -p "$A/notebook"
# The AI's helper talks to the same game; screenshots and saves are read from the game's folder.
node -e 'const f=process.argv[1],c=JSON.parse(require("fs").readFileSync(f));c.userDataPath=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(c,null,2))' "$A/bridge.config.json" "$B/user-data"
chown -R agent:agent "$A"
chmod 600 "$A/bridge.config.json"

# The AI may not read the game's folder (old runs, notes, other prompts), except new screenshots and saves.
as_player mkdir -p $B/user-data/screenshot $B/user-data/save
chmod -R o-rwx /home/player
chmod o+x /home/player $B $B/user-data
chmod o+rx $B/user-data/screenshot $B/user-data/save
(cd "$A" && runuser -u agent -- env HOME=/home/agent node cli.js arm >/dev/null)

# Video of the whole run: record the game's screen until finalize stops it.
# Kept in a folder only root can read, so the AI never sees it.
mkdir -p /root/rec && chmod 700 /root/rec
setsid nohup ffmpeg -nostdin -loglevel error -f x11grab -framerate 10 -video_size 1280x720 -i :99 \
    -c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p /root/rec/run.mkv >/root/rec/ffmpeg.log 2>&1 < /dev/null &
echo $! > /root/rec/pid
sleep 2
kill -0 "$(cat /root/rec/pid)" 2>/dev/null || { echo "screen recorder did not start:"; cat /root/rec/ffmpeg.log; }
# The scenario's objective window shows for the first seconds of the video, then closes so the park is visible.
# (Backspace = the game's own "close top window" key.) The AI's tools never see this window either way.
sleep 5
as_player xdotool mousemove 640 360 key BackSpace >/dev/null 2>&1 || true
echo ready
