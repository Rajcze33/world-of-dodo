// ---------- World of DODO, issue #24: the objectives in the city ----------
// The three ground zones and the river zone (client/shared/rules.ts ZONES) are a ring on the ground (on the water) in the colour of the
// team that holds the zone, a faint disc inside it, and a flag pole in the middle (on the river a buoy): its flag climbs as a team
// captures the zone and takes that team's colour (white while the capture stands at nothing). The eight supply depots (DEPOTS, four a
// team in its own half) are a concrete pad with two fuel tanks lying on cradles, a stack of crates, a pallet, two barrels and a pole
// with the team's flag; destroyed, a smoking ruin (charred, flattened tanks, scattered crates, the pole snapped) until it is rebuilt. A
// damaged depot smokes a little. game/teams.ts keeps the state from the server (TM); this module draws it every frame.
//
// None of it draws random numbers from the city's seed (core/util.ts R): the city stays the same for everyone.
//
// What hits a depot (docs/PROTOCOL.md, thit): its body is an upright cylinder of the depot's radius r and height h standing on the
// ground. A parcel or a shell that reaches it bursts there on every screen, a bullet stops in it; only the shooter's browser reports it
// (game/shots.ts, shells.ts, bullets.ts), and only for a standing depot of the other team: the server decides the damage. A standing
// depot is solid for your tank (a circle a little inside its radius) and for your plane.
import { TransformNode, type Mesh, type StandardMaterial } from '@babylonjs/core';
import { scene, camera } from '../core/engine';
import { Bucket, addGeo, boxGeo, cylGeo, sphereGeo, quad, translate, rotateX, rotateY, rotateZ, scaleGeo, geoMesh, type Geo, type P3 } from '../core/geo';
import { VC_MAT, VC_GLOW, basic, lambert } from '../core/mat';
import { c3 } from '../core/colors';
import { groundH } from '../../shared/map.ts';
import { WATER_Y } from '../../shared/naval.ts';
import { ZONES, DEPOTS, DEPOT_HP, DEPOT_SOLID, TEAM_COL, depotAt as ruleDepot } from '../../shared/rules.ts';
import { TM, teamMat, zoneP } from '../game/teams';
import { burst, puff, glow } from '../game/shells';
import { startImpactFx } from '../game/fx';

const NEUTRAL = 0xeaebeb;                                     // a zone nobody holds: its ring and its flag
// the ground under a depot's model (rules.ts gives its y, the pavement's 0.3; the pad reaches down to the street's 0 under it)
const DG = DEPOTS.map(d => Math.min(d.y, groundH(d.x, d.z)));

