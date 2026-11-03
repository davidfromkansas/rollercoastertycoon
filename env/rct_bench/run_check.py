"""Run check: after a run, list everything that came from the harness rather than the game.

    python3 env/rct_bench/run_check.py TRACES.jsonl [--json OUT.json] [--md OUT.md]

Reads a vf-eval traces.jsonl and reports, for each trace:
  1. Messages added by Claude Code (not by the game, our prompt or the AI): reminders, notices,
     working-folder updates, and extra blocks in the setup text.
  2. Commands Claude Code blocked or refused, and tool calls that got no result.
  3. Bridge replies that were errors, plus fields that came back empty (may be normal; worth a look).
  4. Whether the AI stopped early: time used against the limit, and whether the game had decided the goal.
  5. Game warnings that repeated many times.
  6. Tools offered to the AI beyond the ones a player uses.
A clean run lists nothing under 1, 2, 4 and 5. Display only: nothing here changes a score.
"""
import argparse
import json
import re
import sys
from collections import Counter

PLAYER_TOOLS = {"Bash", "Read", "Write", "Edit"}
REPEAT_LIMIT = 3          # a warning seen this many times or more is listed
EARLY_STOP_MINUTES = 2    # stopping with more than this left (and the goal undecided) counts as early


def text_of(content):
    if isinstance(content, list):
        return "\n".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in content)
    return content or ""


def first_line(text, width=140):
    line = next((l.strip() for l in str(text).splitlines() if l.strip()), "")
    return line[:width] + ("…" if len(line) > width else "")


def kind_of_added(text):
    """A short label for a message Claude Code added, so repeats group together."""
    t = text.strip()
    if t.startswith("# Environment update"):
        return "Working-folder update (# Environment update)"
    if t.startswith("[SYSTEM NOTIFICATION"):
        return "Background-task notification"
    return first_line(t, 110)


def check_trace(trace, minutes_limit=None):
    nodes = trace.get("nodes") or []
    data = (trace.get("task") or {}).get("data") or {}
    limit = minutes_limit or data.get("minutes")
    report = {
        "task": data.get("id") or data.get("name"),
        "model": next((c.get("model") for c in trace.get("calls") or [] if c.get("model")), None),
        "added_messages": Counter(),
        "setup_extras": [],
        "blocked": [],
        "no_result": [],
        "bridge_errors": Counter(),
        "empty_fields": Counter(),
        "warnings": Counter(),
        "extra_tools": sorted({t.get("name") for t in trace.get("tools") or [] if t.get("name")} - PLAYER_TOOLS),
        "stop": {},
    }
    t0 = float(nodes[0]["timestamp"]) if nodes else 0.0
    calls = {}
    last_say = None
    in_setup = True   # everything before the AI's first reply is setup text
    for i, node in enumerate(nodes):
        msg = node.get("message") or {}
        role = msg.get("role")
        text = text_of(msg.get("content"))
        minutes = (float(node.get("timestamp", t0)) - t0) / 60
        if role == "assistant":
            in_setup = False
        if in_setup:
            # Setup text: list Claude Code's own blocks (the <system-reminder> sections), not our prompt.
            for block in re.findall(r"<system-reminder>\s*(.*?)</system-reminder>", text, re.S):
                head = first_line(block, 110)
                if "AGENTS.md" not in block and head not in report["setup_extras"]:
                    report["setup_extras"].append(head)
            continue
        if role == "user":
            report["added_messages"][kind_of_added(text)] += 1
        elif role == "assistant":
            if text.strip():
                last_say = minutes
            for call in msg.get("tool_calls") or []:
                calls[call.get("id")] = (call.get("name"), call.get("arguments", ""), minutes)
        elif role == "tool":
            calls.pop(msg.get("tool_call_id"), None)
            for block in re.findall(r"<system-reminder>\s*(.*?)</system-reminder>", text, re.S):
                report["added_messages"]["Inside a tool result: " + first_line(block, 90)] += 1
            if "<tool_use_error>" in text:
                report["blocked"].append({"minute": round(minutes, 1), "text": first_line(re.sub(r"</?tool_use_error>", "", text), 200)})
            # Bridge errors: replies with "ok": false, and the CLI's own error lines.
            for err in re.findall(r'"ok":\s*false,\s*"error":\s*"([^"]{0,160})', text):
                report["bridge_errors"][re.sub(r"\d+", "N", err)] += 1
            for err in re.findall(r"^(?:Error|Unknown (?:operation|action))[:\s].{0,140}", text, re.M):
                report["bridge_errors"][re.sub(r"\d+", "N", err.strip())] += 1
            for key in re.findall(r'"(\w+)":\s*\[\s*\]', text):
                report["empty_fields"][key] += 1
            # Game warnings: wait.js lines and gameNews items marked as warnings.
            found = re.findall(r"^WARNING: (.+)$", text, re.M)
            found += re.findall(r"Stopped waiting: the game gave a warning: (.+)$", text, re.M)
            found += re.findall(r'"warning":\s*true,\s*"text":\s*"([^"]+)"', text)
            for w in found:
                w = re.sub(r"\{[A-Z]+\}", " ", w).replace("\\n", " ")
                report["warnings"][re.sub(r"\s+", " ", w).strip()] += 1
    last_call = max((m for _, _, m in calls.values()), default=None)
    for name, args, minutes in calls.values():
        # The call that was running when the run ended is cut off, not refused.
        cut = minutes == last_call and trace.get("stop_condition") != "agent_completed"
        report["no_result"].append({"minute": round(minutes, 1), "tool": name, "args": first_line(args, 160), "cut_off": cut})

    end = (float(nodes[-1]["timestamp"]) - t0) / 60 if nodes else 0
    metrics = trace.get("metrics") or {}
    rewards = trace.get("rewards") or {}
    passed = (rewards.get("goal_completed") or {}).get("score") == 1.0
    failed = metrics.get("goal_failed") == 1.0
    left = (limit - end) if limit else None
    report["stop"] = {
        "reason": trace.get("stop_condition"),
        "minutes_used": round(end, 1),
        "minutes_limit": limit,
        "goal": "met" if passed else "missed" if failed else "undecided",
        "early": bool(trace.get("stop_condition") == "agent_completed" and not passed and not failed
                      and left is not None and left > EARLY_STOP_MINUTES),
        "last_message_minute": round(last_say, 1) if last_say is not None else None,
    }
    report["warnings"] = Counter({k: v for k, v in report["warnings"].items() if v >= REPEAT_LIMIT})
    return report


