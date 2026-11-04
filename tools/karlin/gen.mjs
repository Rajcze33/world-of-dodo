// World of DODO, issue #16: the generator of client/shared/karlin.json, the real Karlín (Prague) for the game.
//   node tools/karlin/gen.mjs [--refresh] [--no-notches] [--synthetic-terrain]
// (--refresh downloads again instead of using tools/karlin/cache/; the other two: see tools/karlin/README.md)
// Reads OpenStreetMap (ODbL, through Overpass), IPR Praha's building floors (CC BY 4.0) and ČÚZK's terrain model DMR 5G
// (CC BY 4.0), turns them into the game's frame (lib/frame.mjs) and writes one JSON file that the client and the server
// load. Every simplification it makes is listed in client/shared/KARLIN-DATA.md. The file is generated: never edit it by
// hand, change this script and run it again.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as F from './lib/frame.mjs';
import { overpass, ipr, dmr, CACHE } from './lib/fetch.mjs';
import * as G from './lib/geom.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, '..', '..');
const OUT = path.join(ROOT, 'client', 'shared', 'karlin.json');
const r1 = G.r1, hU = F.hU, U = F.UNIT_M;
const log = (...a) => console.log(...a), REPORT = {}, NO_NOTCH = process.argv.includes('--no-notches');

// ---------------------------------------------------------------------------------------------------------------------
// The arena (tanks drive here), in units. West/east edges as the brief fixes them (x' -640..400 m: the Negrelli viaduct in
// the west, Forum Karlín in the east). North: the brief's x' -360 m would put the arena's flat margin into the Vltava in
// the west (the bank is at z -234..-250 there), so the north edge moves 5 u south, to just behind the embankment road
// (Rohanské nábřeží stays inside). South: the main railway at the foot of Vítkov runs at z 213..222; the edge moves to
// z 208 so that the line lies just outside (on the flat margin), the natural end of the tanks' Karlín. East: the brief's
// x' 400 m runs exactly along Šaldova/Breitfeldova (x 344..350), which made a street half in, half out; the edge moves
// 9.3 u east, just behind Šaldova's east kerb, so the street is the arena's eastern border.
// ---------------------------------------------------------------------------------------------------------------------
const ARENA = [r1((F.ARENA_M.x0 - F.CX) / U), -215, 356, 208];
const OUTER = [-F.OUTER_U, -F.OUTER_U, F.OUTER_U, F.OUTER_U];
const [AX0, AZ0, AX1, AZ1] = ARENA;
const inArena = (x, z, m = 0) => x >= AX0 - m && x <= AX1 + m && z >= AZ0 - m && z <= AZ1 + m;
const boxInArena = b => G.boxHit(b, ARENA);
const flat = r => { const o = []; for (const [x, z] of r) o.push(r1(x), r1(z)); return o; };

// ---- load -----------------------------------------------------------------------------------------------------------
const osm = await overpass();
const osmDate = osm.osm3s.timestamp_osm_base;
const EL = new Map();
for (const e of osm.elements) { const k = e.type[0] + e.id, o = EL.get(k); if (!o || (!o.geometry && e.geometry) || (!o.members?.[0]?.geometry && e.members?.[0]?.geometry)) EL.set(k, o ? { ...o, ...e } : e); }
const all = [...EL.values()];
const WAYS = all.filter(e => e.type === 'way' && e.geometry), RELS = all.filter(e => e.type === 'relation'), NODES = all.filter(e => e.type === 'node');
const P = g => F.toU(g.lon, g.lat);
const wayPts = w => w.geometry.filter(Boolean).map(P);
const closed = w => w.nodes && w.nodes.length > 3 && w.nodes[0] === w.nodes[w.nodes.length - 1];
// areas of a way or a multipolygon relation: [{ outer, holes }] (outer positive, holes negative)
function areasOf(e) {
  if (e.type === 'way') { if (!closed(e)) return []; const r = G.dedupe(wayPts(e)); return r.length >= 3 ? [{ outer: G.ccw(r), holes: [] }] : []; }
  const outs = [], ins = [];
  for (const m of e.members || []) if (m.type === 'way' && m.geometry) (m.role === 'inner' ? ins : outs).push(m.geometry.filter(Boolean).map(P));
  const res = G.joinRings(outs).map(r => ({ outer: G.ccw(G.dedupe(r)), holes: [] }));
  for (const h of G.joinRings(ins)) { const hr = G.ccw(G.dedupe(h)).reverse(), pg = res.find(p => G.pip(p.outer, hr[0][0], hr[0][1])); if (pg) pg.holes.push(hr); }
  return res;
}
const num = v => { if (v == null) return NaN; const m = String(v).replace(',', '.').match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : NaN; };
const hash = s => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const fold = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// ---- the terrain (needed for the buildings' base and the rail decks) -------------------------------------------------
const water = [];          // simple rings, units
for (const e of [...WAYS, ...RELS]) {
  const t = e.tags || {};
  if (!(t.natural === 'water' || t.waterway === 'riverbank' || t.landuse === 'basin' || t.landuse === 'reservoir')) continue;
  for (const pg of areasOf(e)) {
    if (!G.boxHit(G.box(pg.outer), OUTER)) continue;
    for (const c of G.clipRect(pg.outer, pg.holes, ...OUTER)) for (const r of G.decompose(c.outer, c.holes)) {
      const s = G.cleanRing(r, inArena(...G.centroid(r)) ? 0.4 : 1.0, 4);
      if (s && G.area(s) >= 20) water.push({ r: s, river: t.water === 'river' || t.waterway === 'riverbank' || /Vltava/.test(t.name || '') });
    }
  }
}
log('water polygons', water.length);

const TER = { x0: -F.OUTER_U, z0: -F.OUTER_U, step: 10, nx: 0, nz: 0, h: [] };
TER.nx = Math.round((OUTER[2] - OUTER[0]) / TER.step) + 1; TER.nz = TER.nx;
let terrainRoute = 'ČÚZK DMR 5G';
{
  let dem = null;
  if (!process.argv.includes('--synthetic-terrain')) try { dem = await dmr(5); } catch (e) { log('terrain download failed, synthesising:', e.message.split('\n')[0]); }
  const ZERO_M = 15, BLEND = 45;
  // the distance outside the arena, measured like the margin: the rectangle grown by d (so the flat zone has square corners)
  const outDist = (x, z) => Math.max(AX0 - x, 0, x - AX1, AZ0 - z, z - AZ1);
  const wet = (x, z) => water.some(w => { const b = w.b || (w.b = G.box(w.r)); return x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3] && G.pip(w.r, x, z); });
  let sample;
  if (dem) {
    const { W, H, data, extent: ex } = dem;
    const at = (lon, lat) => {
      const fx = (lon - ex.xmin) / (ex.xmax - ex.xmin) * W - 0.5, fy = (ex.ymax - lat) / (ex.ymax - ex.ymin) * H - 0.5;
      const i = Math.max(0, Math.min(W - 2, Math.floor(fx))), j = Math.max(0, Math.min(H - 2, Math.floor(fy))), tx = Math.min(1, Math.max(0, fx - i)), ty = Math.min(1, Math.max(0, fy - j));
      const v = (a, b) => { const q = data[b * W + a]; return q > -100 && q < 2000 ? q : NaN; };
      const a = v(i, j), b = v(i + 1, j), c = v(i, j + 1), d = v(i + 1, j + 1);
      return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    };
    // Karlín's own level: the median of the terrain inside the arena, off the water
    const inside = [];
    for (let z = AZ0; z <= AZ1; z += 10) for (let x = AX0; x <= AX1; x += 10) { const v = at(...F.fromU(x, z)); if (!isNaN(v) && !wet(x, z)) inside.push(v); }
    inside.sort((a, b) => a - b);
    const base = inside[inside.length >> 1];
    REPORT.terrainBase = base;
    sample = (x, z) => { const v = at(...F.fromU(x, z)); return isNaN(v) ? 0 : hU(v - base); };
  } else {
    terrainRoute = 'synthesised';
    // Vítkov: a ridge whose crest runs through the memorial (≈ 80 m above Karlín), steep on the north; Letná/Holešovice behind
    // the river rise gently. Only used when the DMR service cannot be reached.
    sample = (x, z) => {
      const crest = 300 + (x + 36) * 0.05, dz = z - crest;
      const vit = dz < 0 ? hU(80) * Math.exp(-(dz * dz) / (2 * 55 * 55)) : hU(80) * Math.exp(-(dz * dz) / (2 * 160 * 160));
      const ridge = vit * Math.exp(-(Math.max(0, Math.abs(x + 36) - 350) ** 2) / (2 * 200 * 200));
      const north = z < -330 ? hU(Math.min(30, (-330 - z) * 0.06)) : 0;
      return ridge + north;
    };
  }
  for (let j = 0; j < TER.nz; j++) for (let i = 0; i < TER.nx; i++) {
    const x = TER.x0 + i * TER.step, z = TER.z0 + j * TER.step, d = outDist(x, z);
    let h = 0;
    if (d > ZERO_M) {
      const s = Math.min(1, (d - ZERO_M) / BLEND), k = s * s * (3 - 2 * s);
      // the river bed sits at -2 (the water is drawn above it); the land never dips below -0.6 so that it stays dry
      h = wet(x, z) ? -2 : Math.max(-0.6, k * sample(x, z));
    }
    TER.h.push(r1(h));
  }
}
const terrainH = (x, z) => {
  const fx = (x - TER.x0) / TER.step, fz = (z - TER.z0) / TER.step;
  const i = Math.max(0, Math.min(TER.nx - 2, Math.floor(fx))), j = Math.max(0, Math.min(TER.nz - 2, Math.floor(fz))), tx = Math.min(1, Math.max(0, fx - i)), tz = Math.min(1, Math.max(0, fz - j));
  const h = (a, b) => TER.h[b * TER.nx + a];
  return (h(i, j) * (1 - tx) + h(i + 1, j) * tx) * (1 - tz) + (h(i, j + 1) * (1 - tx) + h(i + 1, j + 1) * tx) * tz;
};
log('terrain', terrainRoute, TER.nx + '×' + TER.nz, 'max', Math.max(...TER.h));

