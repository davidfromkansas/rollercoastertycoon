'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadFakeGame } = require('./fake-game.js');

async function armed(game) {
    const hello = await game.request({ op: 'hello' });
    const arm = await game.request({ op: 'arm', session: hello.result.session });
    assert.strictEqual(arm.ok, true);
    return hello.result.session;
}

test('listens only on 127.0.0.1 and starts read-only', async () => {
    const g = loadFakeGame();
    assert.deepStrictEqual(g.listenedOn(), { port: 21572, host: '127.0.0.1' });
    const hello = await g.request({ op: 'hello' });
    assert.strictEqual(hello.ok, true);
    assert.strictEqual(hello.result.armed, false);
    assert.strictEqual(hello.result.apiVersion, 122);
});

test('a wrong password is refused', async () => {
    const g = loadFakeGame();
    const reply = await g.request({ op: 'hello' }, { token: 'b'.repeat(64) });
    assert.strictEqual(reply.ok, false);
    assert.match(reply.error, /password/);
});

test('bad JSON gets a clear error', async () => {
    const g = loadFakeGame();
    const reply = await g.request({}, { raw: 'not json\n' });
    assert.deepStrictEqual(reply, { ok: false, error: 'Invalid JSON' });
});

test('reads park data', async () => {
    const g = loadFakeGame();
    const reply = await g.request({ op: 'park' });
    assert.strictEqual(reply.result.park.name, 'Test Park');
    assert.strictEqual(reply.result.park.cash, 100000);
});

test('changes are refused until armed', async () => {
    const g = loadFakeGame();
    const reply = await g.request({ op: 'action.execute', session: 'x', args: { action: 'ridesetprice', args: { ride: 3, price: 20, isPrimaryPrice: true }, maxCost: 0 } });
    assert.strictEqual(reply.ok, false);
    assert.match(reply.error, /read-only/);
    assert.strictEqual(g.executed.length, 0);
});

test('an armed change runs, is checked first, and leaves a receipt', async () => {
    const g = loadFakeGame();
    const session = await armed(g);
    const req = { id: 'price-change-1', op: 'action.execute', session, args: { action: 'ridesetprice', args: { ride: 3, price: 20, isPrimaryPrice: true }, maxCost: 0 } };
    const reply = await g.request(req);
    assert.strictEqual(reply.result.state, 'completed');
    assert.strictEqual(g.queried.length, 1);
    assert.strictEqual(g.executed.length, 1);
    const receipt = await g.request({ op: 'receipt', args: { id: 'price-change-1' } });
    assert.strictEqual(receipt.result.state, 'completed');
});

test('sending the same request id twice never repeats the change', async () => {
    const g = loadFakeGame();
    const session = await armed(g);
    const req = { id: 'repeat-test-1', op: 'action.execute', session, args: { action: 'ridesetprice', args: { ride: 3, price: 20, isPrimaryPrice: true }, maxCost: 0 } };
    await g.request(req);
    const again = await g.request(req);
    assert.strictEqual(again.result.state, 'completed');
    assert.strictEqual(g.executed.length, 1);
    const different = await g.request({ ...req, args: { ...req.args, args: { ride: 3, price: 99, isPrimaryPrice: true } } });
    assert.strictEqual(different.ok, false);
    assert.match(different.error, /already used/);
});

test('actions that are not on the allow-list are refused', async () => {
    const g = loadFakeGame();
    const session = await armed(g);
    const reply = await g.request({ op: 'action.execute', session, args: { action: 'cheatset', args: {}, maxCost: 0 } });
    assert.strictEqual(reply.ok, false);
    assert.match(reply.error, /not allowed/);
});

test('a batch stops at the budget and reports partial', async () => {
    const g = loadFakeGame({ costs: { staffhire: 5000 } });
    const session = await armed(g);
    const hire = { action: 'staffhire', args: { autoPosition: true, staffType: 0, costumeIndex: 0, staffOrders: 7 } };
    const reply = await g.request({ op: 'batch.execute', session, args: { actions: [hire, hire, hire], maxCost: 12000 } });
    assert.strictEqual(reply.result.state, 'partial');
    assert.strictEqual(reply.result.failure.phase, 'budget');
    assert.strictEqual(g.executed.length, 2);
    assert.strictEqual(reply.result.spent, 10000);
});

