# RollerCoaster Tycoon 2 benchmark for AI agents

Tests how well an AI model can run a theme park. Each task is one of RollerCoaster Tycoon 2's own scenarios, with the scenario's own goal (for example "700 guests by the end of October, Year 2"). The AI plays the real game (OpenRCT2) through a small command-line bridge, inside a cloud sandbox, and the game itself decides pass or fail.

Runs use Prime Intellect's [verifiers](https://github.com/PrimeIntellect-ai/verifiers) framework and Prime sandboxes. Every run records a video of the screen.

## What's in here

| Folder | What it is |
| --- | --- |
| `bridge/` | The bridge: an OpenRCT2 plugin plus `cli.js`, the helper the AI uses to look at and change the park. Safe by design: read-only until armed, spending limits, receipts. |
| `image/` | Recipe for the game image: OpenRCT2 v0.5.5, Node 20, the bridge, a virtual screen and ffmpeg. |
| `env/` | The benchmark itself (Python package `rct-bench`): task list, prompt, setup, scoring. |
| `docs/base-game-tasks.md` | The 15 base-game tasks and their goals. |

## How a run works

1. A fresh sandbox starts from the game image and opens the scenario, paused.
2. The AI (Claude Code by default) gets the prompt (`env/rct_bench/data/PROMPT.md`) and a folder with only the bridge helper. It can't see the bridge's own files, past runs or the goal settings.
3. The run ends at whichever comes first: the game decides the goal (met, or failed at its deadline) or the time limit (60 real minutes by default).
4. Score: **1 if the game marks the scenario completed, else 0.** Also recorded: guests, park rating, cash, loan, park value, game months passed, tool calls and web searches.
5. Kept on your machine: the full video, a 16x video, and the AI's folder plus the final park save. In the video the camera zooms in where the AI is building and back out when it goes quiet, the game's money/guests and date boxes are shown at double size, and a panel on the right shows the AI's live log: its messages under a chip with the model's name, its thinking, and each tool it runs as one line with a green or red mark for whether it worked. The header shows the model's name on a chip and the goal.
6. The benchmark sends the repo's `bridge/` files into each game when it starts and rebuilds the plugin there, so bridge fixes apply without rebuilding the image.

## Run it yourself

### 1. What you need

- Your own copy of **RollerCoaster Tycoon 2** (GOG or Steam): the folder that contains `Data/g1.dat`. The game files are copyrighted; they go only into your **private** image. Never publish an image that contains them.
- A [Prime Intellect](https://app.primeintellect.ai) account and API key, and the CLI: `pip install prime && prime login`.
- An API key for the model you want to test (e.g. an Anthropic key), or use Prime's own model service.
- Python 3.11+.

### 2. Build your private game image

```bash
CONTEXT_ONLY=./image-context bash image/build.sh ./bridge "/path/to/RollerCoaster Tycoon 2"
prime images push rct-bench:v1 --context ./image-context --private --arch amd64
```

This builds on Prime (no Docker needed locally; about 5 minutes). Note the full image name it prints, like `prime/<your-id>/rct-bench:v1`.

### 3. Install the benchmark

```bash
pip install -e ./env
export RCT_IMAGE=prime/<your-id>/rct-bench:v1
export PRIME_API_KEY=...          # your Prime key
export MY_ANTHROPIC_KEY=...       # your model key (any variable name)
```

### 4. Run a task

```bash
vf-eval rct-bench -m claude-opus-5-5 \
  --client.base-url https://api.anthropic.com/v1 --client.api-key-var MY_ANTHROPIC_KEY \
  --env.agent.harness.id claude_code --env.agent.harness.version 2.1.316 \
  --select.include.ids electric-fields
```

- `--select.include.ids` picks tasks (ids are in `env/rct_bench/data/base-game.json`); leave it out to run all 15.
- `--env.taskset.minutes 5` makes a short test run.
- `--env.agent.harness.version` sets the Claude Code version; newer models need a recent one.
- Videos and the AI's files land in `./rct-files` (change with `RCT_FILES_DIR`). Add `--no-push` to skip uploading results to your Prime Evaluations page.
- To use Prime's model service instead of your own key, drop the two `--client` flags and use a Prime model name.

**Tip:** run `vf-eval` from a small Prime sandbox (for example `python:3.12-slim`) if your own network blocks Prime's sandbox connections. Start it with `setsid nohup` so it survives your session.

## Costs (one example)

Opus 5.5 on Electric Fields (Nov 2, 2026): passed, about 55 minutes, about $6.80 in model tokens, plus a few cents of sandbox time.

## Licence

GPL-3.0 (see `LICENSE`). The bridge's design was inspired by [FTPAiYT/openrct2-agent-bridge](https://github.com/FTPAiYT/openrct2-agent-bridge). RollerCoaster Tycoon 2 is not included.
