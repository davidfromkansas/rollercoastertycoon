# Instructions for an AI agent using this bridge

You control a RollerCoaster Tycoon 2 park through `node cli.js`. Read README.md for commands and units.

Before playing, read `wiki/rct2-manual.md` (and `wiki/index.md` if it exists): the official manual's sections on how the game works. Where it says to click a button or open a window, use the matching bridge command instead.

## Before playing

1. Run `node cli.js hello`. Expect `apiVersion: 122`. If it can't connect, the game isn't running: ask the user to run `scripts/start.sh` and open a park. Do not start the game yourself unless asked.
2. Run `node cli.js park`, `rides`, and look at the map around the park entrance. Understand the goal, money and guests before acting.
3. Check `paused` in the park answer. Time only passes when unpaused (`pausetoggle`, then `gamesetspeed` 1 to 4). In headless mode there are no screenshots; use `map`, `rides` and `ride` instead.
4. Only run `node cli.js arm` once the user has given you a goal that needs changes. Changing parks disarms; re-arm only for the same goal.

## Making changes

- Check arguments with `node cli.js schema ACTION`. Do not guess field names.
- Write each change as a JSON file and send it with `node cli.js request FILE`. Always include a sensible `maxCost` (10 = $1).
- Group related actions (a stretch of path, a row of stalls) into one `batch.execute` request instead of sending them one by one.
- Dry-run unfamiliar actions first with `action.query`.
- Run `node cli.js save` before big changes (new coaster, large demolition).
- Never resend a change after a timeout or lost connection, not even with a new id. Run `node cli.js receipt ID`, then look at the park, then decide.
- A `partial` result means some actions ran. Look at what was done before continuing. Do not demolish things silently.

## Coasters

1. Pick a ride object (`objects '{"type":"ride"}'`) and a flat, owned, empty area (`map`).
2. `track.plan` with your pieces (see `examples/plan-small-coaster.json`). It must say `closed: true`.
3. `coaster.build` with the plan id (see `examples/build-coaster.template.json`), then add an entrance, exit and paths.
4. Test it: `ridesetstatus` with status 2, wait, then read `ride` stats. A closed plan does not prove the train makes it round.
5. Open it (status 1) only after a good test.
6. Before editing track on an existing ride, close it and check that trains have stopped.

## Rules

- Stay within the user's goal, budget and time. When the user says stop, stop sending changes.
- No cheats. Respect research and scenario rules.
- Never overwrite the user's original save. Never share `bridge.config.json`, logs or saves.