// ---- IPR floors -------------------------------------------------------------------------------------------------------
const { meta: iprMeta, feats: iprFeats } = await ipr();
const ROOF_CODES = {};   // strecha code -> r, read from the layer's coded domain
for (const f of iprMeta.fields) if (f.name === 'strecha' && f.domain) for (const cv of f.domain.codedValues) {
  const n = fold(cv.name);
  ROOF_CODES[cv.code] = /rovn/.test(n) ? 0 : /sikm|kopul/.test(n) ? 1 : /atyp|kombin/.test(n) ? 2 : null;
}
REPORT.iprRoofCodes = ROOF_CODES;
const IPR = [], IPRH = new Map(), IC = 20;
for (const f of iprFeats) {
  const a = f.attributes; if (!f.geometry || a.nova_budova === 3) continue;       // 3 = demolished
  const rings = f.geometry.rings.map(r => r.map(([lon, lat]) => F.toU(lon, lat)));
  const b = G.box(rings.flat()); if (!G.boxHit(b, OUTER, 20)) continue;
  const k = IPR.push({ rings, b, a }) - 1;
  for (let i = Math.floor(b[0] / IC); i <= Math.floor(b[2] / IC); i++) for (let j = Math.floor(b[1] / IC); j <= Math.floor(b[3] / IC); j++) { const key = i + ',' + j; (IPRH.get(key) || IPRH.set(key, []).get(key)).push(k); }
}
const iprAt = (x, z) => {
  for (const k of IPRH.get(Math.floor(x / IC) + ',' + Math.floor(z / IC)) || []) {
    const f = IPR[k]; if (x < f.b[0] || x > f.b[2] || z < f.b[1] || z > f.b[3]) continue;
    let inn = false; for (const r of f.rings) if (G.pip(r, x, z)) inn = !inn;
    if (inn) return f;
  }
  return null;
};
// the IPR polygon under the building: the one containing its inner point, else the one most of its sample points fall in
function iprFor(r) {
  const c = G.inner(r), f0 = iprAt(c[0], c[1]); if (f0) return f0;
  const b = G.box(r), votes = new Map();
  for (let i = 1; i < 6; i++) for (let j = 1; j < 6; j++) {
    const x = b[0] + (b[2] - b[0]) * i / 6, z = b[1] + (b[3] - b[1]) * j / 6;
    if (!G.pip(r, x, z)) continue; const f = iprAt(x, z); if (f) votes.set(f, (votes.get(f) || 0) + 1);
  }
  let best = null, bv = 0; for (const [f, v] of votes) if (v > bv) { bv = v; best = f; }
  return best;
}

// ---- buildings --------------------------------------------------------------------------------------------------------
const KIND = {
  church: 'church', chapel: 'church', cathedral: 'church', temple: 'church', mosque: 'church', synagogue: 'synagogue',
  industrial: 'industrial', warehouse: 'industrial', factory: 'industrial', manufacture: 'industrial', hangar: 'industrial', storage_tank: 'industrial',
  garage: 'garage', garages: 'garage', parking: 'garage', carport: 'garage',
  shed: 'shed', hut: 'shed', kiosk: 'shed', cabin: 'shed', service: 'shed', toilets: 'shed', container: 'shed', allotment_house: 'shed',
  office: 'office', commercial: 'office', retail: 'retail', supermarket: 'retail', school: 'school', university: 'school', college: 'school', kindergarten: 'school',
  train_station: 'station', transportation: 'station', hospital: 'hospital', hotel: 'hotel', civic: 'civic', public: 'civic', government: 'civic',
  construction: 'construction', ruins: 'ruins', bunker: 'shed',
};
const DEF_FLOORS = { industrial: 2, garage: 1, shed: 1, office: 6, retail: 2, school: 4, church: 4, synagogue: 4, station: 2, hospital: 5, hotel: 6, civic: 4, construction: 3, ruins: 1 };
// facade palette (index -> reference colour), documented in KARLIN-DATA.md: cream, ochre, light grey, white, salmon, sage, grey-blue, brick
const PAL = [[0xef, 0xe6, 0xcf], [0xe3, 0xc7, 0x8a], [0xc9, 0xc9, 0xc4], [0xf4, 0xf4, 0xf0], [0xe7, 0xb9, 0xa5], [0xc2, 0xd1, 0xb0], [0xb5, 0xc3, 0xcf], [0xb4, 0x6a, 0x50]];
const NAMED = { white: 3, ivory: 0, beige: 0, cream: 0, wheat: 0, yellow: 1, ochre: 1, gold: 1, khaki: 1, orange: 4, grey: 2, gray: 2, silver: 2, lightgrey: 2, lightgray: 2, darkgrey: 2, darkgray: 2, black: 2, pink: 4, salmon: 4, peach: 4, green: 5, olive: 5, lightgreen: 5, blue: 6, lightblue: 6, red: 7, brown: 7, maroon: 7, brick: 7, darkred: 7 };
function colourIdx(t, id) {
  const c = (t['building:colour'] || t['building:color'] || '').trim().toLowerCase();
  if (NAMED[c.replace(/[\s_-]/g, '')] !== undefined) return NAMED[c.replace(/[\s_-]/g, '')];
  const m = c.match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/);
  if (m) {
    const h = m[1].length === 3 ? m[1].split('').map(x => x + x).join('') : m[1], rgb = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
    let bi = 0, bd = 1e9; PAL.forEach((p, i) => { const d = (p[0] - rgb[0]) ** 2 + (p[1] - rgb[1]) ** 2 + (p[2] - rgb[2]) ** 2; if (d < bd) { bd = d; bi = i; } });
    return bi;
  }
  return hash(id) % 8;
}
const ROOF_SHAPE = s => { s = (s || '').toLowerCase(); if (!s) return null; if (s === 'flat') return 0; if (/mansard|gambrel/.test(s)) return 2; return 1; };
const isUnder = t => t.location === 'underground' || t.location === 'indoor' || num(t.layer) < 0 || t.parking === 'underground';

// building parts: their heights, to give an outline without a height of its own the tallest of its parts
const parts = [];
for (const e of [...WAYS, ...RELS]) {
  const t = e.tags || {}; if (!t['building:part'] || t['building:part'] === 'no' || isUnder(t)) continue;
  const H = num(t.height), L = num(t['building:levels']), m = H > 0 ? H : L > 0 ? L * 3.2 + (num(t['roof:levels']) > 0 ? num(t['roof:levels']) * 3 : 0) : NaN;
  if (!(m > 0)) continue;
  for (const pg of areasOf(e)) parts.push({ c: G.inner(pg.outer), m, b: G.box(pg.outer) });
}