// ---------- the zones ----------
interface ZoneView { ring: StandardMaterial; disc: StandardMaterial; flag: StandardMaterial; fn: TransformNode; lo: number; hi: number; col: number; fcol: number }
const ZV: ZoneView[] = [];
// a flat annulus from r0 to r1 round (cx, cz) in segs steps, its points at the height y(x, z): it follows the street, the kerb and the
// pavement under it (a flat ring would float over the street or sink into the pavement)
function annulus(bk: Geo, cx: number, cz: number, r0: number, r1: number, segs: number, y: (x: number, z: number) => number) {
  const P = (r: number, a: number): P3 => { const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r; return [x, y(x, z), z]; };
  for (let k = 0; k < segs; k++) {
    const a0 = k / segs * Math.PI * 2, a1 = (k + 1) / segs * Math.PI * 2;
    quad(bk, P(r0, a0), P(r0, a1), P(r1, a1), P(r1, a0), 0xffffff);    // seen from above (the materials draw both sides anyway)
  }
}
function buildZones() {
  for (const zn of ZONES) {
    const yAt = zn.sea ? () => WATER_Y + 0.12 : (x: number, z: number) => groundH(x, z) + 0.08;
    const ring = basic(NEUTRAL, { transparent: true, opacity: 0.7, depthWrite: false, double: true });
    const disc = basic(NEUTRAL, { transparent: true, opacity: 0.1, depthWrite: false, double: true });
    const rg = Bucket(); annulus(rg, zn.x, zn.z, zn.r - 1.1, zn.r, 96, yAt);
    const dg = Bucket(); for (let k = 0; k < 6; k++) annulus(dg, zn.x, zn.z, (zn.r - 1.1) * k / 6, (zn.r - 1.1) * (k + 1) / 6, 64, yAt);
    geoMesh('zoneRing', rg, ring, false, false); geoMesh('zoneDisc', dg, disc, false, false);
    // the pole (on the river a buoy carries it), a lamp on its top; the flag on a node that climbs it
    const g0 = zn.sea ? WATER_Y : groundH(zn.x, zn.z), H = zn.sea ? 7 : 11, pole = Bucket(), lamp = Bucket();
    if (zn.sea) { addGeo(pole, translate(cylGeo(1.3, 1.6, 2.2, 14), 0, 0.5, 0), null, 0xc0524a); addGeo(pole, translate(cylGeo(1.33, 1.33, 0.5, 14), 0, 1.0, 0), null, 0xeaebeb); }
    else addGeo(pole, translate(cylGeo(0.55, 0.7, 0.45, 12), 0, 0.22, 0), null, 0x555c5a);
    addGeo(pole, translate(cylGeo(0.1, 0.13, H, 8), 0, H / 2, 0), null, 0xd6d8d7);
    addGeo(lamp, translate(sphereGeo(0.26, 8, 6), 0, H + 0.2, 0), null, 0xffffff);
    const pn = new TransformNode('zonePole', scene); pn.position.set(zn.x, g0, zn.z);
    geoMesh('zonePoleParts', pole, VC_MAT, true, true).parent = pn; geoMesh('zonePoleLamp', lamp, VC_GLOW, false, false).parent = pn;
    const flag = lambert(NEUTRAL, { emissive: NEUTRAL, emissiveIntensity: 0.35, double: true });
    const fn = new TransformNode('zoneFlag', scene); fn.parent = pn;
    geoMesh('zoneFlagCloth', translate(boxGeo(0.06, 1.7, 2.8), 0, 0, 1.5), flag, true, false).parent = fn;
    ZV.push({ ring, disc, flag, fn, lo: zn.sea ? 2.4 : 1.6, hi: H - 1.0, col: -2, fcol: -2 });
  }
}
const colOf = (t: number) => t === 0 || t === 1 ? TEAM_COL[t] : NEUTRAL;
function drawZones(tnow: number) {
  ZONES.forEach((zn, i) => {
    const v = ZV[i], own = TM.z[i] ? TM.z[i][0] : -1, p = zoneP(i), lean = p > 0.5 ? 0 : p < -0.5 ? 1 : -1;
    if (own !== v.col) {                                     // the ring in its owner's colour, brighter once held
      v.col = own; const c = c3(colOf(own)); v.ring.emissiveColor = c; v.disc.emissiveColor = c;
      v.ring.alpha = own >= 0 ? 0.85 : 0.6; v.disc.alpha = own >= 0 ? 0.16 : 0.08;
    }
    if (lean !== v.fcol) { v.fcol = lean; const c = c3(colOf(lean)); v.flag.diffuseColor = c; v.flag.emissiveColor = c.scale(0.4); }
    v.fn.position.y = v.lo + (v.hi - v.lo) * Math.min(1, Math.abs(p) / 100);
    v.fn.rotation.y = Math.sin(tnow * 0.0011 + i * 1.7) * 0.35 - 0.6;   // it stirs in the wind
  });
}

