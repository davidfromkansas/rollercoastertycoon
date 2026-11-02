// Runs beside a park run: saves the park at every game year end and copies the save into the run folder.
// Usage: node park/yearsave.js RUN_FOLDER
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { send, readConfig } = require('../cli.js');

const out = path.join(process.argv[2], 'saves');
const saveDir = path.join(__dirname, '..', 'user-data', 'save');
const config = readConfig();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ask = (op, extra = {}) => send(config, { id: crypto.randomUUID(), op, ...extra }, 60000);

async function save(name) {
    for (let tries = 0; tries < 12; tries++) {
        const hello = await ask('hello');
        const reply = await ask('save', { session: hello.result.session });
        if (reply.ok && reply.result.state === 'completed') {
            fs.mkdirSync(out, { recursive: true });
            fs.copyFileSync(path.join(saveDir, reply.result.filename), path.join(out, name + '.park'));
            console.log('saved ' + name);
            return;
        }
        await sleep(5000);  // usually "Another change is still running"
    }
    console.log('could not save ' + name);
}

(async () => {
    if (process.argv[3] === '--now') return save(process.argv[4] || 'final');
    let last = null;
    for (;;) {
        try {
            const p = (await ask('park')).result;
            const m = p.date.monthsElapsed;
            if (last !== null && m !== last && m % 8 === 0) await save(`year-${m / 8}-end`);
            last = m;
        } catch (e) { /* game busy or restarting; try again */ }
        await sleep(10000);
    }
})();
