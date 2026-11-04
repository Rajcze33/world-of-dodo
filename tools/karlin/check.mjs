// World of DODO, issue #16: checks client/shared/karlin.json against the rules the game relies on (the schema in
// KARLIN-DATA.md): every polygon positive (sum(x_i*z_(i+1) - x_(i+1)*z_i) > 0), simple and rounded to 0.1, the street graph
// connected with its edges ending on their nodes, blocks off the carriageways, the tram loop smooth and closed, the
// terrain flat in and around the arena, the lots really empty. Exits with 1 if anything fails.
//   node tools/karlin/check.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as G from './lib/geom.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const D = JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', 'client', 'shared', 'karlin.json'), 'utf8'));
let fails = 0;
const ok = (c, what, extra = '') => { console.log((c ? 'ok   ' : 'FAIL ') + what + (extra ? '  ' + extra : '')); if (!c) fails++; };
const ring = a => { const r = []; for (let i = 0; i < a.length; i += 2) r.push([a[i], a[i + 1]]); return r; };
const tenth = v => Math.abs(v * 10 - Math.round(v * 10)) < 1e-6;
const [AX0, AZ0, AX1, AZ1] = D.arena;
const inA = (x, z, m = 0.05) => x >= AX0 - m && x <= AX1 + m && z >= AZ0 - m && z <= AZ1 + m;

function polys(list, name, minArea = 0) {
  let bad = [];
  list.forEach((p, i) => {
    const r = ring(p);
    if (p.length < 6 || p.length % 2) bad.push(`${i}: ${p.length / 2} points`);
    else if (!p.every(tenth)) bad.push(`${i}: not rounded`);
    else if (G.area(r) <= minArea) bad.push(`${i}: area ${G.area(r).toFixed(2)}`);
    else if (G.selfHits(r).length) bad.push(`${i}: crosses itself`);
  });
  ok(!bad.length, `${name}: ${list.length} polygons positive, simple, rounded`, bad.slice(0, 5).join('; '));
}

// ---- top level ----
for (const k of ['v', 'attribution', 'osmDate', 'frame', 'arena', 'outer', 'buildings', 'roads', 'blocks', 'plazas', 'tram', 'rail', 'water', 'parks', 'trees', 'lots', 'landmarks', 'terrain']) ok(k in D, `has ${k}`);
ok(D.v === 1 && D.attribution.some(a => /OpenStreetMap/.test(a)) && D.attribution.some(a => /IPR/.test(a)), 'version 1 and the attribution lines');

// ---- buildings ----
const B = D.buildings;
polys(B.map(b => b.p), 'buildings');
ok(B.every(b => b.h > (b.y0 || 0) && b.h < 200), 'buildings: h above y0 and sane');
ok(B.every(b => [0, 1, 2].includes(b.r) && b.rh >= 0 && (b.r !== 0 || b.rh === 0) && Number.isInteger(b.f) && b.f >= 1 && Number.isInteger(b.c) && b.c >= 0 && b.c <= 7), 'buildings: r, rh, f, c in range');
const ab = B.filter(b => !b.far);
ok(ab.every(b => G.area(ring(b.p)) >= 6 / 2.25 - 0.01), 'arena buildings at least 6 m²');
ok(ab.every(b => G.boxHit(G.box(ring(b.p)), D.arena)) && B.filter(b => b.far).every(b => !G.boxHit(G.box(ring(b.p)), D.arena)), 'far flag = outside the arena');
const BH = new Map(), BC = 16;
ab.forEach((b, i) => { const bb = G.box(ring(b.p)); b.r_ = ring(b.p); b.bb = bb; for (let x = Math.floor(bb[0] / BC); x <= Math.floor(bb[2] / BC); x++) for (let z = Math.floor(bb[1] / BC); z <= Math.floor(bb[3] / BC); z++) { const k = x + ',' + z; (BH.get(k) || BH.set(k, []).get(k)).push(b); } });
const inBuilding = (x, z) => (BH.get(Math.floor(x / BC) + ',' + Math.floor(z / BC)) || []).some(b => x >= b.bb[0] && x <= b.bb[2] && z >= b.bb[1] && z <= b.bb[3] && G.pip(b.r_, x, z));

