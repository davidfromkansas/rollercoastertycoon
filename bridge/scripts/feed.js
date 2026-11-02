#!/usr/bin/env node
// Shows what Claude Code or Codex prints in the game's "AI output" panel, while it plays.
// Usage:
//   claude -p "$(cat TASK.md)" --output-format stream-json --verbose | node scripts/feed.js --title "Claude Opus"
//   codex exec --json "$(cat TASK.md)" | node scripts/feed.js --title "GPT-5 (Codex)"
// Options: --max-output-lines N  (command output lines to show, default 12; 0 = all)
// Everything read is also printed unchanged and saved to logs/feed-TIME.jsonl for replays.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { send, readConfig } = require('../cli.js');
const { toEntries } = require('../src/feed-format.js');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const option = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const title = option('--title', 'AI output');
const maxOutputLines = Number(option('--max-output-lines', 12));

const config = readConfig();
fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
const logFile = path.join(ROOT, 'logs', `feed-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
const log = fs.createWriteStream(logFile);

let pending = [];
let first = true;
let sending = Promise.resolve();
let warned = false;

// Send what has piled up in one request, at most 4 times a second, in order.
function flush() {
    if (pending.length === 0 && !first) return sending;
    const entries = pending.splice(0, 200);
    const args = { entries };
    if (first) Object.assign(args, { clear: true, title });
    first = false;
    sending = sending.then(() => send(config, { id: crypto.randomUUID(), op: 'feed', args }, 10000))
        .then(reply => {
            if (!reply.ok) throw new Error(reply.error);
        })
        .catch(e => {
            if (!warned) console.error(`feed: could not reach the game panel (${e.message}). Still saving to ${logFile}`);
            warned = true;
        });
    if (pending.length) return flush();
    return sending;
}
const timer = setInterval(flush, 250);

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
    process.stdout.write(line + '\n');
    log.write(line + '\n');
    pending.push(...toEntries(line, { maxOutputLines }));
});
input.on('close', async () => {
    clearInterval(timer);
    await flush();
    log.end();
    console.error(`feed: saved to ${logFile}`);
});
