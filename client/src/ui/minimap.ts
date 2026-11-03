// The minimap in the top right corner: the city, the construction site, the depot and the REDLINE hall, the other players once
// spotted, and your tank. A click makes it big (game/input.ts). World of DODO, issue #14: in a plane it shows the whole airspace, and
// the planes are drawn as arrows, the tanks as dots.
import { HALF, ROAD, RC, blockC, DEPOT_B, PARK_B, PLAZA_B, RIVAL_B, RIVAL_PARK, depot, AIR_LIM } from '../world/grid';
import { AIRFIELD } from '../world/land';
import { $ } from '../core/dom';
import { now, hexCss } from '../core/util';
import { SPOT_MS } from '../net/net';
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
}
// an arrow pointing along heading h, q its size
function arrow(c: CanvasRenderingContext2D, x: number, y: number, h: number, q: number) {
  c.save(); c.translate(x, y); c.rotate(-h + Math.PI);
  c.beginPath(); c.moveTo(0, -q * 1.2); c.lineTo(q * 0.8, q * 0.8); c.lineTo(0, q * 0.35); c.lineTo(-q * 0.8, q * 0.8); c.closePath();
  c.fill(); c.stroke(); c.restore();
}
// World of DODO: the map reaches south far enough for the construction site (client/shared/site.js); the city is a little smaller
// and centred. The arena's map only: the original's stops, time windows, GAIA's route, your trail, the police and the hunting tanks
// are gone with the single-player game.
export function drawMap(ctx: CanvasRenderingContext2D, S: number, opt: MapOpt) {
  const site = window.WOD_SITE;
  const E = opt.air ? AIR_LIM : HALF + ROAD / 2 + 10, SZ = opt.air ? AIR_LIM : site ? site.area.z1 + 6 : E, sc = S / (E + SZ), ox = (S - 2 * E * sc) / 2;
  const mx = (x: number) => ox + (x + E) * sc, my = (z: number) => (z + E) * sc;
  ctx.fillStyle = '#3d4543'; ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = '#adb1b0'; ctx.fillRect(mx(-HALF - 7), my(-HALF - 7), (2 * HALF + 14) * sc, (2 * HALF + 14) * sc);
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
    const bx = blockC(i), bz = blockC(j), k = i + ',' + j;
    ctx.fillStyle = k === PARK_B.join(',') || k === PLAZA_B.join(',') ? '#00746a' : '#3d4543'; rr(ctx, mx(bx - 19), my(bz - 19), 38 * sc, 38 * sc, RC * sc); ctx.fill();
    if (k === DEPOT_B.join(',')) { ctx.strokeStyle = '#b2dcd6'; ctx.lineWidth = Math.max(1, 2 * sc * 2); ctx.strokeRect(mx(bx - 17), my(bz - 17), 34 * sc, 34 * sc); }
    if (k === RIVAL_B.join(',')) { ctx.strokeStyle = '#e03b3b'; ctx.lineWidth = Math.max(1, 2 * sc * 2); ctx.strokeRect(mx(bx - 17), my(bz - 17), 34 * sc, 34 * sc); }
  }
  if (site) {                                                     // World of DODO: the site's ground, and everything standing on it in its colour
    const A = site.area;
    ctx.fillStyle = '#797e7d'; ctx.fillRect(mx(A.x0), my(A.z0), (A.x1 - A.x0) * sc, (A.z1 - A.z0) * sc);
    for (const b of site.solids) {
      ctx.fillStyle = hexCss(b.color ?? 0);
      ctx.fillRect(mx(b.x0), my(b.z0), Math.max(1, (b.x1 - b.x0) * sc), Math.max(1, (b.z1 - b.z0) * sc));
    }
  }
  if (opt.air) {                                                  // the airfield out in the country (world/land.ts)
    const A = AIRFIELD, hx = Math.sin(A.h) * A.len / 2, hz = Math.cos(A.h) * A.len / 2;
    ctx.strokeStyle = '#adb1b0'; ctx.lineWidth = Math.max(2, A.w * sc); ctx.beginPath(); ctx.moveTo(mx(A.x - hx), my(A.z - hz)); ctx.lineTo(mx(A.x + hx), my(A.z + hz)); ctx.stroke();
  }
  const r = Math.max(6, S / 24);
  const dx = mx(depot.park[0]), dy = my(depot.park[1]); ctx.fillStyle = '#b2dcd6'; ctx.beginPath(); ctx.arc(dx, dy, r * 0.7, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#e03b3b'; ctx.beginPath(); ctx.arc(mx(RIVAL_PARK[0]), my(RIVAL_PARK[1]), r * 0.7, 0, Math.PI * 2); ctx.fill();   // REDLINE hall
  if (opt.others) {
    const t = now();
    for (const o of opt.others) {
      const age = t - (o.seenAt || -1e9); if (!o.on || age > SPOT_MS) continue;   // the other players: only once spotted,
      ctx.globalAlpha = o.seen ? 1 : Math.max(0.2, 1 - age / SPOT_MS);            // then their last seen place, fading
      ctx.fillStyle = hexCss(o.color); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5;
      if (o.k === 1) arrow(ctx, mx(o.seenX!), my(o.seenZ!), o.h, r * 0.7);
      else { ctx.beginPath(); ctx.arc(mx(o.seenX!), my(o.seenZ!), r * 0.62, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    }
    ctx.globalAlpha = 1;
  }
  if (opt.car) {
    const c = opt.car; ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#3d4543'; ctx.lineWidth = 1.5;
    arrow(ctx, Math.max(r, Math.min(S - r, mx(c.x))), Math.max(r, Math.min(S - r, my(c.z))), c.h, r * 0.9);
  }
}

export const mini = $<HTMLCanvasElement>('mini'), mctx = mini.getContext('2d')!;
// the canvas in device pixels (at most 2 per CSS pixel), as big as it is shown (small, or big after a click)
export function sizeMini() { const r = Math.min(window.devicePixelRatio || 1, 2), w = mini.clientWidth || 176; mini.width = w * r; mini.height = w * r; }
