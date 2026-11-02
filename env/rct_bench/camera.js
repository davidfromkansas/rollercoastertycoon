// Camera for the run video (display only; the AI never sees or uses it).
// Watches the AI's change requests (its logs/*.request.json) and points the game camera:
// close up on the spot the AI just changed, and back out to the whole park after a quiet spell.
//   node camera.js AI_LOGS_DIR
// Runs as root; moves the camera through the game's own bridge as the game's user.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const LOGS = process.argv[2];
const BRIDGE = '/home/player/bridge';
const CLOSE = Number(process.env.CAMERA_CLOSE_ZOOM || 0);  // 0 = closest
const FAR = Number(process.env.CAMERA_FAR_ZOOM || 1);
const QUIET_MS = Number(process.env.CAMERA_QUIET_SECONDS || 12) * 1000;

function bridge(op, args) {
    const out = execFileSync('runuser', ['-u', 'player', '--', 'env', 'HOME=/home/player', 'node', 'cli.js', op, JSON.stringify(args || {})],
        { cwd: BRIDGE, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out);
}

let mapMax = 256 * 32;
try { mapMax = bridge('park').result.mapSize.x * 32; } catch (e) { /* keep default */ }

// Every {x, y} pair in a request that looks like a spot on the map (world units).
function spots(value, found = []) {
    if (Array.isArray(value)) value.forEach(v => spots(v, found));
    else if (value && typeof value === 'object') {
        if (Number.isFinite(value.x) && Number.isFinite(value.y) && value.x >= 0 && value.y >= 0 && value.x < mapMax && value.y < mapMax) {
            found.push({ x: value.x, y: value.y });
        }
        Object.values(value).forEach(v => spots(v, found));
    }
    return found;
}

const seen = new Set();
const all = [];          // every spot the AI has worked on, for the zoomed-out centre
let lastAction = 0;
let close = false;

function look(args) {
    try { bridge('view', args); } catch (e) { /* the game may be busy; try again next time */ }
}

function tick() {
    let files = [];
    try { files = fs.readdirSync(LOGS).filter(f => f.endsWith('.request.json') && !seen.has(f)); } catch (e) { /* not made yet */ }
    let latest = null;
    for (const f of files) {
        seen.add(f);
        try {
            const found = spots(JSON.parse(fs.readFileSync(path.join(LOGS, f), 'utf8')).args);
            if (found.length) {
                latest = found[found.length - 1];
                all.push(...found);
                if (all.length > 400) all.splice(0, all.length - 400);
            }
        } catch (e) { /* half-written file: skip */ }
    }
    const now = Date.now();
    if (latest) {
        lastAction = now;
        close = true;
        look({ x: latest.x, y: latest.y, zoom: CLOSE });
    } else if (close && now - lastAction > QUIET_MS) {
        close = false;
        const n = all.length || 1;
        const cx = Math.round(all.reduce((s, p) => s + p.x, 0) / n) || mapMax / 2;
        const cy = Math.round(all.reduce((s, p) => s + p.y, 0) / n) || mapMax / 2;
        look({ x: cx, y: cy, zoom: FAR });
    }
}

// Files already there at start belong to setup, not to the AI.
try { fs.readdirSync(LOGS).forEach(f => seen.add(f)); } catch (e) { /* none yet */ }
setInterval(tick, 1000);
