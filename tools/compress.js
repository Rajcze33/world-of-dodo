// After `vite build`: writes a brotli (.br) and a gzip (.gz) copy next to every built script, style and page in client/dist, so the
// server can send the smaller one (server/server.js, sendFile). Babylon.js makes the game script big: 6.8 MB, about 1.2 MB as brotli.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const DIST = path.join(__dirname, '..', 'client', 'dist');
let n = 0, raw = 0, br = 0;
for (const f of fs.readdirSync(DIST, { recursive: true })) {
  const file = path.join(DIST, f);
  if (!/\.(js|css|html|svg|txt)$/.test(file) || !fs.statSync(file).isFile()) continue;
  const data = fs.readFileSync(file);
  if (data.length < 1024) continue;
  const b = zlib.brotliCompressSync(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 10, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length } });
  fs.writeFileSync(file + '.br', b);
  fs.writeFileSync(file + '.gz', zlib.gzipSync(data, { level: 9 }));
  n++; raw += data.length; br += b.length;
}
console.log(`compressed ${n} files: ${(raw / 1e6).toFixed(1)} MB → ${(br / 1e6).toFixed(1)} MB as brotli`);