const B = [];        // output buildings (before landmark tagging), each { p (ring), h, y0, r, rh, f, c, k, far, src, id, tags }
const SRC = { height: 0, levels: 0, parts: 0, ipr: 0, default: 0 }, ROOFSRC = { osm: 0, ipr: 0, default: 0 };
const SRC_ARENA = { height: 0, levels: 0, parts: 0, ipr: 0, default: 0 }, SRC_FAR = { ...SRC_ARENA };
let dropped = { small: 0, invalid: 0, roof: 0, under: 0 }, LEVEL1_OVERRIDDEN = 0;
const DEFAULT_AREAS = [];
for (const e of [...WAYS, ...RELS]) {
  const t = e.tags || {}; if (!t.building || t.building === 'no') continue;
  if (e.type === 'relation' && t.type !== 'multipolygon') continue;
  if (t.building === 'roof' || t.building === 'canopy' || t.building === 'carport' && !t['building:levels']) { dropped.roof++; continue; }
  if (isUnder(t)) { dropped.under++; continue; }
  const pgs = areasOf(e); if (!pgs.length) continue;
  // the height in metres: OSM height, OSM levels, the building's parts, IPR, a default by type
  const kind = KIND[t.building] || (t.amenity === 'place_of_worship' ? (t.religion === 'jewish' ? 'synagogue' : 'church') : undefined);
  const H = num(t.height), RH = num(t['roof:height']), L = num(t['building:levels']), RL = num(t['roof:levels']);
  let walls, roofM = NaN, floors, src, r = ROOF_SHAPE(t['roof:shape']), rsrc = r === null ? null : 'osm';
  const big = pgs.reduce((a, p) => G.area(p.outer) > G.area(a.outer) ? p : a, pgs[0]);
  const ip = iprFor(big.outer);
  // IPR's storey height for the house (7: old houses with high ceilings, 3: non-standard storeys), also when OSM gives the count
  const fh = ip ? (ip.a.typ === 7 ? 3.7 : ip.a.typ === 3 ? 4.5 : 3.2) : 3.2;
  // building:levels=1 is a placeholder on many RÚIAN-imported houses in Karlín (IPR has 4, 5, 7 floors for them):
  // when IPR knows more than one floor, IPR wins over such a 1
  const ipFloors = ip ? Math.max(ip.a.pocet_podlazi || 0, ip.a.podlaz_celk || 0) : 0, osmL = L > 1 || (L === 1 && !(ipFloors > 1)) ? L : NaN;
  if (L === 1 && ipFloors > 1) LEVEL1_OVERRIDDEN++;
  if (H > 0) { roofM = RH >= 0 ? RH : RL > 0 ? RL * 3 : NaN; walls = H - (roofM > 0 ? roofM : 0); floors = L > 0 ? L : Math.max(1, Math.round(walls / 3.2)); src = 'height'; }
  else if (osmL > 0) { walls = osmL * fh; roofM = RL > 0 ? RL * 3 : NaN; floors = osmL; src = 'levels'; }
  else {
    const b = G.box(big.outer), pm = parts.filter(p => G.boxHit(p.b, b) && G.pip(big.outer, p.c[0], p.c[1])).reduce((m, p) => Math.max(m, p.m), 0);
    if (pm > 0) { walls = pm; floors = Math.max(1, Math.round(pm / 3.2)); src = 'parts'; }
    else if (ip && (ip.a.pocet_podlazi > 0 || ip.a.podlaz_celk > 0)) {
      const a = ip.a, cor = a.pocet_podlazi > 0 ? a.pocet_podlazi : a.podlaz_celk, tot = Math.max(cor, a.podlaz_celk || 0);
      walls = cor * fh; floors = cor; src = 'ipr';
      if (tot > cor) roofM = (tot - cor) * 3;
    } else {
      // no count anywhere: by type, and a plain building=yes by its size (a 15 m² shed in a courtyard is no 5-storey house)
      const m2 = G.area(big.outer) * U * U;
      floors = DEF_FLOORS[kind] ?? (/^(apartments|residential|house|terrace|dormitory)$/.test(t.building) ? 5 : m2 < 30 ? 1 : m2 < 80 ? 2 : m2 < 200 ? 3 : 5);
      walls = floors * 3.2; src = 'default';
    }
  }
  if (r === null && ip && ROOF_CODES[ip.a.strecha] != null) { r = ROOF_CODES[ip.a.strecha]; rsrc = 'ipr'; }
  if (r === null) { r = (!kind || kind === 'civic' || kind === 'school' || kind === 'church') && floors <= 6 ? 1 : 0; rsrc = 'default'; }
  // a flat roof with extra storeys: they are set-back floors, count them as walls (a footprint cannot step back)
  if (r === 0 && roofM > 0) { walls += roofM; floors += Math.round(roofM / 3); roofM = 0; }
  walls = Math.max(2.5, Math.min(walls, 150));
  const farB = !pgs.some(pg => boxInArena(G.box(pg.outer)));
  SRC[src]++; ROOFSRC[rsrc]++; (farB ? SRC_FAR : SRC_ARENA)[src]++;
  for (const pg of pgs) {
    const b0 = G.box(pg.outer); if (!G.boxHit(b0, OUTER)) continue;
    const far = !boxInArena(b0);
    let pieces = [pg];
    if (b0[0] < OUTER[0] || b0[2] > OUTER[2] || b0[1] < OUTER[1] || b0[3] > OUTER[3]) pieces = G.clipRect(pg.outer, pg.holes, ...OUTER);
    for (const pc of pieces) for (const ring of G.decompose(pc.outer, pc.holes)) {
      const s = G.cleanRing(ring, far ? 0.5 : 0.25, 0);
      if (!s) { dropped.invalid++; continue; }
      const A = G.area(s);
      if (A < (far ? 14 : 6 / (U * U))) { dropped.small++; continue; }
      const mr = G.minRect(s), Wm = mr.W * U;
      let rh = r === 0 ? 0 : roofM > 0 ? roofM : r === 2 ? Math.min(3.5, 0.3 * Wm) : Math.min(0.35 * Wm, 7);
      if (r !== 0) rh = Math.min(rh, 0.6 * Wm);
      if (src === 'default') DEFAULT_AREAS.push([Math.round(A * U * U), far ? 'far' : 'arena', t.building]);
      B.push({ p: s, wallsM: walls, rhM: rh, r: rh > 0.2 ? r : 0, f: Math.max(1, Math.round(floors)), c: colourIdx(t, e.id), k: kind, far, src, id: e.type[0] + e.id, tags: t, area: A, mr });
    }
  }
}
log('buildings', B.length, 'height sources', SRC, 'roof sources', ROOFSRC, 'dropped', dropped);
REPORT.heightSources = { all: SRC, arena: SRC_ARENA, far: SRC_FAR }; REPORT.roofSources = ROOFSRC; REPORT.droppedBuildings = dropped;
log('  arena', SRC_ARENA, 'far', SRC_FAR, 'OSM levels=1 overridden by IPR', LEVEL1_OVERRIDDEN);
REPORT.level1Overridden = LEVEL1_OVERRIDDEN; REPORT.defaultAreas = DEFAULT_AREAS;

