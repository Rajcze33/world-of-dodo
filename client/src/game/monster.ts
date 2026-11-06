// ---------- World of DODO, issue #26: Velemlok, as this browser knows it ----------
// Velemlok, a colossal river salamander (world/monster.ts draws it), comes up in the Vltava once in a while and both teams fight it:
// the team that deals more damage gets the bonus when it leaves. The server decides everything about it (server/monster.js, the rules
// in client/shared/monster.ts, docs/PROTOCOL.md); this module keeps what the server said and acts on it here:
// - its state (obj.g, once a second and at once on a change: away, surfacing, out, leaving; its hit points, the damage of each team,
//   the moment of its next appearance or of its leaving) and its pose (snap.g, 20 times a second while it is in the water), drawn
//   INTERP ms behind the server's clock between the two rows round that moment, as the other players are (net/net.ts);
// - my projectiles that hit it (game/shots.ts, bullets.ts, shells.ts ask monBody / monSeg, the hitbox of client/shared/monster.ts at
//   the pose drawn here): every projectile bursts on it on every screen, mine I report (mhit), the server checks it and counts it;
// - its attacks (mon): drawn as announced (world/monster.ts), and the moment one lands this browser decides whether it hit my own
//   vehicle (monAtkHits, the same test the server makes for the bots) and applies it (game/tank.ts hitPlayer, kind 'mon'; it scores
//   for nobody, so nothing goes back to the server);
// - the result (mres) and the toasts when it surfaces and leaves (ui/monhud.ts shows the HUD).
import { WATER_Y } from '../../shared/naval.ts';
import { MON_HP, monSpheres, monSphHit, monSphSegT, monAtkHits, type MonAtk, type MonPose } from '../../shared/monster.ts';
import { r2, angLerp, now } from '../core/util';
import { T } from '../texts';
import { G, car } from './state';
import { NET, netSend, serverNow, INTERP } from '../net/net';
import { hitPlayer } from './tank';
import { sh } from './ship';
import { flash } from '../ui/hud';
import { drawMonster, monAtkFx, monSparkFx, updateMonFx, clearMonFx } from '../world/monster';
import { showMonResult, type MonRes } from '../ui/monhud';

// what the server said and what is drawn: st 0 away, 1 surfacing, 2 out, 3 leaving (diving, or sinking when killed); hp, max its hit
// points; dmg the damage of team A and B in this appearance; next the server's time of its next appearance (away) or of its leaving;
// known: an obj.g came. on: drawn now, at pose (with its row's st and hp as drawn, its speed v); sph: the hitbox at that pose (the
// projectiles' tests); res: the last result and when it came
export const MON = {
  st: 0, hp: MON_HP, max: MON_HP, dmg: [0, 0], next: 0, known: false,
  on: false, pose: { x: 0, z: 0, h: 0, y: -16, rear: 0 } as MonPose, dst: 0, dhp: MON_HP, v: 0,
  sph: monSpheres({ x: 0, z: 0, h: 0, y: -100, rear: 0 }),
  res: null as MonRes | null, resAt: -1e9, hitAt: -1e9,
  lastAtk: '' as string, lastAtkAt: 0,                 // the last attack announced and when it lands (the tests)
};

