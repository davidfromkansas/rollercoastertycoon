#!/usr/bin/env bash
# Runs a park-growth challenge on a Mac: a fresh park with a guest goal, a live AI player (Claude Code), then a summary.
# Watch it in the game window. Each run gets its own folder in park/runs/, and the player works in a clean temporary folder.
# Usage: park/run-mac.sh --rct2-path "/path/to/RCT2 folder" --goal-guests 5000 [--years 4] [--minutes 60] [--model claude-opus-5-5]
#   without --years: reach the guests at any time, keeping the rating at 700+ (the game's "guests and rating" goal)
#   with --years Y:  have the guests at the end of October, year Y, with a rating of 600+ (the game's "guests by date" goal)
set -u
cd "$(dirname "$0")/.."
B="$PWD"; P="$B/park"
RCT2=""; MIN=60; MODEL="claude-opus-5-5"; GUESTS=""; YEARS=""; CASH_FLOOR=1000
while [ $# -gt 0 ]; do
    case "$1" in
        --rct2-path) RCT2="$2"; shift 2 ;;
        --minutes) MIN="$2"; shift 2 ;;
        --model) MODEL="$2"; shift 2 ;;
        --goal-guests) GUESTS="$2"; shift 2 ;;
        --years) YEARS="$2"; shift 2 ;;
        --cash-floor) CASH_FLOOR="$2"; shift 2 ;;
        *) echo "unknown option $1" >&2; exit 1 ;;
    esac
done
[ -f "$RCT2/Data/g1.dat" ] || { echo "Give --rct2-path, the folder that contains Data/g1.dat" >&2; exit 1; }
[[ "$GUESTS" =~ ^[0-9]+$ ]] && [ "$GUESTS" -ge 1 ] && [ "$GUESTS" -le 50000 ] || { echo "Give --goal-guests, 1 to 50000 (the game's limit)" >&2; exit 1; }
[ -z "$YEARS" ] || [[ "$YEARS" =~ ^[0-9]+$ ]] || { echo "--years must be a whole number" >&2; exit 1; }
SCEN=$(find "$RCT2" -iname "Build your own Six Flags Park.SC6" -print -quit)
[ -n "$SCEN" ] || { echo "Scenario 'Build your own Six Flags Park' not found under $RCT2" >&2; exit 1; }
command -v claude >/dev/null || { echo "Claude Code (claude) is not installed" >&2; exit 1; }

RUN=$(date +%Y%m%d-%H%M%S); O="$P/runs/$RUN"
mkdir -p "$O"
A=$(mktemp -d "${TMPDIR:-/tmp}/park-agent-$RUN-XXXX")
echo "$A" > "$O/agent-folder.txt"
now() { node -e 'console.log(Date.now())'; }

echo "==> Starting a fresh park"
for p in $(pgrep -x OpenRCT2); do kill "$p"; done
sleep 3
for p in $(pgrep -x OpenRCT2); do kill -9 "$p"; done  # a game waiting on a dialog ignores the normal quit
sleep 1
cp "$SCEN" "$O/park.sc6"
scripts/start.sh --rct2-path "$RCT2" --park "$O/park.sc6" || exit 1
for i in $(seq 1 60); do node cli.js hello >/dev/null 2>&1 && break; sleep 1; done
node cli.js hello >/dev/null 2>&1 || { echo "The game did not answer" >&2; exit 1; }

# The goal is set before arming: the bridge allows it once per park and never once armed, so the player cannot change it.
if [ -n "$YEARS" ]; then
    GOAL="{\"type\":\"guestsBy\",\"guests\":$GUESTS,\"year\":$YEARS}"
    GOAL_TEXT="Have at least $GUESTS guests in the park at the end of October, year $YEARS, with a park rating of at least 600. The game checks this once, on that date (a game year runs March to October)."
else
    GOAL="{\"type\":\"guestsAndRating\",\"guests\":$GUESTS}"
    GOAL_TEXT="Get $GUESTS guests in the park at the same time, as early as you can. Keep the park rating at 700 or higher: if it stays below 700 for four weeks the goal fails and the game closes the park. There is no deadline."