def to_markdown(r):
    out = [f"## Run check: {r['task']} ({r['model'] or 'unknown model'})", ""]
    s = r["stop"]
    flags = 0

    out.append("**1. Messages added by Claude Code**")
    if r["added_messages"]:
        flags += 1
        out += [f"- {n}× {k}" for k, n in r["added_messages"].most_common()]
    else:
        out.append("- none")
    if r["setup_extras"]:
        out.append("- Claude Code blocks in the setup text: " + "; ".join(r["setup_extras"]))

    out += ["", "**2. Blocked or unanswered commands**"]
    refused = [b for b in r["no_result"] if not b["cut_off"]]
    if r["blocked"] or refused:
        flags += 1
    out += [f"- {b['minute']} min: blocked: {b['text']}" for b in r["blocked"]]
    out += [f"- {b['minute']} min: no result for {b['tool']}" + (" (cut off when the run ended; not a problem)" if b["cut_off"] else "") + f": {b['args']}"
            for b in r["no_result"]]
    if not r["blocked"] and not r["no_result"]:
        out.append("- none")

    out += ["", "**3. Bridge errors and empty fields** (errors are often the AI's own mistakes; check the list)"]
    out += [f"- {n}× {k}" for k, n in r["bridge_errors"].most_common(15)] or ["- no errors"]
    if r["empty_fields"]:
        out.append("- Empty fields seen: " + ", ".join(f"{k} ({n}×)" for k, n in r["empty_fields"].most_common(12)))

    out += ["", "**4. How the run ended**"]
    out.append(f"- {s['reason']} after {s['minutes_used']} of {s['minutes_limit']} minutes; goal {s['goal']}")
    if s["early"]:
        flags += 1
        out.append(f"- FLAG: stopped early with {round(s['minutes_limit'] - s['minutes_used'], 1)} minutes left and the goal undecided")

    out += ["", f"**5. Game warnings repeated {REPEAT_LIMIT}+ times**"]
    if r["warnings"]:
        flags += 1
        out += [f"- {n}× {k}" for k, n in r["warnings"].most_common(10)]
    else:
        out.append("- none")

    out += ["", "**6. Tools offered beyond Bash, Read, Write, Edit**",
            "- " + (", ".join(r["extra_tools"]) if r["extra_tools"] else "none"), ""]
    out.insert(1, f"{flags} of 4 checks flagged (1, 2, 4, 5).\n")
    return "\n".join(out)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("traces")
    p.add_argument("--minutes", type=float, help="time limit, if the trace doesn't say")
    p.add_argument("--json")
    p.add_argument("--md")
    a = p.parse_args(argv)
    reports = []
    with open(a.traces) as f:
        for line in f:
            if line.strip():
                for trace in json.loads(line).get("traces", []):
                    reports.append(check_trace(trace, a.minutes))
    md = "\n".join(to_markdown(r) for r in reports)
    if a.md:
        open(a.md, "w").write(md)
    if a.json:
        json.dump(reports, open(a.json, "w"), indent=1, default=dict)
    sys.stdout.write(md + "\n")


if __name__ == "__main__":
    main()