// ---- roads ------------------------------------------------------------------------------------------------------------
const CLS = { motorway: 0, trunk: 0, primary: 0, motorway_link: 0, trunk_link: 0, primary_link: 0, secondary: 1, secondary_link: 1, tertiary: 2, tertiary_link: 2, residential: 3, unclassified: 3, living_street: 3, service: 4 };
const WIDTH_M = [14, 12, 10, 8, 5];
const roadWays = WAYS.filter(w => {
  const t = w.tags || {}, c = CLS[t.highway];
  // under ground, or through a house (a building passage, a covered drive): the house is solid in the game, a car cannot pass
  if (c === undefined || t.area === 'yes' || /^(yes|building_passage)$/.test(t.tunnel || '') || t.covered === 'yes' || num(t.layer) < 0) return false;
  if (c === 4 && /parking_aisle|driveway|drive-through|emergency_access/.test(t.service || '')) return false;
  if ((c >= 3) && /^(no|private)$/.test(t.access || '') && !/^(yes|destination)$/.test(t.motor_vehicle || t.motorcar || '')) return false;
  return true;
});
const nodeUse = new Map();
for (const w of roadWays) w.nodes.forEach((id, i) => nodeUse.set(id, (nodeUse.get(id) || 0) + (i === 0 || i === w.nodes.length - 1 ? 2 : 1)));
// pieces between shared nodes (and way ends)
let RN = new Map(), RE = [], newId = 0;
const addNode = (id, x, z, edge) => { if (!RN.has(id)) RN.set(id, { id, x, z, edge: !!edge }); return id; };
for (const w of roadWays) {
  const t = w.tags, c = CLS[t.highway], wm = num(t.width) > 0 ? Math.min(Math.max(num(t.width), 3), 30) : WIDTH_M[c];
  const pts = wayPts(w); if (pts.length !== w.nodes.length) continue;
  let start = 0;
  for (let i = 1; i < pts.length; i++) {
    if (i < pts.length - 1 && (nodeUse.get(w.nodes[i]) || 0) < 2) continue;
    const seg = pts.slice(start, i + 1), ids = [w.nodes[start], w.nodes[i]];
    start = i;
    for (const piece of G.clipLine(seg, AX0, AZ0, AX1, AZ1)) {
      // a piece that only grazes the arena (both ends on its edge, short) is no street of the arena
      if (piece.pts.length < 2 || G.len(piece.pts) < 0.05 || (piece.aEdge && piece.bEdge && G.len(piece.pts) < 6)) continue;
      const pa = piece.pts[0], pb = piece.pts[piece.pts.length - 1];
      const a = piece.aEdge ? addNode('E' + newId++, pa[0], pa[1], true) : addNode(ids[0], pa[0], pa[1]);
      const b = piece.bEdge ? addNode('E' + newId++, pb[0], pb[1], true) : addNode(ids[1], pb[0], pb[1]);
      RE.push({ a, b, pts: piece.pts, c, w: wm / U, n: t.name, way: w.id, oneway: t.oneway === 'yes' });
    }
  }
}
const degree = () => { const d = new Map(); for (const e of RE) { d.set(e.a, (d.get(e.a) || 0) + 1); d.set(e.b, (d.get(e.b) || 0) + 1); } return d; };
// snap the cut points exactly onto the arena edge
for (const n of RN.values()) if (n.edge) {
  const dx0 = Math.abs(n.x - AX0), dx1 = Math.abs(n.x - AX1), dz0 = Math.abs(n.z - AZ0), dz1 = Math.abs(n.z - AZ1), m = Math.min(dx0, dx1, dz0, dz1);
  if (m === dx0) n.x = AX0; else if (m === dx1) n.x = AX1; else if (m === dz0) n.z = AZ0; else n.z = AZ1;
}
const fixEnds = () => { for (const e of RE) { const a = RN.get(e.a), b = RN.get(e.b); e.pts[0] = [a.x, a.z]; e.pts[e.pts.length - 1] = [b.x, b.z]; } };
fixEnds();
// service roads only where they link streets: prune dead-end service edges until none is left
for (let changed = true; changed;) {
  changed = false; const d = degree();
  RE = RE.filter(e => { if (e.c === 4 && ((d.get(e.a) === 1 && !RN.get(e.a).edge) || (d.get(e.b) === 1 && !RN.get(e.b).edge) || e.a === e.b)) { changed = true; return false; } return true; });
}
// merge nodes joined by a very short edge (complex junctions mapped as several close nodes)
const MERGE = 4;
for (let changed = true; changed;) {
  changed = false;
  RE.sort((p, q) => G.len(p.pts) - G.len(q.pts));
  for (const e of RE) {
    if (e.a === e.b || G.len(e.pts) >= MERGE) continue;
    const A = RN.get(e.a), Bn = RN.get(e.b);
    if (A.edge && Bn.edge) continue;
    const keep = A.edge ? A : Bn.edge ? Bn : A, gone = keep === A ? Bn : A;
    if (!keep.edge) { keep.x = (A.x + Bn.x) / 2; keep.z = (A.z + Bn.z) / 2; }
    for (const f of RE) { if (f.a === gone.id) f.a = keep.id; if (f.b === gone.id) f.b = keep.id; }
    RN.delete(gone.id); e.dead = true; changed = true; break;
  }
  RE = RE.filter(e => !e.dead);
}
fixEnds();
RE = RE.filter(e => e.a !== e.b || G.len(e.pts) > 20);
// fold degree-2 nodes into their edges' polylines
const foldDeg2 = () => {
  for (let changed = true; changed;) {
    changed = false; const inc = new Map();
    for (const e of RE) { (inc.get(e.a) || inc.set(e.a, []).get(e.a)).push(e); if (e.b !== e.a) (inc.get(e.b) || inc.set(e.b, []).get(e.b)).push(e); }
    for (const [id, es] of inc) {
      if (es.length !== 2 || RN.get(id).edge || es[0] === es[1]) continue;
      const [e1, e2] = es, o1 = e1.a === id ? e1.b : e1.a, o2 = e2.a === id ? e2.b : e2.a;
      if (o1 === o2 || o1 === id || o2 === id) continue;
      const p1 = e1.b === id ? e1.pts : e1.pts.slice().reverse(), p2 = e2.a === id ? e2.pts : e2.pts.slice().reverse();
      const L1 = G.len(p1), L2 = G.len(p2), m = L1 >= L2 ? e1 : e2;
      RE.push({ ...m, a: o1, b: o2, pts: [...p1, ...p2.slice(1)] });
      e1.dead = e2.dead = true; RE = RE.filter(e => !e.dead); RN.delete(id); changed = true; break;
    }
  }
};
foldDeg2();
// a loop edge (both ends on one node) gets a node in its middle, so that every edge joins two different nodes
for (const e of RE.filter(e => e.a === e.b)) {
  const mid = Math.floor(e.pts.length / 2) || 1, id = 'L' + newId++, p = e.pts[mid];
  addNode(id, p[0], p[1]); RE.push({ ...e, a: id, b: e.b, pts: e.pts.slice(mid) }); e.b = id; e.pts = e.pts.slice(0, mid + 1);
}
// parallel duplicates (both halves of a dual carriageway between the same two junctions): keep the wider
{
  const seen = new Map();
  for (const e of RE) {
    const k = [e.a, e.b].sort().join('|'), o = seen.get(k);
    // only the two halves of one street (same name or class), not a service lane running beside a street
    if (o && (o.n === e.n || o.c === e.c) && Math.abs(G.len(o.pts) - G.len(e.pts)) < 0.2 * G.len(e.pts) && G.distPoly2(o.pts, ...e.pts[Math.floor(e.pts.length / 2)], false) < 12 ** 2) {
      e.dead = true; if (e.w > o.w) o.w = e.w;
    } else if (!o || e.c < o.c) seen.set(k, e);
  }
  RE = RE.filter(e => !e.dead);
}
// the largest connected piece only
{
  const adj = new Map(); for (const e of RE) { (adj.get(e.a) || adj.set(e.a, []).get(e.a)).push(e.b); (adj.get(e.b) || adj.set(e.b, []).get(e.b)).push(e.a); }
  const comp = new Map(); let best = -1, bestN = 0, ci = 0;
  for (const s of adj.keys()) {
    if (comp.has(s)) continue;
    const st = [s]; comp.set(s, ci); let n = 0;
    while (st.length) { const v = st.pop(); n++; for (const u of adj.get(v)) if (!comp.has(u)) { comp.set(u, ci); st.push(u); } }
    if (n > bestN) { bestN = n; best = ci; } ci++;
  }
  REPORT.roadComponents = ci;
  RE = RE.filter(e => comp.get(e.a) === best);
}
foldDeg2();
for (const id of [...RN.keys()]) if (!RE.some(e => e.a === id || e.b === id)) RN.delete(id);
// simplify the polylines (the ends stay on their nodes)
for (const e of RE) e.pts = G.simplifyLine(G.dedupe(e.pts, 1e-6, false), 0.25);
// a carriageway must not run into the houses: where OSM's (or the default) width would reach a facade, narrow the edge so
// that a 2 u pavement stays between kerb and facade (the pedestrians walk 1.4 u in from the kerb); never below 4.5 u.
// Edges whose centreline itself runs through a building (a passage under a house) are only reported.
const narrowed = [], through = [];
{
  const BH = new Map(), BC = 12;
  B.forEach((b, i) => { if (b.far) return; const bb = G.box(b.p); for (let x = Math.floor(bb[0] / BC); x <= Math.floor(bb[2] / BC); x++) for (let z = Math.floor(bb[1] / BC); z <= Math.floor(bb[3] / BC); z++) { const k = x + ',' + z; (BH.get(k) || BH.set(k, []).get(k)).push(i); } });
  const near = (x, z, r) => { const out = new Set(); for (let i = Math.floor((x - r) / BC); i <= Math.floor((x + r) / BC); i++) for (let j = Math.floor((z - r) / BC); j <= Math.floor((z + r) / BC); j++) for (const k of BH.get(i + ',' + j) || []) out.add(k); return out; };
  for (const e of RE) {
    const ds = []; let inside = 0;
    const sm = G.resample(e.pts, 2), L = G.len(e.pts);
    sm.forEach((p, k) => {
      // skip the junction ends: corner houses come close to the crossing street's centreline, not to this one
      const s = k * 2; if (s < 8 || s > L - 8) return;
      let d = 40;
      for (const i of near(p[0], p[1], 20)) { const b = B[i].p; if (G.pip(b, p[0], p[1])) { d = 0; inside++; break; } d = Math.min(d, Math.sqrt(G.distPoly2(b, p[0], p[1], true))); }
      ds.push(d);
    });
    if (inside * 2 > 1.5) through.push(`${e.n || e.way}: ${inside * 2} u inside a building`);
    if (ds.length < 3) continue;
    ds.sort((a, b) => a - b);
    const d10 = ds[Math.floor(ds.length * 0.1)], allow = 2 * (d10 - 2);
    if (allow < e.w - 0.3 && d10 > 0) { const w0 = e.w; e.w = Math.max(4.5, allow); if (e.w < w0 - 0.3) narrowed.push(`${e.n || e.way}: ${r1(w0)} -> ${r1(e.w)}`); }
  }
  log('edges narrowed to keep a pavement', narrowed.length, 'centrelines through a building', through.length);
  REPORT.narrowed = narrowed; REPORT.throughBuildings = through;
}
// stable order: nodes by position, edges by their nodes
const nodeList = [...RN.values()].sort((p, q) => p.x - q.x || p.z - q.z), NI = new Map(nodeList.map((n, i) => [n.id, i]));
RE.forEach(e => { if (NI.get(e.a) > NI.get(e.b)) { [e.a, e.b] = [e.b, e.a]; e.pts.reverse(); } });
RE.sort((p, q) => NI.get(p.a) - NI.get(q.a) || NI.get(p.b) - NI.get(q.b) || p.pts.length - q.pts.length);
log('roads', nodeList.length, 'nodes', RE.length, 'edges');

