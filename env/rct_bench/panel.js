// Side panel for the run video (display only; the AI never sees or uses it).
// Follows the AI's own conversation log (Claude Code's session file) and keeps a text file with the
// newest part of it: what the AI says, thinks, runs, and what comes back. The screen recorder draws
// that file to the right of the game, so the panel in the video always matches the moment in the game.
//   node panel.js AI_FOLDER OUT_TEXT_FILE [HEADER_FILE INFO_JSON]
// The header shows the model's name (read from the log) and the scenario's goal (from INFO_JSON: {scenario, goal}).
// Runs as root. Settings: PANEL_COLUMNS (characters per line), PANEL_ROWS (lines shown).
'use strict';
const fs = require('fs');
const path = require('path');

const FOLDER = process.argv[2];
const OUT = process.argv[3];
const HEADER = process.argv[4];
let info = {};
try { info = JSON.parse(fs.readFileSync(process.argv[5], 'utf8')); } catch (e) { /* no header details */ }
let model = null;    // e.g. "Opus 5.5", from the log
let lastHeader = '';
const COLS = Number(process.env.PANEL_COLUMNS || 70);
const ROWS = Number(process.env.PANEL_ROWS || 29);
const MAX_RESULT_LINES = 3;

let file = null;     // the session file being followed
let offset = 0;      // how far it has been read
let partial = '';    // an unfinished last line
let lines = [];      // wrapped panel lines, newest last
let last = '';

// Newest Claude Code session file under the AI's folder (any *.jsonl in a "projects" folder).
function findSession(dir, depth = 0, found = []) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return found; }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory() && depth < 6 && e.name !== 'node_modules' && e.name !== 'notebook') findSession(p, depth + 1, found);
        else if (e.isFile() && e.name.endsWith('.jsonl') && p.includes(`${path.sep}projects${path.sep}`)) {
            try { found.push({ p, size: fs.statSync(p).size }); } catch (err) { /* gone */ }
        }
    }
    return found;
}

// Plain characters only: the video font has no emoji, and % or \ could be misread.
function clean(text) {
    return String(text || '').replace(/\r/g, '').replace(/\t/g, '  ')
        .replace(/[^\n\x20-\x7E -ɏ‘-”…£]/g, '');
}

function wrap(text, prefix, cols = COLS) {
    const pad = ' '.repeat(prefix.length);
    const out = [];
    clean(text).split('\n').forEach((para, i) => {
        let rest = para.trimEnd();
        let first = out.length === 0;
        if (!rest) { if (!first) out.push(''); return; }
        while (rest.length) {
            const lead = first ? prefix : pad;
            const room = cols - lead.length;
            let cut = rest.length <= room ? rest.length : rest.lastIndexOf(' ', room);
            if (cut <= 0) cut = room;
            out.push(lead + rest.slice(0, cut));
            rest = rest.slice(cut).trimStart();
            first = false;
        }
    });
    return out;
}

function add(text, prefix, maxLines) {
    let w = wrap(text, prefix);
    if (maxLines && w.length > maxLines) w = w.slice(0, maxLines - 1).concat([' '.repeat(prefix.length) + '...']);
    if (!w.length) return;
    if (lines.length) lines.push('');
    lines.push(...w);
    if (lines.length > ROWS * 4) lines = lines.slice(-ROWS * 2);
}

function toolText(name, input) {
    if (!input || typeof input !== 'object') return name;
    if (name === 'Bash' && input.command) return input.command;
    if (input.file_path) return `${name} ${input.file_path}`;
    if (input.pattern) return `${name} ${input.pattern}`;
    if (input.query) return `${name} ${input.query}`;
    if (input.url) return `${name} ${input.url}`;
    return `${name} ${JSON.stringify(input)}`;
}

function resultText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(c => (c && c.type === 'text' ? c.text : c && c.type === 'image' ? '[image]' : '')).join('\n');
    return '';
}