// ---------- the depots ----------
interface DepotView { node: TransformNode; up: Mesh[]; ruin: Mesh; hp: number; smokeT: number }
const DV: DepotView[] = [];
const WOOD = 0x9a7448, CONC = 0x8d9593, TANKC = 0xd6d8d7, DARK = 0x2b3130, CHAR = 0x24221f;
// a depot's model, its middle on the origin, along +z (the node turns it by the depot's rot), scaled to its radius (built for 4)
function depotModel(s: number): { up: Geo; team: Geo; ruin: Geo } {
  const up = Bucket(), team = Bucket(), ruin = Bucket();
  const put = (bk: Geo, g: Geo, x: number, y: number, z: number, col: number) => addGeo(bk, translate(g, x * s, y, z * s), null, col);
  const along = (g: Geo) => rotateZ(g, Math.PI / 2);                                   // a cylinder lying along x
  put(up, boxGeo(8.2 * s, 0.24, 8.2 * s), 0, 0.12, 0, CONC);                           // the pad
  for (const z of [-2.0, 0.5]) {                                                       // two fuel tanks on cradles, a band in the team's colour
    put(up, along(cylGeo(1.05, 1.05, 5.0 * s, 16)), -0.6, 1.45, z, TANKC);
    put(up, along(cylGeo(0.75, 0.75, 5.1 * s, 16)), -0.6, 1.45, z, 0x9aa19f);
    for (const x of [-2.2, 1.0]) put(up, boxGeo(0.35, 0.62, 1.9), x, 0.55, z, DARK);
    put(team, along(cylGeo(1.09, 1.09, 0.55, 16)), 0.9, 1.45, z, 0xffffff);
    put(up, boxGeo(0.25, 1.4, 0.25), -3.2, 1.55, z, DARK);                            // a pipe up to the valve
    put(ruin, rotateY(scaleGeo(along(cylGeo(1.05, 1.05, 4.6 * s, 10)), 1, 0.5, 1), z * 0.07), -0.4, 0.62, z + 0.2, CHAR);
  }
  for (const [x, y, z] of [[1.7, 0.85, 2.7], [2.95, 0.85, 2.7], [2.3, 2.05, 2.7], [2.95, 0.85, 1.45]]) put(up, boxGeo(1.2, 1.2, 1.2), x, y, z, WOOD);
  put(team, boxGeo(1.24, 1.24, 0.16), 2.3, 2.05, 2.7, 0xffffff);                      // a strap round the top crate
  put(up, boxGeo(1.4, 0.16, 1.2), -2.7, 0.32, 2.8, 0x6e5434);                          // a pallet, two barrels
  for (const [x, z] of [[-3.1, 2.4], [-2.4, 3.2]]) put(up, cylGeo(0.36, 0.36, 1.0, 10), x, 0.74, z, 0x4d6b8a);
  put(up, cylGeo(0.08, 0.08, 7.6, 6), 3.5, 3.8, -3.4, DARK);                          // the flag pole and the flag
  put(team, boxGeo(0.07, 1.4, 2.4), 3.5, 6.9, -2.2, 0xffffff);
  // the ruin: a scorched pad, the flattened tanks, crates thrown about, the pole snapped
  put(ruin, boxGeo(8.2 * s, 0.22, 8.2 * s), 0, 0.11, 0, 0x4a4f4e);
  put(ruin, boxGeo(6.4 * s, 0.04, 6.0 * s), -0.3, 0.24, -0.4, 0x1c1e1d);
  for (const [x, z, a, t] of [[1.6, 2.6, 0.5, 0.3], [3.0, 1.2, 1.1, -0.4], [-1.0, 3.3, 0.2, 0.6], [2.6, -1.4, 0.9, 0.2], [-3.2, -3.0, 0.4, -0.3]]) {
    put(ruin, rotateX(rotateY(boxGeo(1.1, 1.1, 1.1), a), t), x, 0.6, z, 0x4a3a2a);
  }
  put(ruin, rotateZ(cylGeo(0.07, 0.07, 2.4, 6), 0.55), 3.0, 1.1, -3.4, DARK);
  return { up, team, ruin };
}
function buildDepots() {
  for (const d of DEPOTS) {
    const node = new TransformNode('depot', scene); node.position.set(d.x, DG[d.i], d.z); node.rotation.y = d.rot;
    const m = depotModel(d.r / 4);
    const up = [geoMesh('depotParts', m.up, VC_MAT, true, true), geoMesh('depotTeam', m.team, teamMat(d.team), true, true)];
    const ruin = geoMesh('depotRuin', m.ruin, VC_MAT, true, true);
    for (const x of [...up, ruin]) x.parent = node;
    ruin.setEnabled(false);
    DV.push({ node, up, ruin, hp: DEPOT_HP, smokeT: 0 });
  }
}
// a depot's state from the server (TM.d) on the screen: a hit flashes and puffs, a destroyed one blows up and becomes a ruin that
// smokes, a rebuilt one stands again; a damaged one smokes a little. Smoke only near the camera (the puffs are a shared pool).
function drawDepots(dt: number) {
  const c = camera.position;
  DEPOTS.forEach((d, i) => {
    const v = DV[i], hp = TM.d[i] ? TM.d[i][0] : DEPOT_HP, y = DG[i];
    if (hp !== v.hp) {
      if (hp <= 0 && v.hp > 0) { startImpactFx(d.x, d.z, 0.9, 0.8, y); burst(d.x, y + 1.5, d.z, 2.2); }
      else if (hp < v.hp) { burst(d.x + (Math.random() - 0.5) * d.r, y + 1.4, d.z + (Math.random() - 0.5) * d.r, 1.1); }
      const was = v.hp > 0; v.hp = hp;
      if (was !== hp > 0) { for (const m of v.up) m.setEnabled(hp > 0); v.ruin.setEnabled(hp <= 0); }
    }
    if (hp >= DEPOT_HP || Math.abs(c.x - d.x) > 420 || Math.abs(c.z - d.z) > 420) return;
    if ((v.smokeT -= dt) > 0) return;
    const ruin = hp <= 0, k = ruin ? 1 : 1 - hp / DEPOT_HP;
    v.smokeT = ruin ? 0.22 : 1.2 - 0.8 * k;
    const ox = (Math.random() - 0.5) * d.r * 1.2, oz = (Math.random() - 0.5) * d.r * 1.2;
    puff(d.x + ox, y + (ruin ? 1.0 : 2.2), d.z + oz, ruin ? 2.0 : 1.2 + k, ruin ? 3.2 : 2.4, ruin ? 2.2 : 1.6, 0.6, 0.3);
    if (ruin && Math.random() < 0.35) glow(d.x + ox * 0.6, y + 0.8, d.z + oz * 0.6, 1.4, 0.4);   // embers
  });
}

