# Side panel for the run video (display only; the AI never sees or uses it).
# Follows the AI's own conversation log (Claude Code's session file) and draws the newest part of it as a
# 640x720 picture: a header with the model's name on a chip and the scenario's goal, then what the AI says,
# thinks, which tools it runs and whether they worked. The screen recorder re-reads the picture every frame
# and puts it to the right of the game, so the panel in the video always matches the moment in the game.
#   python3 panel.py AI_FOLDER OUT_PNG INFO_JSON [--first]
# INFO_JSON: {"scenario": ..., "goal": ...}. Needs Pillow (setup.sh puts it in PIL_DIR). Runs as root.
import json
import os
import re
import sys
import time

sys.path.insert(0, os.environ.get("PIL_DIR", "/root/rec/pil"))
from PIL import Image, ImageDraw, ImageFont  # noqa: E402

FOLDER, OUT = sys.argv[1], sys.argv[2]
try:
    INFO = json.load(open(sys.argv[3]))
except Exception:
    INFO = {}

W, H = 640, 720
PAD = 16
FONTS = "/usr/share/fonts/truetype/dejavu/"


def font(name, size, *fallbacks):
    for n in (name,) + fallbacks:
        try:
            return ImageFont.truetype(FONTS + n, size)
        except OSError:
            pass
    return ImageFont.load_default()


F_TITLE = font("DejaVuSans.ttf", 18)
F_CHIP_BIG = font("DejaVuSans-Bold.ttf", 17)
F_GOAL = font("DejaVuSans.ttf", 13)
F_TEXT = font("DejaVuSans.ttf", 14)
F_THINK = font("DejaVuSans-Oblique.ttf", 13, "DejaVuSansMono-Oblique.ttf", "DejaVuSans.ttf")
F_CHIP = font("DejaVuSans-Bold.ttf", 12)
F_LABEL = font("DejaVuSans-Bold.ttf", 12)
F_MONO = font("DejaVuSansMono.ttf", 13)
F_MONO_B = font("DejaVuSansMono-Bold.ttf", 13)

BG = (21, 24, 29)
HEAD = (36, 49, 63)
WHITE = (232, 232, 232)
GOAL = (201, 214, 227)
CHIP_BG = (242, 180, 110)
CHIP_FG = (28, 22, 16)
DIM = (128, 136, 148)
TOOL = (120, 180, 255)
CMD = (190, 196, 204)
OK = (110, 200, 120)
BAD = (240, 110, 100)
THINK = (150, 140, 190)
LINE = 19          # line height for body text
GAP = 12           # space between items
HEADER_H = 92


def clean(text):
    # Keep characters the font can draw (no emoji).
    text = str(text or "").replace("\r", "").replace("\t", "  ")
    return re.sub(r"[^\n\x20-\x7e -ɏ‐-‧←-⇿─-◿✓✗£€]", "", text)


def wrap(text, fnt, width, max_lines=None):
    """Wrap text to a pixel width. Returns lines; if cut, the last one ends with an ellipsis."""
    out = []
    for para in clean(text).split("\n"):
        para = para.rstrip()
        if not para:
            if out and out[-1] != "":
                out.append("")
            continue
        words = para.split(" ")
        cur = ""
        for w in words:
            trial = (cur + " " + w) if cur else w
            if fnt.getlength(trial) <= width:
                cur = trial
                continue
            if cur:
                out.append(cur)
            # A word longer than the line is cut into pieces.
            while fnt.getlength(w) > width:
                n = len(w)
                while n > 1 and fnt.getlength(w[:n]) > width:
                    n -= 1
                out.append(w[:n])
                w = w[n:]
            cur = w
        if cur:
            out.append(cur)
    while out and out[-1] == "":
        out.pop()
    if max_lines and len(out) > max_lines:
        out = out[:max_lines]
        out[-1] = fit(out[-1] + " …", fnt, width)
    return out


def fit(text, fnt, width):
    """One line, cut with an ellipsis if too wide."""
    text = clean(text).replace("\n", " ")
    if fnt.getlength(text) <= width:
        return text
    while text and fnt.getlength(text + "…") > width:
        text = text[:-1]
    return text + "…"