// ---- roads ----
const N = D.roads.nodes, E = D.roads.edges, nn = N.length / 2;
ok(N.length % 2 === 0 && N.every(tenth), `roads: ${nn} nodes`);
ok(E.every(e => e.a >= 0 && e.a < nn && e.b >= 0 && e.b < nn && e.a !== e.b), `roads: ${E.length} edges join two different nodes`);
ok(E.every(e => e.pts[0] === N[e.a * 2] && e.pts[1] === N[e.a * 2 + 1] && e.pts[e.pts.length - 2] === N[e.b * 2] && e.pts[e.pts.length - 1] === N[e.b * 2 + 1]), 'roads: polylines end on their nodes');
ok(E.every(e => e.w > 0 && [0, 1, 2, 3, 4].includes(e.c) && e.pts.length >= 4 && e.pts.every(tenth)), 'roads: widths, classes, rounding');
ok(E.every(e => { for (let i = 0; i < e.pts.length; i += 2) if (!inA(e.pts[i], e.pts[i + 1])) return false; return true; }), 'roads: inside the arena');
{
  const adj = Array.from({ length: nn }, () => []); E.forEach(e => { adj[e.a].push(e.b); adj[e.b].push(e.a); });
  const seen = new Uint8Array(nn), st = [0]; seen[0] = 1; let c = 1;
  while (st.length) for (const u of adj[st.pop()]) if (!seen[u]) { seen[u] = 1; c++; st.push(u); }
  ok(c === nn, 'roads: one connected graph', `${c}/${nn}`);
  const deg = adj.map(a => a.length), hist = {}; deg.forEach(d => hist[d] = (hist[d] || 0) + 1);
  const onEdge = i => N[i * 2] === AX0 || N[i * 2] === AX1 || N[i * 2 + 1] === AZ0 || N[i * 2 + 1] === AZ1;
  console.log('     degree histogram', JSON.stringify(hist), 'nodes on the arena edge', [...Array(nn).keys()].filter(onEdge).length);
  const len = e => G.len(ring(e.pts)), short = E.filter(e => len(e) < 6);
  console.log('     total length', Math.round(E.reduce((s, e) => s + len(e), 0)), 'u; edges under 6 u:', short.map(e => `${e.n || '?'} ${len(e).toFixed(1)}`).join(', ') || 'none');
}
// the carriageway (centreline and 80 % of the half width either side) must not run through houses
{
  let n = 0, hit = 0; const where = [];
  for (const e of E) {
    const p = ring(e.pts), L = G.len(p);
    G.resample(p, 2).forEach((q, k) => {
      if (k * 2 < 6 || k * 2 > L - 6) return;
      const i = Math.min(p.length - 2, G.project(p, q[0], q[1]).i), dx = p[i + 1][0] - p[i][0], dz = p[i + 1][1] - p[i][1], l = Math.hypot(dx, dz) || 1;
      for (const o of [0, 0.8, -0.8]) { n++; const x = q[0] - dz / l * o * e.w / 2, z = q[1] + dx / l * o * e.w / 2; if (inBuilding(x, z)) { hit++; if (where.length < 5) where.push(`${e.n || '?'} ${x.toFixed(0)},${z.toFixed(0)}`); } }
    });
  }
  ok(hit / n < 0.01, `roads: carriageway clear of houses (${hit}/${n} samples inside one)`, where.join('; '));
}

// ---- blocks and plazas ----
polys(D.blocks, 'blocks');
polys(D.plazas, 'plazas');
const BL = D.blocks.map(ring), BLB = BL.map(G.box), inBlock = (x, z) => BL.some((b, i) => x >= BLB[i][0] && x <= BLB[i][2] && z >= BLB[i][1] && z <= BLB[i][3] && G.pip(b, x, z));
ok(BL.every(b => b.every(([x, z]) => inA(x, z))), 'blocks: inside the arena');
{
  let n = 0, hit = 0;
  for (const e of E) for (const q of G.resample(ring(e.pts), 2)) { n++; if (inBlock(q[0], q[1])) hit++; }
  ok(hit / n < 0.005, `blocks: off the street centrelines (${hit}/${n} samples on a block)`);
  let ov = 0;
  for (let i = 0; i < BL.length; i++) for (let j = i + 1; j < BL.length; j++) if (G.boxHit(BLB[i], BLB[j]) && (BL[i].some(p => G.pip(BL[j], p[0], p[1])) || BL[j].some(p => G.pip(BL[i], p[0], p[1])))) ov++;
  ok(ov === 0, 'blocks: no two overlap', `${ov} pairs`);
  const areas = BL.map(G.area).sort((a, b) => a - b);
  console.log('     blocks', BL.length, 'smallest', areas.slice(0, 5).map(a => a.toFixed(1)).join(', '), 'largest', areas[areas.length - 1].toFixed(0));
  const pin = D.plazas.map(ring).filter(p => { const c = G.inner(p); return inBlock(c[0], c[1]); }).length;
  ok(pin === D.plazas.length, `plazas: on blocks (${pin}/${D.plazas.length})`);
}

