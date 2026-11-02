// Adds the wall-clock time to every line of claude's stream-json output and saves it.
// With --print, also shows what the player says, thinks and runs.
const rl = require('node:readline').createInterface({ input: process.stdin });
const out = require('node:fs').createWriteStream(process.argv[2], { flags: 'a' });
const print = process.argv.includes('--print');
rl.on('line', l => {
  out.write(JSON.stringify({ t: Date.now(), line: l }) + '\n');
  if (!print) return;
  let e; try { e = JSON.parse(l); } catch { return; }
  if (e.type !== 'assistant') return;
  for (const c of e.message.content) {
    if (c.type === 'text' && c.text.trim()) console.log('\n' + c.text.trim());
    if (c.type === 'thinking' && c.thinking && c.thinking.trim()) console.log('\n(thinking) ' + c.thinking.trim());
    if (c.type === 'tool_use') console.log('  $ ' + String((c.input && (c.input.command || c.input.file_path)) || c.name).replace(/\s+/g, ' ').slice(0, 160));
  }
});
rl.on('close', () => out.end());
