// A pretend OpenRCT2 for tests: just enough of the plugin API to load src/plugin.js
// and send it requests, without the real game.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const ROOT = path.resolve(__dirname, '..');
const segments = require('./fixtures/segments.json');
const TOKEN = 'a'.repeat(64);
const SCHEMAS = {
    ridesetprice: { ride: 'number', price: 'number', isPrimaryPrice: 'boolean' },
    ridecreate: { rideType: 'number', rideObject: 'number', entranceObject: 'number', colour1: 'number', colour2: 'number', inspectionInterval: 'number' },
    ridesetname: { ride: 'number', name: 'string' },
    ridesetstatus: { ride: 'number', status: 'number' },
    trackplace: { x: 'number', y: 'number', z: 'number', direction: 'number', ride: 'number', trackType: 'number', rideType: 'number', brakeSpeed: 'number', colour: 'number', seatRotation: 'number', trackPlaceFlags: 'number', isFromTrackDesign: 'boolean' },
    staffhire: { autoPosition: 'boolean', staffType: 'number', costumeIndex: 'number', staffOrders: 'number' },
};

function loadFakeGame(options = {}) {
    const trackNames = {};
    for (const s of Object.values(segments)) trackNames[s.name] = s.type;
    const storage = new Map(Object.entries(options.storage || {}));
    const hooks = {};
    const executed = [];
    const queried = [];
    const game = {
        costs: options.costs || {},
        failOn: options.failOn || null,
        saved: [],
        menuItems: {},
    };
    let connectionHandler = null;
    let listenedOn = null;

    const rides = [{ id: 3, type: 52, name: 'Coaster 1', status: 'closed', price: [10], stations: [] }];
    const context = {
        apiVersion: 122, mode: 'normal', paused: false, gameSpeed: 1,
        sharedStorage: {
            get: key => (storage.has(key) ? JSON.parse(JSON.stringify(storage.get(key))) : undefined),
            set: (key, value) => storage.set(key, JSON.parse(JSON.stringify(value))),
        },
        subscribe: (hook, cb) => { hooks[hook] = cb; return { dispose() {} }; },
        queryAction: (name, args, cb) => {
            queried.push({ name, args });
            setImmediate(() => cb(game.failOn === name ? { error: 1, errorMessage: 'Not allowed here' } : { error: 0, cost: game.costs[name] || 0 }));
        },
        executeAction: (name, args, cb) => {
            executed.push({ name, args: { ...args } });
            setImmediate(() => cb(name === 'ridecreate' ? { error: 0, cost: game.costs[name] || 0, ride: 7 } : { error: 0, cost: game.costs[name] || 0 }));
        },
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        getTrackSegment: type => segments[type] || null,
        getAllTrackSegments: () => Object.values(segments),
        saveGame: o => game.saved.push(o.filename),
        captureImage: () => {},
    };
    const sandbox = {
        BRIDGE_VERSION: '0.0.0-test',
        BRIDGE_CONFIG: { host: '127.0.0.1', port: 21572, token: TOKEN },
        TRACK_NAMES: trackNames,
        ACTION_SCHEMAS: SCHEMAS,
        context,
        map: {
            size: { x: 128, y: 128 },
            rides,
            getRide: id => rides.find(r => r.id === id) || null,
            getTile: (x, y) => ({ elements: [{ type: 'surface', baseZ: 14 }] }),
            getAllEntities: () => [],
            getTrackIterator: () => null,
        },
        park: { name: 'Test Park', cash: 100000, rating: 600, guests: 42, messages: [] },
        scenario: { name: 'Test', status: 'inProgress', objective: { type: 'guestsBy', guests: 500 } },
        date: { monthsElapsed: 0, month: 0, day: 1 },
        network: {
            mode: 'none',
            createListener: () => ({
                on: (event, cb) => { if (event === 'connection') connectionHandler = cb; },
                listen: (port, host) => { listenedOn = { port, host }; },
            }),
        },
        objectManager: { getAllObjects: () => [] },
        console: { log() {} },
        registerPlugin: meta => { game.meta = meta; meta.main(); },
        setImmediate, setTimeout,
    };
    // A headless game has no ui object at all.
    game.windows = {};
    if (!options.headless) {
        sandbox.ui = {
            width: 1280, height: 720,
            registerMenuItem: (name, cb) => { game.menuItems[name] = cb; },
            getWindow: c => game.windows[c] || null,
            openWindow: desc => {
                const win = { ...desc, findWidget: name => desc.widgets.find(w => w.name === name) };
                game.windows[desc.classification] = win;
                return win;
            },
        };
    }
    vm.createContext(sandbox);
    for (const file of ['src/core.js', 'src/plugin.js']) {
        vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });
    }

    // Open a pretend connection and send one request; resolves with the parsed reply.
    function request(req, { token = TOKEN, raw } = {}) {
        return new Promise(resolve => {
            const socket = new EventEmitter();
            socket.write = text => { resolve(JSON.parse(text)); return true; };
            socket.end = () => resolve({ ended: true });
            connectionHandler(socket);
            socket.emit('data', raw !== undefined ? raw : JSON.stringify({ id: 'test-' + Math.random().toString(36).slice(2), token, ...req }) + '\n');
        });
    }

    // Hand a real network socket to the plugin, for end-to-end tests with cli.js.
    function attach(netSocket) {
        const socket = new EventEmitter();
        socket.write = text => netSocket.write(text);
        socket.end = () => netSocket.end();
        netSocket.setEncoding('utf8');
        netSocket.on('data', chunk => socket.emit('data', chunk));
        netSocket.on('close', () => socket.emit('close'));
        netSocket.on('error', () => {});
        connectionHandler(socket);
    }

    return { request, attach, game, hooks, executed, queried, storage, sandbox, listenedOn: () => listenedOn };
}

module.exports = { loadFakeGame, TOKEN };
