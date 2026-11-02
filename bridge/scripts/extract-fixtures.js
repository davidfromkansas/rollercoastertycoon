// Copies real track geometry for a few pieces out of the OpenRCT2 source into test/fixtures/segments.json,
// so the track planner can be tested without the game running.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RIDE_SRC = path.join(ROOT, 'vendor', 'OpenRCT2', 'src', 'openrct2', 'ride');
const PIECES = ['flat', 'endStation', 'beginStation', 'middleStation', 'brakes',
    'flatToUp25', 'up25', 'up25ToFlat', 'flatToDown25', 'down25', 'down25ToFlat',
    'leftQuarterTurn3Tiles', 'rightQuarterTurn3Tiles', 'leftQuarterTurn5Tiles', 'rightQuarterTurn5Tiles',
    'flatToRightBank', 'rightBankToFlat', 'bankedRightQuarterTurn5Tiles',
    'leftEighthToDiag', 'rightEighthToOrthogonal', 'diagFlat'];

const tedFiles = fs.readdirSync(path.join(RIDE_SRC, 'ted')).filter(f => f.startsWith('TED.') && f.endsWith('.h')).map(f => path.join('ted', f));
const source = ['TrackData.cpp', ...tedFiles].map(f => fs.readFileSync(path.join(RIDE_SRC, f), 'utf8')).join('\n');
const pitchAndRoll = fs.readFileSync(path.join(RIDE_SRC, 'ted', 'PitchAndRoll.h'), 'utf8');
const names = JSON.parse(fs.readFileSync(path.join(ROOT, 'generated', 'track-names.json'), 'utf8'));

function readEnum(name) {
    const body = pitchAndRoll.match(new RegExp(`enum class ${name}[^{]*\\{([\\s\\S]*?)\\}`))[1];
    const values = {};
    for (const m of body.matchAll(/(\w+)\s*=\s*(\d+)/g)) values[m[1]] = Number(m[2]);
    return values;
}
const PITCH = readEnum('TrackPitch');
const ROLL = readEnum('TrackRoll');

const result = {};
for (const name of PIECES) {
    const descriptor = 'kTED' + name[0].toUpperCase() + name.slice(1);
    const block = source.match(new RegExp(`constexpr auto ${descriptor} = TrackElementDescriptor\\{([\\s\\S]*?)\\n    \\};`));
    if (!block) throw new Error(`Could not find ${descriptor}`);
    const body = block[1];

    // coordinates = { rotationBegin, rotationEnd, zBegin, zEnd, x, y }
    const [beginDirection, endDirection, beginZ, endZ, endX, endY] = body.match(/\.coordinates = \{([^}]+)\}/)[1].split(',').map(Number);
    // definition = { group, pitchEnd, pitchStart, rollEnd, rollStart, ... }
    const def = body.match(/\.definition = \{ TrackGroup::\w+, TrackPitch::(\w+), TrackPitch::(\w+), TrackRoll::(\w+), TrackRoll::(\w+)/);
    const sequenceNames = body.match(/\.sequenceData = \{\s*\d+,\s*\{([^}]+)\}/)[1].split(',').map(s => s.trim());
    const elements = sequenceNames.map(seq => {
        const seqBlock = source.match(new RegExp(`SequenceDescriptor ${seq} = \\{([\\s\\S]*?)\\n    \\};`));
        if (!seqBlock) throw new Error(`Could not find ${seq}`);
        const xyz = seqBlock[1].match(/\.clearance = \{\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)/);
        if (!xyz) throw new Error(`Could not read clearance of ${seq}`);
        return { x: Number(xyz[1]), y: Number(xyz[2]), z: Number(xyz[3]) };
    });

    result[names[name]] = {
        name, type: names[name],
        beginDirection, endDirection, beginZ, endZ, endX, endY,
        beginSlope: PITCH[def[2]], endSlope: PITCH[def[1]],
        beginBank: ROLL[def[4]], endBank: ROLL[def[3]],
        elements,
        allowsChainLift: /TrackElementFlag::allowLiftHill/.test(body),
    };
}

fs.mkdirSync(path.join(ROOT, 'test', 'fixtures'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'test', 'fixtures', 'segments.json'), JSON.stringify(result, null, 2) + '\n');
console.log(`Saved geometry for ${Object.keys(result).length} track pieces`);
