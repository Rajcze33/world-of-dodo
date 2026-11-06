// World of DODO: what the server flies. The bots live here (server/bots.js, planebot.js, shipbot.js), so the server decides what hits
// them, and since issue #24 also what the bots' own fire hits: the other team's bots and supply depots (client/shared/rules.ts). A hit
// on a person is never decided here: their browser flies everyone's parcels, shells, torpedoes and the bots' bullets and decides it
// (docs/PROTOCOL.md); a person's hit on a depot is reported by their browser (thit, server/game.js checks it).
//
// - A person's parcel or shell (and, issue #24, torpedo) is tested against where each bot of the other team was when the shooter saw it
//   (its lag: the moment of the city the shooter's browser showed when firing, rt; 200 ms without it, at most 400): lag compensation, in
//   favour of the shooter.
// - A bot's parcel, shell, torpedo or bullet (issue #24) is tested against the other team's bots where they are, and against the other
//   team's depots.
// The flight is the game's: a parcel's gravity, bounce and roll (client/src/game/shots.ts: SHOT_G, SHOT_E), a shell's gravity (SHELL_G,
// client/src/game/shells.ts; it bursts on the ground, the water or a building), a torpedo running on the water (TORP_RUN, until a bank
// or a pier), a bullet straight (BUL_LIFE, client/src/game/bullets.ts). The hit shapes are the browsers': a tank's box (TANK_L, TANK_W,
// TANK_H), a plane's sphere (PLANE_R), a ship's box (shipBox, as game/shells.ts) and for a bullet its three spheres (SHIP_R).
// Issue #26: and Velemlok, when it is out (client/shared/monster.ts, its spheres): everything flown here stops on it, as in the browsers,
// and the server counts the bots' hits on it (the people report theirs, mhit).
'use strict';

const { solidAt, groundH, segHit, inArena } = require('./city');
const { surfaceY, inWater, WATER_Y } = require('../client/shared/naval.ts');
const { DEPOTS, depotAt } = require('../client/shared/rules.ts');
const { monSphHit, monSphSegT } = require('../client/shared/monster.ts');

const SHOT_G = 14, SHOT_E = 0.4, PARCEL_LIFE = 6;
const SHELL_G = 38, SHELL_LIFE = 8;                         // (SHELL_G: the same as client/src/game/shells.ts)
const TORP_RUN = 350, BUL_LIFE = 1.6;
const TANK_L = 2.4, TANK_W = 1.15, TANK_H = 2.1, TANK_R = 1.35, PLANE_R = 2.4, SHIP_R = 3;
const SHIP_HL = 11, SHIP_HW = 2.6, SHIP_HH = 3.8;
const PARCEL = 0, BULLET = 1, SHELL = 2, TORP = 3;

// a ship's hit box (game/shells.ts shipBox): sy its heave and sinking
function shipBox(x, y, z, sx, sy, sz, h) {
  const ly = y - (WATER_Y + sy); if (ly < -1.2 || ly >= SHIP_HH) return false;
  const hx = Math.sin(h), hz = Math.cos(h), dx = x - sx, dz = z - sz, a = dx * hx + dz * hz;
  if (a > SHIP_HL || a < -SHIP_HL) return false;
  const w = a > 6 ? SHIP_HW * (SHIP_HL - a) / (SHIP_HL - 6) + 0.2 : SHIP_HW;
  return Math.abs(dx * hz - dz * hx) < w;
}
// is (x, y, z) in the vehicle p ({kind, x, y, z, h}: a tank on the ground, a plane at y, a ship with its heave y)?
function inside(p, x, y, z) {
  if (p.kind === 1) { const dx = x - p.x, dy = y - p.y, dz = z - p.z; return dx * dx + dy * dy + dz * dz < PLANE_R * PLANE_R; }
  if (p.kind === 2) return shipBox(x, y, z, p.x, p.y, p.z, p.h);
  const gy = groundH(p.x, p.z);
  if (y < gy - 0.2 || y >= gy + TANK_H) return false;
  const hx = Math.sin(p.h), hz = Math.cos(p.h), dx = x - p.x, dz = z - p.z;
  return Math.abs(dx * hx + dz * hz) < TANK_L && Math.abs(dx * hz - dz * hx) < TANK_W;
}
// where along a → a + d (0..1) it first touches the sphere round c, or 2
function segSphere(ax, ay, az, dx, dy, dz, cx, cy, cz, r) {
  const fx = ax - cx, fy = ay - cy, fz = az - cz, a = dx * dx + dy * dy + dz * dz, b = fx * dx + fy * dy + fz * dz, c = fx * fx + fy * fy + fz * fz - r * r;
  if (c <= 0) return 0;
  const disc = b * b - a * c; if (disc < 0 || a < 1e-9) return 2;
  const t = (-b - Math.sqrt(disc)) / a; return t >= 0 && t <= 1 ? t : 2;
}
// a bullet's segment against a vehicle (game/bullets.ts vehicleT): a plane's sphere, a tank's two, a ship's three
function vehicleT(ax, ay, az, dx, dy, dz, p) {
  if (p.kind === 1) return segSphere(ax, ay, az, dx, dy, dz, p.x, p.y, p.z, PLANE_R);
  const hx = Math.sin(p.h), hz = Math.cos(p.h);
  if (p.kind === 2) {
    const cy = WATER_Y + p.y + 1.6; let t = 2;
    for (const j of [-7, 0, 7]) t = Math.min(t, segSphere(ax, ay, az, dx, dy, dz, p.x + hx * j, cy, p.z + hz * j, SHIP_R));
    return t;
  }
  const gy = groundH(p.x, p.z) + 1.1;
  return Math.min(segSphere(ax, ay, az, dx, dy, dz, p.x + hx * 1.2, gy, p.z + hz * 1.2, TANK_R), segSphere(ax, ay, az, dx, dy, dz, p.x - hx * 1.2, gy, p.z - hz * 1.2, TANK_R));
}
// where a bullet's segment a → a + d (0..1) enters depot D (radius r, up to its top), or 2
function depotT(ax, ay, az, dx, dy, dz, D) {
  const fx = ax - D.x, fz = az - D.z, a = dx * dx + dz * dz, b = fx * dx + fz * dz, c = fx * fx + fz * fz - D.r * D.r;
  let t;
  if (c <= 0) t = 0;
  else { const disc = b * b - a * c; if (disc < 0 || a < 1e-9) return 2; t = (-b - Math.sqrt(disc)) / a; if (t < 0 || t > 1) return 2; }
  return ay + dy * t <= D.y + D.h ? t : 2;
}