fi
node cli.js objective.set "$GOAL" > "$O/goal.json" || { echo "Could not set the goal" >&2; cat "$O/goal.json"; exit 1; }
node cli.js arm >/dev/null
PAUSED=$(node -p 'JSON.parse(require("child_process").execSync("node cli.js park")).result.paused')
if [ "$PAUSED" != "true" ]; then
    echo '{"op":"action.execute","args":{"maxCost":0,"action":"pausetoggle","args":{}}}' > "$O/pause.json"
    node cli.js request "$O/pause.json" >/dev/null
fi
node cli.js park > "$O/start.json"

# The player's folder holds only the helper, its docs and the wiki. A new folder each run, so no notes carry over.
cp cli.js bridge.config.json README.md AGENTS.md package.json "$A/"
cp -R examples generated wiki "$A/"
cp "$P/wait.js" "$A/"
(cd "$A" && node cli.js arm >/dev/null)  # same session; gives the player's helper its session record
node -e '
const [task, out, goal, min, floor] = process.argv.slice(1);
let s = require("fs").readFileSync(task, "utf8");
s = s.replace("{GOAL_TEXT}", goal).replace("{MINUTES}", min).replace("{CASH_FLOOR}", "£" + Number(floor).toLocaleString("en-GB"));
require("fs").writeFileSync(out, s);' "$P/TASK.md" "$A/TASK.md" "$GOAL_TEXT" "$MIN" "$CASH_FLOOR"
cp "$A/TASK.md" "$O/TASK.md"

node "$P/yearsave.js" "$O" > "$O/yearsave.log" 2>&1 &
SAVER=$!

echo "==> AI player ($MODEL) has $MIN minutes. Goal: $GOAL_TEXT"
echo "    Watch the game window. Everything is saved in $O"
now > "$O/record-start.txt"
cd "$A"
# perl's alarm ends the player if it runs past the time limit (macOS has no `timeout`).
# The player may run node (its helper and its own scripts) but cannot read ~/rct-play or ~/.claude (Read rules cover Glob and Grep too).
perl -e 'alarm shift; exec @ARGV' $((MIN*60+120)) \
  claude -p "$(cat TASK.md)" --model "$MODEL" --output-format stream-json --verbose \
  --no-session-persistence --strict-mcp-config \
  --allowedTools "Bash(node:*)" "Bash(date:*)" "Bash(sleep:*)" Read Write Edit Glob Grep \
  --disallowedTools WebFetch WebSearch Task Agent Monitor \
    "Read(/$HOME/rct-play/**)" "Read(/$HOME/.claude/**)" \
  2> "$O/claude.err" | node "$B/scripts/feed.js" --title "$MODEL" | node "$B/coaster/stamp.js" "$O/agent.jsonl" --print
now > "$O/agent-end.txt"
cd "$B"

kill "$SAVER" 2>/dev/null
node "$P/yearsave.js" "$O" --now final >> "$O/yearsave.log" 2>&1
mkdir -p "$O/agent-files"
cp -R "$A"/. "$O/agent-files/" 2>/dev/null

echo "==> Summary"
node -e '
const fs = require("fs"), cp = require("child_process"), dir = process.argv[1], agent = process.argv[2];
const p = JSON.parse(cp.execSync("node cli.js park")).result, rides = JSON.parse(cp.execSync("node cli.js rides")).result;
const start = JSON.parse(fs.readFileSync(dir + "/start.json", "utf8")).result;
const t0 = +fs.readFileSync(dir + "/record-start.txt", "utf8"), t1 = +fs.readFileSync(dir + "/agent-end.txt", "utf8");
let changes = 0; try { changes = fs.readdirSync(agent + "/logs").filter(f => f.endsWith(".request.json")).length; } catch (e) {}
const months = ["March","April","May","June","July","August","September","October"], m = p.date.monthsElapsed;
const s = {
  goal: p.scenario.objective, goalStatus: p.scenario.status,
  gameDate: `Year ${Math.floor(m / 8) + 1}, ${months[m % 8]}`, monthsElapsed: m,
  guests: p.park.guests, rating: p.park.rating, guestCap: p.park.suggestedGuestMaximum,
  cash: p.park.cash / 10, loan: p.park.bankLoan / 10, startCash: start.park.cash / 10,
  rides: Array.isArray(rides) ? rides.length : null,
  changesSentWithCli: changes, realMinutes: Math.round((t1 - t0) / 60000),
};
fs.writeFileSync(dir + "/summary.json", JSON.stringify(s, null, 2));
console.log(JSON.stringify(s, null, 2));' "$O" "$A"
echo "Everything from this run is in $O"
