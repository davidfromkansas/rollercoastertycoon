// Prints the AI's notebook as JSON {file: text}, for the run's trace on Prime's dashboard.
//   node notebook.js NOTEBOOK_DIR
// Text files only; each cut at 20,000 characters and 200,000 in total.
'use strict';
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const out = {};
let total = 0;
function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
        const file = path.join(dir, name);
        if (fs.statSync(file).isDirectory()) { walk(file); continue; }
        if (!/\.(md|txt|js|json|py|sh|csv)$/i.test(name)) continue;
        let text = fs.readFileSync(file, 'utf8');
        if (text.length > 20000) text = text.slice(0, 20000) + '\n[cut at 20,000 characters]';
        const key = path.relative(root, file);
        if (total + text.length > 200000) { out[key] = '[left out: notebook over 200,000 characters]'; continue; }
        total += text.length;
        out[key] = text;
    }
}
try { walk(root); } catch (e) { /* no notebook */ }
process.stdout.write(JSON.stringify(out));