def model_name(mid):
    # "claude-opus-5-5" -> "Opus 5.5"
    parts = [p for p in re.sub(r"\[.*\]$", "", re.sub(r"^claude-", "", str(mid))).split("-") if not re.fullmatch(r"\d{8}", p)]
    words = [p[0].upper() + p[1:] for p in parts if p and not p.isdigit()]
    version = ".".join(p for p in parts if p.isdigit())
    return (" ".join(words) + (" " + version if version else "")).strip() or str(mid)


def tool_args(name, inp):
    if not isinstance(inp, dict):
        return ""
    for key in ("command", "file_path", "pattern", "query", "url", "description"):
        if inp.get(key):
            # The AI's commands usually start by moving into its own folder; that part says nothing.
            return re.sub(r"^\s*cd\s+\S+\s*(;|&&)\s*", "", str(inp[key]))
    return json.dumps(inp)


def result_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(c.get("text", "") if c.get("type") == "text" else "[image]" if c.get("type") == "image" else ""
                         for c in content if isinstance(c, dict))
    return ""


# ---- what the panel shows: a list of items, newest last ----
model = None
items = []          # dicts: {"kind": "say"|"think"|"tool", ...}
tools = {}          # tool_use id -> item


def on_entry(e):
    global model, items
    msg = e.get("message") if isinstance(e, dict) else None
    if not isinstance(msg, dict):
        return
    content = msg.get("content")
    if isinstance(content, str):
        content = [{"type": "text", "text": content}]
    if not isinstance(content, list):
        return
    if e.get("type") == "assistant":
        if msg.get("model") and not model and "synthetic" not in msg["model"]:
            model = model_name(msg["model"])
        for b in content:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "text" and b.get("text", "").strip():
                items.append({"kind": "say", "text": b["text"]})
            elif b.get("type") == "thinking" and b.get("thinking", "").strip():
                items.append({"kind": "think", "text": b["thinking"]})
            elif b.get("type") == "tool_use":
                it = {"kind": "tool", "name": b.get("name", "tool"), "args": tool_args(b.get("name"), b.get("input")), "result": None}
                items.append(it)
                tools[b.get("id")] = it
    elif e.get("type") == "user":
        for b in content:
            if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("tool_use_id") in tools:
                lines = [re.sub(r"\s{2,}", " ", l.strip()) for l in result_text(b.get("content")).split("\n")]
                lines = [l for l in lines if l]
                tools[b["tool_use_id"]]["result"] = {"bad": bool(b.get("is_error")), "lines": lines}
    if len(items) > 200:
        items = items[-100:]


