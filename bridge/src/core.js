/* SPDX-License-Identifier: GPL-3.0-only */
// Pure logic shared by the game plugin and the Node tests.
// Nothing in this file talks to the game: it only checks inputs and does track geometry math.
var BridgeCore = (function () {
    'use strict';

    const TILE = 32;        // one map tile in world units
    const HEIGHT_STEP = 8;  // one height unit in world units
    const MAX_COORD = 32736;
    const MAX_Z = 2040;
    const MAX_PLAN_PIECES = 2048;

    function fail(message) {
        throw new Error(message);
    }

    // Check that n is a whole number between min and max (inclusive).
    function int(n, name, min, max) {
        if (!Number.isSafeInteger(n) || n < min || n > max) {
            fail(`${name} must be a whole number from ${min} to ${max}`);
        }
        return n;
    }

    // Rotate an (x, y) offset by a cardinal direction (0..3), clockwise in map terms.
    function rotate(x, y, direction) {
        switch (direction & 3) {
            case 0: return [x, y];
            case 1: return [y, -x];
            case 2: return [-x, -y];
            default: return [-y, x];
        }
    }

    // One tile forward in each cardinal direction: 0 = -x, 1 = +y, 2 = +x, 3 = -y.
    const FORWARD = [[-TILE, 0], [0, TILE], [TILE, 0], [0, -TILE]];

    function samePosition(a, b) {
        return ['x', 'y', 'z', 'direction', 'slope', 'bank'].every(k => a[k] === b[k]);
    }

    function startPosition(p) {
        if (!p || typeof p !== 'object') fail('start is required');
        const start = {
            x: int(p.x, 'start.x', 0, MAX_COORD),
            y: int(p.y, 'start.y', 0, MAX_COORD),
            z: int(p.z, 'start.z', 0, MAX_Z),
            direction: int(p.direction, 'start.direction', 0, 7),
            slope: p.slope === undefined ? 0 : int(p.slope, 'start.slope', 0, 255),
            bank: p.bank === undefined ? 0 : int(p.bank, 'start.bank', 0, 255),
        };
        if (start.x % TILE || start.y % TILE) fail('start x/y must be multiples of 32 (world units)');
        if (start.z % HEIGHT_STEP) fail('start z must be a multiple of 8 (world units)');
        return start;
    }

    // Given where the track currently ends (the cursor) and the next segment's shape,
    // work out where that segment is placed and where the track ends after it.
    function placeSegment(cursor, segment) {
        if ((cursor.direction & 4) !== (segment.beginDirection & 4)) fail('diagonal/straight connection mismatch');
        if (cursor.slope !== segment.beginSlope) fail('slope does not match the previous piece');
        if (cursor.bank !== segment.beginBank) fail('banking does not match the previous piece');

        const rotation = ((cursor.direction & 3) - (segment.beginDirection & 3) + 4) & 3;
        const [dx, dy] = rotate(segment.endX, segment.endY, rotation);
        const endDirection = ((rotation + segment.endDirection) & 3) | (segment.endDirection & 4);
        // Straight-facing pieces end one tile ahead; diagonal ones end on the same tile.
        const [fx, fy] = endDirection & 4 ? [0, 0] : FORWARD[endDirection];
        const baseZ = cursor.z - segment.beginZ;

        return {
            placement: { x: cursor.x, y: cursor.y, z: baseZ, direction: rotation },
            next: {
                x: cursor.x + dx + fx,
                y: cursor.y + dy + fy,
                z: baseZ + segment.endZ,
                direction: endDirection,
                slope: segment.endSlope,
                bank: segment.endBank,
            },
        };
    }

    // Turn a list of named pieces into exact placements.
    // getSegment(type) returns the engine's geometry for a track type.
    // names maps piece names (e.g. "flat") to type numbers.
    function planTrack(input, getSegment, names, mapSize) {
        if (!input || typeof input !== 'object') fail('plan input must be an object');
        if (!Array.isArray(input.pieces) || input.pieces.length === 0) fail('pieces must be a non-empty list');

        const start = startPosition(input.start);
        const steps = [];
        const footprint = [];
        const overlaps = [];
        const occupied = Object.create(null);
        const seenPlacements = Object.create(null);
        let cursor = start;

        for (let spec of input.pieces) {
            if (typeof spec === 'string' || typeof spec === 'number') spec = { type: spec };
            if (!spec || typeof spec !== 'object') fail('each piece must be a name, number or object');

            const type = typeof spec.type === 'string' ? names[spec.type] : spec.type;
            if (type === undefined) fail(`Unknown track piece name: ${spec.type}`);
            int(type, 'track type', 0, 65534);
            const segment = getSegment(type);
            if (!segment || !Array.isArray(segment.elements) || segment.elements.length === 0) {
                fail(`Unsupported track type: ${spec.type}`);
            }
            if (spec.chain && !segment.allowsChainLift) fail(`Chain lift is not allowed on ${spec.type}`);

            const repeat = spec.repeat === undefined ? 1 : int(spec.repeat, 'repeat', 1, 512);
            const brakeSpeed = spec.brakeSpeed === undefined ? 8 : int(spec.brakeSpeed, 'brakeSpeed', 0, 255);
            const colour = spec.colour === undefined ? 0 : int(spec.colour, 'colour', 0, 3);
            const seatRotation = spec.seatRotation === undefined ? 0 : int(spec.seatRotation, 'seatRotation', 0, 15);

            for (let r = 0; r < repeat; r++) {
                const index = steps.length;
                if (index >= MAX_PLAN_PIECES) fail(`A plan can have at most ${MAX_PLAN_PIECES} pieces`);

                let result;
                try {
                    result = placeSegment(cursor, segment);
                } catch (e) {
                    fail(`Piece ${index} (${spec.type}): ${e.message}`);
                }
                const at = result.placement;
                if (at.z < 0 || at.z > MAX_Z) fail(`Piece ${index} is outside the allowed height range`);

                const placementKey = [at.x, at.y, at.z, at.direction, type].join(',');
                if (seenPlacements[placementKey] !== undefined) fail(`Piece ${index} repeats an earlier placement`);
                seenPlacements[placementKey] = index;

                for (const el of segment.elements) {
                    const [ex, ey] = rotate(el.x, el.y, at.direction);
                    const tile = { x: at.x + ex, y: at.y + ey, z: at.z + el.z, piece: index };
                    if (mapSize && (tile.x < TILE || tile.y < TILE ||
                        tile.x >= (mapSize.x - 1) * TILE || tile.y >= (mapSize.y - 1) * TILE)) {
                        fail(`Piece ${index} goes off the usable map`);
                    }
                    const key = [tile.x, tile.y, tile.z].join(',');
                    if (occupied[key] !== undefined && occupied[key] !== index) {
                        overlaps.push({ piece: index, other: occupied[key], position: tile });
                    }
                    occupied[key] = index;
                    footprint.push(tile);
                }

                steps.push({
                    x: at.x, y: at.y, z: at.z, direction: at.direction,
                    trackType: type,
                    brakeSpeed, colour, seatRotation,
                    trackPlaceFlags: (spec.chain ? 1 : 0) | (spec.inverted ? 2 : 0),
                    isFromTrackDesign: false,
                });
                cursor = result.next;
            }
        }

        const closed = samePosition(cursor, start);
        if (input.requireClosed && !closed) {
            fail(`Track does not loop back to the start. Ends at ${JSON.stringify(cursor)}, start is ${JSON.stringify(start)}`);
        }
        return {
            start, end: cursor, closed, steps, footprint, possibleOverlaps: overlaps,
            note: 'Geometry only. Land, money, ride compatibility and train physics are checked by the game when building.',
        };
    }

    // Check a game action's arguments against the allowed list and its schema.
    // schemas looks like { ridesetprice: { ride: 'number', price: 'number', isPrimaryPrice: 'boolean' } }.
    function validateAction(name, args, schemas) {
        if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(schemas, name)) {
            fail(`Action is not allowed: ${name}`);
        }
        if (!args || typeof args !== 'object' || Array.isArray(args)) fail('Action args must be an object');
        const schema = schemas[name];
        for (const key of Object.keys(args)) {
            if (!Object.prototype.hasOwnProperty.call(schema, key)) fail(`Unknown argument "${key}" for ${name}`);
        }
        for (const key of Object.keys(schema)) {
            const type = schema[key];
            const value = args[key];
            if (type === 'number' || type === 'Direction') {
                int(value, key, -2147483648, 2147483647);
            } else if (type === 'boolean') {
                if (typeof value !== 'boolean') fail(`${key} must be true or false`);
            } else if (type === 'string') {
                if (typeof value !== 'string' || value.length > 512) fail(`${key} must be text of at most 512 characters`);
            } else if (type === 'CoordsXY[]') {
                if (!Array.isArray(value) || value.length > 1024) fail(`${key} must be a list of at most 1024 points`);
                for (const p of value) {
                    if (!p || typeof p !== 'object') fail(`${key} must contain {x, y} points`);
                    int(p.x, 'x', 0, MAX_COORD);
                    int(p.y, 'y', 0, MAX_COORD);
                }
            } else {
                fail(`Unsupported argument type ${type} for ${name}.${key}`);
            }
        }
        // Options a normal player can't use without cheats or debug tools.
        if (name === 'ridesetsetting' && args.setting === 10) fail('Changing a ride\'s type needs a cheat, which is not allowed');
        if (name === 'gamesetspeed' && args.speed > 4) fail('speed must be 1 to 4; faster speeds need the debug tools');
        // The game's own window only uses this action to track a guest, so that's all we allow.
        if (name === 'guestsetflags' && args.guestFlags !== 0 && args.guestFlags !== 8) fail('guestFlags must be 8 (track this guest) or 0 (stop tracking)');
        return args;
    }

    return { int, rotate, samePosition, placeSegment, planTrack, validateAction };
})();

if (typeof module !== 'undefined') module.exports = BridgeCore;
