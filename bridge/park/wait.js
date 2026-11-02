// Lets the game run and returns only at the end of a game year, on an alert (including any red game warning), or after a time limit.
// Prints new game messages as they arrive.
// Usage: node wait.js [--max-minutes 9] [--cash-floor 1000]
// Prints one line per game month seen while waiting, then why it stopped.
'use strict';
const crypto = require('node:crypto');
const { send, readConfig, unseenNews } = require('./cli.js');

const argv = process.argv.slice(2);
const option = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : fallback;
};
const maxMs = option('--max-minutes', 9) * 60000;
const cashFloor = option('--cash-floor', 1000);  // in £, the game counts money in tenths (10 = £1)

const MONTHS = ['March', 'April', 'May', 'June', 'July', 'August', 'September', 'October'];
const config = readConfig();
let warned = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function park() {
    const reply = await send(config, { id: crypto.randomUUID(), op: 'park' }, 30000);
    if (!reply.ok) throw new Error(reply.error);
    // News ticker: print every new game message; a red warning ends the wait.
    for (const n of unseenNews(reply.recentNews || [])) {
        console.log(`${n.warning ? 'WARNING' : 'News'}: ${n.text}`);
        if (n.warning) warned = n.text;
    }
    return reply.result;
}

function line(p) {
    const m = p.date.monthsElapsed;
    return `Year ${Math.floor(m / 8) + 1} ${MONTHS[m % 8]}: guests ${p.park.guests}, rating ${p.park.rating}, ` +
        `cash £${Math.round(p.park.cash / 10)}, guest cap ${p.park.suggestedGuestMaximum}, goal ${p.scenario.status}`;
}

(async () => {
    const start = Date.now();
    let p = await park();
    const firstStatus = p.scenario.status;
    let lastMonth = p.date.monthsElapsed;
    let lastGuests = p.park.guests;
    let falls = 0;
    console.log('Now: ' + line(p));
    const stop = reason => { console.log('Stopped waiting: ' + reason); process.exit(0); };
    if (p.paused) stop('the game is paused (nothing happens until you unpause it)');
    while (Date.now() - start < maxMs) {
        await sleep(5000);
        p = await park();
        if (p.paused) stop('the game is paused');
        if (warned) stop('the game gave a warning: ' + warned);
        if (p.scenario.status !== firstStatus) stop('the goal is now ' + p.scenario.status);
        if (p.park.cash / 10 < cashFloor) stop(`cash is below £${cashFloor}`);
        if (p.date.monthsElapsed === lastMonth) continue;
        lastMonth = p.date.monthsElapsed;
        console.log(line(p));
        falls = p.park.guests < lastGuests ? falls + 1 : 0;
        lastGuests = p.park.guests;
        if (falls >= 3) stop('guests fell three months in a row');
        if (lastMonth % 8 === 0) stop('a game year ended');
    }
    stop(`${maxMs / 60000} real minutes passed`);
})().catch(e => { console.log('Error: ' + e.message); process.exit(1); });