// One step of every projectile in list (removed when it is done). s: { k (0 parcel, 1 bullet, 2 shell, 3 torpedo), by, team, sid, bot
// (fired by a bot), x, y, z, vx, vy, vz, age, lag (ms; a person's), run (a torpedo's) }.
// targets(lag): the bots as { b, kind, team, x, y, z, h } where they were lag ms ago (the living ones that can be hit); onBot(b, s) when
// s reaches bot b of another team, onDepot(i, s) when a bot's s reaches depot i of another team. Issue #26: mon, Velemlok while it is
// out ({ x, z, sph: its spheres this tick (monster.ts monSpheres), hit(s) when s reaches it }), or null. Returns nothing.
function fly(list, dt, targets, onBot, onDepot, mon = null) {
  MON = mon;
  const cache = new Map();                                  // lag -> the bots then (the people's shots share a few lags)
  const at = lag => { const k = Math.round(lag / 25); let v = cache.get(k); if (!v) { v = targets(k * 25); cache.set(k, v); } return v; };
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i], foes = at(s.bot ? 0 : (s.lag ?? 200)).filter(p => p.team !== s.team);
    let alive = s.k === TORP ? torpStep(s, dt, foes, onBot) : s.k === BULLET ? bulletStep(s, dt, foes, onBot, onDepot) : ballStep(s, dt, foes, onBot, onDepot);
    if (alive) s.age += dt;
    if (!alive || s.age > (s.k === SHELL ? SHELL_LIFE : s.k === BULLET ? BUL_LIFE : s.k === TORP ? 30 : PARCEL_LIFE)) list.splice(i, 1);
  }
}
// issue #26: Velemlok this step (or null), and is (x, y, z) in it? (a quick box round its body first: its spheres reach about 35 from
// the middle of its body and 30 over the water)
let MON = null;
const MON_BOX = 42;
const inMon = (x, y, z) => MON !== null && Math.abs(x - MON.x) < MON_BOX && Math.abs(z - MON.z) < MON_BOX && y < WATER_Y + 32 && monSphHit(MON.sph, x, y, z);
// a bot's projectile that came down (or burst) at x, y, z: on a depot of the other team?
function depotHit(s, x, y, z, onDepot) {
  if (!s.bot) return false;
  const i = depotAt(x, y, z, s.k === SHELL ? 2 : 0);
  if (i < 0 || DEPOTS[i].team === s.team) return false;
  onDepot(i, s); return true;
}
// a parcel or a shell: gravity, the buildings, the ground or the river; a parcel bounces and rolls (a shell bursts)
function ballStep(s, dt, foes, onBot, onDepot) {
  const shell = s.k === SHELL, n = Math.max(1, Math.ceil(Math.hypot(s.vx, s.vy, s.vz) * dt / 0.4)), h = dt / n;
  for (let k = 0; k < n; k++) {
    s.vy -= (shell ? SHELL_G : SHOT_G) * h; s.x += s.vx * h; s.y += s.vy * h; s.z += s.vz * h;
    if (Math.abs(s.x) > 800 || Math.abs(s.z) > 800) return false;
    if (solidAt(s.x, s.y, s.z)) { depotHit(s, s.x, s.y, s.z, onDepot); return false; }   // a building stops it (in the game a parcel bounces off)
    if (inMon(s.x, s.y, s.z)) { MON.hit(s); return false; }
    for (const p of foes) if ((!shell || p.kind !== 1) && inside(p, s.x, s.y, s.z)) { onBot(p.b, s); return false; }   // (shells fly through planes)
    if (depotHit(s, s.x, s.y, s.z, onDepot)) return false;
    const g = surfaceY(s.x, s.z), wet = g === WATER_Y && !inArena(s.x, s.z);
    if (shell || wet) { if (s.y < g) return false; continue; }  // a shell bursts where it lands; a parcel sinks in the river
    // the ground as in the game (client/src/game/shots.ts): the street, the pavement, the terrain outside the arena
    const gy = (g > 0 ? g : g + 0.04) + 0.25;
    if (s.y < gy) {
      s.y = gy;
      if (s.vy < 0) { s.vy = -s.vy * SHOT_E; s.vx *= 0.78; s.vz *= 0.78; if (s.vy < 1.8) s.vy = 0; }
      if (s.vy === 0) { const f = Math.max(0, 1 - 4 * h); s.vx *= f; s.vz *= f; if (Math.hypot(s.vx, s.vz) < 0.4) return false; }
    }
  }
  return true;
}
// a torpedo: along the water at its speed until it hits a ship of the other team, a bank or a pier, or its run is over
function torpStep(s, dt, foes, onBot) {
  const l = Math.hypot(s.vx, s.vz); if (l < 1) return false;
  const n = Math.max(1, Math.ceil(l * dt / 1.2)), d = l * dt / n, hx = s.vx / l, hz = s.vz / l;
  for (let k = 0; k < n; k++) {
    s.x += hx * d; s.z += hz * d; s.run = (s.run || 0) + d;
    if (!inWater(s.x, s.z, 0.3) || s.run >= TORP_RUN) return false;
    if (inMon(s.x, WATER_Y + 0.3, s.z)) { MON.hit(s); return false; }
    for (const p of foes) if (p.kind === 2 && shipBox(s.x, WATER_Y + 0.3, s.z, p.x, p.y, p.z, p.h)) { onBot(p.b, s); return false; }
  }
  return true;
}
// a bullet: straight, stopped by the first building, the ground or the water, a vehicle of the other team or (a bot's) a depot
function bulletStep(s, dt, foes, onBot, onDepot) {
  const dx = s.vx * dt, dy = s.vy * dt, dz = s.vz * dt;
  let t = segHit(s.x, s.y, s.z, s.x + dx, s.y + dy, s.z + dz), who = null, dep = -1, mon = false;
  const ge = surfaceY(s.x + dx, s.z + dz) + 0.05;
  if (s.y + dy < ge) { const u = dy < 0 ? Math.max(0, (s.y - ge) / -dy) : 0; if (u < t) t = u; }
  const ex = s.x + dx / 2, ez = s.z + dz / 2, reach = Math.hypot(dx, dz) / 2 + 14;
  for (const p of foes) {
    if (Math.abs(p.x - ex) > reach || Math.abs(p.z - ez) > reach) continue;
    const u = vehicleT(s.x, s.y, s.z, dx, dy, dz, p); if (u < t) { t = u; who = p; }
  }
  if (s.bot) for (const D of DEPOTS) {
    if (D.team === s.team || Math.abs(D.x - ex) > reach || Math.abs(D.z - ez) > reach) continue;
    const u = depotT(s.x, s.y, s.z, dx, dy, dz, D); if (u < t) { t = u; who = null; dep = D.i; }
  }
  if (MON !== null && Math.abs(MON.x - ex) < reach + MON_BOX && Math.abs(MON.z - ez) < reach + MON_BOX) {
    const u = monSphSegT(MON.sph, s.x, s.y, s.z, s.x + dx, s.y + dy, s.z + dz); if (u < t) { t = u; who = null; dep = -1; mon = true; }
  }
  s.x += dx * Math.min(1, t); s.y += dy * Math.min(1, t); s.z += dz * Math.min(1, t);
  if (t >= 1) return true;
  if (mon) MON.hit(s); else if (who) onBot(who.b, s); else if (dep >= 0) onDepot(dep, s);
  return false;
}

module.exports = { fly, shipBox, inside, vehicleT, segSphere, PARCEL, BULLET, SHELL, TORP, SHOT_G, SHELL_G, PLANE_R };
