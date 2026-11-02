// Scores the coaster challenge. Usage:
//   node judge.js measure START_CASH_TENTHS   -> prints the scorecard (before the guest month)
//   node judge.js month RIDE_ID               -> opens park + ride, runs one game month, prints satisfaction
'use strict';
const crypto = require('node:crypto');
const { send, readConfig } = require('../cli.js');
const P = require('./plot.json');

const config = readConfig();
async function rpc(op, args, session) {
    const req = { id: crypto.randomUUID(), op, args: args || {} };
    if (session) req.session = session;
    const r = await send(config, req, 300000);
    if (!r.ok) throw new Error(op + ': ' + r.error);
    return r.result;
}

async function scan() {
    const catalog = await rpc('track.catalog');
    const inversion = {};
    for (const s of catalog) inversion[s.type] = !!s.isInversion;
    const tiles = [];
    const x0 = P.x1 - 8, y0 = P.y1 - 8, x1 = P.x2 + 8, y1 = P.y2 + 8;
    for (let y = y0; y <= y1; y += 32) for (let x = x0; x <= x1; x += 32) {
        tiles.push(...await rpc('map', { x, y, width: Math.min(32, x1 - x + 1), height: Math.min(32, y1 - y + 1) }));
    }
    const rides = {};
    for (const t of tiles) {
        const surf = t.elements.find(e => e.type === 'surface');
        const inPlot = t.x >= P.x1 && t.x <= P.x2 && t.y >= P.y1 && t.y <= P.y2;
        for (const e of t.elements) {
            if ((e.type !== 'track' && e.type !== 'entrance') || e.ride === undefined || e.ride === null) continue;
            const r = rides[e.ride] = rides[e.ride] || { tiles: new Set(), outside: new Set(), inversions: 0, terrain: new Set() };
            const key = t.x + ',' + t.y;
            r.tiles.add(key);
            if (!inPlot) r.outside.add(key);
            if (e.type === 'track') {
                if (e.sequence === 0 && inversion[e.trackType]) r.inversions++;
                if (surf && (e.baseZ < surf.baseZ || surf.waterHeight > 0)) r.terrain.add(key);
            }
        }
    }
    return rides;
}

function score(stats, footprint, startCash, cash) {
    const spent = Math.max(0, (startCash - cash) / 10);
    const exc = (stats.excitement || 0) / 100, inten = (stats.intensity || 0) / 100;
    const c = {};
    c.excitement = inten > 9 ? 0 : exc * 10;
    c.value = spent > 0 ? Math.min(20, 20 * exc / (spent / 1000)) : 0;
    c.inversions = Math.min(24, 3 * footprint.inversions);
    c.airtime = Math.min(20, 2 * (stats.totalAirTime || 0));
    c.footprint = Math.max(0, 15 * (1 - footprint.tiles.size / 300));
    c.terrain = Math.min(20, footprint.terrain.size);
    return { spent, excitement: exc, intensity: inten, nausea: (stats.nausea || 0) / 100, points: c };
}

async function measure(startCash) {
    const park = await rpc('park');
    const rides = await scan();
    const results = [];
    for (const id of Object.keys(rides)) {
        const f = rides[id];
        const r = await rpc('ride', { ride: Number(id) });
        const s = score(r, f, startCash, park.park.cash);
        const problems = [];
        if (f.outside.size) problems.push(`${f.outside.size} tiles outside the plot`);
        if (s.spent > P.budget) problems.push(`over budget (£${s.spent.toFixed(0)})`);
        if (!(r.excitement > 0)) problems.push('no test ratings');
        if (f.inversions < 1) problems.push('no inversion');
        if (r.status !== 'open') problems.push(`status is ${r.status}`);
        results.push({ ride: Number(id), name: r.name, status: r.status, tiles: f.tiles.size, inversions: f.inversions,
            terrainTiles: f.terrain.size, airtime: r.totalAirTime, maxSpeed: r.maxSpeed, rideLength: r.rideLength,
            ...s, problems, subtotal: problems.length ? 0 : Object.values(s.points).reduce((a, b) => a + b, 0) });
    }
    results.sort((a, b) => b.subtotal - a.subtotal);
    console.log(JSON.stringify({ cash: park.park.cash, date: park.date, results }, null, 2));
}

async function month(rideId) {
    const hello = await rpc('hello');
    if (!hello.armed) await rpc('arm');
    const session = (await rpc('hello')).session;
    const act = (action, args) => rpc('batch.execute', { actions: [{ action, args }], maxCost: 0 }, session);
    await act('parksetparameter', { parameter: 1, value: 0 }).catch(e => console.error('open park:', e.message));
    const r0 = await rpc('ride', { ride: rideId });
    if (r0.status !== 'open') await act('ridesetstatus', { ride: rideId, status: 1 }).catch(e => console.error(e.message));
    const p0 = await rpc('park');
    if (p0.paused) await act('pausetoggle', {});
    await act('gamesetspeed', { speed: 4 }).catch(() => {});
    const start = p0.date.monthsElapsed;
    while ((await rpc('park')).date.monthsElapsed < start + 2) await new Promise(r => setTimeout(r, 3000));
    await act('gamesetspeed', { speed: 1 }).catch(() => {});
    const r = await rpc('ride', { ride: rideId });
    const p = await rpc('park');
    const sat = r.satisfaction > 100 ? null : r.satisfaction;
    console.log(JSON.stringify({ satisfaction: sat, points: sat === null ? 0 : sat / 5, totalCustomers: r.totalCustomers,
        guestsInPark: p.park.guests, date: p.date }, null, 2));
}

const [cmd, arg] = process.argv.slice(2);
(cmd === 'measure' ? measure(Number(arg)) : month(Number(arg))).catch(e => { console.error(e); process.exit(1); });