test('a failed check stops the batch without running the action', async () => {
    const g = loadFakeGame({ failOn: 'staffhire' });
    const session = await armed(g);
    const hire = { action: 'staffhire', args: { autoPosition: true, staffType: 0, costumeIndex: 0, staffOrders: 7 } };
    const reply = await g.request({ op: 'batch.execute', session, args: { actions: [hire], maxCost: 0 } });
    assert.strictEqual(reply.result.state, 'partial');
    assert.strictEqual(reply.result.failure.phase, 'check');
    assert.strictEqual(g.executed.length, 0);
});

test('STOP from the game menu disarms', async () => {
    const g = loadFakeGame();
    const session = await armed(g);
    g.game.menuItems['Agent bridge: STOP']();
    const reply = await g.request({ op: 'action.execute', session, args: { action: 'ridesetprice', args: { ride: 3, price: 20, isPrimaryPrice: true }, maxCost: 0 } });
    assert.strictEqual(reply.ok, false);
    assert.match(reply.error, /read-only/);
});

test('loading another park disarms and invalidates the session', async () => {
    const g = loadFakeGame();
    const session = await armed(g);
    g.hooks['map.changed']();
    const hello = await g.request({ op: 'hello' });
    assert.notStrictEqual(hello.result.session, session);
    assert.strictEqual(hello.result.armed, false);
});

test('coaster.build creates a ride and places every planned piece on it', async () => {
    const g = loadFakeGame();
    const session = await armed(g);
    const plan = await g.request({ op: 'track.plan', args: {
        start: { x: 2048, y: 2048, z: 64, direction: 0 }, requireClosed: true,
        pieces: [{ type: 'endStation', repeat: 2 }, { type: 'rightQuarterTurn3Tiles', repeat: 2 }, { type: 'flat', repeat: 2 }, { type: 'rightQuarterTurn3Tiles', repeat: 2 }],
    } });
    assert.strictEqual(plan.ok, true, plan.error);
    assert.strictEqual(plan.result.closed, true);
    const build = await g.request({ op: 'coaster.build', session, args: {
        planId: plan.result.planId, maxCost: 1000000, name: 'Loop',
        create: { rideType: 52, rideObject: 1, entranceObject: 0, colour1: 0, colour2: 0, inspectionInterval: 0 },
        test: true,
    } });
    assert.strictEqual(build.result.state, 'completed', JSON.stringify(build.result.failure));
    assert.strictEqual(build.result.ride, 7);
    const names = g.executed.map(e => e.name);
    assert.deepStrictEqual(names.slice(0, 2), ['ridecreate', 'ridesetname']);
    assert.strictEqual(names.filter(n => n === 'trackplace').length, 8);
    assert.strictEqual(names.at(-1), 'ridesetstatus');
    assert.ok(g.executed.slice(1).every(e => e.args.ride === 7));
});

test('save writes a uniquely named checkpoint', async () => {
    const g = loadFakeGame();
    const session = await armed(g);
    const reply = await g.request({ id: 'save-check-1', op: 'save', session });
    assert.strictEqual(reply.result.state, 'completed');
    assert.deepStrictEqual(g.game.saved, ['agent-checkpoint-save-check-1']);
});

test('objective.set works once per park and only before arming', async () => {
    const g = loadFakeGame();
    const bad = await g.request({ op: 'objective.set', args: { type: 'guestsAndRating', guests: 60000 } });
    assert.strictEqual(bad.ok, false);
    const reply = await g.request({ op: 'objective.set', args: { type: 'guestsAndRating', guests: 50000 } });
    assert.strictEqual(reply.ok, true, JSON.stringify(reply));
    const park = await g.request({ op: 'park' });
    assert.deepStrictEqual(park.result.scenario.objective, { type: 'guestsAndRating', guests: 50000 });
    assert.strictEqual(park.result.scenario.status, 'inProgress');
    const again = await g.request({ op: 'objective.set', args: { type: 'haveFun' } });
    assert.match(again.error, /already set/);
});

test('objective.set is refused once armed', async () => {
    const g = loadFakeGame();
    await armed(g);
    const reply = await g.request({ op: 'objective.set', args: { type: 'haveFun' } });
    assert.match(reply.error, /before arming/);
});

