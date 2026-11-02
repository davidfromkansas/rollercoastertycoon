'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadFakeGame } = require('./fake-game.js');
const { toEntries } = require('../src/feed-format.js');

// A pretend drawing surface: every character is 6 pixels wide.
function fakeGraphics(width, height) {
    const drawn = [];
    const visible = s => s.replace(/\{[A-Z]+\}/g, '').replace(/\{\{/g, '{').replace(/\}\}/g, '}');
    return {
        width, height, drawn,
        measureText: s => ({ width: visible(s).length * 6, height: 10 }),
        text: (s, x, y) => drawn.push({ s, x, y }),
    };
}

test('the panel opens on the right and shows the newest line at the bottom', async () => {
    const g = loadFakeGame();
    const reply = await g.request({ op: 'feed', args: { title: 'Claude', entries: [
        { kind: 'model', text: 'I will look at the park first.' },
        { kind: 'tool', text: 'Bash(node cli.js park)' },
        { kind: 'output', text: '{"cash": 100000}' },
    ] } });
    assert.strictEqual(reply.ok, true);
    assert.strictEqual(reply.result.shown, 3);
    const win = g.game.windows['agent-bridge-feed'];
    assert.ok(win, 'window opened');
    assert.strictEqual(win.x + win.width, 1280);
    assert.strictEqual(win.title, 'Claude');

    const gfx = fakeGraphics(100, 50); // only part of the panel is being redrawn
    win.widgets[0].onDraw(gfx);
    const bottom = gfx.drawn[0];
    assert.strictEqual(bottom.y, win.height - 16 - 11 - 2, 'newest line sits at the bottom of the whole panel');
    assert.match(bottom.s, /\{PALESILVER\}/);
    assert.match(bottom.s, /\{\{"cash": 100000\}\}/, 'braces are escaped so the game shows them as text');
    assert.ok(gfx.drawn.some(d => d.s.includes('{YELLOW}> Bash(node cli.js park)')));
});

test('long lines wrap to the panel width', async () => {
    const g = loadFakeGame();
    await g.request({ op: 'feed', args: { entries: [{ kind: 'model', text: 'word '.repeat(40).trim() }] } });
    const win0 = () => g.game.windows['agent-bridge-feed'];
    win0().width = 110; // 100 px of text = 16 characters
    const gfx = fakeGraphics(10, 10);
    g.game.windows['agent-bridge-feed'].widgets[0].onDraw(gfx);
    assert.ok(gfx.drawn.length > 5);
    for (const d of gfx.drawn) assert.ok(d.s.replace('{WHITE}', '').length <= 16, d.s);
});

test('feed works without arming and rejects bad entries', async () => {
    const g = loadFakeGame();
    const bad = await g.request({ op: 'feed', args: { entries: [{ kind: 'shout', text: 'hi' }] } });
    assert.strictEqual(bad.ok, false);
    const headless = loadFakeGame({ headless: true });
    const ok = await headless.request({ op: 'feed', args: { entries: [{ kind: 'info', text: 'hi' }] } });
    assert.deepStrictEqual(ok.result, { shown: 1, panel: false });
});

test('Claude Code stream lines become panel entries unchanged', () => {
    assert.deepStrictEqual(toEntries(JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-x' })),
        [{ kind: 'info', text: 'Claude Code started · claude-x' }]);
    assert.deepStrictEqual(toEntries(JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'thinking', thinking: 'Cash is low.' },
        { type: 'text', text: 'Checking the park.' },
        { type: 'tool_use', name: 'Bash', input: { command: 'node cli.js park' } },
    ] } })), [
        { kind: 'thinking', text: 'Cash is low.' },
        { kind: 'model', text: 'Checking the park.' },
        { kind: 'tool', text: 'Bash(node cli.js park)' },
    ]);
    const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const [result] = toEntries(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: long }] } }));
    assert.strictEqual(result.kind, 'output');
    assert.match(result.text, /line 11\n… \+8 lines$/);
    assert.strictEqual(toEntries(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: long }] } }), { maxOutputLines: 0 })[0].text, long);
});

test('Codex stream lines become panel entries unchanged', () => {
    assert.deepStrictEqual(toEntries(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'node cli.js rides' } })),
        [{ kind: 'tool', text: '$ node cli.js rides' }]);
    assert.deepStrictEqual(toEntries(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'x', aggregated_output: 'oops', exit_code: 1, status: 'failed' } })),
        [{ kind: 'error', text: 'oops\n(exit code 1)' }]);
    assert.deepStrictEqual(toEntries(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: '**Planning**' } })),
        [{ kind: 'thinking', text: '**Planning**' }]);
    assert.deepStrictEqual(toEntries(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } })),
        [{ kind: 'model', text: 'Done.' }]);
});

test('the panel keeps up with its size and redraws when new lines arrive', async () => {
    const g = loadFakeGame();
    await g.request({ op: 'feed', args: { title: 'Codex', entries: [{ kind: 'info', text: 'hi' }] } });
    const win = g.game.windows['agent-bridge-feed'];
    win.width = 500;
    win.title = 'old';
    win.onUpdate();
    assert.strictEqual(win.widgets[0].width, 498);
    assert.strictEqual(win.title, 'Codex');
});
