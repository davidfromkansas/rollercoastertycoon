# Park challenge

An AI player grows "Build your own Six Flags Park" toward a guest goal, live, through the bridge.
`TASK.md` is the prompt template the player gets.

    park/run-mac.sh --rct2-path "/path/to/RCT2 folder" --goal-guests 5000                 # reach 5,000 at any time, rating 700+
    park/run-mac.sh --rct2-path "..." --goal-guests 3000 --years 4                        # 3,000 at the end of October, year 4, rating 600+
    park/run-mac.sh --rct2-path "..." --goal-guests 5000 --minutes 90 --model claude-opus-5-5

What the script does:
- **Fresh park:** starts a fresh copy of the scenario, sets the goal with `objective.set` before arming (so the player cannot change it), and starts the game paused.
- **Clean folder:** the player works in a new temporary folder holding only `cli.js`, the docs, `examples/`, `generated/`, `wiki/` and `wait.js`. It cannot read `~/rct-play` or `~/.claude`, and has no web, subagents or log watchers.
- **Live view:** the player's output is shown in the game's AI panel and saved.
- **Saves:** the park is saved at every game year end and at the finish (`saves/`). A `summary.json` is written at the end.

Each run is saved in `park/runs/TIME/`:
- `agent.jsonl`: the player's full output
- `TASK.md`: the exact prompt
- `goal.json`
- `saves/`
- `summary.json`
- `agent-files/`: what the player left in its folder
