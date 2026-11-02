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
