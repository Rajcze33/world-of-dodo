// World of DODO, issue #16: a picture of client/shared/karlin.json for a look by eye (not used by the game).
//   node tools/karlin/preview.mjs [outDir] [--view x0,z0,x1,z1,zoom]
// writes preview.svg (the whole outer zone) and preview-arena.svg (the arena) to outDir (default tools/karlin/cache), and
// PNGs of both if puppeteer-core can be found (npm i --no-save puppeteer-core, as for tools/browser-test.js; CHROME=path).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const D = JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', 'client', 'shared', 'karlin.json'), 'utf8'));
const args = process.argv.slice(2), vi = args.indexOf('--view'), VIEW = vi >= 0 ? args.splice(vi, 2)[1].split(',').map(Number) : null;
const OUT = args[0] || path.join(HERE, 'cache');
const pts = a => { let s = ''; for (let i = 0; i < a.length; i += 2) s += (i ? ' ' : '') + a[i] + ',' + a[i + 1]; return s; };
const poly = (a, st) => `<polygon points="${pts(a)}" ${st}/>`;
const line = (a, st) => `<polyline points="${pts(a)}" fill="none" ${st}/>`;
// arena buildings by height: a sequential ramp, light (low) to dark (high)
const RAMP = ['#fde9c7', '#f9cf8f', '#f3ad5c', '#e2853a', '#c45f2a', '#99401f', '#6b2a17'];
const hcol = h => RAMP[Math.max(0, Math.min(RAMP.length - 1, Math.floor(h / 6)))];

