#!/usr/bin/env bash
# Runs the coaster challenge on a Mac: a fresh park, a live AI player (Claude Code), then the judge.
# Watch it happen in the game window. Each run gets its own folder in coaster/runs/.
# Usage: coaster/run-mac.sh --rct2-path "/path/to/RCT2 folder" [--minutes 60] [--model claude-opus-5-5]
set -u
cd "$(dirname "$0")/.."
B="$PWD"; C="$B/coaster"
RCT2=""; MIN=""; MODEL="claude-opus-5-5"
while [ $# -gt 0 ]; do
    case "$1" in
        --rct2-path) RCT2="$2"; shift 2 ;;
        --minutes) MIN="$2"; shift 2 ;;
        --model) MODEL="$2"; shift 2 ;;
        *) echo "unknown option $1" >&2; exit 1 ;;
    esac
done
[ -f "$RCT2/Data/g1.dat" ] || { echo "Give --rct2-path, the folder that contains Data/g1.dat" >&2; exit 1; }
[ -n "$MIN" ] || MIN=$(node -p 'require("./coaster/plot.json").minutes')
SCEN=$(find "$RCT2" -iname "Build your own Six Flags Park.SC6" -print -quit)
[ -n "$SCEN" ] || { echo "Scenario 'Build your own Six Flags Park' not found under $RCT2" >&2; exit 1; }
command -v claude >/dev/null || { echo "Claude Code (claude) is not installed" >&2; exit 1; }

RUN=$(date +%Y%m%d-%H%M%S); O="$C/runs/$RUN"; A="$O/agent"
mkdir -p "$A/logs"
now() { node -e 'console.log(Date.now())'; }

echo "==> Starting a fresh park"
for p in $(pgrep -x OpenRCT2); do kill "$p"; done
sleep 2
cp "$SCEN" "$O/park.sc6"
scripts/start.sh --rct2-path "$RCT2" --park "$O/park.sc6" || exit 1
for i in $(seq 1 60); do node cli.js hello >/dev/null 2>&1 && break; sleep 1; done
node cli.js hello >/dev/null 2>&1 || { echo "The game did not answer" >&2; exit 1; }
node cli.js arm >/dev/null
# £30,000 cash to work with (the budget is £20,000), and start paused like in the cloud runs.
cat > "$O/setup.json" <<J
{"op":"batch.execute","args":{"maxCost":0,"actions":[{"action":"parksetloan","args":{"value":300000}},{"action":"pausetoggle","args":{}}]}}
J
node cli.js request "$O/setup.json" >/dev/null
node cli.js view '{"x":3150,"y":2560,"zoom":1,"rotation":0}' >/dev/null
START_CASH=$(node -p 'JSON.parse(require("child_process").execSync("node cli.js park")).result.park.cash')
echo "$START_CASH" > "$O/start-cash.txt"

# The player's folder holds only the helper and its docs. A new folder each run, so no notes carry over.
cp cli.js bridge.config.json README.md AGENTS.md package.json "$A/"
cp -R examples generated "$A/"
node -e '
const p=require(process.argv[1]+"/plot.json");let s=require("fs").readFileSync(process.argv[1]+"/TASK.md","utf8");
s=s.replace("{PLOT_X1}",p.x1).replace("{PLOT_X2}",p.x2).replace("{PLOT_Y1}",p.y1).replace("{PLOT_Y2}",p.y2)
 .replace("{BUDGET}","£"+p.budget.toLocaleString("en-GB")).replace("{MINUTES}",process.argv[3]);
require("fs").writeFileSync(process.argv[2]+"/TASK.md",s);' "$C" "$A" "$MIN"

echo "==> AI player ($MODEL) has $MIN minutes. Watch the game window."
now > "$O/record-start.txt"
cd "$A"
# perl's alarm ends the player if it runs past the time limit (macOS has no `timeout`).
perl -e 'alarm shift; exec @ARGV' $((MIN*60+120)) \
  claude -p "$(cat TASK.md)" --model "$MODEL" --output-format stream-json --verbose \
  --no-session-persistence --strict-mcp-config \
  --allowedTools "Bash(node cli.js:*)" "Bash(date:*)" "Bash(sleep:*)" Read Write Edit Glob Grep \
  --disallowedTools WebFetch WebSearch Task Agent \
  2> "$O/claude.err" | node "$C/stamp.js" "$O/agent.jsonl" --print
now > "$O/agent-end.txt"
cd "$C"

echo "==> Judging"
node judge.js measure "$START_CASH" > "$O/measure.json" 2>> "$O/judge.err"
RIDE=$(node -p 'const r=require(process.argv[1]).results;r.length?r[0].ride:-1' "$O/measure.json")
if [ "$RIDE" -ge 0 ]; then
    echo "==> Opening the park for two game months to see what guests think"
    node judge.js month "$RIDE" > "$O/month.json" 2>> "$O/judge.err"
fi
node -e '
const m=require(process.argv[1]+"/measure.json"),g=(()=>{try{return require(process.argv[1]+"/month.json")}catch{return {points:0}}})();
const r=m.results[0];if(!r){console.log("No coaster to score.");process.exit()}
const total=r.subtotal+(r.problems.length?0:g.points);
console.log(`\n${r.name}: ${total.toFixed(1)} points`);
for(const [k,v] of Object.entries(r.points))console.log(`  ${k.padEnd(11)} ${v.toFixed(1)}`);
console.log(`  guests      ${g.points.toFixed(1)}`);
if(r.problems.length)console.log("  Problems: "+r.problems.join(", "));' "$O"
echo "Everything from this run is in $O"