// ---- blocks: the faces of the street graph inside the arena, pulled in to the kerb ------------------------------------
const BLOCKS = [];
{
  // the face graph: the streets without their dead ends + the arena's edge between the points where streets meet it
  let FE = RE.map(e => ({ a: e.a, b: e.b, pts: e.pts.map(p => p.slice()), d: e.w / 2 }));
  const FN = new Map(nodeList.map(n => [n.id, { x: n.x, z: n.z, edge: n.edge }]));
  const per = (x, z) => z === AZ0 ? x - AX0 : x === AX1 ? (AX1 - AX0) + (z - AZ0) : z === AZ1 ? 2 * (AX1 - AX0) + (AZ1 - AZ0) - (x - AX0) : 2 * (AX1 - AX0) + 2 * (AZ1 - AZ0) - (z - AZ0);
  const onB = [...FN.entries()].filter(([, n]) => n.edge).map(([id, n]) => [id, per(n.x, n.z)]);
  [[AX0, AZ0], [AX1, AZ0], [AX1, AZ1], [AX0, AZ1]].forEach(([x, z], i) => { FN.set('C' + i, { x, z, edge: true }); onB.push(['C' + i, per(x, z)]); });
  onB.sort((p, q) => p[1] - q[1]);
  for (let i = 0; i < onB.length; i++) {
    const a = onB[i][0], b = onB[(i + 1) % onB.length][0], A = FN.get(a), Bn = FN.get(b);
    if (Math.hypot(A.x - Bn.x, A.z - Bn.z) > 1e-6) FE.push({ a, b, pts: [[A.x, A.z], [Bn.x, Bn.z]], d: 0, bound: true });
  }
  // planarise: a street crossing another without a shared node (a bridge) is cut there, for the faces only
  let crossings = 0;
  for (let i = 0; i < FE.length; i++) for (let j = i + 1; j < FE.length; j++) {
    const e = FE[i], f = FE[j]; if (!G.boxHit(G.box(e.pts), G.box(f.pts))) continue;
    outer: for (let s = 0; s + 1 < e.pts.length; s++) for (let u = 0; u + 1 < f.pts.length; u++) {
      const [t, v] = G.segX(e.pts[s], e.pts[s + 1], f.pts[u], f.pts[u + 1]);
      if (t <= 1e-6 || t >= 1 - 1e-6 || v <= 1e-6 || v >= 1 - 1e-6) continue;
      const X = [e.pts[s][0] + (e.pts[s + 1][0] - e.pts[s][0]) * t, e.pts[s][1] + (e.pts[s + 1][1] - e.pts[s][1]) * t], id = 'X' + crossings++;
      FN.set(id, { x: X[0], z: X[1] });
      FE.push({ ...e, a: id, pts: [X, ...e.pts.slice(s + 1)] }); e.pts = [...e.pts.slice(0, s + 1), X]; e.b = id;
      FE.push({ ...f, a: id, pts: [X, ...f.pts.slice(u + 1)] }); f.pts = [...f.pts.slice(0, u + 1), X]; f.b = id;
      break outer;
    }
  }
  REPORT.faceCrossings = crossings;
  // dead ends: the brief takes them out before the faces, which paves a dead-end street over with its block; by default they
  // stay, and the face walks round them, so that the kerb leaves a notch the width of the street (--no-notches: the brief's way)
  for (let changed = NO_NOTCH; changed;) {
    changed = false; const d = new Map(); for (const e of FE) { d.set(e.a, (d.get(e.a) || 0) + 1); d.set(e.b, (d.get(e.b) || 0) + 1); }
    const n0 = FE.length; FE = FE.filter(e => d.get(e.a) > 1 && d.get(e.b) > 1); changed = FE.length !== n0;
  }
  // half-edges around each node, by angle; walk the faces with the inside on the left
  const out = new Map();
  FE.forEach((e, i) => {
    for (const dir of [0, 1]) {
      const pts = dir ? e.pts.slice().reverse() : e.pts, from = dir ? e.b : e.a;
      let k = 1; while (k < pts.length - 1 && Math.hypot(pts[k][0] - pts[0][0], pts[k][1] - pts[0][1]) < 1.5) k++;
      const ang = Math.atan2(pts[k][1] - pts[0][1], pts[k][0] - pts[0][0]);
      (out.get(from) || out.set(from, []).get(from)).push({ e: i, dir, ang, to: dir ? e.a : e.b, pts, d: e.d });
    }
  });
  for (const l of out.values()) l.sort((p, q) => p.ang - q.ang);
  const used = new Set(), faces = [];
  for (const [from, l] of out) for (const h0 of l) {
    const key0 = h0.e + ':' + h0.dir; if (used.has(key0)) continue;
    const ring = [], dist = []; let h = h0, guard = 0, ok = true;
    while (guard++ < 5000) {
      const k = h.e + ':' + h.dir; if (used.has(k)) { ok = k === key0; break; }
      used.add(k);
      for (let i = 0; i + 1 < h.pts.length; i++) { ring.push(h.pts[i]); dist.push(h.d); }
      const l2 = out.get(h.to), back = l2.findIndex(q => q.e === h.e && q.dir !== h.dir);
      h = l2[(back - 1 + l2.length) % l2.length];
    }
    if (ok && ring.length >= 3) faces.push({ ring, dist });
  }
  let invalid = 0, tiny = 0;
  for (const f of faces) {
    if (G.area(f.ring) <= 0) continue;              // the outside of the arena
    for (const k of G.offsetRing(f.ring, f.dist, 2)) {
      const s = G.cleanRing(k, 0.25, 2);
      if (!s) { invalid++; continue; }
      if (G.area(s) < 6) { tiny++; continue; }
      BLOCKS.push(s);
    }
  }
  BLOCKS.sort((p, q) => G.centroid(p)[1] - G.centroid(q)[1] || G.centroid(p)[0] - G.centroid(q)[0]);
  REPORT.blocks = { faces: faces.length, blocks: BLOCKS.length, invalidDropped: invalid, tinyDropped: tiny };
  log('blocks', REPORT.blocks, 'face crossings', crossings);
}
const blockBoxes = BLOCKS.map(G.box);
const inBlock = (x, z) => BLOCKS.some((b, i) => { const bb = blockBoxes[i]; return x >= bb[0] && x <= bb[2] && z >= bb[1] && z <= bb[3] && G.pip(b, x, z); });

// ---- plazas: pedestrian streets and squares, on the blocks (never on a carriageway) -----------------------------------
const PLAZAS = [];
{
  const g = new G.Grid(AX0, AZ0, AX1, AZ1, 0.5);
  const src = new G.Grid(AX0, AZ0, AX1, AZ1, 0.5);
  for (const e of [...WAYS, ...RELS]) {
    const t = e.tags || {};
    const areaLike = t.place === 'square' || /^(pedestrian|footway)$/.test(t['area:highway'] || '') || (/^(pedestrian|footway)$/.test(t.highway || '') && t.area === 'yes');
    if (areaLike) { for (const pg of areasOf(e)) if (G.boxHit(G.box(pg.outer), ARENA)) { src.fill(pg.outer, 1); for (const h of pg.holes) src.fill(h, 0); } continue; }
    if (e.type !== 'way') continue;
    const wm = num(t.width);
    if (t.highway === 'pedestrian' || (t.highway === 'footway' && wm >= 4 && t.footway !== 'sidewalk')) {
      const pts = wayPts(e); if (!G.boxHit(G.box(pts), ARENA, 5)) continue;
      src.stroke(pts, (wm > 0 ? Math.min(wm, 20) : 6) / U / 2, 1);
    }
  }
  // only where a block is (a square drawn over its streets keeps the streets)
  for (const b of BLOCKS) g.fill(b, 1);
  for (let i = 0; i < g.a.length; i++) g.a[i] = g.a[i] && src.a[i] ? 1 : 0;
  const rings = g.trace(), outers = rings.filter(r => G.area(r) > 0).map(r => ({ outer: r, holes: [] }));
  for (const h of rings.filter(r => G.area(r) < 0)) { const o = outers.find(p => G.pip(p.outer, h[0][0] + 0.01, h[0][1] + 0.01)); if (o) o.holes.push(h); }
  for (const o of outers) for (const r of G.decompose(o.outer, o.holes)) { const s = G.cleanRing(r, 0.4, 1); if (s && G.area(s) >= 15) PLAZAS.push(s); }
  log('plazas', PLAZAS.length);
}

