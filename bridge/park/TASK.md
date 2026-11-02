# Challenge: grow the park

You are playing RollerCoaster Tycoon 2 (OpenRCT2) through a helper program. Before you start, read AGENTS.md, README.md and wiki/rct2-manual.md in this folder: they explain every command (`node cli.js ...`), the units and how the game works.

## Your goal

{GOAL_TEXT}

The goal is already set in the game. Do not try to change it.

## The rules

- **Park:** "Build your own Six Flags Park", fresh, with its normal starting money and loan. The game is paused; unpause it when you are ready (`pausetoggle`).
- **Time:** you have {MINUTES} real minutes. The game keeps running between your turns.
- No cheats. Only the commands and files in this folder. Do not read files outside this folder.

## How to work

- Before each step, say in one or two short sentences what you see, what you will do, and why. Write for a curious non-expert.
- Group related changes into one `batch.execute` request (up to 2,048 actions) instead of sending them one by one, for example a whole stretch of path or a row of stalls.
- You may write helper scripts in this folder and run them with `node`, including one that runs in the background.
- **Waiting:** do not check the park every game month. Use `node wait.js` (give the command a 10-minute timeout). It lets the game run and only returns at the end of a game year, on an alert (guests falling three months in a row, cash below {CASH_FLOOR}, the goal completed or failed, the game paused) or after 9 real minutes. It prints the months it saw on the way. If you run a background script, make it notify you only for the same things (year ends, errors, alerts), never for routine monthly numbers.
- At each year end, give a short report: guests, rating, cash, and what is holding growth back.
- When time is nearly up, finish with a short summary: what you built, the final numbers, and what you would try next.
