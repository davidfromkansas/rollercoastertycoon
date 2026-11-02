'use strict';
const test = require('node:test');
const assert = require('node:assert');
const core = require('../src/core.js');
const segments = require('./fixtures/segments.json');

const names = {};
for (const s of Object.values(segments)) names[s.name] = s.type;
const getSegment = type => segments[type];
const start = { x: 2048, y: 2048, z: 64, direction: 0 };
const plan = (pieces, extra = {}) => core.planTrack({ start, pieces, ...extra }, getSegment, names, { x: 128, y: 128 });

test('four right quarter turns make a closed loop', () => {
    const result = plan([{ type: 'rightQuarterTurn3Tiles', repeat: 4 }], { requireClosed: true });
    assert.strictEqual(result.closed, true);
    assert.strictEqual(result.steps.length, 4);
    assert.strictEqual(result.footprint.length, 16);
});

test('a station loop with turns closes', () => {
    const result = plan([
        { type: 'endStation', repeat: 4 },
        { type: 'rightQuarterTurn3Tiles', repeat: 2 },
        { type: 'flat', repeat: 4 },
        { type: 'rightQuarterTurn3Tiles', repeat: 2 },
    ], { requireClosed: true });
    assert.strictEqual(result.closed, true);
});

test('a hill goes up and comes back to the same height', () => {
    const result = plan(['flatToUp25', { type: 'up25', repeat: 3 }, 'up25ToFlat', 'flatToDown25', { type: 'down25', repeat: 3 }, 'down25ToFlat']);
    assert.strictEqual(result.end.z, start.z);
    assert.strictEqual(result.end.slope, 0);
    assert.ok(Math.max(...result.steps.map(s => s.z)) > start.z);
});

test('pieces that do not fit together are refused', () => {
    assert.throws(() => plan(['flat', 'up25']), /slope/);
    assert.throws(() => plan(['flat', 'rightBankToFlat']), /banking/);
    assert.throws(() => plan([{ type: 'endStation', chain: true }]), /Chain lift/);
    assert.throws(() => plan(['notAPiece']), /Unknown track piece/);
    assert.throws(() => plan([{ type: 'rightQuarterTurn3Tiles', repeat: 4 }, 'rightQuarterTurn3Tiles']), /repeats an earlier placement/);
});

test('an open track is refused when a loop is required', () => {
    assert.throws(() => plan(['flat'], { requireClosed: true }), /does not loop back/);
    assert.strictEqual(plan(['flat']).closed, false);
});

test('bad start positions are refused', () => {
    assert.throws(() => core.planTrack({ start: { x: 10, y: 0, z: 0, direction: 0 }, pieces: ['flat'] }, getSegment, names), /multiples of 32/);
    assert.throws(() => core.planTrack({ start: { x: 32, y: 32, z: 3, direction: 0 }, pieces: ['flat'] }, getSegment, names), /multiple of 8/);
    assert.throws(() => core.planTrack({ start, pieces: [] }, getSegment, names), /non-empty/);
});

test('track going off the map is refused', () => {
    const edge = { x: 64, y: 2048, z: 64, direction: 0 };
    assert.throws(() => core.planTrack({ start: edge, pieces: [{ type: 'flat', repeat: 3 }] }, getSegment, names, { x: 128, y: 128 }), /off the usable map/);
});

test('diagonal pieces connect only to diagonal pieces', () => {
    const result = plan(['leftEighthToDiag', { type: 'diagFlat', repeat: 2 }]);
    assert.strictEqual(result.end.direction & 4, 4);
    assert.throws(() => plan(['leftEighthToDiag', 'flat']), /diagonal/);
});

test('action arguments are checked against the schema', () => {
    const schemas = { ridesetprice: { ride: 'number', price: 'number', isPrimaryPrice: 'boolean' }, landbuyrights: { tiles: 'CoordsXY[]' } };
    assert.doesNotThrow(() => core.validateAction('ridesetprice', { ride: 1, price: 20, isPrimaryPrice: true }, schemas));
    assert.throws(() => core.validateAction('cheatset', {}, schemas), /not allowed/);
    assert.throws(() => core.validateAction('ridesetprice', { ride: 1, price: 2.5, isPrimaryPrice: true }, schemas), /whole number/);
    assert.throws(() => core.validateAction('ridesetprice', { ride: 1, price: 20, isPrimaryPrice: 'yes' }, schemas), /true or false/);
    assert.throws(() => core.validateAction('ridesetprice', { ride: 1, price: 20, isPrimaryPrice: true, extra: 1 }, schemas), /Unknown argument/);
    assert.throws(() => core.validateAction('ridesetprice', { ride: 1 }, schemas), /whole number/);
    assert.throws(() => core.validateAction('toString', {}, schemas), /not allowed/);
    assert.throws(() => core.validateAction('landbuyrights', { tiles: [{ x: -1, y: 0 }] }, schemas), /x must be/);
});

test('the example coaster plan is a closed loop', () => {
    const example = require('../examples/plan-small-coaster.json').args;
    const result = core.planTrack(example, getSegment, names, { x: 128, y: 128 });
    assert.strictEqual(result.closed, true);
    assert.strictEqual(result.possibleOverlaps.length, 0);
});