// ---------- the server's word ----------
interface MRow { t: number; x: number; z: number; h: number; y: number; st: number; hp: number; rear: number }
const ROWS: MRow[] = [];
// snap.g at server time ts: [x, z, h, y, st, hp, rear]
export function monSnap(g: unknown, ts: unknown) {
  if (!Array.isArray(g) || g.length < 7 || typeof ts !== 'number') return;
  if (ROWS.length && ts <= ROWS[ROWS.length - 1].t) return;
  ROWS.push({ t: ts, x: +g[0] || 0, z: +g[1] || 0, h: +g[2] || 0, y: +g[3] || 0, st: g[4] | 0, hp: +g[5] || 0, rear: +g[6] || 0 });
  if (ROWS.length > 50) ROWS.shift();
}
// obj.g: {st, hp, max, dmg: [a, b], next}; first: the state at the welcome (no toasts)
export function monObj(g: unknown, first = false) {
  if (!g || typeof g !== 'object') return;
  const o = g as { st?: number; hp?: number; max?: number; dmg?: number[]; next?: number };
  const was = MON.known ? MON.st : 0, st = o.st === 1 || o.st === 2 || o.st === 3 ? o.st : 0;
  MON.st = st; MON.known = true;
  if (Number(o.max) > 0) MON.max = Number(o.max);
  MON.hp = Math.max(0, Number(o.hp) || 0);
  if (Array.isArray(o.dmg)) MON.dmg = [Number(o.dmg[0]) || 0, Number(o.dmg[1]) || 0];
  MON.next = Number(o.next) || 0;
  if (first) return;
  if (was === 0 && (st === 1 || st === 2)) flash(T.monUp);                       // it came up: a toast for everyone
  else if (was !== 0 && st === 0 && now() - MON.resAt > 15000) flash(T.monGone);  // it went without a result (should not happen)
}
// mon: an attack announced (client/shared/monster.ts MonAtk): drawn from now, applied to my vehicle when it lands
const ATKS: (MonAtk & { done: boolean })[] = [];
export function monAttack(m: unknown) {
  const A = m as MonAtk;
  if (!A || (A.a !== 'slam' && A.a !== 'jet' && A.a !== 'geyser') || ![A.x, A.y, A.z, A.r, A.at].every(Number.isFinite)) return;
  if (A.a === 'jet' && ![A.t0, A.sx, A.sy, A.sz, A.vx, A.vy, A.vz].every(Number.isFinite)) return;
  ATKS.push({ ...A, done: false }); if (ATKS.length > 16) ATKS.shift();
  MON.lastAtk = A.a; MON.lastAtkAt = A.at;
  monAtkFx(A);
}
// mres: it left: {killed, dmg: [a, b], win: -1 | 0 | 1, pts, top: [[id, dmg], ...], end?}
export function monResult(m: unknown) {
  const r = m as MonRes; if (!r || !Array.isArray(r.dmg)) return;
  MON.res = r; MON.resAt = now();
  showMonResult(r);
}
// a new connection or back to the menu: nothing known, nothing drawn
export function monReset() {
  ROWS.length = 0; ATKS.length = 0;
  Object.assign(MON, { st: 0, hp: MON_HP, max: MON_HP, dmg: [0, 0], next: 0, known: false, on: false, res: null, resAt: -1e9 });
  MON.pose.y = -100; monSpheres(MON.pose, MON.sph);
  drawMonster(null, 0, 0); clearMonFx();
}

