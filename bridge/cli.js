#!/usr/bin/env node
// The helper an AI agent (or you) runs to talk to the game.
// Examples:
//   node cli.js hello
//   node cli.js park
//   node cli.js map '{"x":60,"y":60,"width":8,"height":8}'
//   node cli.js arm
//   node cli.js request examples/set-ride-price.json
'use strict';
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const LOGS = path.join(ROOT, 'logs');
const SESSION_FILE = path.join(LOGS, 'session.json');
const CHANGE_OPS = new Set(['action.execute', 'batch.execute', 'track.build', 'coaster.build', 'save']);
const NOT_DONE_STATES = ['partial', 'stopped', 'outcome_unknown', 'started'];
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

const HELP = `Usage: node cli.js COMMAND [ARGS]

Look (safe, always allowed):
  hello                      bridge status, game API version, current session
  park                       money, guests, rating, scenario goal, date
  rides | ride '{"ride":3}'  ride stats
  map '{"x":60,"y":60,"width":8,"height":8}'   tiles (map squares) in an area
  guests | staff '{"offset":0,"limit":50}'
  objects '{"type":"ride"}'  things loaded in this park (rides, scenery, ...)
  schema [ACTION]            allowed game actions and their arguments
  capture                    save a screenshot (a copy goes in screenshots/ here)
  news '{"limit":50}'        all game messages, newest first (warning: true = red warning)
                             Every command also shows new game messages since your last command as gameNews.
  receipt REQUEST-ID         what happened to an earlier change
  track.walk / track.plan / track.catalog / action.query   (see README)

Change (needs "arm" first):
  arm                        allow changes for the current park
  stop                       disallow changes again
  save                       save a checkpoint copy of the park
  objective.set '{"type":"guestsAndRating","guests":50000}'   set the park's goal: once per loaded park, before "arm"
                             (also none, haveFun, buildTheBest, guestsBy, parkValueBy, repayLoanAndParkValue; year 1-25,
                             parkValue in game money, 10 = $1)
  request FILE.json          send a request written in a file`;

function readConfig() {
    const file = path.join(ROOT, 'bridge.config.json');
    if (!fs.existsSync(file)) throw new Error('bridge.config.json not found. Run scripts/setup.sh first.');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (config.host !== '127.0.0.1') throw new Error('Only 127.0.0.1 (this computer) is supported');
    return config;
}

// Send one request and wait for its one-line reply.
function send(config, request, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        let buffer = '';
        let settled = false;
        const socket = net.createConnection({ host: '127.0.0.1', port: config.port });
        socket.setEncoding('utf8');

        const done = (err, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            if (err) reject(err);
            else resolve(value);
        };
        const timer = setTimeout(() => done(new Error(
            'No answer in time. A change may or may not have happened: check it with "receipt", never resend.')), timeoutMs);

        socket.on('connect', () => socket.write(JSON.stringify({ ...request, token: config.token }) + '\n'));
        socket.on('error', err => done(err.code === 'ECONNREFUSED'
            ? new Error('Could not connect. Is the game running (scripts/start.sh) with a park open?')
            : err));
        socket.on('close', () => done(new Error('Connection closed before an answer. Check the receipt before any further change.')));
        socket.on('data', chunk => {
            buffer += chunk;
            if (buffer.length > MAX_RESPONSE_BYTES) return done(new Error('Answer too large (over 32 MB)'));
            const newline = buffer.indexOf('\n');
            if (newline < 0) return;
            try {
                const reply = JSON.parse(buffer.slice(0, newline));
                if (reply.id !== request.id) throw new Error('Answer was for a different request');
                done(null, reply);
            } catch (e) {
                done(e);
            }
        });
    });
}

// Write a file that must not already exist, and flush it to disk.
// Used so a change request's id can never be reused.
function writeOnce(file, value) {
    const fd = fs.openSync(file, 'wx');
    try {
        fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
}

function parseArgs(text) {
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error(`Arguments must be JSON, for example '{"ride":3}'. Got: ${text}`);
    }
}

async function buildRequest(config, command, arg) {
    if (command === 'request') {
        if (!arg) throw new Error('Usage: node cli.js request FILE.json');
        return JSON.parse(fs.readFileSync(path.resolve(arg), 'utf8'));
    }
    if (command === 'arm') {
        const hello = await send(config, { id: crypto.randomUUID(), op: 'hello' });
        if (!hello.ok) throw new Error(hello.error);
        return { op: 'arm', session: hello.result.session };
    }
    if (command === 'receipt') {
        if (!arg) throw new Error('Usage: node cli.js receipt REQUEST-ID');
        return { op: 'receipt', args: { id: arg } };
    }
    return { op: command, args: parseArgs(arg) };
}

