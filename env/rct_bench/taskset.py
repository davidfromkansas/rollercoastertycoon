"""RollerCoaster Tycoon 2 benchmark: each task is one built-in scenario with its own goal.

Setup opens the scenario's park in the game image, arms the bridge and pauses the game.
The AI (user `agent`) plays from a clean folder with only the bridge helper and its docs.
Pass = the game itself says the scenario is completed.
"""

import json
import os
import time
from importlib.resources import files
from pathlib import Path

import verifiers.v1 as vf

IMAGE = "prime/cmvypuqxg0013vqovd7u20x6e/rct-bench:v2"
DATA = files("rct_bench") / "data"
BRIDGE = "/home/player/bridge"
PLAY = "/home/agent/play"

# Each running game's sandbox, by trace id, so the stop check below can read the game.
RUNTIMES: dict[str, object] = {}
LAST_CHECK: dict[str, float] = {}
CHECK_EVERY = 20  # seconds between game checks (the check runs before the AI's next model call)


class RctData(vf.TaskData):
    scenario: str
    park_file: str
    difficulty: str
    goal: str
    minutes: int


async def park_state(runtime) -> dict:
    """The game's own view of the park, read through the bridge as the game's user."""
    result = await runtime.run(
        ["bash", "-c", f"cd {BRIDGE} && runuser -u player -- node cli.js park"], {}
    )
    if result.exit_code != 0:
        raise RuntimeError(f"bridge did not answer: {result.stderr[-500:]}")
    return json.loads(result.stdout)["result"]


class RctTask(vf.Task[RctData]):
    NEEDS_CONTAINER = True

    async def setup(self, trace: vf.Trace, runtime) -> None:
        RUNTIMES[trace.id] = runtime
        script = (files("rct_bench") / "setup.sh").read_bytes()
        await runtime.write("/tmp/rct-setup.sh", script)
        result = await runtime.run(["bash", "/tmp/rct-setup.sh", self.data.park_file], {})
        if result.exit_code != 0 or "ready" not in result.stdout:
            raise RuntimeError(
                f"setup failed ({result.exit_code}): {result.stdout[-1000:]} {result.stderr[-1000:]}"
            )
        # Optional extra copy of the handbook (data/rct2-guide.md; not in the public repo).
        guide = DATA / "rct2-guide.md"
        if guide.is_file():
            await runtime.write(f"{PLAY}/wiki/rct2-guide.md", guide.read_bytes())
            await runtime.run(["chown", "agent:agent", f"{PLAY}/wiki/rct2-guide.md"], {})

    @vf.stop
    async def scenario_decided(self, trace: vf.Trace) -> bool:
        """End the run as soon as the game itself decides the scenario (goal met or failed,
        e.g. at a dated goal's deadline). The time limit still ends it otherwise."""
        runtime = RUNTIMES.get(trace.id)
        now = time.monotonic()
        if runtime is None or now - LAST_CHECK.get(trace.id, 0) < CHECK_EVERY:
            return False
        LAST_CHECK[trace.id] = now
        try:
            status = (await park_state(runtime))["scenario"]["status"]
        except Exception:
            return False  # a missed check must never end or break the run
        return status in ("completed", "failed")

    async def finalize(self, trace: vf.Trace, runtime) -> None:
        RUNTIMES.pop(trace.id, None)
        LAST_CHECK.pop(trace.id, None)
        # Pause the game so the score is read from the moment the AI stopped.
        await runtime.run(
            [
                "bash",
                "-c",
                f"cd {BRIDGE} && runuser -u player -- node -e '"
                'const cp=require("child_process");'
                'const p=JSON.parse(cp.execSync("node cli.js park")).result;'
                'if(!p.paused){require("fs").writeFileSync("/tmp/pause-end.json",JSON.stringify({op:"action.execute",args:{maxCost:0,action:"pausetoggle",args:{}}}));'
                'cp.execSync("node cli.js request /tmp/pause-end.json")}\'',
            ],
            {},
        )

        # Keep the AI's folder (notes, scripts, screenshots, change log) and a final save of the park,
        # next to the run's results: RCT_FILES_DIR (default ./rct-files)/TASK-TRACE.tgz. Never the password file.
        pack = (
            f"cd {BRIDGE} && runuser -u player -- node cli.js save > /tmp/final-save.json 2>&1; "
            "mkdir -p /tmp/keep/park && cp -a /home/agent/play /tmp/keep/ && "
            "rm -rf /tmp/keep/play/.vf-claude /tmp/keep/play/bridge.config.json /tmp/keep/play/wiki /tmp/keep/play/generated /tmp/keep/play/examples; "
            f"f=$(ls -t {BRIDGE}/user-data/save/* 2>/dev/null | head -1); [ -n \"$f\" ] && cp \"$f\" /tmp/keep/park/final.park; "
            "tar -czf /tmp/keep.tgz -C /tmp keep"
        )
        await runtime.run(["bash", "-c", pack], {})
        out = Path(os.environ.get("RCT_FILES_DIR", "rct-files"))
        out.mkdir(parents=True, exist_ok=True)
        try:
            data = await runtime.read("/tmp/keep.tgz")
            (out / f"{self.data.id}-{trace.id}.tgz").write_bytes(data)
        except Exception as e:  # keeping files must never fail the run
            print(f"rct-bench: could not keep the AI's files: {e}")

        # Stop the screen recorder and keep the video: the whole run, plus a 16x fast version.
        video = (
            "p=$(cat /root/rec/pid 2>/dev/null) && kill -INT $p 2>/dev/null; "
            "for i in $(seq 1 30); do kill -0 $p 2>/dev/null || break; sleep 1; done; "
            "cd /root/rec && ffmpeg -nostdin -loglevel error -y -i run.mkv -c copy -movflags +faststart run.mp4 && "
            "ffmpeg -nostdin -loglevel error -y -i run.mkv -vf 'setpts=PTS/16' -r 30 -an "
            "-c:v libx264 -preset veryfast -crf 26 -pix_fmt yuv420p -movflags +faststart run-16x.mp4"
        )
        await runtime.run(["bash", "-c", video], {})
        for name, suffix in (("run.mp4", ""), ("run-16x.mp4", "-16x")):
            try:
                data = await runtime.read(f"/root/rec/{name}")
                (out / f"{self.data.id}-{trace.id}{suffix}.mp4").write_bytes(data)
            except Exception as e:  # keeping the video must never fail the run
                print(f"rct-bench: could not keep the video {name}: {e}")

    @vf.reward(weight=1.0)
    async def goal_completed(self, trace: vf.Trace, runtime) -> float:
        p = await park_state(runtime)
        return 1.0 if p["scenario"]["status"] == "completed" else 0.0

    @vf.metric
    async def tools_used(self, trace: vf.Trace) -> dict:
        # We don't mention the web in the prompt; this shows whether the AI reaches for it on its own.
        c = tool_counts(trace)
        return {
            "tool_calls": sum(c.values()),
            "web_searches": c.get("WebSearch", 0),
            "web_fetches": c.get("WebFetch", 0),
            "subagents": c.get("Agent", 0) + c.get("Task", 0),
        }

    @vf.metric
    async def park(self, trace: vf.Trace, runtime) -> dict:
        p = await park_state(runtime)
        status = p["scenario"]["status"]
        return {
            "guests": p["park"]["guests"],
            "park_rating": p["park"]["rating"],
            "cash_gbp": p["park"]["cash"] / 10,
            "loan_gbp": p["park"]["bankLoan"] / 10,
            "park_value_gbp": p["park"]["value"] / 10,
            "months_elapsed": p["date"]["monthsElapsed"],
            "goal_failed": 1.0 if status == "failed" else 0.0,
        }


