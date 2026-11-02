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

# Newer bridge files than the image has (sent by the benchmark as /tmp/rct-bridge-update.tgz): unpack, rebuild the plugin, install it.
if [ -f /tmp/rct-bridge-update.tgz ]; then
    chmod 644 /tmp/rct-bridge-update.tgz
    (cd $B && as_player tar -xzf /tmp/rct-bridge-update.tgz && as_player node scripts/build.js >/dev/null \
        && as_player cp dist/agent-bridge.js user-data/plugin/agent-bridge.js) || { echo "bridge update failed"; exit 1; }
fi
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
# Layout: the game (1280x720) on the left, with its bottom-left (money, guests, rating) and bottom-right (date, weather)
# panels shown at double size; the AI's live log on a 640-pixel panel to the right (panel.js keeps it up to date).
mkdir -p /root/rec && chmod 700 /root/rec
SCENARIO_NAME="$(basename "$PARK" | sed 's/\.[^.]*$//')"
printf 'The AI playing %s\n' "$SCENARIO_NAME" > /root/rec/header.txt
printf ' \n' > /root/rec/header-goal.txt
printf 'Waiting for the AI to start...\n' > /root/rec/panel.txt
# Header details (scenario and goal), sent by the benchmark.
[ -f /tmp/rct-panel-info.json ] && mv /tmp/rct-panel-info.json /root/rec/info.json
if [ -f /tmp/rct-panel.js ]; then
    mv /tmp/rct-panel.js /root/rec/panel.js && chmod 700 /root/rec/panel.js
    setsid nohup node /root/rec/panel.js "$A" /root/rec/panel.txt /root/rec/header.txt /root/rec/info.json \
        >/root/rec/panel.log 2>&1 < /dev/null &
    echo $! > /root/rec/panel.pid
fi
MONO=/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf
SANS=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf
LAYOUT="[0:v]split=3[game][l][r];\
[l]crop=142:32:0:688,scale=284:64:flags=neighbor[left];\
[r]crop=142:32:1138:688,scale=284:64:flags=neighbor[right];\
[game][left]overlay=0:656[g1];[g1][right]overlay=996:656[g2];\
[g2]pad=1920:720:0:0:color=0x15181d,\
drawbox=x=1280:y=0:w=640:h=86:color=0x24313f:t=fill,\
drawtext=fontfile=$SANS:textfile=/root/rec/header.txt:reload=1:expansion=none:fontcolor=white:fontsize=19:x=1296:y=12,\
drawtext=fontfile=$SANS:textfile=/root/rec/header-goal.txt:reload=1:expansion=none:fontcolor=0xc9d6e3:fontsize=13:line_spacing=4:x=1296:y=42,\
drawtext=fontfile=$MONO:textfile=/root/rec/panel.txt:reload=1:expansion=none:fontcolor=0xe8e8e8:fontsize=14:line_spacing=4:x=1296:y=98[out]"
setsid nohup ffmpeg -nostdin -loglevel error -f x11grab -framerate 10 -video_size 1280x720 -i :99 \
    -filter_complex "$LAYOUT" -map '[out]' \
    -c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p -y /root/rec/run.mkv >/root/rec/ffmpeg.log 2>&1 < /dev/null &
echo $! > /root/rec/pid
sleep 2
kill -0 "$(cat /root/rec/pid)" 2>/dev/null || { echo "screen recorder did not start:"; cat /root/rec/ffmpeg.log; }
# The scenario's objective window shows for the first seconds of the video, then closes so the park is visible.
# (Backspace = the game's own "close top window" key.) The AI's tools never see this window either way.
sleep 5
as_player xdotool mousemove 640 360 key BackSpace >/dev/null 2>&1 || true
echo ready
