// Records the park as a series of top-down map snapshots, for watching a game without graphics.
// Usage: node scripts/record.js [seconds between frames] [number of frames] [output file]
//   e.g. node scripts/record.js 3 40 recordings/solar-park.json
// Open the result in viewer/viewer.html.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { send } = require('../cli.js');

const ROOT = path.resolve(__dirname, '..');
const [everySeconds = 3, frameCount = 40, outFile = `recordings/recording-${Date.now()}.json`] = process.argv.slice(2);

async function ask(config, op, args = {}) {
    const reply = await send(config, { id: crypto.randomUUID(), op, args });
    if (!reply.ok) throw new Error(`${op}: ${reply.error}`);
    return reply.result;
}

async function main() {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'bridge.config.json'), 'utf8'));
    const rides = await ask(config, 'rides');
    const recording = {
        recordedAt: new Date().toISOString(),
        rides: rides.map(r => ({ id: r.id, name: r.name, classification: r.classification })),
        frames: [],
    };
    for (let i = 0; i < Number(frameCount); i++) {
        const [overview, park] = await Promise.all([ask(config, 'overview', { guests: true }), ask(config, 'park')]);
        if (i === 0) {
            recording.width = overview.width;
            recording.height = overview.height;
            recording.legend = overview.legend;
        }
        recording.frames.push({
            date: park.date,
            paused: park.paused,
            cash: park.park.cash,
            guests: park.park.guests,
            rating: park.park.rating,
            rows: overview.rows,
            rideTiles: overview.rideTiles,
            people: overview.guests,
        });
        process.stdout.write(`frame ${i + 1}/${frameCount}\r`);
        if (i + 1 < Number(frameCount)) await new Promise(r => setTimeout(r, Number(everySeconds) * 1000));
    }
    // The map rarely changes, so store each frame's rows only when they differ from the previous frame.
    for (let i = recording.frames.length - 1; i > 0; i--) {
        const now = recording.frames[i];
        const before = recording.frames[i - 1];
        if (JSON.stringify(now.rows) === JSON.stringify(before.rows)) delete now.rows;
        if (JSON.stringify(now.rideTiles) === JSON.stringify(before.rideTiles)) delete now.rideTiles;
    }
    const file = path.resolve(ROOT, outFile);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(recording));
    console.log(`\nSaved ${recording.frames.length} frames to ${path.relative(ROOT, file)}`);
}

main().catch(e => {
    console.error(e.message);
    process.exitCode = 1;
});