// ---- tram ----
{
  const L = ring(D.tram.loop), C = [...L, L[0]], len = G.len(C);
  ok(L.length > 20 && Math.hypot(L[0][0] - L[L.length - 1][0], L[0][1] - L[L.length - 1][1]) < 5, `tram: closed loop, ${L.length} points, ${len.toFixed(0)} u long`);
  let minR = 1e9; const rs = G.resample(C, 3);
  for (let i = 1; i + 1 < rs.length; i++) { const a = rs[i - 1], b = rs[i], c = rs[i + 1], cr = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])); if (cr > 1e-9) minR = Math.min(minR, Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.hypot(c[0] - b[0], c[1] - b[1]) * Math.hypot(a[0] - c[0], a[1] - c[1]) / (2 * cr)); }
  ok(minR >= 10, `tram: radius at least 10 u (min ${minR.toFixed(1)})`);
  ok(D.tram.stops.length >= 2 && D.tram.stops.every((s, i, a) => s >= 0 && s < len && (i === 0 || s > a[i - 1])), `tram: ${D.tram.stops.length} stops ascending along the loop`, D.tram.stops.join(', '));
  // right-hand running: on the pass going +x the track is on the +z side of the pass going -x
  const east = L.filter((p, i) => { const q = L[(i + 1) % L.length]; return q[0] - p[0] > 1 && inA(p[0], p[1]); }), west = L.filter((p, i) => { const q = L[(i + 1) % L.length]; return q[0] - p[0] < -1 && inA(p[0], p[1]); });
  const mz = a => a.reduce((s, p) => s + p[1], 0) / a.length;
  ok(east.length && west.length && mz(east) > mz(west), 'tram: right-hand running (eastbound on the south track)');
  ok(D.tram.tracks.length > 0, `tram: ${D.tram.tracks.length} track polylines for drawing`);
}

// ---- rail, water, parks, trees ----
ok(D.rail.every(r => r.pts.length >= 4 && r.deck >= 0 && (r.bridge === 0 || r.bridge === 1) && (r.bridge || r.deck === 0)), `rail: ${D.rail.length} lines (${D.rail.filter(r => r.bridge).length} bridges)`);
polys(D.water, 'water');
polys(D.parks, 'parks');
{
  const T = D.trees, n = T.length / 3; let bad = 0, inb = 0, offb = 0;
  for (let i = 0; i < T.length; i += 3) { if (!inA(T[i], T[i + 1]) || T[i + 2] < 0.7 || T[i + 2] > 1.3) bad++; if (inBuilding(T[i], T[i + 1])) inb++; if (!inBlock(T[i], T[i + 1])) offb++; }
  ok(T.length % 3 === 0 && !bad && !inb && !offb, `trees: ${n} inside the arena, on blocks, not in houses`, `${bad} bad, ${inb} in houses, ${offb} off blocks`);
}

// ---- lots ----
{
  const Ls = D.lots; let bad = [];
  Ls.forEach((l, i) => {
    if (!(l[2] > l[0] && l[3] > l[1]) || !inA(l[0], l[1]) || !inA(l[2], l[3])) { bad.push(i + ' outside'); return; }
    for (let x = l[0] + 0.5; x < l[2]; x += 1) for (let z = l[1] + 0.5; z < l[3]; z += 1) {
      if (inBuilding(x, z)) { bad.push(i + ' house at ' + x + ',' + z); return; }
      if (!inBlock(x, z)) { bad.push(i + ' carriageway at ' + x + ',' + z); return; }
    }
    for (let j = 0; j < i; j++) { const m = Ls[j]; if (l[0] < m[2] && m[0] < l[2] && l[1] < m[3] && m[1] < l[3]) bad.push(i + ' overlaps ' + j); }
  });
  ok(!bad.length && Ls.length > 0, `lots: ${Ls.length} empty, non-overlapping`, bad.slice(0, 4).join('; ') + ' sizes ' + Ls.map(l => `${(l[2] - l[0]).toFixed(0)}×${(l[3] - l[1]).toFixed(0)}`).join(' '));
}

