// The minimap in the top right corner: the city, the construction site, the depot, the other players once spotted, and your tank. A
// click makes it big (game/input.ts). World of DODO, issue #14: in a plane it shows the whole airspace, and the planes are drawn as
// arrows, the tanks as dots. World of DODO, issue #16: the real Karlín. The map itself (the river, the woods, the far houses, the
// streets, the blocks and the houses on them, the squares, the site, the depot) is drawn once per size into a canvas of its own and
// copied every frame; only the markers are drawn each time. The arena is wider than high: its view is a square round the arena's
// middle as wide as the arena, so the river shows above it and Vítkov below. World of DODO, issue #20: in a ship it shows the river round
// it (a window of SEA_E either side of the ship, cut from the airspace's map drawn twice as big), and the ships are drawn as hulls.
// World of DODO, issue #24: the zones (a circle in the colour of the team that holds it, an arc round it for how far a capture has got)
// and the supply depots (a square in their team's colour; a destroyed one dark and crossed out), the others in their team's colour, my
// teammates always (the enemy only once spotted), my arrow ringed in my team's colour.
import { DATA, ARENA, AIR_LIM, SITE, DEPOT, BLOCKS } from '../../shared/map.ts';
import { ZONES, DEPOTS } from '../../shared/rules.ts';
import { $ } from '../core/dom';
import { now, hexCss } from '../core/util';
import { SPOT_MS } from '../net/net';
import { TM, zoneP, teamCss } from '../game/teams';
import type { Other } from '../game/types';

