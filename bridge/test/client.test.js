'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { loadFakeGame, TOKEN } = require('./fake-game.js');

const ROOT = path.resolve(__dirname, '..');

// Run cli.js from a temporary copy of the project, talking to the fake game over a real local connection.
async function withBridge(fn) {
    const game = loadFakeGame();
    const server = net.createServer(socket => game.attach(socket));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cli-'));
    fs.copyFileSync(path.join(ROOT, 'cli.js'), path.join(dir, 'cli.js'));
    fs.writeFileSync(path.join(dir, 'bridge.config.json'), JSON.stringify({ host: '127.0.0.1', port: server.address().port, token: TOKEN }));
    const run = (...args) => new Promise(resolve => {
        execFile(process.execPath, [path.join(dir, 'cli.js'), ...args], (error, stdout, stderr) => {
            let reply = null;
            try { reply = JSON.parse(stdout); } catch (e) { /* not JSON */ }
            resolve({ code: error ? error.code : 0, reply, stdout, stderr });
        });
    });
    try {
        await fn({ run, dir, game });
    } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('hello and park work end to end', () => withBridge(async ({ run }) => {
    const hello = await run('hello');
    assert.strictEqual(hello.code, 0, hello.stderr);
    assert.strictEqual(hello.reply.result.armed, false);
    const park = await run('park');
    assert.strictEqual(park.reply.result.park.name, 'Test Park');
}));

test('a change needs arm first', () => withBridge(async ({ run, dir }) => {
    const file = path.join(dir, 'price.json');
    fs.writeFileSync(file, JSON.stringify({ op: 'action.execute', args: { action: 'ridesetprice', args: { ride: 3, price: 20, isPrimaryPrice: true }, maxCost: 0 } }));
    const before = await run('request', file);
    assert.notStrictEqual(before.code, 0);
    assert.match(before.stderr, /arm/);
}));

test('arm, change, receipt, and logs on disk', () => withBridge(async ({ run, dir, game }) => {
    assert.strictEqual((await run('arm')).code, 0);
    const file = path.join(dir, 'price.json');
    fs.writeFileSync(file, JSON.stringify({ id: 'cli-price-1', op: 'action.execute', args: { action: 'ridesetprice', args: { ride: 3, price: 20, isPrimaryPrice: true }, maxCost: 0 } }));
    const change = await run('request', file);
    assert.strictEqual(change.code, 0, change.stderr);
    assert.strictEqual(change.reply.result.state, 'completed');
    assert.ok(fs.existsSync(path.join(dir, 'logs', 'cli-price-1.request.json')));
    assert.ok(fs.existsSync(path.join(dir, 'logs', 'cli-price-1.response.json')));
    const request = JSON.parse(fs.readFileSync(path.join(dir, 'logs', 'cli-price-1.request.json'), 'utf8'));
    assert.strictEqual(request.token, undefined, 'the password must never be written to the logs');

    // Sending the same file again is refused by the helper before anything reaches the game.
    const again = await run('request', file);
    assert.notStrictEqual(again.code, 0);
    assert.strictEqual(game.executed.length, 1);

    const receipt = await run('receipt', 'cli-price-1');
    assert.strictEqual(receipt.reply.result.state, 'completed');
}));

test('a clear message when the game is not running', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cli-'));
    fs.copyFileSync(path.join(ROOT, 'cli.js'), path.join(dir, 'cli.js'));
    const free = net.createServer();
    await new Promise(resolve => free.listen(0, '127.0.0.1', resolve));
    const port = free.address().port;
    await new Promise(resolve => free.close(resolve));
    fs.writeFileSync(path.join(dir, 'bridge.config.json'), JSON.stringify({ host: '127.0.0.1', port, token: TOKEN }));
    const result = await new Promise(resolve => execFile(process.execPath, [path.join(dir, 'cli.js'), 'hello'], (error, stdout, stderr) => resolve({ error, stderr })));
    assert.ok(result.error);
    assert.match(result.stderr, /Is the game running/);
    fs.rmSync(dir, { recursive: true, force: true });
});