def tool_counts(trace: vf.Trace) -> dict[str, int]:
    """How often the AI used each of its tools (from the recorded conversation)."""
    counts: dict[str, int] = {}
    data = trace.model_dump() if hasattr(trace, "model_dump") else trace
    for node in data.get("nodes", []):
        message = node.get("message") or {}
        if message.get("role") != "assistant":
            continue
        for call in message.get("tool_calls") or []:
            name = (call.get("function") or call).get("name") or "?"
            counts[name] = counts.get(name, 0) + 1
    return counts


class RctConfig(vf.TasksetConfig):
    tasks_file: str = "base-game.json"
    """Task list inside rct_bench/data."""
    minutes: int | None = None
    """Override every task's time limit (real minutes)."""
    image: str = os.environ.get("RCT_IMAGE", IMAGE)
    """Your private game image on Prime (see README). Or set RCT_IMAGE."""
    cpu: float = 2.0
    memory: float = 4.0


class RctBenchTaskset(vf.Taskset[RctTask, RctConfig]):
    def load(self):
        spec = json.loads((DATA / self.config.tasks_file).read_text())
        template = (DATA / spec["prompt_template"]).read_text()
        for t in spec["tasks"]:
            minutes = self.config.minutes or t["minutes"]
            prompt = (
                template.replace("{SCENARIO}", t["scenario"])
                .replace("{GOAL}", t["goal"])
                .replace("{MINUTES}", str(minutes))
            )
            yield RctTask(
                RctData(
                    id=t["id"],
                    name=t["id"],
                    description=f"{t['scenario']} ({t['difficulty']})",
                    prompt=prompt,
                    image=self.config.image,
                    workdir=PLAY,
                    agent_user="agent",
                    scenario=t["scenario"],
                    park_file=t["park_file"],
                    difficulty=t["difficulty"],
                    goal=t["goal"],
                    minutes=minutes,
                    timeout=vf.TaskTimeout(setup=600, agent=minutes * 60, finalize=600, scoring=120),
                    resources=vf.TaskResources(cpu=self.config.cpu, memory=self.config.memory, disk=10),
                ),
                self.config.task,
            )