// a rounded rectangle path
export function rr(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath(); c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

export interface MapOpt {
  car?: { x: number; z: number; h: number };   // your tank or plane: an arrow, kept inside the map
  others?: Iterable<Other>;                    // the other players and the bots
  air?: boolean;                               // flying: the whole airspace
  sea?: boolean;                               // sailing: the river round the ship (issue #20)
  team?: number;                               // my team (issue #24; -1 none)
}
// an arrow pointing along heading h, q its size
function arrow(c: CanvasRenderingContext2D, x: number, y: number, h: number, q: number) {
  c.save(); c.translate(x, y); c.rotate(-h + Math.PI);
  c.beginPath(); c.moveTo(0, -q * 1.2); c.lineTo(q * 0.8, q * 0.8); c.lineTo(0, q * 0.35); c.lineTo(-q * 0.8, q * 0.8); c.closePath();
  c.fill(); c.stroke(); c.restore();
}
// a ship's hull pointing along heading h, q its size (issue #20)
function hull(c: CanvasRenderingContext2D, x: number, y: number, h: number, q: number) {
  c.save(); c.translate(x, y); c.rotate(-h + Math.PI);
  c.beginPath(); c.moveTo(0, -q * 1.6); c.quadraticCurveTo(q * 0.75, -q * 0.4, q * 0.55, q * 1.2); c.lineTo(-q * 0.55, q * 1.2); c.quadraticCurveTo(-q * 0.75, -q * 0.4, 0, -q * 1.6); c.closePath();
  c.fill(); c.stroke(); c.restore();
}
// the window of a view: its middle and half size in world units
const AX = (ARENA.x0 + ARENA.x1) / 2, AZ = (ARENA.z0 + ARENA.z1) / 2, AE = (ARENA.x1 - ARENA.x0) / 2 + 10, SEA_E = 260;
const view = (air: boolean) => air ? { cx: 0, cz: 0, e: AIR_LIM } : { cx: AX, cz: AZ, e: AE };
// a ship's window: round the ship, kept inside the airspace's map
const seaView = (x: number, z: number) => ({ cx: Math.max(-AIR_LIM + SEA_E, Math.min(AIR_LIM - SEA_E, x)), cz: Math.max(-AIR_LIM + SEA_E, Math.min(AIR_LIM - SEA_E, z)), e: SEA_E });

// the map drawn once into a canvas of S × S pixels for one view
const CACHE: { S: number; air: boolean; c: HTMLCanvasElement | null } = { S: 0, air: false, c: null };
function base(S: number, air: boolean): HTMLCanvasElement {
  if (CACHE.c && CACHE.S === S && CACHE.air === air) return CACHE.c;
  const cv = CACHE.c || document.createElement('canvas'); cv.width = cv.height = S;
  const g = cv.getContext('2d')!, { cx, cz, e } = view(air), sc = S / (2 * e);
  const mx = (x: number) => (x - cx + e) * sc, my = (z: number) => (z - cz + e) * sc;
  const poly = (p: ArrayLike<number>) => { g.beginPath(); for (let i = 0; i < p.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, mx(p[i]), my(p[i + 1])); g.closePath(); };
  const line = (p: ArrayLike<number>) => { g.beginPath(); for (let i = 0; i < p.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, mx(p[i]), my(p[i + 1])); };
  g.fillStyle = '#2f3534'; g.fillRect(0, 0, S, S);
  // the terrain: the higher, the lighter (Vítkov, Letná)
  const T = DATA.terrain;
  for (let j = 0; j < T.nz; j++) for (let i = 0; i < T.nx; i++) {
    const h = T.h[j * T.nx + i]; if (h < 4) continue;
    g.fillStyle = 'rgba(173,177,176,' + Math.min(0.35, h / 160).toFixed(3) + ')';
    g.fillRect(mx(T.x0 + (i - 0.5) * T.step), my(T.z0 + (j - 0.5) * T.step), T.step * sc + 1, T.step * sc + 1);
  }
  g.fillStyle = '#365049'; for (const q of DATA.parks) { poly(q); g.fill(); }        // the woods and parks
  g.fillStyle = '#5d8f92'; for (const q of DATA.water) { poly(q); g.fill(); }        // the Vltava
  g.strokeStyle = '#6b706f'; g.lineWidth = Math.max(1, 1.2 * sc);                    // the railway
  for (const r of DATA.rail) { line(r.pts); g.stroke(); }
  // the arena: the streets light, the blocks dark, the squares teal, the houses a shade lighter than their blocks
  g.fillStyle = '#adb1b0'; g.fillRect(mx(ARENA.x0), my(ARENA.z0), (ARENA.x1 - ARENA.x0) * sc, (ARENA.z1 - ARENA.z0) * sc);
  g.fillStyle = '#3d4543'; for (const b of BLOCKS) { poly(b.p); g.fill(); }
  g.fillStyle = '#00746a'; for (const q of DATA.plazas) { poly(q); g.fill(); }
  DATA.buildings.forEach(b => { g.fillStyle = b.far ? '#4c5452' : '#59615f'; poly(b.p); g.fill(); });
  const L = DATA.landmarks;                                                           // the landmarks a little brighter
  g.fillStyle = '#c9ccca'; for (const k of ['church', 'forum', 'kasarna', 'synagogue', 'theatre', 'vitkov']) { const l = L[k]; if (l && l.b >= 0 && DATA.buildings[l.b]) { poly(DATA.buildings[l.b].p); g.fill(); } }
  g.strokeStyle = '#b2dcd6'; g.lineWidth = Math.max(1, 0.9 * sc); line(DATA.tram.loop); g.closePath(); g.stroke();   // the tram
  // the construction site: its ground, and everything standing on it in its colour
  if (SITE) {
    const A = SITE.area; g.fillStyle = '#797e7d'; g.fillRect(mx(A.x0), my(A.z0), (A.x1 - A.x0) * sc, (A.z1 - A.z0) * sc);
    for (const b of SITE.solids) { g.fillStyle = hexCss(b.color ?? 0); g.fillRect(mx(b.x0), my(b.z0), Math.max(1, (b.x1 - b.x0) * sc), Math.max(1, (b.z1 - b.z0) * sc)); }
  }
  if (DEPOT.p) { g.fillStyle = '#3d4543'; poly(DEPOT.p); g.fill(); g.strokeStyle = '#b2dcd6'; g.lineWidth = Math.max(1, 1.5 * sc * 2); g.stroke(); }
  if (air) { g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 1; g.strokeRect(mx(ARENA.x0), my(ARENA.z0), (ARENA.x1 - ARENA.x0) * sc, (ARENA.z1 - ARENA.z0) * sc); }
  CACHE.c = cv; CACHE.S = S; CACHE.air = air;
  return cv;
}

// the arena's map only: the original's stops, time windows, GAIA's route, your trail, the police and the hunting tanks are gone with
// the single-player game
export function drawMap(ctx: CanvasRenderingContext2D, S: number, opt: MapOpt) {
  const sea = !!opt.sea && !!opt.car, air = !!opt.air, { cx, cz, e } = sea ? seaView(opt.car!.x, opt.car!.z) : view(air), sc = S / (2 * e);
  const mx = (x: number) => (x - cx + e) * sc, my = (z: number) => (z - cz + e) * sc;
  if (sea) {                                                                          // the window, cut from the airspace's map
    const B = Math.round(S * 2), k = B / (2 * AIR_LIM);
    ctx.fillStyle = '#2f3534'; ctx.fillRect(0, 0, S, S);
    ctx.drawImage(base(B, true), (cx - e + AIR_LIM) * k, (cz - e + AIR_LIM) * k, 2 * e * k, 2 * e * k, 0, 0, S, S);
  } else ctx.drawImage(base(S, air), 0, 0);
  const r = Math.max(6, S / 24), team = opt.team ?? -1, teams = TM.on && (team === 0 || team === 1);
  if (!teams) { ctx.fillStyle = '#b2dcd6'; ctx.beginPath(); ctx.arc(mx(DEPOT.park.x), my(DEPOT.park.z), r * 0.7, 0, Math.PI * 2); ctx.fill(); }   // the depot's start (issue #24: no more one start)
  else objectives(ctx, mx, my, sc, r);
  if (opt.others) {
    const t = now();
    for (const o of opt.others) {
      const mate = teams && o.team === team;                                     // issue #24: a teammate shows where he is
      const age = mate ? 0 : t - (o.seenAt || -1e9); if (!o.on || age > SPOT_MS || mate && o.s === 2 && o.k === 1) continue;   // the others: only once spotted,
      ctx.globalAlpha = mate || o.seen ? 1 : Math.max(0.2, 1 - age / SPOT_MS);   // then their last seen place, fading
      const x = mate ? o.x : o.seenX!, z = mate ? o.z : o.seenZ!;
      ctx.fillStyle = teams && o.team >= 0 ? teamCss(o.team) : hexCss(o.color); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5;
      if (o.k === 1) arrow(ctx, mx(x), my(z), o.h, r * 0.7);
      else if (o.k === 2) hull(ctx, mx(x), my(z), o.h, r * 0.6);
      else { ctx.beginPath(); ctx.arc(mx(x), my(z), r * 0.62, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    }
    ctx.globalAlpha = 1;
  }
  if (opt.car) {
    const c = opt.car; ctx.fillStyle = '#ffffff'; ctx.strokeStyle = teams ? teamCss(team) : '#3d4543'; ctx.lineWidth = teams ? 2.5 : 1.5;
    (sea ? hull : arrow)(ctx, Math.max(r, Math.min(S - r, mx(c.x))), Math.max(r, Math.min(S - r, my(c.z))), c.h, r * (sea ? 0.75 : 0.9));
  }
}

// World of DODO, issue #24: the zones and the depots on the map (mx, my: world to the map's pixels, sc its pixels per unit, r the
// markers' size)
function objectives(ctx: CanvasRenderingContext2D, mx: (x: number) => number, my: (z: number) => number, sc: number, r: number) {
  const TAU = Math.PI * 2;
  for (const zn of ZONES) {
    const own = TM.z[zn.i] ? TM.z[zn.i][0] : -1, p = zoneP(zn.i), x = mx(zn.x), y = my(zn.z), q = Math.max(r * 0.75, zn.r * sc);
    ctx.fillStyle = ctx.strokeStyle = teamCss(own);
    ctx.globalAlpha = own >= 0 ? 0.4 : 0.2; ctx.beginPath(); ctx.arc(x, y, q, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1; ctx.lineWidth = 1.5; ctx.stroke();
    if (Math.abs(p) > 0.5 && Math.abs(p) < 99.5) {                              // a capture under way: an arc round it
      ctx.strokeStyle = teamCss(p > 0 ? 0 : 1); ctx.lineWidth = Math.max(2, r * 0.3);
      ctx.beginPath(); ctx.arc(x, y, q + ctx.lineWidth, -Math.PI / 2, -Math.PI / 2 + TAU * Math.abs(p) / 100); ctx.stroke();
    }
  }
  for (const d of DEPOTS) {
    const up = !TM.d[d.i] || TM.d[d.i][0] > 0, x = mx(d.x), y = my(d.z), q = Math.max(r * 0.48, d.r * sc);
    ctx.strokeStyle = up ? '#ffffff' : teamCss(d.team); ctx.lineWidth = up ? 1.2 : Math.max(1.5, r * 0.25);
    if (up) { ctx.fillStyle = teamCss(d.team); ctx.fillRect(x - q, y - q, q * 2, q * 2); ctx.strokeRect(x - q, y - q, q * 2, q * 2); }
    else { ctx.beginPath(); ctx.moveTo(x - q, y - q); ctx.lineTo(x + q, y + q); ctx.moveTo(x + q, y - q); ctx.lineTo(x - q, y + q); ctx.stroke(); }
  }
}

export const mini = $<HTMLCanvasElement>('mini'), mctx = mini.getContext('2d')!;
// the canvas in device pixels (at most 2 per CSS pixel), as big as it is shown (small, or big after a click)
export function sizeMini() { const r = Math.min(window.devicePixelRatio || 1, 2), w = mini.clientWidth || 176; mini.width = w * r; mini.height = w * r; }