// ---- the tram: one real line along one long street, right-hand running, a turning loop at each end ----------------------
const TRAM = { loop: [], stops: [], tracks: [] };
const tramWays = WAYS.filter(w => w.tags?.railway === 'tram' && w.tags.tunnel !== 'yes');
for (const w of tramWays) for (const pc of G.clipLine(wayPts(w), ...OUTER)) if (pc.pts.length >= 2) {
  const s = G.simplifyLine(pc.pts, 0.5); if (G.len(s) > 3) TRAM.tracks.push(flat(s));
}
let tramFarDropped = [];
let tramInfo = {};
{
  // which street: Sokolovská or Křižíkova, the one whose tram tracks span more of the arena
  const near = (name) => {
    const st = WAYS.filter(w => w.tags?.highway && w.tags.name === name).map(wayPts);
    let x0 = 1e9, x1 = -1e9; const tr = [];
    for (const w of tramWays) {
      const pts = wayPts(w).filter(p => inArena(p[0], p[1], 80) && st.some(s => G.distPoly2(s, p[0], p[1], false) < 15 ** 2));
      if (pts.length < 2) continue; tr.push(w);
      for (const p of pts) if (inArena(p[0], p[1])) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); }
    }
    return { name, span: Math.max(0, x1 - x0), tr, st };
  };
  const cands = ['Sokolovská', 'Křižíkova'].map(near).sort((a, b) => b.span - a.span), C = cands[0];
  tramInfo = { street: C.name, spans: Object.fromEntries(cands.map(c => [c.name, r1(c.span)])) };
  // the street's centreline as z(x): the mean of the tram tracks crossing each x (the street runs along x in this frame)
  const XA = AX0 - 6, XB = AX1 + 6, step = 2, cl = [];
  const trs = C.tr.map(wayPts);
  for (let x = XA - 70; x <= XB + 70; x += step) {
    const zs = [];
    for (const t of trs) for (let i = 0; i + 1 < t.length; i++) {
      const a = t[i], b = t[i + 1]; if ((a[0] - x) * (b[0] - x) > 0 || a[0] === b[0]) continue;
      const z = a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]); if (cl.length && Math.abs(z - cl[cl.length - 1][1]) > 12) continue; zs.push(z);
    }
    if (zs.length) cl.push([x, zs.reduce((s, v) => s + v, 0) / zs.length]);
  }
  // smooth it a little (the two tracks are not always both mapped at the same x)
  const sm = cl.map((p, i) => { let s = 0, n = 0; for (let k = Math.max(0, i - 3); k <= Math.min(cl.length - 1, i + 3); k++) { s += cl[k][1]; n++; } return [p[0], s / n]; });
  const mid = sm.filter(p => p[0] >= XA && p[0] <= XB);
  const O = 2.2, R = 12, LS = 28;                     // track offset from the centreline, loop radius, length of the S-bend
  const dirAt = (pts, i) => { const a = pts[Math.max(0, i - 3)], b = pts[Math.min(pts.length - 1, i + 3)], l = Math.hypot(b[0] - a[0], b[1] - a[1]); return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
  const offset = (pts, o) => pts.map((p, i) => { const [dx, dz] = dirAt(pts, i); return [p[0] - dz * o, p[1] + dx * o]; });   // o > 0: to the right
  // a turning loop at the end E heading d: swing out to the right, a half circle to the left, back onto the other track
  const loopAt = (E, d) => {
    const r = [-d[1], d[0]], pts = [], at = (u, v) => [E[0] + d[0] * u + r[0] * v, E[1] + d[1] * u + r[1] * v];
    for (let k = 1; k <= 16; k++) { const u = LS * k / 16; pts.push(at(u, O + (R - O) * (1 - Math.cos(Math.PI * u / LS)) / 2)); }
    for (let k = 1; k < 40; k++) { const a = Math.PI * k / 40; pts.push(at(LS + R * Math.sin(a), R * Math.cos(a))); }
    for (let k = 16; k >= 0; k--) { const u = LS * k / 16; pts.push(at(u, -(O + (R - O) * (1 - Math.cos(Math.PI * u / LS)) / 2))); }
    return pts;
  };
  const east = mid[mid.length - 1], west = mid[0];
  const dE = dirAt(mid, mid.length - 1), dW = dirAt(mid, 0).map(v => -v);
  // the four parts, each simplified on its own so that the arc length where each starts is known
  const fwd = G.simplifyLine(offset(mid, O), 0.05), back = G.simplifyLine(offset(mid.slice().reverse(), O), 0.05).slice(1);
  const loopE = loopAt(east, dE), loopW = loopAt(west, dW).slice(0, -1);
  const loop = [...fwd, ...loopE, ...back, ...loopW];
  TRAM.loop = flat(loop);
  const L = [...loop, loop[0]], total = G.len(L);
  const sFwd = 0, sBack = G.len([...fwd, ...loopE, back[0]]);
  // far buildings in the loops' way go (inside the arena nothing is touched: the loops lie outside it); a building
  // standing inside a loop, clear of the track, may stay
  const corridor = G.resample([fwd[fwd.length - 1], ...loopE, back[0]], 1).concat(G.resample([back[back.length - 1], ...loopW, fwd[0]], 1));
  const cbox = G.box(corridor);
  for (const b of B) {
    if (!b.far || !G.boxHit(G.box(b.p), cbox, 4)) continue;
    if (corridor.some(p => G.pip(b.p, p[0], p[1]) || G.distPoly2(b.p, p[0], p[1], true) < 2.8 ** 2)) { b.drop = true; tramFarDropped.push(b.id + (b.tags.name ? ' ' + b.tags.name : '')); }
  }
  // stops: the real tram stops along it (stop positions), each on the pass of its own direction; a stop mapped for one
  // direction only gets its twin on the other track
  const byName = new Map();
  for (const n of NODES) {
    const t = n.tags || {}; if (!(t.railway === 'tram_stop' || (t.public_transport === 'stop_position' && t.tram === 'yes'))) continue;
    const [x, z] = P(n); if (!inArena(x, z, 2)) continue;
    if (G.project(mid, x, z).d2 > 8 ** 2) continue;
    const pf = G.project(fwd, x, z), pb = G.project(back, x, z), onF = pf.d2 <= pb.d2;
    const l = byName.get(t.name) || byName.set(t.name, { f: [], b: [] }).get(t.name);
    const s = onF ? sFwd + pf.s : sBack + pb.s, list = onF ? l.f : l.b;
    if (!list.some(v => Math.abs(v - s) < 8)) list.push(s);
  }
  const stops = [];
  for (const [name, l] of byName) {
    if (!l.f.length && l.b.length) for (const s of l.b) { const p = pAt(back, s - sBack); l.f.push(sFwd + G.project(fwd, p[0], p[1]).s); }
    if (!l.b.length && l.f.length) for (const s of l.f) { const p = pAt(fwd, s - sFwd); l.b.push(sBack + G.project(back, p[0], p[1]).s); }
    for (const s of [...l.f, ...l.b]) stops.push([r1(s), name]);
  }
  function pAt(pts, s) { let acc = 0; for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); if (acc + l >= s) { const t = (s - acc) / (l || 1); return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]; } acc += l; } return pts[pts.length - 1]; }
  stops.sort((a, b) => a[0] - b[0]);
  TRAM.stops = stops.map(s => s[0]);
  tramInfo.stops = stops.map(([s, n]) => `${n} @${s}`);
  tramInfo.length = r1(total);
  // the minimum radius of curvature along the loop (three points apart ~2 u)
  let minR = 1e9, minAt = null; const rs = G.resample(L, 3);
  for (let i = 1; i + 1 < rs.length; i++) { const a = rs[i - 1], b = rs[i], c = rs[i + 1], ab = Math.hypot(b[0] - a[0], b[1] - a[1]), bc = Math.hypot(c[0] - b[0], c[1] - b[1]), ca = Math.hypot(a[0] - c[0], a[1] - c[1]), cr = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])); if (cr > 1e-9 && ab * bc * ca / (2 * cr) < minR) { minR = ab * bc * ca / (2 * cr); minAt = b.map(r1); } }
  tramInfo.minRadius = r1(minR); tramInfo.minRadiusAt = minAt;
  // the street edges the tram runs along
  for (const e of RE) {
    const s = G.resample(e.pts, 2), on = s.filter(p => G.distPoly2(mid, p[0], p[1], false) < 4 ** 2).length;
    if (on >= 0.6 * s.length) e.tram = 1;
  }
  log('tram', tramInfo, 'far buildings dropped for the loops', tramFarDropped.length);
}

// ---- railways -----------------------------------------------------------------------------------------------------------
const RAIL = [];
{
  const rw = WAYS.filter(w => { const t = w.tags || {}; return /^(rail|light_rail|narrow_gauge)$/.test(t.railway) && t.tunnel !== 'yes' && !(num(t.layer) < 0) && !/^(siding|spur)$/.test(t.service || '') || (t.railway === 'disused' && /viaduct|yes/.test(t.bridge || '')); });
  // join ways end to end where the bridge state is the same, so that a line is one polyline
  const segs = rw.map(w => ({ ids: w.nodes.slice(), pts: wayPts(w), br: /^(yes|viaduct)$/.test(w.tags.bridge || '') ? 1 : 0, neg: /Negrelli/.test(w.tags['bridge:name'] || w.tags.name || ''), dis: w.tags.railway === 'disused' }));
  const ends = new Map(); segs.forEach((s, i) => { for (const id of [s.ids[0], s.ids[s.ids.length - 1]]) (ends.get(id) || ends.set(id, []).get(id)).push(i); });
  const used = new Uint8Array(segs.length), lines = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue; used[i] = 1;
    let cur = { ...segs[i], ids: segs[i].ids.slice(), pts: segs[i].pts.slice() };
    for (const side of [1, 0]) for (let guard = 0; guard < 500; guard++) {
      const endId = side ? cur.ids[cur.ids.length - 1] : cur.ids[0], c = (ends.get(endId) || []).filter(k => !used[k] && segs[k].br === cur.br && segs[k].dis === cur.dis);
      if (c.length !== 1 || (ends.get(endId) || []).length > 2) break;
      const k = c[0], s = segs[k]; used[k] = 1;
      let ids = s.ids, pts = s.pts; if ((side && ids[0] !== endId) || (!side && ids[ids.length - 1] !== endId)) { ids = ids.slice().reverse(); pts = pts.slice().reverse(); }
      if (side) { cur.ids.push(...ids.slice(1)); cur.pts.push(...pts.slice(1)); } else { cur.ids = [...ids.slice(0, -1), ...cur.ids]; cur.pts = [...pts.slice(0, -1), ...cur.pts]; }
      cur.neg = cur.neg || s.neg;
    }
    lines.push(cur);
  }
  for (const l of lines) for (const pc of G.clipLine(l.pts, ...OUTER)) {
    const s = G.simplifyLine(pc.pts, 0.5); if (G.len(s) < 4) continue;
    let deck = 0;
    if (l.br) {
      // the Negrelli viaduct: its track bed about 8 m above the street; other bridges land on the terrain at their ends
      const ends = Math.max(terrainH(...s[0]), terrainH(...s[s.length - 1]), 0);
      deck = l.neg || inArena(...s[Math.floor(s.length / 2)], 40) ? Math.max(hU(8), ends) : Math.max(ends, hU(6));
    }
    RAIL.push({ pts: flat(s), deck: r1(deck), bridge: l.br });
  }
  log('rail lines', RAIL.length, 'bridges', RAIL.filter(r => r.bridge).length);
}

