/* SPDX-License-Identifier: GPL-3.0-only */
// Turns the live output of Claude Code (`claude -p --output-format stream-json --verbose`)
// or Codex (`codex exec --json`) into panel lines for the game.
// Nothing is reworded or summarised. The only change is that long command output is cut
// after a few lines, like the apps do, unless maxOutputLines is 0.
'use strict';

function textOf(content) {
    if (content === undefined || content === null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(c => (c && c.type === 'text' ? c.text : c && c.type === 'image' ? '[image]' : '')).join('\n');
    return JSON.stringify(content);
}

function cutLines(text, maxLines) {
    const lines = String(text).replace(/\s+$/, '').split('\n');
    if (!maxLines || lines.length <= maxLines) return lines.join('\n');
    return lines.slice(0, maxLines).join('\n') + `\n… +${lines.length - maxLines} lines`;
}

// What Claude Code shows for a tool call, e.g. Bash(node cli.js park)
function claudeToolLine(block) {
    const input = block.input || {};
    if (block.name === 'Bash' && typeof input.command === 'string') return `Bash(${input.command})`;
    const keys = Object.keys(input);
    if (keys.length === 1 && typeof input[keys[0]] === 'string') return `${block.name}(${input[keys[0]]})`;
    return `${block.name}(${JSON.stringify(input)})`;
}

function fromClaude(event, opts) {
    const out = [];
    if (event.type === 'system' && event.subtype === 'init') {
        out.push({ kind: 'info', text: `Claude Code started · ${event.model || 'unknown model'}` });
    } else if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
        for (const block of event.message.content) {
            if (block.type === 'text' && block.text) out.push({ kind: 'model', text: block.text });
            else if (block.type === 'thinking' && block.thinking) out.push({ kind: 'thinking', text: block.thinking });
            else if (block.type === 'redacted_thinking') out.push({ kind: 'thinking', text: '[thinking hidden by the provider]' });
            else if (block.type === 'tool_use') out.push({ kind: 'tool', text: claudeToolLine(block) });
        }
    } else if (event.type === 'user' && event.message && Array.isArray(event.message.content)) {
        for (const block of event.message.content) {
            if (block.type !== 'tool_result') continue;
            const text = cutLines(textOf(block.content), opts.maxOutputLines);
            out.push({ kind: block.is_error ? 'error' : 'output', text: text || '(no output)' });
        }
    } else if (event.type === 'result') {
        const bits = [event.is_error ? 'Finished with an error' : 'Finished'];
        if (event.num_turns !== undefined) bits.push(`${event.num_turns} turns`);
        if (event.duration_ms !== undefined) bits.push(`${Math.round(event.duration_ms / 1000)}s`);
        if (event.total_cost_usd !== undefined) bits.push(`$${Number(event.total_cost_usd).toFixed(2)}`);
        out.push({ kind: event.is_error ? 'error' : 'info', text: bits.join(' · ') });
    }
    return out;
}

function fromCodex(event, opts) {
    const out = [];
    const item = event.item || {};
    if (event.type === 'thread.started') {
        out.push({ kind: 'info', text: 'Codex started' });
    } else if (event.type === 'item.started' && item.type === 'command_execution') {
        out.push({ kind: 'tool', text: `$ ${item.command}` });
    } else if (event.type === 'item.completed') {
        switch (item.type) {
            case 'agent_message': out.push({ kind: 'model', text: item.text || '' }); break;
            case 'reasoning': out.push({ kind: 'thinking', text: item.text || '' }); break;
            case 'command_execution': {
                const text = cutLines(item.aggregated_output || '', opts.maxOutputLines) || '(no output)';
                const failed = item.status === 'failed' || (item.exit_code !== undefined && item.exit_code !== null && item.exit_code !== 0);
                out.push({ kind: failed ? 'error' : 'output', text: failed && item.exit_code ? `${text}\n(exit code ${item.exit_code})` : text });
                break;
            }
            case 'file_change':
                out.push({ kind: 'tool', text: 'Edited ' + (item.changes || []).map(c => `${c.kind} ${c.path}`).join(', ') });
                break;
            case 'mcp_tool_call':
                out.push({ kind: 'tool', text: `${item.server}.${item.tool}(${JSON.stringify(item.arguments || {})})` });
                if (item.error) out.push({ kind: 'error', text: textOf(item.error.message || item.error) });
                else if (item.result) out.push({ kind: 'output', text: cutLines(textOf(item.result.content || item.result), opts.maxOutputLines) });
                break;
            case 'web_search': out.push({ kind: 'tool', text: `Search: ${item.query}` }); break;
            case 'todo_list':
                out.push({ kind: 'model', text: (item.items || []).map(t => `${t.completed ? '[x]' : '[ ]'} ${t.text}`).join('\n') });
                break;
            case 'error': out.push({ kind: 'error', text: item.message || 'error' }); break;
        }
    } else if (event.type === 'turn.failed') {
        out.push({ kind: 'error', text: (event.error && event.error.message) || 'Turn failed' });
    } else if (event.type === 'error') {
        out.push({ kind: 'error', text: event.message || 'error' });
    }
    return out;
}

// One line of JSON from either tool -> zero or more panel entries.
function toEntries(line, opts = {}) {
    const options = { maxOutputLines: 12, ...opts };
    let event;
    try {
        event = JSON.parse(line);
    } catch (e) {
        return line.trim() ? [{ kind: 'output', text: line }] : [];
    }
    if (!event || typeof event !== 'object') return [];
    const isCodex = typeof event.type === 'string' && /^(thread|turn|item)\.|^error$/.test(event.type);
    return (isCodex ? fromCodex(event, options) : fromClaude(event, options)).filter(e => e.text);
}

module.exports = { toEntries, cutLines };