# ---- drawing ----
def chip(d, x, y, text, fnt, padx, pady):
    """A rounded label; returns its width and height."""
    l, t, r, b = d.textbbox((0, 0), text, font=fnt)
    w, h = r - l + 2 * padx, b - t + 2 * pady
    d.rounded_rectangle((x, y, x + w, y + h), radius=h // 2, fill=CHIP_BG)
    d.text((x + padx - l, y + pady - t), text, font=fnt, fill=CHIP_FG)
    return w, h


def draw_header(d):
    d.rectangle((0, 0, W, HEADER_H), fill=HEAD)
    x, y = PAD, 12
    name = ("Claude " + model) if model else "Claude"
    cw, ch = chip(d, x, y, name, F_CHIP_BIG, 12, 6)
    d.text((x + cw + 10, y + ch / 2), "playing " + (INFO.get("scenario") or "the park"), font=F_TITLE, fill=WHITE, anchor="lm")
    goal = (INFO.get("goal") or "").replace("**", "")
    if goal:
        for i, line in enumerate(wrap("Goal: " + goal, F_GOAL, W - 2 * PAD, 2)):
            d.text((PAD, y + ch + 10 + i * 17), line, font=F_GOAL, fill=GOAL)


TEXT_W = W - 2 * PAD


def item_ops(it):
    """Turn one item into drawing steps (kind, x, dy, ...) and its height."""
    ops, h = [], 0
    if it["kind"] == "say":
        ops.append(("chip", 0, 0, model or "Claude"))
        h = 24
        for line in wrap(it["text"], F_TEXT, TEXT_W, 10):
            ops.append(("text", 0, h, line, F_TEXT, WHITE))
            h += LINE
    elif it["kind"] == "think":
        ops.append(("text", 0, 0, "thinking", F_LABEL, THINK))
        h = 18
        for line in wrap(it["text"], F_THINK, TEXT_W - 12, 4):
            ops.append(("text", 12, h, line, F_THINK, THINK))
            h += 17
    else:
        res = it["result"]
        dot = DIM if res is None else BAD if res["bad"] else OK
        ops.append(("dot", 0, 0, dot))
        name_w = F_MONO_B.getlength(it["name"])
        ops.append(("text", 14, 0, it["name"], F_MONO_B, TOOL))
        ops.append(("text", 14 + name_w + 9, 0, fit(it["args"], F_MONO, TEXT_W - 14 - name_w - 9), F_MONO, CMD))
        h = LINE
        if res is None:
            ops.append(("text", 14, h, "└ running…", F_MONO, DIM))
        else:
            mark, color = ("✗", BAD) if res["bad"] else ("✓", OK)
            first = res["lines"][0] if res["lines"] else "done"
            more = len(res["lines"]) - 1
            extra = f"  (+{more} lines)" if more > 0 else ""
            ops.append(("text", 14, h, "└", F_MONO, DIM))
            ops.append(("text", 30, h, mark, F_MONO_B, color))
            ops.append(("text", 46, h, fit(first, F_MONO, TEXT_W - 46 - F_MONO.getlength(extra)) + extra, F_MONO, DIM))
        h += LINE
    return ops, h


def render():
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    # Newest at the bottom; older items scroll up and are cut by the header.
    y = H - PAD
    top = HEADER_H + 8
    if not items:
        d.text((PAD, top + 8), "Waiting for the AI to start…", font=F_TEXT, fill=DIM)
    for it in reversed(items):
        ops, h = item_ops(it)
        y -= h
        for op in ops:
            kind, x, dy = op[0], PAD + op[1], y + op[2]
            if kind == "chip":
                chip(d, x, dy, op[3], F_CHIP, 9, 4)
            elif kind == "dot":
                d.ellipse((x + 1, dy + 4, x + 9, dy + 12), fill=op[3])
            else:
                d.text((x, dy), op[3], font=op[4], fill=op[5])
        y -= GAP
        if y < top:
            break
    draw_header(d)   # drawn last, so it covers anything that scrolled under it
    return img


def find_session():
    found = []
    for root, dirs, fs in os.walk(FOLDER):
        dirs[:] = [x for x in dirs if x not in ("node_modules", "notebook")]
        if os.sep + "projects" + os.sep not in root + os.sep:
            continue
        for f in fs:
            if f.endswith(".jsonl"):
                p = os.path.join(root, f)
                try:
                    found.append((os.path.getsize(p), p))
                except OSError:
                    pass
    return max(found)[1] if found else None


def save(img):
    tmp = OUT + ".tmp.png"
    img.save(tmp)
    os.replace(tmp, OUT)   # the recorder never reads a half-written picture


def main():
    path, offset, partial, last = None, 0, "", None
    while True:
        try:
            if not path:
                path = find_session()
            if path:
                size = os.path.getsize(path)
                if size > offset:
                    with open(path, "rb") as fh:
                        fh.seek(offset)
                        chunk = partial + fh.read(size - offset).decode("utf8", "replace")
                    offset = size
                    parts = chunk.split("\n")
                    partial = parts.pop()
                    for line in parts:
                        if line.strip():
                            try:
                                on_entry(json.loads(line))
                            except ValueError:
                                pass
            state = json.dumps([model, items], default=str)
            if state != last:
                last = state
                save(render())
        except Exception as err:   # the panel must never stop the run
            print("panel:", err, file=sys.stderr, flush=True)
        time.sleep(1)


if __name__ == "__main__":
    if len(sys.argv) > 4 and sys.argv[4] == "--first":
        # The opening picture, drawn once before the recorder starts (also checks that drawing works).
        save(render())
    elif len(sys.argv) > 4 and sys.argv[4] == "--once":
        # Test: read a whole session file and draw one picture.
        for line in open(FOLDER):
            if line.strip():
                on_entry(json.loads(line))
        save(render())
    else:
        main()