function svg(view, zoom) {
  const [x0, z0, x1, z1] = view, W = Math.round((x1 - x0) * zoom), H = Math.round((z1 - z0) * zoom), o = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${x0} ${z0} ${x1 - x0} ${z1 - z0}">`);
  o.push(`<rect x="${x0}" y="${z0}" width="${x1 - x0}" height="${z1 - z0}" fill="#f2efe6"/>`);
  // terrain as shaded cells (green-brown with height), the river bed blue
  const T = D.terrain;
  for (let j = 0; j < T.nz; j++) for (let i = 0; i < T.nx; i++) {
    const h = T.h[j * T.nx + i], x = T.x0 + i * T.step - T.step / 2, z = T.z0 + j * T.step - T.step / 2;
    if (x > x1 || z > z1 || x + T.step < x0 || z + T.step < z0 || h === 0) continue;
    const c = h <= -1.5 ? `rgb(150,185,215)` : h < 0 ? 'rgb(236,232,214)' : `rgb(${Math.round(232 - h * 1.6)},${Math.round(226 - h * 0.9)},${Math.round(200 - h * 1.9)})`;
    o.push(`<rect x="${x}" y="${z}" width="${T.step + 0.3}" height="${T.step + 0.3}" fill="${c}"/>`);
  }
  for (const p of D.parks) o.push(poly(p, 'fill="#b9d89a" fill-opacity="0.75"'));
  for (const p of D.water) o.push(poly(p, 'fill="#6fa8dc"'));
  for (const p of D.blocks) o.push(poly(p, 'fill="#dcd6c8" stroke="#a9a091" stroke-width="0.4"'));
  for (const p of D.plazas) o.push(poly(p, 'fill="#efd9a8" stroke="#c9a85a" stroke-width="0.3"'));
  const N = D.roads.nodes;
  for (const e of D.roads.edges) o.push(line(e.pts, `stroke="${e.tram ? '#8a8a9a' : '#9a9a9a'}" stroke-width="${e.w}" stroke-opacity="0.55" stroke-linecap="round" stroke-linejoin="round"`));
  for (const e of D.roads.edges) o.push(line(e.pts, `stroke="#555" stroke-width="${0.35 / zoom * 2}"`));
  for (const r of D.rail) o.push(line(r.pts, r.bridge ? `stroke="#7a3b1b" stroke-width="${Math.max(2.2, 3 / zoom)}"` : `stroke="#333" stroke-width="${Math.max(0.8, 1.2 / zoom)}" stroke-dasharray="3 2"`));
  for (const t of D.tram.tracks) o.push(line(t, `stroke="#e08a00" stroke-width="${Math.max(0.6, 1 / zoom)}"`));
  for (const b of D.buildings) {
    const fill = b.far ? (b.y0 > 2 ? '#9d9a92' : '#b8b4aa') : hcol(b.h);
    o.push(poly(b.p, `fill="${fill}" stroke="${b.far ? '#888' : '#5a4632'}" stroke-width="${b.far ? 0.2 : 0.25}"`));
  }
  for (let i = 0; i < D.trees.length; i += 3) o.push(`<circle cx="${D.trees[i]}" cy="${D.trees[i + 1]}" r="${D.trees[i + 2] * 1.1}" fill="#3f8f3a" fill-opacity="0.8"/>`);
  for (let i = 0; i < N.length; i += 2) o.push(`<circle cx="${N[i]}" cy="${N[i + 1]}" r="${Math.max(0.9, 1.6 / zoom)}" fill="#1b4f9c"/>`);
  // the tram loop and its stops
  o.push(`<polygon points="${pts(D.tram.loop)}" fill="none" stroke="#d1007a" stroke-width="${Math.max(0.6, 1.2 / zoom)}"/>`);
  const L = []; for (let i = 0; i < D.tram.loop.length; i += 2) L.push([D.tram.loop[i], D.tram.loop[i + 1]]); L.push(L[0]);
  const at = s => { let acc = 0; for (let i = 1; i < L.length; i++) { const l = Math.hypot(L[i][0] - L[i - 1][0], L[i][1] - L[i - 1][1]); if (acc + l >= s) { const t = (s - acc) / l; return [L[i - 1][0] + (L[i][0] - L[i - 1][0]) * t, L[i - 1][1] + (L[i][1] - L[i - 1][1]) * t]; } acc += l; } return L[0]; };
  for (const s of D.tram.stops) { const [x, z] = at(s); o.push(`<rect x="${x - 3}" y="${z - 1.2}" width="6" height="2.4" fill="#d1007a"/>`); }
  for (const [i, l] of D.lots.entries()) {
    o.push(`<rect x="${l[0]}" y="${l[1]}" width="${l[2] - l[0]}" height="${l[3] - l[1]}" fill="#2fbf71" fill-opacity="0.25" stroke="#0f8a4a" stroke-width="${Math.max(0.6, 1.2 / zoom)}" stroke-dasharray="4 2"/>`);
    o.push(`<text x="${(l[0] + l[2]) / 2}" y="${(l[1] + l[3]) / 2}" font-size="${Math.max(6, 11 / zoom)}" text-anchor="middle" dominant-baseline="middle" fill="#0b5e33" font-family="sans-serif" font-weight="bold">L${i} ${Math.round(l[2] - l[0])}×${Math.round(l[3] - l[1])}</text>`);
  }
  const A = D.arena;
  o.push(`<rect x="${A[0]}" y="${A[1]}" width="${A[2] - A[0]}" height="${A[3] - A[1]}" fill="none" stroke="#e0201b" stroke-width="${Math.max(1, 2 / zoom)}"/>`);
  for (const [k, v] of Object.entries(D.landmarks)) {
    const fs_ = Math.max(7, 13 / zoom), dx = Math.cos(v.rot) * 12, dz = Math.sin(v.rot) * 12;
    o.push(`<line x1="${v.x - dx}" y1="${v.z - dz}" x2="${v.x + dx}" y2="${v.z + dz}" stroke="#1a1aa0" stroke-width="${Math.max(0.8, 1.4 / zoom)}"/>`);
    o.push(`<circle cx="${v.x}" cy="${v.z}" r="${Math.max(2.5, 4 / zoom)}" fill="#1a1aa0"/>`);
    o.push(`<text x="${v.x + 5}" y="${v.z - 5}" font-size="${fs_}" fill="#1a1aa0" font-family="sans-serif" font-weight="bold" stroke="#fff" stroke-width="${fs_ / 6}" paint-order="stroke">${k}${v.b < 0 ? '' : ' #' + v.b}</text>`);
  }
  // a legend of the height ramp
  const lx = x0 + 8 / zoom * 2, lz = z0 + 8 / zoom * 2, s = 14 / zoom;
  RAMP.forEach((c, i) => o.push(`<rect x="${lx + i * s * 2.4}" y="${lz}" width="${s * 2.4}" height="${s}" fill="${c}" stroke="#555" stroke-width="${0.5 / zoom}"/><text x="${lx + i * s * 2.4 + s * 1.2}" y="${lz + s * 1.9}" font-size="${s * 0.8}" text-anchor="middle" font-family="sans-serif">${i * 6}+</text>`));
  o.push(`<text x="${lx}" y="${lz + s * 3.2}" font-size="${s * 0.85}" font-family="sans-serif">arena building height (units, h): ${D.buildings.filter(b => !b.far).length} buildings; far ones grey</text>`);
  o.push('</svg>');
  return { svg: o.join('\n'), W, H };
}

fs.mkdirSync(OUT, { recursive: true });
const A = D.arena, shots = VIEW ? [['preview-view', svg(VIEW.slice(0, 4), VIEW[4] || 3)]] : [
  ['preview', svg(D.outer, 1.1)],
  ['preview-arena', svg([A[0] - 25, A[1] - 25, A[2] + 25, A[3] + 25], 2.4)],
];
for (const [n, s] of shots) fs.writeFileSync(path.join(OUT, n + '.svg'), s.svg);
let puppeteer = null;
try { puppeteer = createRequire(path.join(process.cwd(), 'x.js'))('puppeteer-core'); } catch { try { puppeteer = createRequire(import.meta.url)('puppeteer-core'); } catch { /* no PNGs */ } }
if (puppeteer) {
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-sandbox'] });
  try {
    for (const [n, s] of shots) {
      const page = await browser.newPage();
      await page.setViewport({ width: s.W, height: s.H });
      await page.setContent(`<html><body style="margin:0">${s.svg}</body></html>`, { waitUntil: 'load', timeout: 120000 });
      await page.screenshot({ path: path.join(OUT, n + '.png'), clip: { x: 0, y: 0, width: s.W, height: s.H } });
      await page.close();
    }
  } finally { await browser.close(); }
  console.log('PNGs written to', OUT);
} else console.log('SVGs written to', OUT, '(no puppeteer-core for PNGs)');