test('receipts survive a plugin restart', async () => {
    const g = loadFakeGame();
    const session = await armed(g);
    await g.request({ id: 'persist-test-1', op: 'action.execute', session, args: { action: 'ridesetprice', args: { ride: 3, price: 20, isPrimaryPrice: true }, maxCost: 0 } });
    const restarted = loadFakeGame({ storage: Object.fromEntries(g.storage) });
    const receipt = await restarted.request({ op: 'receipt', args: { id: 'persist-test-1' } });
    assert.strictEqual(receipt.result.state, 'completed');
});

test('only the newest 1,000 receipts are kept, and changes keep working', async () => {
    const old = {};
    for (let i = 0; i < 1200; i++) old['old-receipt-' + String(i).padStart(4, '0')] = { id: 'old-receipt-' + i, state: 'completed' };
    const g = loadFakeGame({ storage: { 'agent-bridge.receipts.v1': old } });
    const hello = await g.request({ op: 'hello' });
    assert.deepStrictEqual(hello.result.receipts, { kept: 1000, max: 1000 });
    const oldest = await g.request({ op: 'receipt', args: { id: 'old-receipt-0000' } });
    assert.strictEqual(oldest.result, null);
    const session = await armed(g);
    const reply = await g.request({ id: 'after-trim-1', op: 'action.execute', session, args: { action: 'ridesetprice', args: { ride: 3, price: 20, isPrimaryPrice: true }, maxCost: 0 } });
    assert.strictEqual(reply.result.state, 'completed');
    const kept = g.storage.get('agent-bridge.receipts.v1');
    assert.strictEqual(Object.keys(kept).length, 1000);
    assert.ok(kept['after-trim-1']);
    assert.ok(!kept['old-receipt-0200']);
});

test('screenshots are refused in headless mode instead of crashing the game', async () => {
    const g = loadFakeGame({ headless: true });
    const reply = await g.request({ op: 'capture' });
    assert.strictEqual(reply.ok, false);
    assert.match(reply.error, /headless/);
});

test('every reply carries the newest game messages, red ones marked as warnings', async () => {
    const g = loadFakeGame();
    const reply = await g.request({ op: 'park' });
    assert.ok(Array.isArray(reply.recentNews));
});

test('a flat ride shows its station, entrance and exit even though its station length is 0', async () => {
    const g = loadFakeGame();
    const ride = g.sandbox.map.rides[0];
    ride.stations = [
        { start: { x: 320, y: 320, z: 112 }, length: 0, entrance: { x: 320, y: 352, z: 112, direction: 1 }, exit: { x: 352, y: 320, z: 112, direction: 2 }, queueTime: 0 },
        { start: null, length: 0, entrance: null, exit: null, queueTime: 0 },
    ];
    const one = await g.request({ op: 'ride', args: { ride: 3 } });
    assert.strictEqual(one.result.stations.length, 1);
    assert.deepStrictEqual(one.result.stations[0].entrance, { x: 320, y: 352, z: 112, direction: 1 });
    assert.deepStrictEqual(one.result.stations[0].exit, { x: 352, y: 320, z: 112, direction: 2 });
    const all = await g.request({ op: 'rides' });
    assert.strictEqual(all.result[0].stations.length, 1);
});

