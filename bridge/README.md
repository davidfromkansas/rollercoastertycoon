# RCT agent bridge (Mac and Linux cloud)

Lets an AI agent look at and play a RollerCoaster Tycoon 2 park running in OpenRCT2.

- **Plugin** (`src/plugin.js`): runs inside the game. Listens on this computer only (127.0.0.1, port 21572), checks a private password, and runs allowed game actions.
- **Helper** (`cli.js`): what the agent (or you) runs to send requests and read answers.

It starts **read-only**. Changes need `arm`, a spending limit, and pass checks first. Every change gets a receipt, and the same request is never run twice. The newest 1,000 receipts are kept; older ones are dropped automatically.

Design inspired by [FTPAiYT/openrct2-agent-bridge](https://github.com/FTPAiYT/openrct2-agent-bridge) (GPL-3.0); this is a separate Mac-first version under the same license.

## What you need

- A Mac, Node.js 20+, git (`xcode-select --install`).
- Your own copy of RollerCoaster Tycoon 2 (GOG or Steam). You need the folder that contains `Data/g1.dat`.

## Set up (once)

```bash
scripts/setup.sh
```

This downloads the pinned OpenRCT2 v0.5.5 (source + official Mac app, checksum-checked), builds the plugin with a fresh password, runs the tests, and installs everything inside this folder. Your RCT2 files and any other OpenRCT2 install are not touched.

## Play

```bash
scripts/start.sh --rct2-path "/path/to/RollerCoaster Tycoon 2"
# open or start a park in the game window, then:
node cli.js hello      # should show apiVersion 122 and armed: false
node cli.js park
```

Then open Claude Code (or another agent) in this folder and give it a goal. `AGENTS.md` tells the agent how to use the bridge.

Stop the agent any time from the game's menu: **Agent bridge: STOP**.

## Run in the cloud (Linux, no window)

```bash
scripts/setup.sh                                   # same script, picks the Linux build
P=$(scripts/sample-park.sh "Solar Park")           # a free park that ships with OpenRCT2
scripts/start.sh --headless --park "$P"
node cli.js hello
```

Headless mode needs no RCT2 files, because nothing is drawn. That also means no screenshots: `capture` is refused there (asking the engine for a picture would crash it). Many sample parks are saved paused; the agent can unpause with the `pausetoggle` action and speed up with `gamesetspeed`.

## Watch the AI's output in the game

A panel on the right of the game window shows what the AI prints while it plays, the same things you'd see in the Claude Code or Codex app: its messages, its thinking (as much as each app shows), each command it runs, and what the game answers. Nothing is summarised or reworded. Long command output is cut after 12 lines, like the apps do (`--max-output-lines 0` shows everything).

```bash
claude -p "$(cat TASK.md)" --output-format stream-json --verbose | node scripts/feed.js --title "Claude"
codex exec --json "$(cat TASK.md)" | node scripts/feed.js --title "Codex"
```

The panel opens by itself on the first message. Reopen it from the game's menu: **Agent bridge: AI output panel**. You can drag and resize it. Everything is also saved to `logs/feed-TIME.jsonl`.

## Commands

| Command | What it does |
| --- | --- |
| `node cli.js hello` | Status, API version, session |
| `node cli.js park` | Money, guests, rating, scenario goal, date, and the scenario's fixed rules (`park.rules`: who pays at the gate or per ride, which prices can change, harder guests, intensity preferences, forbidden actions) |
| `node cli.js rides '{"sortBy":"profit"}'` / `ride '{"ride":3}'` | Ride stats, like the ride list window (sort by any number) |
| `node cli.js map '{"x":60,"y":60,"width":8,"height":8}'` | Map tiles (max 32x32) |
| `node cli.js guests` / `staff` | People, 100 at a time (`offset`, `limit`). Filter guests by `ride`, `state`, `thought`, `item`; staff by `staffType`. Each guest has `inParkSince`: the game date the bridge first saw them in the park |
| `node cli.js thoughts` | What guests are thinking, counted (the guest list's summary) |
| `node cli.js finances` | Money in and out by month and type (the finances window) |
| `node cli.js research` | What's being invented and when (the research window) |
| `node cli.js weather` / `awards` | Today's and the next weather; awards the park holds |
| `node cli.js history` | Cash, rating, guests and value for every game day since the bridge started watching (`every` to thin it) |
| `node cli.js marketing` | Adverts started through the bridge that are still running |
| `node cli.js news '{"limit":50}'` | All news messages, newest first |
| `node cli.js view '{"rotation":1,"show":["underground"],"ride":3}'` | Camera: zoom, rotate, view options, jump to a ride or `entity` |
| `node cli.js objects '{"type":"ride"}'` | Rides, scenery, paths loaded in this park |
| `node cli.js schema ridesetprice` | Exact arguments of an allowed action |
| `node cli.js capture` | Screenshot into `user-data/screenshot`, with a copy in `screenshots/` next to `cli.js` |
| `node cli.js arm` / `stop` | Allow / disallow changes |
| `node cli.js save` | Checkpoint copy into `user-data/save` |
| `node cli.js request FILE.json` | Send a request written in a file (see `examples/`) |
| `node cli.js receipt ID` | What happened to an earlier change (one of the last 1,000) |

**News ticker:** every command's answer also lists the game messages you have not seen yet, as `gameNews` (`warning: true` = the game's red warnings, such as guests who can't reach a ride, a crash, or a low park rating). `node wait.js` prints them too and stops on a warning.

Request types for files: `action.query` (dry run), `action.execute`, `batch.execute`, `track.plan`, `track.build`, `coaster.build`, `track.walk`.

## Units

- Map reads use **tiles**. Building uses **world units**: x/y = tile × 32, z = 8 per height step (16 per land step).
- Directions: 0 = −x, 1 = +y, 2 = +x, 3 = −y. 4–7 are diagonals (planner only).
- Money is in tenths: 10 = $1. `maxCost: 100000` = $10,000.
- Ratings: 652 means 6.52.

## Safety rules built in

- Only 66 named actions are allowed (`generated/actions.json`): everything a normal player can do. No cheats, scenario-editor or multiplayer actions, no code, no file paths.
- A few options inside allowed actions are refused too: changing a ride's type (`ridesetsetting` setting 10), speeds above 4, and any `guestsetflags` value other than 8 (track this guest) or 0 (stop).
- Saved ride designs (`trackdesign`) can't be used: the game's plugin system doesn't support that action yet.
- Every action is dry-run (queried) before it runs; a batch stops at the first problem or at the budget. Nothing is undone automatically.
- Loading a different park disarms the bridge.
- The helper writes `logs/ID.request.json` before sending, and refuses to reuse an id. After a timeout or crash, check `receipt ID` and the park; never resend.

## Tests

```bash
npm test
```

Tests use a pretend game (`test/fake-game.js`) and real track geometry from the OpenRCT2 source. They don't prove a coaster's train can make it round: only a real test run in the game does that.

## Private files

Never share `bridge.config.json`, `dist/`, `user-data/`, `logs/`, `runtime/` or `vendor/`. The built plugin contains your password.