// ---- the streets outside the arena (issue #16, 4. 11.: drawn for the planes only; no graph, no traffic) ------------------
// The same car roads as the arena's, in the outer square, without the parts inside the arena (the graph draws those). A piece on a
// bridge keeps a deck height: the higher of its two ends' terrain, and never below the river's ice.
const FAR_ROADS = [];
{
  // the parts of a polyline outside the rectangle, as polylines
  const outside = (pts, x0, z0, x1, z1) => {
    const out = []; let cur = null;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1], dx = bx - ax, dz = bz - az, P = t => [ax + dx * t, az + dz * t];
      let t0 = 0, t1 = 1;                                           // the part inside (Liang-Barsky); t0 >= t1: none
      for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dz, az - z0], [dz, z1 - az]]) {
        if (p === 0) { if (q < 0) { t0 = 1; t1 = 0; } continue; }
        const r = q / p; if (p < 0) t0 = Math.max(t0, r); else t1 = Math.min(t1, r);
      }
      const iv = t0 < t1 ? [[0, t0], [t1, 1]].filter(([u, v]) => v - u > 1e-9) : [[0, 1]];
      if (!iv.length || iv[0][0] > 0) { if (cur) out.push(cur); cur = null; }
      for (const [u, v] of iv) {
        if (u === 0 && cur) cur.push(P(v)); else { if (cur) out.push(cur); cur = [P(u), P(v)]; }
        if (v < 1) { out.push(cur); cur = null; }
      }
    }
    if (cur) out.push(cur);
    return out;
  };
  for (const w of roadWays) {
    const t = w.tags, c = CLS[t.highway], wm = num(t.width) > 0 ? Math.min(Math.max(num(t.width), 3), 30) : WIDTH_M[c], pts = wayPts(w);
    if (pts.length < 2) continue;
    for (const pc of G.clipLine(pts, ...OUTER)) for (const piece of outside(pc.pts, AX0, AZ0, AX1, AZ1)) {
      const s = G.simplifyLine(piece, 0.6); if (s.length < 2 || G.len(s) < 2) continue;
      const o = { pts: flat(s), w: r1(wm / U) };
      if (t.bridge && t.bridge !== 'no') o.y = r1(Math.max(terrainH(...s[0]), terrainH(...s[s.length - 1]), 0.3));
      FAR_ROADS.push(o);
    }
  }
  REPORT.farRoads = { pieces: FAR_ROADS.length, length: Math.round(FAR_ROADS.reduce((a, o) => { let l = 0; for (let i = 2; i < o.pts.length; i += 2) l += Math.hypot(o.pts[i] - o.pts[i - 2], o.pts[i + 1] - o.pts[i - 1]); return a + l; }, 0)), bridges: FAR_ROADS.filter(o => o.y !== undefined).length };
  log('far roads', JSON.stringify(REPORT.farRoads));
}

// ---- parks --------------------------------------------------------------------------------------------------------------
const PARKS = [];
for (const e of [...WAYS, ...RELS]) {
  const t = e.tags || {};
  if (!(/^(park|garden)$/.test(t.leisure || '') || /^(grass|forest|recreation_ground|meadow|village_green|cemetery)$/.test(t.landuse || '') || /^(wood|scrub|grassland)$/.test(t.natural || ''))) continue;
  if (t.landuse === 'recreation_ground' && t.surface && /asphalt|paved|concrete/.test(t.surface)) continue;
  for (const pg of areasOf(e)) {
    if (!G.boxHit(G.box(pg.outer), OUTER)) continue;
    for (const c of G.clipRect(pg.outer, pg.holes, ...OUTER)) for (const r of G.decompose(c.outer, c.holes)) {
      const ia = boxInArena(G.box(r)), s = G.cleanRing(r, ia ? 0.4 : 1.0, 4);
      if (s && G.area(s) >= (ia ? 15 : 40)) PARKS.push(s);
    }
  }
}
log('parks', PARKS.length);

// ---- trees (inside the arena): OSM trees and tree rows, on a pavement or in a courtyard, never on a carriageway ----------
const TREES = [];
{
  const raw = [];
  for (const n of NODES) if (n.tags?.natural === 'tree') { const [x, z] = P(n); if (inArena(x, z)) raw.push([x, z, num(n.tags.height), n.id]); }
  for (const w of WAYS) if (w.tags?.natural === 'tree_row') {
    const pts = wayPts(w); if (!G.boxHit(G.box(pts), ARENA)) continue;
    G.resample(pts, 6).forEach((p, i) => { if (inArena(p[0], p[1])) raw.push([p[0], p[1], num(w.tags.height), w.id + ':' + i]); });
  }
  const bh = new Map(), BC = 16;
  B.forEach((b, i) => { if (b.far) return; const bb = G.box(b.p); for (let x = Math.floor(bb[0] / BC); x <= Math.floor(bb[2] / BC); x++) for (let z = Math.floor(bb[1] / BC); z <= Math.floor(bb[3] / BC); z++) { const k = x + ',' + z; (bh.get(k) || bh.set(k, []).get(k)).push(i); } });
  const inBuilding = (x, z) => (bh.get(Math.floor(x / BC) + ',' + Math.floor(z / BC)) || []).some(i => G.pip(B[i].p, x, z));
  let moved = 0, gone = 0;
  for (let [x, z, h, id] of raw) {
    if (!inBlock(x, z)) {
      // a street tree a little off: move it onto the nearest kerb polygon if that is close
      let best = null, bd = 3 ** 2;
      BLOCKS.forEach((b, i) => { const bb = blockBoxes[i]; if (x < bb[0] - 3 || x > bb[2] + 3 || z < bb[1] - 3 || z > bb[3] + 3) return; const q = G.project([...b, b[0]], x, z); if (q.d2 < bd) { bd = q.d2; best = { q, b }; } });
      if (!best) { gone++; continue; }
      const c = G.centroid(best.b), dx = c[0] - best.q.x, dz = c[1] - best.q.z, l = Math.hypot(dx, dz) || 1;
      x = best.q.x + dx / l * 0.9; z = best.q.z + dz / l * 0.9; moved++;
      if (!inBlock(x, z)) { gone++; continue; }
    }
    if (inBuilding(x, z)) { gone++; continue; }
    const size = h > 0 ? Math.min(1.3, Math.max(0.7, 0.7 + (h - 6) / 20 * 0.6)) : 0.7 + (hash(id) % 61) / 100;
    if (!inBlock(r1(x), r1(z)) || inBuilding(r1(x), r1(z))) { gone++; continue; }      // rounding can push it off the kerb
    TREES.push(r1(x), r1(z), r1(size));
  }
  log('trees', TREES.length / 3, 'moved onto a pavement', moved, 'dropped', gone);
  REPORT.trees = { kept: TREES.length / 3, moved, dropped: gone };
}

// ---- landmarks ---------------------------------------------------------------------------------------------------------
const LM = {};
const lmMissing = [];
{
  const find = (test) => all.filter(e => e.tags && test(e.tags, e));
  const ptOf = e => e.type === 'node' ? P(e) : e.center ? P(e.center) : e.geometry ? G.centroid(wayPts(e)) : areasOf(e)[0] ? G.inner(areasOf(e)[0].outer) : null;
  const SPEC = {
    church: t => /cyril.*metod/.test(fold(t.name)) && (t.building || t.amenity),
    theatre: t => /hudebni divadlo karlin/.test(fold(t.name)),
    forum: t => /forum karlin/.test(fold(t.name)) && t.building,
    kasarna: t => /karlinska kasarna/.test(fold(t.name)) && t.building,
    synagogue: t => /karlinska synagoga/.test(fold(t.name)),
    vitkov: t => /narodni pamatnik na vitkove/.test(fold(t.name)) || (t.building && fold(t['addr:street']) === 'u pamatniku' && t['addr:housenumber'] === '1900'),
  };
  for (const [key, test] of Object.entries(SPEC)) {
    const cand = find(test); if (!cand.length) { lmMissing.push(key); continue; }
    const p = ptOf(cand.find(e => e.tags.building) || cand[0]); if (!p) { lmMissing.push(key); continue; }
    // the building at that point (the biggest piece if a multipolygon was cut), else the nearest within 10 u
    let bi = -1, ba = 0;
    B.forEach((b, i) => { if (b.drop) return; const bb = G.box(b.p); if (p[0] < bb[0] - 10 || p[0] > bb[2] + 10 || p[1] < bb[1] - 10 || p[1] > bb[3] + 10) return; if (G.pip(b.p, p[0], p[1]) && b.area > ba) { ba = b.area; bi = i; } });
    if (bi < 0) { let bd = 10 ** 2; B.forEach((b, i) => { if (b.drop) return; const d = G.distPoly2(b.p, p[0], p[1], true); if (d < bd) { bd = d; bi = i; } }); }
    if (bi >= 0) {
      const b = B[bi], src = cand.find(e => e.tags.building) || cand[0];
      // all pieces of the same OSM building carry the key
      for (const o of B) if (o.id === b.id) o.k = key;
      // the memorial is mapped 5 m high (one storey); it is a 22 m stone block on the hill, seen from every plane
      if (key === 'vitkov') for (const o of B) if (o.id === b.id) { o.wallsM = Math.max(o.wallsM, 22); o.f = Math.max(o.f, 4); o.landmarkFix = 'height 22 m (OSM says 5)'; }
      LM[key] = { bi, x: b.mr.c[0], z: b.mr.c[1], rot: b.mr.a, src: src.type + src.id };
    } else LM[key] = { bi: -1, x: p[0], z: p[1], rot: 0 };
  }
  // the viaduct: the bridge outline (man_made=bridge) inside the arena, its middle and its direction
  const vb = find(t => t.man_made === 'bridge' && /negrelli/.test(fold(t.name))).filter(e => e.type === 'way' && closed(e));
  if (vb.length) {
    const r = G.dedupe(wayPts(vb[0])), parts = G.clipRect(G.ccw(r), [], ...ARENA), pc = parts.sort((a, b) => G.area(b.outer) - G.area(a.outer))[0];
    const ring = pc ? pc.outer : G.ccw(r), mr = G.minRect(ring);
    LM.viaduct = { bi: -1, x: mr.c[0], z: mr.c[1], rot: mr.a };
  } else lmMissing.push('viaduct');
  log('landmarks', Object.fromEntries(Object.entries(LM).map(([k, v]) => [k, `${r1(v.x)},${r1(v.z)} b${v.bi}`])), 'missing', lmMissing);
}