// A small park: a path from (5,5) east to (6,5), a ride entrance at (7,5) and an exit at (7,6) with no path to it.
function smallPark(g) {
    const tiles = {
        '5,5': [{ type: 'surface', baseZ: 14, ownership: 2, grassLength: 5 },
            { type: 'footpath', baseZ: 112, edges: 4, isQueue: false, addition: 0, isAdditionBroken: true, isAdditionFull: false, slopeDirection: null }],
        '6,5': [{ type: 'surface', baseZ: 14, ownership: 8, grassLength: 0 },
            { type: 'footpath', baseZ: 112, edges: 1 | 4, isQueue: true, addition: 1, isAdditionBroken: false, isAdditionFull: true, slopeDirection: 2 }],
        '7,5': [{ type: 'surface', baseZ: 112, ownership: 2 }, { type: 'entrance', baseZ: 112, ride: 3, station: 0 }],
        '7,6': [{ type: 'surface', baseZ: 112, ownership: 2 }, { type: 'entrance', baseZ: 112, ride: 3, station: 0 }],
        '9,9': [{ type: 'surface', baseZ: 112, ownership: 2 }, { type: 'entrance', baseZ: 112, ride: 0, station: 0 }],
        '8,8': [{ type: 'surface', baseZ: 14, ownership: 2 }, { type: 'small_scenery', baseZ: 14, object: 4, age: 45 }],
    };
    g.sandbox.map.getTile = (x, y) => ({ elements: tiles[x + ',' + y] || [{ type: 'surface', baseZ: 14, ownership: 0 }] });
    g.sandbox.map.getAllEntities = type => (type === 'litter'
        ? [{ x: 5 * 32 + 3, y: 5 * 32 + 9, litterType: 'vomit' }, { x: 5 * 32, y: 5 * 32, litterType: 'empty_can' },
            { x: -32768, y: -32768, litterType: 'rubbish' }]
        : []);
    g.sandbox.objectManager.getObject = (type, index) => ({
        'footpath_addition:0': { name: 'Bench', flags: 0 },
        'footpath_addition:1': { name: 'Litter Bin', flags: 0 },
        'small_scenery:4': { name: 'Flowers', flags: 1 << 5 },
    })[type + ':' + index] || null;
    const ride = g.sandbox.map.rides[0];
    ride.stations = [{ start: { x: 256, y: 192, z: 112 }, length: 0,
        entrance: { x: 7 * 32, y: 5 * 32, z: 112, direction: 0 }, exit: { x: 7 * 32, y: 6 * 32, z: 112, direction: 0 }, queueTime: 0 }];
}

test('tiles describe land, grass, path joins, path items and litter in words', async () => {
    const g = loadFakeGame();
    smallPark(g);
    const reply = await g.request({ op: 'map', args: { x: 5, y: 5, width: 2, height: 1 } });
    const [a, b] = reply.result;
    assert.strictEqual(a.elements[0].land, 'owned');
    assert.strictEqual(a.elements[0].grass, 'long');
    assert.deepStrictEqual(a.elements[1].joinsTo, [[6, 5]]);
    assert.deepStrictEqual(a.elements[1].item, { name: 'Bench', broken: true });
    assert.deepStrictEqual(a.onTheGround, { litter: 1, vomit: 1 });
    assert.strictEqual(b.elements[0].land, 'for sale');
    assert.deepStrictEqual(b.elements[1].joinsTo, [[5, 5], [7, 5]]);
    assert.deepStrictEqual(b.elements[1].slopesUpToward, [7, 5]);
    assert.deepStrictEqual(b.elements[1].item, { name: 'Litter Bin', full: true });
    const park = await g.request({ op: 'park' });
    assert.strictEqual(park.result.park.litterOnGround, 1);
    assert.strictEqual(park.result.park.vomitOnGround, 1);
});

test('a ride warns when its entrance or exit has no path to it', async () => {
    const g = loadFakeGame();
    smallPark(g);
    const reply = await g.request({ op: 'ride', args: { ride: 3 } });
    assert.deepStrictEqual(reply.result.warnings, ['The exit of station 0 is not joined to a path.']);
});

test('the park map draws path joins, entrances, exits and lists upkeep problems', async () => {
    const g = loadFakeGame();
    smallPark(g);
    const reply = await g.request({ op: 'overview', args: { land: true } });
    const r = reply.result;
    assert.strictEqual(r.rows[5].slice(5, 8), '╶═E');
    assert.strictEqual(r.rows[6][7], 'X');
    assert.strictEqual(r.land[5].slice(5, 8), 'o$o');
    assert.strictEqual(r.upkeep.vomit, 1);
    assert.deepStrictEqual(r.upkeep.dirtiestTiles[0], { x: 5, y: 5, litter: 1, vomit: 1 });
    assert.deepStrictEqual(r.upkeep.brokenPathItems, [{ x: 5, y: 5, item: 'Bench' }]);
    assert.deepStrictEqual(r.upkeep.fullBins, [{ x: 6, y: 5 }]);
    assert.deepStrictEqual(r.upkeep.wiltingGardens, [{ x: 8, y: 8 }]);
    assert.strictEqual(r.upkeep.longGrassTiles, 1);
    assert.strictEqual(r.problems.length, 1);
    assert.match(r.problems[0], /exit of station 0 is not joined/);
});

test('the park map marks the park entrance apart from ride entrances', async () => {
    const g = loadFakeGame();
    smallPark(g);
    const reply = await g.request({ op: 'overview', args: {} });
    assert.strictEqual(reply.result.rows[9][9], 'P');
});
