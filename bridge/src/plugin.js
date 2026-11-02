/* SPDX-License-Identifier: GPL-3.0-only */
// The part that runs inside OpenRCT2.
// It listens on 127.0.0.1 for one-line JSON requests, checks them, and answers.
// It starts read-only: nothing in the park can change until the agent "arms" it.
// BRIDGE_VERSION, BRIDGE_CONFIG, TRACK_NAMES, ACTION_SCHEMAS and BridgeCore are added by scripts/build.js.
(function () {
    'use strict';

    const MAX_CLIENTS = 8;
    const MAX_REQUEST_BYTES = 1024 * 1024;
    const MAX_RECEIPTS = 1000;  // only the newest are kept; older ones are dropped
    const MAX_PLANS = 100;
    const MAX_BATCH = 2048;
    const RECEIPTS_KEY = 'agent-bridge.receipts.v1';
    const MAX_FEED = 400;
    const MAX_FEED_TEXT = 4000;
    const FEED_KINDS = ['info', 'model', 'thinking', 'tool', 'output', 'error'];
    const ID_PATTERN = /^[-a-zA-Z0-9]{8,80}$/;
    const CHANGE_OPS = ['action.execute', 'batch.execute', 'track.build', 'coaster.build', 'save'];
    // Objective types the plugin API can set together with their numbers (other types need numbers it cannot set).
    const OBJECTIVE_TYPES = ['none', 'haveFun', 'buildTheBest', 'guestsBy', 'guestsAndRating', 'parkValueBy', 'repayLoanAndParkValue'];
    const READ_OPS = ['hello', 'arm', 'stop', 'receipt', 'actions', 'feed', 'view', 'park', 'rides', 'ride', 'map', 'overview', 'guests', 'staff',
        'objects', 'capture', 'track.catalog', 'track.plan', 'track.walk', 'action.query',
        'finances', 'research', 'weather', 'history', 'marketing', 'news', 'thoughts', 'awards', 'objective.set'];
    const OBJECT_TYPES = ['ride', 'station', 'footpath_surface', 'footpath_railings', 'footpath_addition',
        'small_scenery', 'large_scenery', 'wall', 'banner', 'scenery_group', 'terrain_surface', 'terrain_edge'];

    const C = BridgeCore;
    const fail = message => { throw new Error(message); };
    const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
    const newId = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);

    function main() {
        // ---- State ----
        let armed = false;        // may the agent change the park?
        let busy = false;         // is a change running right now?
        let generation = 0;       // bumped by STOP or a park change; running batches check it
        let session = newId();    // identifies the currently loaded park
        let plans = Object.create(null);
        let goalLocked = false;   // the goal may be set once per park, before arming, so the agent cannot change its own goal
        const receipts = context.sharedStorage.get(RECEIPTS_KEY) || {};

        const trackNameOf = {};
        for (const name of Object.keys(TRACK_NAMES)) trackNameOf[TRACK_NAMES[name]] = name;

        // Keys keep insertion order, so the first keys are the oldest receipts.
        function trimReceipts() {
            const ids = Object.keys(receipts);
            for (let i = 0; i < ids.length - MAX_RECEIPTS; i++) delete receipts[ids[i]];
        }
        trimReceipts();

        function saveReceipts() {
            trimReceipts();
            context.sharedStorage.set(RECEIPTS_KEY, receipts);
        }

        // Loading another park makes everything from the old one invalid.
        function resetSession() {
            armed = false;
            goalLocked = false;
            generation++;
            session = newId();
            plans = Object.create(null);
            if (typeof history !== 'undefined') { history = []; campaigns = []; firstSeen = {}; }
        }
        context.subscribe('map.change', resetSession);
        context.subscribe('map.changed', resetSession);

        function stop() {
            armed = false;
            generation++;
        }

        function requirePark() {
            if (context.mode !== 'normal' && context.mode !== 'track_designer') fail('Load a park first');
            if (network.mode !== 'none') fail('The bridge only works in single-player games');
        }

        function requireArmed(req) {
            requirePark();
            if (!armed) fail('The bridge is read-only. Run "arm" first.');
            if (req.session !== session) fail('Old or missing session. The park may have changed; run "arm" again.');
        }

        // Copy only the listed fields that have a value, turning anything unreadable or non-finite into null.
        // Empty fields are left out to keep answers short for the agent.
        function pick(obj, keys) {
            const out = {};
            for (const k of keys) {
                try {
                    const v = obj[k];
                    if (v === undefined || v === null) continue;
                    out[k] = typeof v === 'number' && (!Number.isFinite(v) || Math.abs(v) > Number.MAX_SAFE_INTEGER) ? null : v;
                } catch (e) {
                    out[k] = null;
                }
            }
            return out;
        }

        // ---- Read-only views ----
        function describeRide(r, full) {
            const view = pick(r, ['id', 'type', 'name', 'classification', 'status', 'mode', 'price', 'excitement',
                'intensity', 'nausea', 'vehicles', 'reliability', 'downtime', 'guestCount', 'incomePerHour', 'profit',
                'totalCustomers', 'maxSpeed', 'averageSpeed', 'rideTime', 'rideLength', 'maxPositiveVerticalGs',
                'maxNegativeVerticalGs', 'maxLateralGs', 'totalAirTime', 'numDrops', 'numLiftHills', 'highestDropHeight',
                'satisfaction', 'age', 'value', 'totalProfit', 'runningCost', 'inspectionInterval', 'breakdown', 'liftHillSpeed',
                'minimumWaitingTime', 'maximumWaitingTime']);
            // Colours and music are only shown for one ride at a time; they're slow to read for hundreds.
            if (full) Object.assign(view, pick(r, ['departFlags', 'music', 'colourSchemes', 'vehicleColours', 'stationStyle']));
            view.stations = (r.stations || [])
                .map((s, index) => Object.assign({ index }, pick(s, ['start', 'length', 'entrance', 'exit', 'queueTime'])))
                .filter(s => s.length > 0);
            return view;
        }

        function getRide(id) {
            C.int(id, 'ride', 0, 65534);
            const ride = map.getRide(id);
            if (!ride) fail(`Ride ${id} does not exist`);
            return ride;
        }

        function describeTile(x, y) {
            const tile = map.getTile(x, y);
            return {
                x, y,
                elements: tile.elements.map((el, elementIndex) => Object.assign({ elementIndex }, pick(el, ['type',
                    'baseZ', 'clearanceZ', 'slope', 'waterHeight', 'ownership', 'surfaceStyle', 'edgeStyle', 'direction',
                    'ride', 'station', 'trackType', 'sequence', 'hasChainLift', 'isInverted', 'edges', 'isQueue', 'isWide',
                    'queueBannerDirection', 'object', 'quadrant']))),
            };
        }

        function describeSegment(s) {
            const view = pick(s, ['type', 'description', 'beginZ', 'endZ', 'endX', 'endY', 'beginDirection',
                'endDirection', 'beginSlope', 'endSlope', 'beginBank', 'endBank', 'length', 'elements', 'trackGroup',
                'allowsChainLift', 'isInversion', 'isBanked', 'mirrorSegment']);
            view.name = trackNameOf[s.type];
            return view;
        }

        // Follow real track in the game from a starting tile until it loops, ends, or hits the limit.
        function walkTrack(a) {
            C.int(a.x, 'tile x', 0, map.size.x - 1);
            C.int(a.y, 'tile y', 0, map.size.y - 1);
            C.int(a.elementIndex, 'elementIndex', 0, 255);
            const limit = a.limit === undefined ? 2048 : C.int(a.limit, 'limit', 1, 4096);
            const it = map.getTrackIterator({ x: a.x * 32, y: a.y * 32 }, a.elementIndex);
            if (!it || !it.segment) fail('No track found at that tile and element');

            const seen = {};
            const pieces = [];
            let firstKey = null;
            for (let i = 0; i < limit; i++) {
                const p = it.position;
                const s = it.segment;
                if (!s) return { closed: false, reason: 'missing segment', pieces };
                const key = [p.x, p.y, p.z, p.direction, s.type].join(',');
                if (seen[key]) {
                    const closed = key === firstKey;
                    return { closed, reason: closed ? 'circuit' : 'loops back to a piece that is not the start', pieces };
                }
                if (firstKey === null) firstKey = key;
                seen[key] = true;
                pieces.push({ position: p, type: s.type, name: trackNameOf[s.type], nextPosition: it.nextPosition });
                if (!it.next()) return { closed: false, reason: 'gap', nextPosition: it.nextPosition, pieces };
            }
            return { closed: false, reason: 'limit reached', pieces };
        }

        // Replaces the scenario's goal and marks it in progress again, so the game checks the new goal.
        // Allowed once per loaded park and only while unarmed: a setup step for the person, not for the agent.
        function setObjective(a) {
            if (goalLocked) fail('The goal was already set for this park. Load the park again to change it.');
            if (armed) fail('Set the goal before arming.');
            if (OBJECTIVE_TYPES.indexOf(a.type) < 0) fail('type must be one of: ' + OBJECTIVE_TYPES.join(', '));
            const needs = {
                guestsBy: ['guests', 'year'], guestsAndRating: ['guests'],
                parkValueBy: ['parkValue', 'year'], repayLoanAndParkValue: ['parkValue'],
            }[a.type] || [];
            const limits = { guests: [1, 50000], year: [1, 25], parkValue: [1, 2147483647] };
            for (const key of needs) C.int(a[key], key, limits[key][0], limits[key][1]);
            const objective = scenario.objective;
            objective.type = a.type;  // first: the other fields only apply to the current type
            for (const key of needs) objective[key] = a[key];
            scenario.status = 'inProgress';
            goalLocked = true;
            return { objective: pick(scenario.objective, ['type', 'guests', 'year', 'parkValue']), status: scenario.status };
        }

        function readPark() {
            const parkView = pick(park, ['name', 'cash', 'rating', 'bankLoan', 'maxBankLoan', 'entranceFee', 'guests',
                'value', 'companyValue', 'suggestedGuestMaximum', 'totalAdmissions', 'totalIncomeFromAdmissions', 'parkSize']);
            // Only the 10 newest messages: old parks can carry hundreds.
            parkView.messages = (park.messages || []).slice(-10).map(m => pick(m, ['type', 'subject', 'text', 'month', 'tickCount', 'isArchived']));
            // The scenario's own rules, as the game's park window would show them (greyed-out prices etc.).
            const flag = name => { try { return park.getFlag(name); } catch (e) { return undefined; } };
            const unlockAll = flag('unlockAllPrices'), freeEntry = flag('freeParkEntry');
            parkView.rules = {
                guestsPayEntryFee: unlockAll || !freeEntry,
                guestsPayForRides: unlockAll || freeEntry,
                entryFeeCanBeChanged: unlockAll || !freeEntry,
                ridePricesCanBeChanged: unlockAll || freeEntry,
                guestsHarderToAttract: flag('difficultGuestGeneration'),
                parkRatingHarderToRaise: flag('difficultParkRating'),
                guestsPreferMoreIntenseRides: flag('preferMoreIntenseRides'),
                guestsPreferLessIntenseRides: flag('preferLessIntenseRides'),
                marketingForbidden: flag('forbidMarketingCampaigns'),
                treeRemovalForbidden: flag('forbidTreeRemoval'),
                landscapeChangesForbidden: flag('forbidLandscapeChanges'),
                highConstructionForbidden: flag('forbidHighConstruction'),
                noMoney: flag('noMoney'),
                parkOpen: flag('open'),
            };
            const scenarioView = pick(scenario, ['name', 'status']);
            scenarioView.objective = pick(scenario.objective || {}, ['type', 'guests', 'year', 'length', 'excitement', 'parkValue', 'monthlyIncome']);
            return {
                session,
                paused: context.paused,
                speed: context.gameSpeed,
                mapSize: map.size,
                park: parkView,
                scenario: scenarioView,
                date: pick(date, ['monthsElapsed', 'month', 'day']),
            };
        }

        function readPeople(kind, a) {
            let all = map.getAllEntities(kind === 'guests' ? 'guest' : 'staff');
            // Filters like the guest list window: on a ride, thinking something, carrying something, or in a state.
            if (a.ride !== undefined) all = all.filter(e => e.currentRide === a.ride);
            if (a.state !== undefined) all = all.filter(e => e.state === a.state);
            if (a.thought !== undefined) all = all.filter(e => (e.thoughts || []).some(t => t.type === a.thought));
            if (a.item !== undefined) all = all.filter(e => (e.items || []).some(i => i.type === a.item));
            if (a.staffType !== undefined) all = all.filter(e => e.staffType === a.staffType);
            const offset = a.offset === undefined ? 0 : C.int(a.offset, 'offset', 0, 1000000);
            const limit = a.limit === undefined ? 100 : C.int(a.limit, 'limit', 1, 500);
            return {
                total: all.length,
                offset,
                people: all.slice(offset, offset + limit).map(e => {
                    const view = pick(e, ['id', 'name', 'x', 'y', 'z', 'state', 'happiness', 'hunger', 'thirst', 'nausea',
                        'energy', 'cash', 'staffType', 'staffOrders', 'currentRide']);
                    if (kind === 'guests') {
                        view.thoughts = (e.thoughts || []).map(t => pick(t, ['type', 'item', 'freshness', 'freshTimeout']));
                        Object.assign(view, pick(e, ['toilet', 'favouriteRide', 'minIntensity', 'maxIntensity', 'nauseaTolerance', 'isInPark', 'isLost']));
                        view.items = (e.items || []).map(i => i.type);
                        try { view.tracking = e.getFlag('tracking'); } catch (err) { /* optional */ }
                        // Game date this guest was first seen inside the park (checked once a game day since the bridge started).
                        if (firstSeen[e.id]) view.inParkSince = firstSeen[e.id];
                    } else {
                        Object.assign(view, pick(e, ['orders', 'costume', 'lawnsMown', 'gardensWatered', 'litterSwept', 'binsEmptied',
                            'ridesFixed', 'ridesInspected', 'vandalsStopped']));
                        try { view.patrolTiles = e.patrolArea.tiles.length; } catch (err) { /* optional */ }
                    }
                    return view;
                }),
            };
        }

        function readMap(a) {
            const x = C.int(a.x, 'tile x', 0, map.size.x - 1);
            const y = C.int(a.y, 'tile y', 0, map.size.y - 1);
            const w = a.width === undefined ? 1 : C.int(a.width, 'width', 1, 32);
            const h = a.height === undefined ? 1 : C.int(a.height, 'height', 1, 32);
            if (x + w > map.size.x || y + h > map.size.y) fail('That area goes past the edge of the map');
            const tiles = [];
            for (let ty = y; ty < y + h; ty++) {
                for (let tx = x; tx < x + w; tx++) tiles.push(describeTile(tx, ty));
            }
            return tiles;
        }

        // A whole-map summary: one character per tile, plus ride tiles and guest positions.
        // Small enough to read in one go, and works without graphics (headless).
        //   ~ water   . ground   # path   = queue   R ride/track   E entrance
        //   B building (large scenery)   t tree/small scenery
        function overview(a) {
            const width = map.size.x;
            const height = map.size.y;
            const rows = [];
            const heights = [];
            const rideTiles = [];
            for (let y = 0; y < height; y++) {
                let row = '';
                const hrow = [];
                for (let x = 0; x < width; x++) {
                    let code = '.';
                    let rank = 0;
                    let ride = null;
                    let ground = 0;
                    const set = (c, r) => { if (r > rank) { code = c; rank = r; } };
                    for (const el of map.getTile(x, y).elements) {
                        switch (el.type) {
                            case 'surface':
                                ground = el.baseZ;
                                if (el.waterHeight > el.baseZ) set('~', 1);
                                break;
                            case 'small_scenery': set('t', 2); break;
                            case 'large_scenery': set('B', 3); break;
                            case 'footpath': set(el.isQueue ? '=' : '#', 4); break;
                            case 'track':
                                set('R', 5);
                                ride = el.ride;
                                break;
                            case 'entrance':
                                set('E', 6);
                                if (el.ride !== undefined && el.ride !== null) ride = el.ride;
                                break;
                        }
                    }
                    row += code;
                    hrow.push(ground);
                    if ((code === 'R' || code === 'E') && Number.isInteger(ride)) rideTiles.push([x, y, ride]);
                }
                rows.push(row);
                heights.push(hrow);
            }
            const result = { width, height, legend: '~ water, . ground, # path, = queue, R ride, E entrance, B building, t tree/scenery', rows, rideTiles };
            if (a.heights) result.heights = heights;
            if (a.guests) {
                result.guests = map.getAllEntities('guest')
                    .filter(g => g.x >= 0 && g.y >= 0)
                    .map(g => [Math.floor(g.x / 32), Math.floor(g.y / 32)]);
            }
            return result;
        }

        // Moves the camera of the game window. Display only: it can't change the park.
        function moveView(a) {
            if (typeof ui === 'undefined' || !ui.mainViewport) fail('No game window in headless mode');
            const vp = ui.mainViewport;
            if (a.zoom !== undefined) vp.zoom = C.int(a.zoom, 'zoom', 0, 3);
            if (a.rotation !== undefined) vp.rotation = C.int(a.rotation, 'rotation', 0, 3);
            if (a.show !== undefined) {
                // Picks which view options are on, like the game's View menu: e.g. ["underground", "seeThroughRides"].
                if (!Array.isArray(a.show)) fail('show must be a list of: ' + Object.keys(VIEW_FLAGS).join(', '));
                let flags = vp.visibilityFlags & VIEW_KEEP;
                for (const name of a.show) {
                    if (!has(VIEW_FLAGS, name)) fail('Unknown view option ' + name + '. Use: ' + Object.keys(VIEW_FLAGS).join(', '));
                    flags |= VIEW_FLAGS[name];
                }
                vp.visibilityFlags = flags >>> 0;
            }
            if (a.ride !== undefined) {
                const st = (getRide(a.ride).stations || []).filter(x => x.start)[0];
                if (!st) fail('That ride has no station to look at');
                vp.moveTo(st.start);
            }
            if (a.entity !== undefined) {
                const e = map.getEntity(C.int(a.entity, 'entity', 0, 65534));
                if (!e) fail(`Nobody with id ${a.entity}`);
                vp.moveTo({ x: e.x, y: e.y, z: e.z });
            }
            if (a.x !== undefined && a.y !== undefined) {
                vp.moveTo({ x: C.int(a.x, 'world x', 0, map.size.x * 32 - 1), y: C.int(a.y, 'world y', 0, map.size.y * 32 - 1) });
            }
            const on = Object.keys(VIEW_FLAGS).filter(k => (vp.visibilityFlags & VIEW_FLAGS[k]) !== 0);
            return { zoom: vp.zoom, rotation: vp.rotation, show: on, centre: vp.getCentrePosition() };
        }

        function capture(a) {
            // Headless games have no graphics; asking for a picture crashes the engine.
            if (typeof ui === 'undefined') fail('Screenshots need the game window. They are not available in headless mode.');
            const options = {
                filename: 'agent-' + newId() + '.png',
                width: a.width === undefined ? 1600 : C.int(a.width, 'width', 320, 2560),
                height: a.height === undefined ? 1000 : C.int(a.height, 'height', 240, 1600),
                zoom: a.zoom === undefined ? 1 : C.int(a.zoom, 'zoom', 0, 3),
                rotation: a.rotation === undefined ? 0 : C.int(a.rotation, 'rotation', 0, 3),
                position: {
                    x: a.x === undefined ? map.size.x * 16 : C.int(a.x, 'world x', 0, map.size.x * 32 - 1),
                    y: a.y === undefined ? map.size.y * 16 : C.int(a.y, 'world y', 0, map.size.y * 32 - 1),
                },
            };
            context.captureImage(options);
            return { filename: options.filename, directory: 'user-data/screenshot', options };
        }

        // ---- What the game's windows show ----
        const VIEW_FLAGS = { underground: 1, seeThroughRides: 1 << 24, seeThroughVehicles: 1 << 25, seeThroughTrees: 1 << 26,
            seeThroughScenery: 1 << 27, seeThroughPaths: 1 << 28, seeThroughSupports: 1 << 29, hideBaseLand: 1 << 12,
            hideVerticalFaces: 1 << 13, hideRides: 1 << 1, hideVehicles: 1 << 20, hideTrees: 1 << 21, hideScenery: 1 << 2,
            hidePaths: 1 << 16, hideSupports: 1 << 3, hideGuests: 1 << 11, hideStaff: 1 << 23, landHeights: 1 << 4,
            trackHeights: 1 << 5, pathHeights: 1 << 6, gridlines: 1 << 7, landOwnership: 1 << 8, constructionRights: 1 << 9,
            cutAway: 1 << 15, pathIssues: 1 << 18 };
        const VIEW_KEEP = (1 << 10) | (1 << 30); // sound and rotation settings are not view options

        const MONEY_TYPES = ['park_entrance_tickets', 'park_ride_tickets', 'shop_sales', 'food_drink_sales', 'shop_stock',
            'food_drink_stock', 'wages', 'ride_runningcosts', 'ride_construction', 'land_purchase', 'landscaping',
            'marketing', 'research', 'interest'];
        // The finances window's summary: money in (positive) and out (negative) by month, this month first.
        function readFinances() {
            const months = {};
            for (const t of MONEY_TYPES) {
                try { months[t] = park.getMonthlyExpenditure(t); } catch (e) { months[t] = null; }
            }
            return {
                unit: 'game money: 10 = 1 pound or dollar', note: 'Each list starts with this month, then last month, and so on.',
                cash: park.cash, bankLoan: park.bankLoan, maxBankLoan: park.maxBankLoan, parkValue: park.value,
                companyValue: park.companyValue, byMonth: months,
            };
        }

        function describeResearchItem(i) {
            if (!i) return null;
            const view = pick(i, ['type', 'category', 'rideType', 'object']);
            try {
                const o = objectManager.getObject(i.type === 'ride' ? 'ride' : 'scenery_group', i.object);
                if (o) view.name = o.name;
            } catch (e) { /* name is optional */ }
            return view;
        }
        function readResearch() {
            const r = park.research;
            return {
                funding: r.funding, priorities: r.priorities, stage: r.stage, progress: r.progress,
                expectedItem: describeResearchItem(r.expectedItem), expectedMonth: r.expectedMonth, expectedDay: r.expectedDay,
                lastResearchedItem: describeResearchItem(r.lastResearchedItem),
                inventedCount: r.inventedItems.length, notYetInventedCount: r.uninventedItems.length,
            };
        }

        function readWeather() {
            return { climate: climate.type, now: pick(climate.current, ['weather', 'temperature']),
                next: pick(climate.future, ['weather', 'temperature']), temperatureUnit: 'Celsius' };
        }

        // The game keeps no history the plugin can read, so the bridge writes down the numbers every game day.
        const MAX_HISTORY = 2000;
        let history = [];
        let firstSeen = {};
        context.subscribe('interval.day', () => {
            try {
                history.push({ monthsElapsed: date.monthsElapsed, day: date.day, cash: park.cash, rating: park.rating,
                    guests: park.guests, parkValue: park.value, companyValue: park.companyValue });
                if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
            } catch (e) { /* never break the game for a log */ }
            // The game doesn't tell plugins how long a guest has been in the park, so note the day each guest is first seen inside.
            try {
                const today = { monthsElapsed: date.monthsElapsed, day: date.day };
                const now = {};
                for (const g of map.getAllEntities('guest')) {
                    if (!g.isInPark) continue;
                    now[g.id] = firstSeen[g.id] || today;
                }
                firstSeen = now;
            } catch (e) { /* never break the game for a log */ }
        });
        function readHistory(a) {
            const every = a.every === undefined ? 1 : C.int(a.every, 'every', 1, 365);
            const rows = history.filter((h, i) => (history.length - 1 - i) % every === 0);
            return { note: 'One row per game day since the bridge started watching this park, oldest first.', rows: rows.slice(-500) };
        }

        // Adverts the agent started, so it can see what is still running (the game doesn't tell plugins).
        let campaigns = [];
        const CAMPAIGN_NAMES = ['free entry vouchers', 'free ride vouchers', 'half-price entry vouchers',
            'free food or drink vouchers', 'park advert', 'ride advert'];
        function noteCampaign(args) {
            const now = date.monthsElapsed * 4 + Math.floor(date.monthProgress / 16384);
            campaigns = campaigns.filter(c => c.type !== args.type);
            campaigns.push({ type: args.type, name: CAMPAIGN_NAMES[args.type], item: args.item, weeks: args.duration, startWeek: now });
        }
        function readMarketing() {
            const now = date.monthsElapsed * 4 + Math.floor(date.monthProgress / 16384);
            return {
                note: 'Campaigns started through the bridge in this session. Weeks left are approximate.',
                running: campaigns.map(c => Object.assign({}, c, { weeksLeft: Math.max(0, c.startWeek + c.weeks - now) }))
                    .filter(c => c.weeksLeft > 0),
            };
        }

        function readNews(a) {
            const all = park.messages || [];
            const offset = a.offset === undefined ? 0 : C.int(a.offset, 'offset', 0, 100000);
            const limit = a.limit === undefined ? 100 : C.int(a.limit, 'limit', 1, 500);
            const newestFirst = all.slice().reverse();
            return { total: all.length, offset, messages: newestFirst.slice(offset, offset + limit)
                .map(m => Object.assign(pick(m, ['type', 'subject', 'text', 'month', 'day', 'isArchived']),
                    { warning: String(m.text || '').indexOf('{RED}') >= 0 })) };
        }

        // The guest list's "thoughts" view: how many guests think each thing.
        function readThoughts() {
            const counts = {};
            let guests = 0;
            for (const g of map.getAllEntities('guest')) {
                if (!g.isInPark) continue;
                guests++;
                for (const t of g.thoughts || []) {
                    const key = t.type + (t.item !== undefined && t.item !== 255 && t.item !== 65535 ? ':' + t.item : '');
                    if (!counts[key]) counts[key] = { thought: t.type, item: t.item, guests: 0, text: null };
                    counts[key].guests++;
                    if (!counts[key].text) try { counts[key].text = t.toString(); } catch (e) { /* optional */ }
                }
            }
            return { guestsInPark: guests, thoughts: Object.keys(counts).map(k => counts[k]).sort((x, y) => y.guests - x.guests) };
        }

        function readAwards() {
            return (park.awards || []).map(w => pick(w, ['type', 'text', 'monthsRemaining']));
        }

        function makePlan(a) {
            if (Object.keys(plans).length >= MAX_PLANS) fail('Too many saved plans; reload the park to clear them');
            const plan = C.planTrack(a, type => context.getTrackSegment(type), TRACK_NAMES, map.size);
            const planId = newId();
            plans[planId] = { session, plan };
            return Object.assign({ planId, session }, plan);
        }

        // Answers every request that does not change the park.
        function handleRead(req) {
            const a = req.args || {};
            switch (req.op) {
                case 'hello':
                    return {
                        bridgeVersion: BRIDGE_VERSION, apiVersion: context.apiVersion, session, armed, busy,
                        mode: context.mode, network: network.mode, operations: READ_OPS.concat(CHANGE_OPS),
                        receipts: { kept: Object.keys(receipts).length, max: MAX_RECEIPTS },
                    };
                case 'actions':
                    return ACTION_SCHEMAS;
                case 'receipt':
                    if (typeof a.id !== 'string') fail('receipt needs an id');
                    return has(receipts, a.id) ? receipts[a.id] : null;
                case 'arm':
                    requirePark();
                    if (req.session !== session) fail('Old session. Run "hello" to get the current one.');
                    armed = true;
                    return { armed: true, session };
                case 'stop':
                    stop();
                    return { armed: false, busy, message: 'Stopped. An action already sent to the game may still finish.' };
                case 'feed':
                    return addToFeed(a);
                case 'view':
                    return moveView(a);
            }
            requirePark();
            switch (req.op) {
                case 'park': return readPark();
                case 'objective.set': return setObjective(a);
                case 'rides': {
                    // Like the ride list window: optionally sorted by any number, highest first.
                    const list = map.rides.map(r => describeRide(r));
                    if (a.sortBy !== undefined) {
                        if (typeof a.sortBy !== 'string') fail('sortBy must be a field name, e.g. "profit"');
                        list.sort((x, y) => (typeof y[a.sortBy] === 'number' ? y[a.sortBy] : -Infinity) - (typeof x[a.sortBy] === 'number' ? x[a.sortBy] : -Infinity));
                    }
                    return list;
                }
                case 'ride': return describeRide(getRide(a.ride), true);
                case 'map': return readMap(a);
                case 'overview': return overview(a);
                case 'guests':
                case 'staff': return readPeople(req.op, a);
                case 'objects':
                    if (OBJECT_TYPES.indexOf(a.type) < 0) fail('type must be one of: ' + OBJECT_TYPES.join(', '));
                    return objectManager.getAllObjects(a.type).map(o => pick(o, ['index', 'identifier', 'name',
                        'description', 'rideType', 'minCarsInTrain', 'maxCarsInTrain', 'carsPerFlatRide']));
                case 'capture': return capture(a);
                case 'finances': return readFinances();
                case 'research': return readResearch();
                case 'weather': return readWeather();
                case 'history': return readHistory(a);
                case 'marketing': return readMarketing();
                case 'news': return readNews(a);
                case 'thoughts': return readThoughts();
                case 'awards': return readAwards();
                case 'track.catalog': return context.getAllTrackSegments().map(describeSegment);
                case 'track.walk': return walkTrack(a);
                case 'track.plan': return makePlan(a);
                default: fail('Unknown operation: ' + req.op);
            }
        }

        // ---- Changes ----
        function queryAction(name, args, callback) {
            C.validateAction(name, args, ACTION_SCHEMAS);
            context.queryAction(name, prepareArgs(name, args), callback);
        }

        // guestsetflags replaces all of a guest's flags, so keep the others as they are and only change tracking.
        const PEEP_FLAG_BITS = { leavingPark: 0, slowWalk: 1, tracking: 3, waving: 4, hasPaidForParkEntry: 5, photo: 6,
            painting: 7, wow: 8, litter: 9, lost: 10, hunger: 11, toilet: 12, crowded: 13, happiness: 14, nausea: 15,
            purple: 16, pizza: 17, explode: 18, rideShouldBeMarkedAsFavourite: 19, parkEntranceChosen: 20, contagious: 22,
            joy: 23, angry: 24, iceCream: 25, hereWeAre: 28 };
        function prepareArgs(name, args) {
            if (name !== 'guestsetflags') return args;
            const guest = map.getEntity(args.peep);
            if (!guest || guest.type !== 'guest') fail(`Guest ${args.peep} does not exist`);
            let flags = 0;
            for (const key of Object.keys(PEEP_FLAG_BITS)) {
                if (key !== 'tracking' && guest.getFlag(key)) flags |= 1 << PEEP_FLAG_BITS[key];
            }
            if (args.guestFlags === 8) flags |= 8;
            return { peep: args.peep, guestFlags: flags >>> 0 };
        }

        // Turn a change request into a list of game actions to run in order.
        function actionsFor(req) {
            const a = req.args || {};
            if (req.op === 'action.execute') return { actions: [{ action: a.action, args: a.args }] };
            if (req.op === 'batch.execute') {
                if (!Array.isArray(a.actions) || a.actions.length === 0 || a.actions.length > MAX_BATCH) {
                    fail(`actions must be a list of 1 to ${MAX_BATCH} entries`);
                }
                return { actions: a.actions.map(item => ({ action: item && item.action, args: item && item.args })) };
            }

            const saved = plans[a.planId];
            if (!saved || saved.session !== session) fail('Unknown or old planId. Make a new plan with track.plan.');
            const plan = saved.plan;

            if (req.op === 'track.build') {
                const ride = getRide(a.ride);
                if (ride.status !== 'closed') fail('Close the ride before adding track');
                return {
                    plan, rideId: a.ride,
                    actions: plan.steps.map(p => ({ action: 'trackplace', args: Object.assign({}, p, { ride: a.ride, rideType: ride.type }) })),
                };
            }

            if (req.op === 'coaster.build') {
                C.validateAction('ridecreate', a.create, ACTION_SCHEMAS);
                // Steps marked newRide get the new ride's id once ridecreate tells us what it is.
                const list = [{ action: 'ridecreate', args: a.create }];
                if (a.name !== undefined) list.push({ action: 'ridesetname', args: { ride: 0, name: a.name }, newRide: true });
                for (const p of plan.steps) {
                    list.push({ action: 'trackplace', args: Object.assign({}, p, { ride: 0, rideType: a.create.rideType }), newRide: true });
                }
                if (a.entrances !== undefined) {
                    if (!Array.isArray(a.entrances) || a.entrances.length > 8) fail('entrances must be a list of at most 8');
                    for (const e of a.entrances) {
                        list.push({ action: 'rideentranceexitplace', args: Object.assign({}, e, { ride: 0 }), newRide: true });
                    }
                }
                if (a.test === true) list.push({ action: 'ridesetstatus', args: { ride: 0, status: 2 }, newRide: true });
                return { plan, actions: list };
            }
            fail('Unknown change operation: ' + req.op);
        }

        function runSave(req, fingerprint, reply) {
            const receipt = { id: req.id, fingerprint, session, op: 'save', state: 'started', filename: `agent-checkpoint-${req.id}.park` };
            receipts[req.id] = receipt;
            saveReceipts();
            try {
                context.saveGame({ filename: `agent-checkpoint-${req.id}` });
                receipt.state = 'completed';
            } catch (e) {
                receipt.state = 'outcome_unknown';
                receipt.failure = String(e);
            }
            saveReceipts();
            reply({ id: req.id, ok: true, result: receipt });
        }

        function handleChange(req, reply) {
            const fingerprint = JSON.stringify({ op: req.op, args: req.args, session: req.session });

            // Same id again: never redo the work, just hand back what happened the first time.
            if (has(receipts, req.id)) {
                const old = receipts[req.id];
                if (old.fingerprint !== fingerprint) fail('This request id was already used for a different request');
                reply({ id: req.id, ok: true, result: old });
                return;
            }

            requireArmed(req);
            if (busy) fail('Another change is still running');

            if (req.op === 'save') {
                runSave(req, fingerprint, reply);
                return;
            }

            const budget = C.int((req.args || {}).maxCost, 'maxCost (game money: 10 = $1)', 0, 2147483647);
            const job = actionsFor(req);
            for (const item of job.actions) C.validateAction(item.action, item.args, ACTION_SCHEMAS);
            for (const item of job.actions) item.args = prepareArgs(item.action, item.args);

            const startedGeneration = generation;
            const startedSession = session;
            let rideId = job.rideId;
            let index = 0;
            const receipt = {
                id: req.id, fingerprint, session, op: req.op, state: 'started',
                completed: [], spent: 0, ride: rideId, startedAt: Date.now(),
            };
            receipts[req.id] = receipt;
            saveReceipts();
            busy = true;

            // What happened goes in its own field: `summary` when every step was done, `failure` (why it stopped) otherwise.
            function finish(state, detail) {
                receipt.state = state;
                if (state === 'completed') receipt.summary = detail;
                else receipt.failure = detail;
                receipt.finishedAt = Date.now();
                busy = false;
                try {
                    saveReceipts();
                } catch (e) {
                    receipt.saveError = String(e);
                }
                reply({ id: req.id, ok: true, result: receipt });
            }

            function stillAllowed() {
                return armed && generation === startedGeneration && session === startedSession &&
                    network.mode === 'none' && (context.mode === 'normal' || context.mode === 'track_designer');
            }

            // Run one action, then schedule the next. Each one is checked (queried) first.
            function step() {
                try {
                    if (!stillAllowed()) return finish('stopped', 'STOP was pressed or the park changed');
                    if (index === job.actions.length) {
                        return finish('completed', {
                            actions: job.actions.length,
                            planClosed: job.plan ? job.plan.closed : undefined,
                            physicsVerified: false,
                        });
                    }
                    const item = job.actions[index];
                    if (item.newRide) item.args.ride = rideId;
                    receipt.next = { index, action: item.action, args: item.args };
                    saveReceipts();

                    context.queryAction(item.action, item.args, check => {
                        try {
                            if (check.error) return finish('partial', { index, phase: 'check', result: check });
                            if (!stillAllowed()) return finish('stopped', 'STOP was pressed or the park changed');
                            const cost = Math.max(0, check.cost || 0);
                            if (receipt.spent + cost > budget) {
                                return finish('partial', { index, phase: 'budget', cost, remaining: budget - receipt.spent });
                            }
                            receipt.inFlight = { index, action: item.action, args: item.args };
                            saveReceipts();

                            context.executeAction(item.action, item.args, result => {
                                try {
                                    delete receipt.inFlight;
                                    if (result.error) return finish('partial', { index, phase: 'execute', result });
                                    receipt.completed.push({ index, action: item.action, args: item.args, result });
                                    if (item.action === 'parkmarketing') noteCampaign(item.args);
                                    receipt.spent += Math.max(0, result.cost || 0);
                                    if (item.action === 'ridecreate') {
                                        rideId = result.ride;
                                        receipt.ride = rideId;
                                        if (!Number.isInteger(rideId)) return finish('outcome_unknown', 'The game did not return the new ride id');
                                    }
                                    index++;
                                    saveReceipts();
                                    context.setTimeout(step, 1);
                                } catch (e) {
                                    finish('outcome_unknown', String(e));
                                }
                            });
                        } catch (e) {
                            finish(receipt.inFlight ? 'outcome_unknown' : 'partial', String(e));
                        }
                    });
                } catch (e) {
                    finish(receipt.inFlight ? 'outcome_unknown' : 'partial', String(e));
                }
            }
            step();
        }

        // ---- Requests ----
        function handle(req, reply) {
            try {
                if (!req || typeof req !== 'object' || req.token !== BRIDGE_CONFIG.token) fail('Wrong or missing password (token)');
                if (typeof req.id !== 'string' || !ID_PATTERN.test(req.id)) fail('id must be 8 to 80 letters, digits or hyphens');
                if (CHANGE_OPS.indexOf(req.op) >= 0) return handleChange(req, reply);
                if (req.op === 'action.query') {
                    requirePark();
                    const a = req.args || {};
                    return queryAction(a.action, a.args, result => reply({ id: req.id, ok: true, result }));
                }
                reply({ id: req.id, ok: true, result: handleRead(req) });
            } catch (e) {
                reply({ id: req && req.id, ok: false, error: String((e && e.message) || e) });
            }
        }

        // News ticker: every reply carries the newest game messages, so the helper can show the unseen ones.
        // Red text in the game ({RED}) is a warning: guests can't reach a ride, a crash, a low park rating, ...
        function recentNews() {
            try {
                const all = park.messages || [];
                return all.slice(-30).map(m => {
                    const raw = String(m.text || '');
                    return {
                        key: [m.month, m.day, m.type, m.subject, raw].join('|'),
                        type: m.type, month: m.month, day: m.day,
                        warning: raw.indexOf('{RED}') >= 0,
                        text: raw.replace(/\{NEWLINE\}/g, ' ').replace(/\{[A-Z0-9_]+\}/g, '').replace(/\s+/g, ' ').trim(),
                    };
                });
            } catch (e) {
                return [];
            }
        }

        let clients = [];
        const listener = network.createListener();
        listener.on('connection', socket => {
            if (clients.length >= MAX_CLIENTS) {
                socket.end();
                return;
            }
            clients.push(socket);
            let buffer = '';
            const send = message => {
                try {
                    if (message && message.id !== undefined) message.recentNews = recentNews();
                    socket.write(JSON.stringify(message) + '\n');
                } catch (e) {
                    console.log('Agent bridge: could not send a reply; the receipt has the result');
                }
            };
            socket.on('error', () => {});
            socket.on('close', () => { clients = clients.filter(c => c !== socket); });
            socket.on('data', chunk => {
                buffer += chunk;
                if (buffer.length > MAX_REQUEST_BYTES) {
                    socket.end();
                    return;
                }
                let newline;
                while ((newline = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, newline);
                    buffer = buffer.slice(newline + 1);
                    if (!line.trim()) continue;
                    let req;
                    try {
                        req = JSON.parse(line);
                    } catch (e) {
                        send({ ok: false, error: 'Invalid JSON' });
                        continue;
                    }
                    handle(req, send);
                }
            });
        });
        listener.listen(BRIDGE_CONFIG.port, '127.0.0.1');

        // ---- AI output panel ----
        // Shows what the AI playing the game prints, as sent by scripts/feed.js. Display only: it can't change the park.
        let feed = [];
        let feedTitle = 'AI output';
        let feedVersion = 0;

        function addToFeed(a) {
            if (a.clear === true) feed = [];
            if (typeof a.title === 'string') feedTitle = a.title.slice(0, 80);
            const entries = a.entries === undefined ? [] : a.entries;
            if (!Array.isArray(entries) || entries.length > 200) fail('entries must be a list of at most 200 items');
            for (const e of entries) {
                if (!e || FEED_KINDS.indexOf(e.kind) < 0 || typeof e.text !== 'string') fail('each entry needs a kind (' + FEED_KINDS.join(', ') + ') and a text');
                feed.push({ kind: e.kind, text: e.text.slice(0, MAX_FEED_TEXT) });
            }
            if (feed.length > MAX_FEED) feed = feed.slice(feed.length - MAX_FEED);
            feedVersion++;
            if (typeof ui !== 'undefined' && a.open !== false) openFeedWindow();
            return { shown: feed.length, panel: typeof ui !== 'undefined' };
        }

        const FEED_STYLE = {
            info: { colour: '{GREEN}', prefix: '' },
            model: { colour: '{WHITE}', prefix: '' },
            thinking: { colour: '{GREY}', prefix: 'Thinking: ' },
            tool: { colour: '{YELLOW}', prefix: '> ' },
            output: { colour: '{PALESILVER}', prefix: '  ' },
            error: { colour: '{LIGHTPINK}', prefix: '  ' },
        };
        const LINE_HEIGHT = 11;

        // Game text treats { and } as formatting codes; doubling them shows them as plain characters.
        const plain = text => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\t/g, '    ').replace(/\{/g, '{{').replace(/\}/g, '}}');

        // Split one entry into lines that fit the panel width.
        function wrapEntry(g, entry, width) {
            const style = FEED_STYLE[entry.kind];
            const lines = [];
            const fits = s => g.measureText(plain(s)).width <= width;
            (style.prefix + entry.text).split('\n').forEach(paragraph => {
                let rest = paragraph;
                while (rest.length > 0) {
                    if (fits(rest)) { lines.push(rest); break; }
                    // Find the longest piece that fits, then prefer to break at a space.
                    let lo = 1, hi = rest.length;
                    while (lo < hi) {
                        const mid = Math.ceil((lo + hi) / 2);
                        if (fits(rest.slice(0, mid))) lo = mid; else hi = mid - 1;
                    }
                    const space = rest.lastIndexOf(' ', lo);
                    const cut = space > lo / 2 ? space : lo;
                    lines.push(rest.slice(0, cut));
                    rest = rest.slice(cut).replace(/^ /, '');
                }
                if (paragraph.length === 0) lines.push('');
            });
            return lines.map(l => style.colour + plain(l));
        }

        // Newest at the bottom, like a chat. Older lines scroll off the top.
        // Uses the widget's own size: g.width and g.height can be just the part of it being redrawn.
        function drawFeed(g, widgetWidth, widgetHeight) {
            const width = widgetWidth - 8;
            let y = widgetHeight - LINE_HEIGHT - 2;
            for (let i = feed.length - 1; i >= 0 && y > -LINE_HEIGHT; i--) {
                const lines = wrapEntry(g, feed[i], width);
                for (let j = lines.length - 1; j >= 0 && y > -LINE_HEIGHT; j--) {
                    g.text(lines[j], 4, y);
                    y -= LINE_HEIGHT;
                }
                y -= 3;
            }
        }

        function openFeedWindow() {
            const existing = ui.getWindow('agent-bridge-feed');
            if (existing) return existing;
            const width = Math.min(420, Math.max(260, Math.floor(ui.width / 3)));
            const top = 28;
            const height = Math.max(200, ui.height - top - 40);
            let shownVersion = -1;
            const win = ui.openWindow({
                classification: 'agent-bridge-feed',
                title: feedTitle,
                x: ui.width - width,
                y: top,
                width,
                height,
                minWidth: 200,
                minHeight: 120,
                maxWidth: 1200,
                maxHeight: 2000,
                colours: [0, 0],
                widgets: [{ type: 'custom', name: 'feed', x: 1, y: 15, width: width - 2, height: height - 16,
                    onDraw: g => drawFeed(g, (win ? win.width : width) - 2, (win ? win.height : height) - 16) }],
                onUpdate: () => {
                    const w = win.findWidget('feed');
                    if (shownVersion !== feedVersion) {
                        shownVersion = feedVersion;
                        win.title = feedTitle;
                        // Changing a widget's size makes the game redraw it, so nudge it.
                        w.height = win.height - 17;
                    }
                    if (w.width !== win.width - 2 || w.height !== win.height - 16) {
                        w.width = win.width - 2;
                        w.height = win.height - 16;
                    }
                },
            });
            return win;
        }

        if (typeof ui !== 'undefined') {
            ui.registerMenuItem('Agent bridge: STOP', () => {
                stop();
                console.log('Agent bridge stopped');
            });
            ui.registerMenuItem('Agent bridge: AI output panel', openFeedWindow);
        }
        console.log(`Agent bridge ${BRIDGE_VERSION} listening on 127.0.0.1:${BRIDGE_CONFIG.port} (read-only)`);
    }

    registerPlugin({
        name: 'Agent Bridge',
        version: BRIDGE_VERSION,
        authors: ['rct-agent-bridge'],
        type: 'intransient',
        licence: 'GPL-3.0-only',
        minApiVersion: 122,
        targetApiVersion: 122,
        main,
    });
})();
