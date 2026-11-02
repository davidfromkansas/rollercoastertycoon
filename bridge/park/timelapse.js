// Records a time-lapse of a running park: one in-game picture every few seconds, taken off-screen so the
// player's view is not touched, then joined into an MP4 with ffmpeg when the run ends.
// Usage: node park/timelapse.js RUN_FOLDER [--every 10] [--x 110 --y 88 --zoom 2]   (x, y in tiles)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { send, readConfig } = require('../cli.js');

const run = process.argv[2];
const argv = process.argv.slice(3);
const option = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 ? Number(argv[i + 1]) : fallback;
};
const every = option('--every', 10) * 1000;
const view = { x: option('--x', 110) * 32, y: option('--y', 88) * 32, zoom: option('--zoom', 2), width: 1920, height: 1080 };
const frames = path.join(run, 'video', 'frames');
const shots = path.join(__dirname, '..', 'user-data', 'screenshot');
const config = readConfig();
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(frames, { recursive: true });

const running = () => {
    try { execFileSync('pgrep', ['-f', 'park/run-mac.sh']); return true; } catch (e) { return false; }
};

(async () => {
    let n = fs.readdirSync(frames).length;
    while (running()) {
        try {
            const reply = await send(config, { id: crypto.randomUUID(), op: 'capture', args: view }, 30000);
            if (reply.ok) {
                const file = path.join(shots, reply.result.filename);
                for (let i = 0; i < 20 && !fs.existsSync(file); i++) await sleep(250);
                if (fs.existsSync(file)) fs.renameSync(file, path.join(frames, `f${String(n++).padStart(5, '0')}.png`));
            }
        } catch (e) { /* game restarting or busy; try again */ }
        await sleep(every);
    }
    console.log(`run ended, ${n} frames`);
    const out = path.join(run, 'video', 'timelapse.mp4');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '12', '-i', path.join(frames, 'f%05d.png'),
        '-vf', 'scale=1920:-2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', out]);
    console.log('wrote ' + out);
})();
