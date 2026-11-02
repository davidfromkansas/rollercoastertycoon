// Builds dist/agent-bridge.js, the single file OpenRCT2 loads as a plugin.
// It reads the pinned OpenRCT2 source to learn the exact game actions and track piece names,
// creates a private password (token) on first run, and joins everything into one file.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'vendor', 'OpenRCT2');
const PINNED = { release: 'v0.5.5', api: 122, commit: '8694e3483690323b6a75fa7264b6c58116f51f31' };
const VERSION = require('../package.json').version;

// The only game actions the agent may use. Anything else is refused.
const ALLOWED_ACTIONS = [
    'ridecreate', 'ridedemolish', 'ridesetname', 'ridesetprice', 'ridesetsetting', 'ridesetstatus',
    'ridesetvehicle', 'ridesetappearance', 'rideentranceexitplace', 'rideentranceexitremove',
    'trackplace', 'trackremove', 'tracksetbrakespeed',
    'footpathplace', 'footpathremove', 'footpathadditionplace', 'footpathadditionremove',
    'staffhire', 'stafffire', 'staffsetorders', 'staffsetname', 'staffsetpatrolarea', 'staffsetcolour',
    'parksetname', 'parksetentrancefee', 'parksetloan', 'parksetparameter', 'parksetresearchfunding', 'parkmarketing',
    'landsetheight', 'landbuyrights', 'surfacesetstyle', 'watersetheight',
    'smallsceneryplace', 'smallsceneryremove', 'wallplace', 'wallremove',
    'gamesetspeed', 'pausetoggle',
    // Added 2026-10-31 from David's picks: everything a normal player can do, minus cheats, editor and multiplayer.
    'ridesetcolourscheme', 'mazeplacetrack', 'mazesettrack', 'footpathlayoutplace',
    'staffsetcostume', 'peeppickup', 'guestsetflags', 'guestsetname', 'balloonpress',
    'landraise', 'landlower', 'landsmooth', 'waterraise', 'waterlower', 'clearscenery',
    'smallscenerysetcolour', 'largesceneryplace', 'largesceneryremove', 'largescenerysetcolour', 'wallsetcolour',
    'bannerplace', 'bannerremove', 'bannersetcolour', 'bannersetname', 'bannersetstyle', 'signsetname', 'signsetstyle',
];
// Where the plugin API's type file is wrong or incomplete, the engine's own parameter list wins.
const ARG_FIXES = {
    clearscenery: { add: { x1: 'number', y1: 'number', x2: 'number', y2: 'number' } },
    footpathlayoutplace: { remove: ['slope'], add: { slopeType: 'number', slopeDirection: 'number' } },
};
const SUPPORTED_TYPES = new Set(['number', 'Direction', 'boolean', 'string', 'CoordsXY[]']);

function readSource(relative) {
    const file = path.join(SOURCE, relative);
    if (!fs.existsSync(file)) throw new Error(`Missing ${relative}. Run scripts/setup.sh to download the pinned OpenRCT2 source.`);
    return fs.readFileSync(file, 'utf8');
}

// Track piece names -> numbers, from the engine's enum.
function extractTrackNames() {
    const header = readSource('src/openrct2/ride/ted/TrackElemType.h');
    const names = {};
    for (const m of header.matchAll(/^\s*(\w+)\s*=\s*(\d+),/gm)) names[m[1]] = Number(m[2]);
    if (Object.keys(names).length < 100) throw new Error('Could not read track piece names from TrackElemType.h');
    return names;
}

// Action name -> { argument: type }, from the plugin API type definitions.
function extractActionSchemas() {
    const types = readSource('distribution/scripting/openrct2.d.ts');
    const schemas = {};
    for (const action of ALLOWED_ACTIONS) {
        const signature = types.match(new RegExp(`queryAction\\(action: "${action}", args: (\\w+)`));
        if (!signature) throw new Error(`Action ${action} not found in the plugin API`);
        const body = types.match(new RegExp(`interface ${signature[1]} extends GameActionArgs \\{([\\s\\S]*?)\\n    \\}`));
        if (!body) throw new Error(`Argument list for ${action} not found`);
        const withoutComments = body[1].replace(/\/\*[\s\S]*?\*\//g, '');
        schemas[action] = {};
        for (const arg of withoutComments.matchAll(/^\s*(\w+)(\??): ([\w[\]]+);/gm)) {
            if (arg[2] === '?') continue; // optional arguments are left out to keep the schema strict
            if (!SUPPORTED_TYPES.has(arg[3])) throw new Error(`Unsupported argument type ${arg[3]} in ${action}.${arg[1]}`);
            schemas[action][arg[1]] = arg[3];
        }
        const fix = ARG_FIXES[action];
        if (fix) {
            for (const name of fix.remove || []) delete schemas[action][name];
            Object.assign(schemas[action], fix.add || {});
        }
    }
    return schemas;
}

// Local settings, including the private token. Created once, never shared.
function loadOrCreateConfig() {
    const file = path.join(ROOT, 'bridge.config.json');
    if (!fs.existsSync(file)) {
        const fresh = { host: '127.0.0.1', port: 21572, token: crypto.randomBytes(32).toString('hex') };
        fs.writeFileSync(file, JSON.stringify(fresh, null, 2) + '\n', { mode: 0o600 });
    }
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (config.host !== '127.0.0.1') throw new Error('bridge.config.json: host must be 127.0.0.1');
    if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('bridge.config.json: port must be 1024..65535');
    if (!/^[a-f0-9]{64}$/.test(config.token)) throw new Error('bridge.config.json: token must be 64 hex characters');
    return config;
}

function main() {
    const trackNames = extractTrackNames();
    const schemas = extractActionSchemas();
    const config = loadOrCreateConfig();

    const generated = path.join(ROOT, 'generated');
    fs.mkdirSync(generated, { recursive: true });
    fs.writeFileSync(path.join(generated, 'track-names.json'), JSON.stringify(trackNames, null, 2) + '\n');
    fs.writeFileSync(path.join(generated, 'actions.json'), JSON.stringify(schemas, null, 2) + '\n');

    const bundle = [
        `// Agent bridge ${VERSION} for OpenRCT2 ${PINNED.release} (plugin API ${PINNED.api}).`,
        '// Built locally. Contains a private token: do not share this file.',
        `var BRIDGE_VERSION = ${JSON.stringify(VERSION)};`,
        `var BRIDGE_CONFIG = ${JSON.stringify(config)};`,
        `var TRACK_NAMES = ${JSON.stringify(trackNames)};`,
        `var ACTION_SCHEMAS = ${JSON.stringify(schemas)};`,
        fs.readFileSync(path.join(ROOT, 'src', 'core.js'), 'utf8'),
        fs.readFileSync(path.join(ROOT, 'src', 'plugin.js'), 'utf8'),
    ].join('\n');

    const dist = path.join(ROOT, 'dist');
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'agent-bridge.js'), bundle, { mode: 0o600 });
    const info = {
        version: VERSION,
        openrct2: PINNED.release,
        api: PINNED.api,
        sourceCommit: PINNED.commit,
        sha256: crypto.createHash('sha256').update(bundle).digest('hex'),
        actions: Object.keys(schemas).length,
        trackNames: Object.keys(trackNames).length,
    };
    fs.writeFileSync(path.join(dist, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
    console.log(`Built dist/agent-bridge.js (${info.actions} actions, ${info.trackNames} track pieces)`);
}

main();