// "claude-opus-5-5" -> "Opus 5.5"; "claude-sonnet-4-5-20250929" -> "Sonnet 4.5".
function modelName(id) {
    const parts = String(id).replace(/^claude-/, '').replace(/\[.*\]$/, '').split('-').filter(p => !/^\d{8}$/.test(p));
    const words = parts.filter(p => !/^\d+$/.test(p)).map(w => w[0].toUpperCase() + w.slice(1));
    const version = parts.filter(p => /^\d+$/.test(p)).join('.');
    return (words.join(' ') + (version ? ' ' + version : '')).trim() || String(id);
}

function onEntry(entry) {
    const msg = entry && entry.message;
    if (!msg || !Array.isArray(msg.content) && typeof msg.content !== 'string') return;
    if (entry.type === 'assistant' && msg.model && !model && !/synthetic/.test(msg.model)) model = modelName(msg.model);
    const who = (model || 'AI') + ': ';
    if (entry.type === 'assistant') {
        for (const block of [].concat(msg.content)) {
            if (typeof block === 'string') add(block, who);
            else if (block.type === 'thinking' && block.thinking) add(block.thinking, 'thinks: ', 8);
            else if (block.type === 'text' && block.text) add(block.text, who);
            else if (block.type === 'tool_use') add(toolText(block.name, block.input), '$ ', 6);
        }
    } else if (entry.type === 'user' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
            if (block.type === 'tool_result') {
                // Results lose their indentation and blank lines, so more of them fits.
                const text = resultText(block.content).split('\n').map(l => l.trim().replace(/\s{2,}/g, ' ')).filter(Boolean).join('\n');
                if (text) add(text, block.is_error ? '! ' : '> ', MAX_RESULT_LINES);
            }
        }
    }
}

function writeHeader() {
    if (!HEADER) return;
    const title = `${model ? 'Claude ' + model : 'The AI'} playing ${info.scenario || 'the park'}\n`;
    const goal = (info.goal ? wrap('Goal: ' + info.goal.replace(/\*\*/g, ''), '', 78).slice(0, 2) : [' ']).join('\n') + '\n';
    if (title + goal === lastHeader) return;
    lastHeader = title + goal;
    // Two files: the title (large) and the goal (small), each drawn by the recorder.
    for (const [f, text] of [[HEADER, title], [HEADER.replace(/\.txt$/, '') + '-goal.txt', goal]]) {
        fs.writeFileSync(f + '.tmp', text);
        fs.renameSync(f + '.tmp', f);
    }
}

function write() {
    writeHeader();
    const shown = lines.slice(-ROWS);
    while (shown.length < ROWS) shown.unshift('');
    // Empty lines are written as one space: the recorder's text drawing skips the rest of the text after an empty first line.
    const text = shown.map(l => l || ' ').join('\n') + '\n';
    if (text === last) return;
    last = text;
    // Write then rename, so the recorder never reads a half-written file.
    fs.writeFileSync(OUT + '.tmp', text);
    fs.renameSync(OUT + '.tmp', OUT);
}

function tick() {
    try {
        if (!file) {
            const found = findSession(FOLDER).sort((a, b) => b.size - a.size);
            if (found.length) { file = found[0].p; offset = 0; }
        }
        if (file) {
            const size = fs.statSync(file).size;
            if (size > offset) {
                const fd = fs.openSync(file, 'r');
                const buf = Buffer.alloc(size - offset);
                fs.readSync(fd, buf, 0, buf.length, offset);
                fs.closeSync(fd);
                offset = size;
                const chunk = partial + buf.toString('utf8');
                const parts = chunk.split('\n');
                partial = parts.pop();
                for (const line of parts) {
                    if (!line.trim()) continue;
                    try { onEntry(JSON.parse(line)); } catch (e) { /* not a full entry */ }
                }
            }
        }
        write();
    } catch (e) { /* keep going: the panel must never stop the run */ }
}

lines = ['Waiting for the AI to start...'];
write();
setInterval(tick, 1000);