// ---- final buildings: units, terrain base, order ----------------------------------------------------------------------
const outB = [], bIndex = new Map();
{
  const keep = B.map((b, i) => [b, i]).filter(([b]) => !b.drop);
  // arena buildings first (sorted by position), then the far ones: the client can stop early when it only wants the arena
  keep.sort(([a], [b]) => (a.far ? 1 : 0) - (b.far ? 1 : 0) || G.centroid(a.p)[1] - G.centroid(b.p)[1] || G.centroid(a.p)[0] - G.centroid(b.p)[0]);
  for (const [b, i] of keep) {
    let y0 = 0, tm = 0;
    if (b.far) {
      const hs = [...b.p, G.centroid(b.p)].map(q => terrainH(q[0], q[1]));
      y0 = Math.min(...hs); tm = hs.reduce((s, v) => s + v, 0) / hs.length;
    }
    const o = { p: flat(b.p), h: r1(tm + hU(b.wallsM)) };
    if (Math.abs(y0) >= 0.1) o.y0 = r1(y0);
    o.r = b.r; o.rh = r1(hU(b.rhM)); if (o.r === 0) o.rh = 0;
    o.f = b.f; o.c = b.c;
    if (b.k) o.k = b.k;
    if (b.far) o.far = 1;
    bIndex.set(i, outB.length); outB.push(o);
  }
  for (const v of Object.values(LM)) v.b = v.bi >= 0 ? bIndex.get(v.bi) ?? -1 : -1;
}

// ---- lots: the biggest empty rectangles inside the arena (no building, carriageway, plaza or water) --------------------
const LOTS = [];
{
  const g = new G.Grid(AX0, AZ0, AX1, AZ1, 1);
  for (const b of BLOCKS) g.fill(b, 1);
  // keep off the pavement: 2 u in from the kerb
  const off = new G.Grid(AX0, AZ0, AX1, AZ1, 1); off.a.set(g.a.map(v => v ? 0 : 1)); off.dilate(2, 1);
  for (let i = 0; i < g.a.length; i++) if (off.a[i]) g.a[i] = 0;
  const occ = new G.Grid(AX0, AZ0, AX1, AZ1, 1);
  for (const o of outB) if (!o.far) { const r = []; for (let i = 0; i < o.p.length; i += 2) r.push([o.p[i], o.p[i + 1]]); occ.fill(r, 1); }
  for (const w of water) occ.fill(w.r, 1);
  // railway tracks (the yard at the foot of Vítkov) and the viaduct's piers are no building ground either
  for (const r of RAIL) { const pts = []; for (let i = 0; i < r.pts.length; i += 2) pts.push([r.pts[i], r.pts[i + 1]]); if (G.boxHit(G.box(pts), ARENA, 4)) occ.stroke(pts, 2.5, 1); }
  // reachable by a tank: flood from the carriageways through everything that is not a building (grown by 2 u, a tank's
  // half width), so that a courtyard closed by houses on all sides does not count
  const wall = new G.Grid(AX0, AZ0, AX1, AZ1, 1); wall.a.set(occ.a); wall.dilate(2, 1);
  const reach = new Uint8Array(g.a.length), st = [];
  for (let i = 0; i < g.a.length; i++) if (off.a[i] && !wall.a[i] && !g.a[i]) { reach[i] = 1; st.push(i); }
  while (st.length) { const i = st.pop(), x = i % g.W, z = (i / g.W) | 0; for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + dx, Z = z + dz; if (X < 0 || Z < 0 || X >= g.W || Z >= g.H) continue; const j = Z * g.W + X; if (!reach[j] && !wall.a[j]) { reach[j] = 1; st.push(j); } } }
  for (const p of PLAZAS) occ.fill(p, 1);
  occ.dilate(1, 1);
  for (let i = 0; i < g.a.length; i++) if (occ.a[i] || !reach[i]) g.a[i] = 0;
  for (let k = 0; k < 8; k++) {
    const m = G.maxRect(g, 12, 4); if (!m) break;
    const [i0, j0, i1, j1] = m;
    LOTS.push([r1(AX0 + i0), r1(AZ0 + j0), r1(AX0 + i1), r1(AZ0 + j1)]);
    for (let j = Math.max(0, j0 - 3); j < Math.min(g.H, j1 + 3); j++) for (let i = Math.max(0, i0 - 3); i < Math.min(g.W, i1 + 3); i++) g.a[j * g.W + i] = 0;
  }
  log('lots', LOTS.map(l => `${r1(l[2] - l[0])}×${r1(l[3] - l[1])}`).join(' '));
}

// ---- statistics for the report ----------------------------------------------------------------------------------------
{
  const deg = new Map(); for (const e of RE) { deg.set(e.a, (deg.get(e.a) || 0) + 1); deg.set(e.b, (deg.get(e.b) || 0) + 1); }
  const dh = {}; for (const n of nodeList) { const d = deg.get(n.id) || 0; dh[d] = (dh[d] || 0) + 1; }
  const short = RE.filter(e => G.len(e.pts) < 6).map(e => `${e.n || e.way} ${r1(G.len(e.pts))} u (${r1(e.pts[0][0])},${r1(e.pts[0][1])})`);
  REPORT.roads = { nodes: nodeList.length, edges: RE.length, degree: dh, lengthU: r1(RE.reduce((s, e) => s + G.len(e.pts), 0)), edgeNodes: nodeList.filter(n => n.edge).length, short, tramEdges: RE.filter(e => e.tram).length, classes: RE.reduce((m, e) => (m[e.c] = (m[e.c] || 0) + 1, m), {}) };
  const ab = outB.filter(b => !b.far), hh = {};
  for (const b of ab) { const k = Math.floor(b.h / 4) * 4; hh[k] = (hh[k] || 0) + 1; }
  REPORT.buildings = { total: outB.length, arena: ab.length, far: outB.length - ab.length, heightHistArena: hh, roofs: outB.reduce((m, b) => (m[b.r] = (m[b.r] || 0) + 1, m), {}), withY0: outB.filter(b => b.y0).length, maxH: Math.max(...outB.map(b => b.h)) };
  const ba = BLOCKS.map(b => r1(G.area(b))).sort((a, b) => a - b);
  REPORT.blocks.smallest = ba.slice(0, 6); REPORT.blocks.largest = ba[ba.length - 1];
  REPORT.plazas = PLAZAS.map(p => r1(G.area(p))).sort((a, b) => b - a);
  REPORT.lots = LOTS;
  log('roads', JSON.stringify(REPORT.roads));
  log('buildings', JSON.stringify(REPORT.buildings));
  log('blocks', JSON.stringify(REPORT.blocks));
}

// ---- write --------------------------------------------------------------------------------------------------------------
const data = {
  v: 1,
  attribution: ['© OpenStreetMap contributors (ODbL)', 'datový podklad © IPR Praha (CC BY 4.0)', 'výškopis © ČÚZK (CC BY 4.0)'],
  osmDate,
  frame: { lat0: F.LAT0, lon0: F.LON0, rotDeg: F.ROT_DEG, unitM: F.UNIT_M, hScale: F.H_SCALE, cx: F.CX, cz: F.CZ },
  arena: ARENA,
  outer: OUTER,
  buildings: outB,
  roads: { nodes: nodeList.flatMap(n => [r1(n.x), r1(n.z)]), edges: RE.map(e => { const o = { a: NI.get(e.a), b: NI.get(e.b), pts: flat(e.pts), w: r1(e.w), c: e.c }; if (e.n) o.n = e.n; if (e.tram) o.tram = 1; return o; }) },
  blocks: BLOCKS.map(flat),
  plazas: PLAZAS.map(flat),
  tram: TRAM,
  rail: RAIL,
  farRoads: FAR_ROADS,
  water: water.map(w => flat(w.r)),
  parks: PARKS.map(flat),
  trees: TREES,
  lots: LOTS,
  landmarks: Object.fromEntries(Object.entries(LM).map(([k, v]) => [k, { x: r1(v.x), z: r1(v.z), rot: Math.round(v.rot * 1000) / 1000, b: v.b }])),
  terrain: TER,
};
// the end points of every edge sit exactly on their (rounded) nodes
for (const e of data.roads.edges) { const n = data.roads.nodes; e.pts[0] = n[e.a * 2]; e.pts[1] = n[e.a * 2 + 1]; e.pts[e.pts.length - 2] = n[e.b * 2]; e.pts[e.pts.length - 1] = n[e.b * 2 + 1]; }
const json = JSON.stringify(data);
fs.writeFileSync(OUT, json + '\n');
const gz = zlib.gzipSync(json).length;
log(`wrote ${path.relative(ROOT, OUT)}: ${(json.length / 1024).toFixed(0)} KB, gzip ${(gz / 1024).toFixed(0)} KB`);
REPORT.size = { bytes: json.length, gzip: gz };
REPORT.tram = tramInfo; REPORT.tramFarDropped = tramFarDropped; REPORT.landmarksMissing = lmMissing; REPORT.terrainRoute = terrainRoute; REPORT.arena = ARENA;
REPORT.landmarkFix = B.filter(b => b.landmarkFix).map(b => b.id + ': ' + b.landmarkFix);
fs.writeFileSync(path.join(CACHE, 'report.json'), JSON.stringify(REPORT, null, 1));