// ---- landmarks ----
{
  const want = ['church', 'theatre', 'forum', 'kasarna', 'synagogue', 'viaduct', 'vitkov'], miss = want.filter(k => !D.landmarks[k]);
  ok(!miss.length, 'landmarks: all seven', miss.join(', '));
  const bad = Object.entries(D.landmarks).filter(([k, v]) => v.b >= B.length || (v.b >= 0 && B[v.b].k !== k));
  ok(!bad.length, 'landmarks: b points at a building of that kind', bad.map(b => b[0]).join(', '));
}

// ---- terrain ----
{
  const T = D.terrain;
  ok(T.h.length === T.nx * T.nz && T.h.every(tenth), `terrain: ${T.nx}×${T.nz} at ${T.step} u`);
  let nz = 0;
  for (let j = 0; j < T.nz; j++) for (let i = 0; i < T.nx; i++) { const x = T.x0 + i * T.step, z = T.z0 + j * T.step; if (inA(x, z, 15) && T.h[j * T.nx + i] !== 0) nz++; }
  ok(nz === 0, 'terrain: exactly 0 in the arena and 15 u around it', nz + ' cells not 0');
  console.log('     terrain min', Math.min(...T.h), 'max', Math.max(...T.h));
  // World of DODO, issue #20: the Vltava (the water connected to the biggest piece) has its bed under the water's surface (-4.5)
  // away from the bank and never over the land's floor; the land (off every water piece, out of the flat zone) never under -0.6;
  // the bridges over the river leave a ship 6.5 u under their decks (road slabs y - 1 .. y, rail slabs deck - 1 .. deck)
  const W = D.water.map(ring), WB = W.map(G.box), touch = (a, b) => G.boxHit(WB[a], WB[b], 0.5) && [[a, b], [b, a]].some(([p, q]) => W[p].some(v => G.distPoly2(W[q], v[0], v[1], true) < 0.25));
  let big = 0; W.forEach((r, i) => { if (G.area(r) > G.area(W[big])) big = i; });
  const riv = new Set([big]), st = [big];
  while (st.length) { const a = st.pop(); for (let b = 0; b < W.length; b++) if (!riv.has(b) && touch(a, b)) { riv.add(b); st.push(b); } }
  const inRiv = (x, z) => [...riv].some(i => x >= WB[i][0] && x <= WB[i][2] && z >= WB[i][1] && z <= WB[i][3] && G.pip(W[i], x, z));
  const wetAny = (x, z) => W.some((r, i) => x >= WB[i][0] && x <= WB[i][2] && z >= WB[i][1] && z <= WB[i][3] && G.pip(r, x, z));
  const nearBank = (x, z, d) => { for (let k = 0; k < 16; k++) { const a = k * Math.PI / 8; if (!inRiv(x + Math.cos(a) * d, z + Math.sin(a) * d)) return true; } return false; };
  let deep = 0, shallow = 0, bedHigh = 0, landLow = 0;
  for (let j = 0; j < T.nz; j++) for (let i = 0; i < T.nx; i++) {
    const x = T.x0 + i * T.step, z = T.z0 + j * T.step, h = T.h[j * T.nx + i]; if (inA(x, z, 15)) continue;
    if (inRiv(x, z)) { if (h > -0.6) bedHigh++; if (!nearBank(x, z, 5) && !nearBank(x, z, 2.5)) { if (h <= -4.5) deep++; else shallow++; } }
    else if (!wetAny(x, z) && h < -0.6) landLow++;
  }
  ok(riv.size > 1 && deep > 1000 && !shallow && !bedHigh && !landLow, `terrain: the Vltava (${riv.size} pieces) has its bed under the water, the land stays over -0.6`, `${deep} deep, ${shallow} shallow 5 u from the bank, ${bedHigh} bed over -0.6, ${landLow} land under -0.6`);
  const over = pts => { const r = ring(pts); return G.resample(r, 1).some(q => inRiv(q[0], q[1])); };
  const fr = (D.farRoads || []).filter(o => o.y !== undefined && over(o.pts)), rl = D.rail.filter(o => o.bridge && over(o.pts));
  ok(fr.every(o => o.y - 1 >= 2) && rl.every(o => o.deck - 1 >= 2), `bridges over the Vltava: ${fr.length} road pieces, ${rl.length} rail lines, all 6.5 u over the water`, fr.filter(o => o.y - 1 < 2).map(o => o.y).join(' '));
}
const size = fs.statSync(path.join(HERE, '..', '..', 'client', 'shared', 'karlin.json')).size;
ok(size < 1.5 * 1024 * 1024, `size ${(size / 1024).toFixed(0)} KB`);
console.log(fails ? `${fails} check(s) failed` : 'all checks passed');
process.exit(fails ? 1 : 0);