// ---------- hits and bodies ----------
// What counts as a hit is client/shared/rules.ts depotAt, the server's own test: a parcel or a shell where it comes down within
// r + DEPOT_NEAR of a depot's middle and no higher than its top (y + h), a bullet where it enters it (radius r). Here only the
// standing depots count, and never the shooter's own team's.
const standing = (i: number) => !TM.d[i] || TM.d[i][0] > 0;
// the standing depot whose body (an upright cylinder of radius r up to y + h) a parcel or a shell at (x, y, z) runs into, or -1: it
// bursts there on every screen
export function depotBody(x: number, y: number, z: number): number {
  for (const d of DEPOTS) {
    if (!standing(d.i)) continue;
    const dx = x - d.x, dz = z - d.z;
    if (dx * dx + dz * dz < d.r * d.r && y < d.y + d.h && y > d.y - 1.5) return d.i;
  }
  return -1;
}
// the standing depot of the other team than team that a projectile of kind k (0 a parcel, 1 a bullet, 2 a shell) coming down at
// (x, y, z) hits by the rules, or -1
export function depotHitAt(x: number, y: number, z: number, k: number, team: number): number {
  const i = ruleDepot(x, y, z, k);
  return i >= 0 && standing(i) && DEPOTS[i].team !== team ? i : -1;
}
// where along the segment from a by d (t 0..1) a bullet first enters a standing depot (its side, or its top from above): DSEG, or null
const DSEG = { i: -1, t: 2 };
export function depotSeg(ax: number, ay: number, az: number, dx: number, dy: number, dz: number): typeof DSEG | null {
  DSEG.i = -1; DSEG.t = 2;
  for (const d of DEPOTS) {
    if (!standing(d.i)) continue;
    const fx = ax - d.x, fz = az - d.z, y0 = d.y - 1.5, y1 = d.y + d.h, a = dx * dx + dz * dz, b = fx * dx + fz * dz, c = fx * fx + fz * fz - d.r * d.r;
    if (Math.abs(fx) > d.r + Math.abs(dx) + 1 || Math.abs(fz) > d.r + Math.abs(dz) + 1) continue;
    let t = 2;
    if (c <= 0) { if (ay >= y0 && ay <= y1) t = 0; }                                   // starts inside the circle, within the height
    else if (a > 1e-9) {
      const disc = b * b - a * c;
      if (disc >= 0) { const u = (-b - Math.sqrt(disc)) / a, y = ay + dy * u; if (u >= 0 && u <= 1 && y >= y0 && y <= y1) t = u; }
    }
    if (t > 1 && dy < 0 && ay > y1) {                                                  // in through the top
      const u = (y1 - ay) / dy, x = fx + dx * u, z = fz + dz * u; if (u >= 0 && u <= 1 && x * x + z * z < d.r * d.r) t = u;
    }
    if (t < DSEG.t) { DSEG.t = t; DSEG.i = d.i; }
  }
  return DSEG.i >= 0 ? DSEG : null;
}
// a circle (px, pz, r) of your tank against the standing depots (a circle DEPOT_SOLID of their radius, as the bots): the deepest push out, or null
export function depotPush(px: number, pz: number, r: number): { nx: number; nz: number; pen: number } | null {
  let best: { nx: number; nz: number; pen: number } | null = null;
  for (const d of DEPOTS) {
    if (!standing(d.i)) continue;
    const dx = px - d.x, dz = pz - d.z, dd = Math.hypot(dx, dz), pen = d.r * DEPOT_SOLID + r - dd;
    if (pen > 1e-4 && (!best || pen > best.pen)) best = { nx: dd > 1e-6 ? dx / dd : 1, nz: dd > 1e-6 ? dz / dd : 0, pen };
  }
  return best;
}

// main.ts calls this once at boot, after the river's effects (nothing here draws from the city's seed)
export function buildObjectives() { buildZones(); buildDepots(); }
// every frame: the flags, the rings' colours, the depots' state and smoke
export function updateObjectives(dt: number, tnow: number) { drawZones(tnow); drawDepots(dt); }
