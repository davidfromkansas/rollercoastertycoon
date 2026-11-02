# Challenge: build the coolest looping roller coaster

You are playing RollerCoaster Tycoon 2 (OpenRCT2) through a helper program. Read README.md and AGENTS.md in this folder first: they explain every command (`node cli.js ...`), the units, and how to plan, build and test track.

## Your goal

Design and build ONE looping roller coaster that scores as many points as possible on the scorecard below. Every item counts, so look for a design that does well on all of them at once, not just one. Be creative: think about what makes a ride thrilling to look at and to ride.

## The rules

- **Where:** the park "Build your own Six Flags Park". It is empty and closed to guests until the judge opens it. Your plot sits between the park entrance (to the east) and the lake (to the west).
- **Plot:** build only inside your plot: tiles x {PLOT_X1} to {PLOT_X2}, y {PLOT_Y1} to {PLOT_Y2}. Any track, station, entrance or exit outside it disqualifies the ride. You may reshape land, clear scenery and build tunnels inside the plot.
- **Budget:** you may spend at most {BUDGET} in total (land changes, track, scenery, everything). Going over disqualifies the ride.
- **Time:** you have {MINUTES} real minutes. Leave time to test.
- **One coaster:** if you build more than one, only your best one is scored. You may demolish and rebuild.
- **It must work:** the ride must be a complete circuit with at least one inversion (a loop, corkscrew or roll), it must pass a test run, and it must be open at the end with an entrance, an exit and footpaths linking them to the park's main path (paths may go outside the plot; the main path starts near tile x 130, y 74). Set a ticket price.
- The game is being filmed. Keep the camera (`view`) on your plot; you may rotate or zoom it to show off the ride.
- No cheats. Only the commands in this folder.

## The scorecard

| What | Points | How it is measured |
| --- | --- | --- |
| Excitement | 10 per 1.00 | The game's excitement rating |
| Not too intense | Lose ALL excitement points if intensity is over 9.00 | The game's intensity rating |
| Value for money | 20 × excitement ÷ thousands of £ spent (max 20) | e.g. excitement 7.00 for £7,000 = 20 points |
| Inversions | 3 each (max 24) | Loops, corkscrews, rolls in the track |
| Airtime | 2 per second (max 20) | The game's "air time" stat |
| Small footprint | 15 × (1 − tiles used ÷ 300), at least 0 | Tiles with your ride's track, station, entrance or exit |
| Guests love it | up to 20 | After you finish, the park opens and runs for two game months; points = the ride's guest satisfaction ÷ 5 |
| Uses the terrain | 1 per tile (max 20) | Tiles where your track runs under the ground (tunnels) or over water |

The judge will measure all of this after you stop. You can check most of it yourself with `node cli.js ride '{"ride":ID}'` after a test.

## How to work

- Before each step, say in one or two short sentences what you see, what you will do, and why. People will watch your notes next to a video of the game, so write for a curious non-expert.
- Plan with `track.plan` (it tells you if the circuit closes) before you spend money.
- Test, read the ratings, then improve. Keep the best version you have tested.
- When you are done, finish with a short summary: your design idea, the final ratings, and what you would try next.
