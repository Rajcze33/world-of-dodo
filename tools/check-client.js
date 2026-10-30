// Parses every inline <script> of client/index.html, so a typo in the 200 KB game page fails fast
// instead of in the browser. Usage: node tools/check-client.js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const file = path.join(__dirname, '..', 'client', 'index.html');
const html = fs.readFileSync(file, 'utf8');
let n = 0, bad = 0;
for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
  n++;
  const line = html.slice(0, m.index).split('\n').length;
  try {
    new vm.Script(m[1], { filename: `client/index.html (script ${n}, from line ${line})` });
  } catch (e) {
    bad++;
    console.error(`script ${n} (from line ${line}): ${e.message}`);
  }
}
console.log(`${n} inline script(s), ${bad ? bad + ' with errors' : 'all parse'}`);
process.exit(bad ? 1 : 0);
