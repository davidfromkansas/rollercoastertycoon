# Coaster challenge

An AI player builds one looping roller coaster in "Build your own Six Flags Park", live, through the bridge.
`TASK.md` is exactly what the player is told. `judge.js` scores the ride afterwards.

    coaster/run-mac.sh --rct2-path "/path/to/RCT2 folder"            # 60 minutes, Claude Opus 5.5
    coaster/run-mac.sh --rct2-path "..." --minutes 5                  # quick test

Each run saves to `coaster/runs/TIME/`: the player's full output (`agent.jsonl`), the score (`measure.json`, `month.json`).
`node coaster/peek.js coaster/runs/TIME/agent.jsonl 30` shows the last 30 things the player did.
