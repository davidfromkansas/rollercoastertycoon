// Turns a run's agent.jsonl into replay notes: the model's own words (verbatim) and the commands it ran.
// Usage: node notes.js OUTDIR SPEED > notes.json   (video time = real seconds since recording start / SPEED)
const fs = require('fs');
const [dir, speedArg] = process.argv.slice(2);
const speed = +speedArg || 1;
const t0 = +fs.readFileSync(dir + '/record-start.txt', 'utf8');
const notes = [];
const shortCmd = c => {
  const s = String(c).replace(/\s+/g, ' ').trim();
  return s.length > 220 ? s.slice(0, 217) + '…' : s;
};
for (const l of fs.readFileSync(dir + '/agent.jsonl', 'utf8').trim().split('\n')) {
  let o, e; try { o = JSON.parse(l); e = JSON.parse(o.line); } catch { continue; }
  if (e.type !== 'assistant') continue;
  const t = Math.max(0, (o.t - t0) / 1000 / speed), real = (o.t - t0) / 1000;
  for (const c of e.message.content) {
    if (c.type === 'thinking' && c.thinking && c.thinking.trim()) notes.push({ t, real, kind: 'think', text: c.thinking.trim() });
    if (c.type === 'text' && c.text.trim()) notes.push({ t, real, kind: 'say', text: c.text.trim() });
    if (c.type === 'tool_use') {
      const i = c.input || {};
      const text = i.command ? shortCmd(i.command) : i.file_path ? `${c.name} ${i.file_path.split('/').pop()}` : c.name;
      notes.push({ t, real, kind: 'run', text });
    }
  }
}
process.stdout.write(JSON.stringify(notes));
