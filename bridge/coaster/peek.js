// Prints the agent's recent text + tool calls from a run's agent.jsonl.
const f = process.argv[2], n = +(process.argv[3] || 20);
const out = [];
for (const l of require('fs').readFileSync(f, 'utf8').trim().split('\n')) {
  let o, e; try { o = JSON.parse(l); e = JSON.parse(o.line); } catch { continue; }
  const ts = new Date(o.t).toISOString().slice(11, 19);
  if (e.type === 'system' && e.model) out.push(ts + ' MODEL ' + e.model);
  if (e.type === 'result') out.push(ts + ' RESULT ' + JSON.stringify(e).slice(0, 300));
  if (e.type !== 'assistant') continue;
  for (const c of e.message.content) {
    if (c.type === 'text') out.push(ts + ' TEXT ' + c.text.slice(0, 400));
    if (c.type === 'thinking' && c.thinking) out.push(ts + ' THINK ' + c.thinking.slice(0, 200));
    if (c.type === 'tool_use') out.push(ts + ' TOOL ' + JSON.stringify(c.input).slice(0, 200));
  }
}
console.log(out.slice(-n).join('\n'));