// News ticker: the game sends its newest messages with every reply. Show only the ones this folder
// has not seen yet, as `gameNews` (warning: true = the game's red warnings). The first time, show the last 10.
const NEWS_SEEN_FILE = path.join(LOGS, 'news-seen.json');
function unseenNews(recent) {
    let seen = null;
    try { seen = JSON.parse(fs.readFileSync(NEWS_SEEN_FILE, 'utf8')); } catch (e) { /* first time */ }
    const known = new Set(seen || []);
    let fresh = recent.filter(n => !known.has(n.key));
    if (seen === null) fresh = fresh.slice(-10);
    const keep = [...(seen || []), ...recent.map(n => n.key).filter(k => !known.has(k))].slice(-500);
    fs.mkdirSync(LOGS, { recursive: true });
    fs.writeFileSync(NEWS_SEEN_FILE, JSON.stringify(keep));
    return fresh.map(n => ({ month: n.month, day: n.day, type: n.type, warning: n.warning, text: n.text }));
}

function showNews(reply) {
    if (!reply || !Array.isArray(reply.recentNews)) return;
    const fresh = unseenNews(reply.recentNews);
    delete reply.recentNews;
    if (fresh.length) reply.gameNews = fresh;
}

async function main(argv) {
    const [command = 'hello', arg] = argv;
    if (command === 'help' || command === '--help' || command === '-h') {
        console.log(HELP);
        return;
    }
    if (command === 'schema') {
        const schemas = JSON.parse(fs.readFileSync(path.join(ROOT, 'generated', 'actions.json'), 'utf8'));
        const result = arg ? schemas[arg] : schemas;
        if (result === undefined) throw new Error(`Unknown action: ${arg}`);
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    const config = readConfig();
    fs.mkdirSync(LOGS, { recursive: true });
    const request = await buildRequest(config, command, arg);
    delete request.token;
    request.id = request.id || crypto.randomUUID();
    if (!/^[-a-zA-Z0-9]{8,80}$/.test(request.id)) throw new Error('id must be 8 to 80 letters, digits or hyphens');

    const isChange = CHANGE_OPS.has(request.op);
    if (isChange) {
        if (!request.session && fs.existsSync(SESSION_FILE)) {
            request.session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')).session;
        }
        if (!request.session) throw new Error('Run "node cli.js arm" first');
        // Record the intent on disk BEFORE sending. If this id was used before, this fails and nothing is sent.
        writeOnce(path.join(LOGS, `${request.id}.request.json`), request);
    }

    const reply = await send(config, request);

    // For saves and screenshots, confirm the file really exists.
    if (reply.ok && (request.op === 'save' || request.op === 'capture') && reply.result && reply.result.filename) {
        const name = reply.result.filename;
        if (path.basename(name) !== name) throw new Error('Unsafe file name in answer');
        // The game's user-data folder; a player folder set up apart from the game names it in bridge.config.json.
        const userData = config.userDataPath || path.join(ROOT, 'user-data');
        const file = path.join(userData, request.op === 'save' ? 'save' : 'screenshot', name);
        try {
            const bytes = fs.readFileSync(file);
            if (bytes.length === 0) throw new Error('file is empty');
            let local = file;
            if (request.op === 'capture') {
                // Keep a copy next to the helper, so the agent can open and look at it.
                fs.mkdirSync(path.join(ROOT, 'screenshots'), { recursive: true });
                local = path.join(ROOT, 'screenshots', name);
                if (local !== file) fs.writeFileSync(local, bytes);
            }
            Object.assign(reply.result, {
                fileVerified: true, path: local, bytes: bytes.length,
                sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
            });
        } catch (e) {
            Object.assign(reply.result, { fileVerified: false, detail: `The game answered, but the file could not be checked: ${e.message}` });
        }
    }

    if (isChange) writeOnce(path.join(LOGS, `${request.id}.response.json`), reply);
    if (command === 'arm' && reply.ok) fs.writeFileSync(SESSION_FILE, JSON.stringify({ session: reply.result.session }));
    if (command === 'stop' && fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);

    showNews(reply);
    console.log(JSON.stringify(reply, null, 2));
    if (!reply.ok || (isChange && reply.result && NOT_DONE_STATES.includes(reply.result.state))) process.exitCode = 1;
}

if (require.main === module) {
    main(process.argv.slice(2)).catch(e => {
        console.error(e.message);
        process.exitCode = 1;
    });
}

module.exports = { send, writeOnce, main, readConfig, unseenNews };