// ---------- every frame ----------
// the pose at server time R from the rows (between the two round it; the newest one held for a moment past it), into MON; false: it is
// not in the water (no rows, or the newest is older than a moment)
function poseAt(R: number): boolean {
  const n = ROWS.length; if (!n || R > ROWS[n - 1].t + 400) return false;
  let i = n - 1; while (i > 0 && ROWS[i].t > R) i--;
  const a = ROWS[i], c = ROWS[i + 1], p = MON.pose;
  if (!c || R <= a.t) { p.x = a.x; p.z = a.z; p.h = a.h; p.y = a.y; p.rear = a.rear; MON.dst = a.st; MON.dhp = a.hp; MON.v = 0; return true; }
  const k = (R - a.t) / (c.t - a.t);
  p.x = a.x + (c.x - a.x) * k; p.z = a.z + (c.z - a.z) * k; p.h = angLerp(a.h, c.h, k); p.y = a.y + (c.y - a.y) * k; p.rear = a.rear + (c.rear - a.rear) * k;
  const b = k < 0.5 ? a : c; MON.dst = b.st; MON.dhp = b.hp;
  MON.v = Math.hypot(c.x - a.x, c.z - a.z) / Math.max(0.001, (c.t - a.t) / 1000);
  return true;
}
const DRAW = { x: 0, z: 0, h: 0, y: 0, rear: 0, st: 0, hp: 0, v: 0 };
// main.ts calls this before the projectiles fly: the pose, the hitbox, the model, its attacks
export function monStep(dt: number) {
  if (NET.off === null || !NET.inGame) { if (MON.on) { MON.on = false; drawMonster(null, dt, 0); } return; }
  const sn = serverNow();
  MON.on = poseAt(sn - INTERP);
  if (MON.on) {
    monSpheres(MON.pose, MON.sph);
    Object.assign(DRAW, MON.pose); DRAW.st = MON.dst; DRAW.hp = MON.dhp; DRAW.v = MON.v;
    drawMonster(DRAW, dt, sn);
  } else { MON.pose.y = -100; monSpheres(MON.pose, MON.sph); drawMonster(null, dt, sn); }
  for (const A of ATKS) if (!A.done && sn >= A.at) { A.done = true; strike(A); }
  while (ATKS.length && ATKS[0].done && sn > ATKS[0].at + 4000) ATKS.shift();
  updateMonFx(dt, sn);
}
// an attack that lands now: does it hit my vehicle (as the server decides for the bots)? A slam also rocks my ship nearby.
function strike(A: MonAtk) {
  if (G.state !== 'drive' || car.topT > 0) return;
  const y = car.k === 1 ? car.y : car.k === 2 ? WATER_Y + car.y : car.gy;
  const dx = car.x - A.x, dz = car.z - A.z, d = Math.hypot(dx, dz);
  // which side it came from (for the way a ship lists, a tank lies): the attack's middle to my left or right
  const side = dx * Math.cos(car.h) - dz * Math.sin(car.h) > 0 ? -1 : 1;
  if (A.a === 'slam' && car.k === 2 && d < A.r + 14) sh.heel += side * 0.22 * (1 - d / (A.r + 14));   // the wave rocks the ship
  if (!monAtkHits(A, car.k, car.x, y, car.z)) return;
  if (hitPlayer('mon', side, T.monHitYou[A.a]) && car.topT > 0) flash(T.monKilledYou);
}

// ---------- my projectiles and everyone's ----------
// Whether something at (x, y, z) is in it now (its hitbox at the pose drawn here): a quick test of the box round it first.
// (Every projectile stops on it on every screen; whose it was decides whether this browser reports it.)
export function monBody(x: number, y: number, z: number): boolean {
  if (!MON.on || MON.pose.y < -10) return false;
  const p = MON.pose;
  if (Math.abs(x - p.x) > 42 || Math.abs(z - p.z) > 42 || y > WATER_Y + p.y + 30 || y < WATER_Y + p.y - 12) return false;
  return monSphHit(MON.sph, x, y, z);
}
// where along the segment a → b (0..1) a bullet first enters it, or 2
export function monSeg(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  if (!MON.on || MON.pose.y < -10) return 2;
  const p = MON.pose, l = Math.abs(bx - ax) + Math.abs(bz - az);
  if (Math.abs(ax - p.x) > 42 + l || Math.abs(az - p.z) > 42 + l) return 2;
  return monSphSegT(MON.sph, ax, ay, az, bx, by, bz);
}
// my projectile sid of kind k (0 a parcel, 1 a bullet, 2 a shell, 3 a torpedo) hit it at (x, y, z): the server checks it and counts
// the damage for my team (only while it can be hurt: surfacing or out; not in the break after a round). A toast now and then.
export function monReport(k: number, sid: number, x: number, y: number, z: number) {
  if (!sid || G.hold || MON.dhp <= 0 || !(MON.dst === 1 || MON.dst === 2)) return;
  netSend({ t: 'mhit', k, sid, x: r2(x), y: r2(y), z: r2(z) });
  if (k !== 1 && now() - MON.hitAt > 2500) { MON.hitAt = now(); flash(T.monHitIt); }
}
// a projectile burst on it at (x, y, z): the sparks (k as above; a bullet's are small)
export function monSpark(x: number, y: number, z: number, k: number) { monSparkFx(x, y, z, k !== 1); }

// ---------- for the HUD and the minimap ----------
// the seconds to its next appearance (away) or to its leaving (out); NaN unknown
export const monLeft = () => MON.known && MON.next > 0 && NET.off !== null ? (MON.next - serverNow()) / 1000 : NaN;
// where to mark it on the minimap: while it is drawn and its back is near the surface
export const monMapPose = () => (MON.on && MON.pose.y > -12 ? MON.pose : null);
