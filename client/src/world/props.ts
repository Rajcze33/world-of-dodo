// Props the tank can knock down: trees and street lamps (world/city.ts builds them and registers them here).
// A prop is a solid circle (r) while it stands. A vehicle that hits it with enough impact speed (>= breakV; trees also need a heavy
// vehicle) topples it: it falls away from the impact and then lies there as scenery. Slower than that, it acts like a wall.
// grid.ts's free() asks propsNear() for the standing ones; the player's tank knocks them over in game/tank.ts (breakProps).
import { Vector3, Quaternion, type TransformNode } from '@babylonjs/core';
import type { Prop } from '../game/types';

export const PROPS: Prop[] = [];
export const FALLING: Prop[] = [];
const PGRID = new Map<number, Prop[]>(), PCELL = 16;

// what a builder hands to registerProp (it fills in the index and the standing state). minMass: the lightest vehicle that topples
// it; lift: how far its base rises as it tips (so it does not sink into the ground); y0: the height of its base.
export interface PropSpec {
  kind: 'tree' | 'lamp';
  x: number; z: number; r: number;
  breakV: number; minMass: number; slow: number;
  th0: number; acc: number; w0: number; lift: number; y0: number;
  apply: (p: Prop) => void;
  [more: string]: any;
}
export function registerProp(spec: PropSpec): Prop {
  const p: Prop = Object.assign(spec, { state: 'up' as const, th: 0, w: 0, bounced: false, fx: 1, fz: 0, i: PROPS.length });
  PROPS.push(p);   // i: the same on every client (the city is built from one seed)
  const k = Math.floor(p.x / PCELL) * 1000 + Math.floor(p.z / PCELL); let a = PGRID.get(k); if (!a) { a = []; PGRID.set(k, a); } a.push(p);
  return p;
}
export function propsNear(x: number, z: number): Prop[] {
  const ci = Math.floor(x / PCELL), cj = Math.floor(z / PCELL), out: Prop[] = [];
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const l = PGRID.get((ci + a) * 1000 + cj + b); if (l) for (const p of l) out.push(p); }
  return out;
}
// a prop that is a group of meshes (the city tree on the plaza): tilt it about its base. p.g is its TransformNode, p.q0 its upright turn.
const PQ1 = new Quaternion(), PAX = new Vector3();
export function applyGroup(p: Prop) {
  const g = p.g as TransformNode, q = g.rotationQuaternion ?? (g.rotationQuaternion = new Quaternion());
  if (p.th > 0) { PAX.set(p.fz, 0, -p.fx); Quaternion.RotationAxisToRef(PAX, p.th, PQ1); PQ1.multiplyToRef(p.q0, q); } else q.copyFrom(p.q0);
  g.position.set(p.x, p.y0 + p.lift * Math.sin(p.th), p.z);
}
export function knockProp(p: Prop, fx: number, fz: number) {
  if (p.state !== 'up') return;
  const l = Math.hypot(fx, fz) || 1, j = (Math.random() - 0.5) * 0.35, c = Math.cos(j), sn = Math.sin(j);   // a little random sideways wobble
  p.fx = (fx / l) * c - (fz / l) * sn; p.fz = (fx / l) * sn + (fz / l) * c; p.state = 'fall'; p.th = 0.001; p.w = p.w0; p.bounced = false; FALLING.push(p);
}
export function updateProps(dt: number) {
  for (let i = FALLING.length - 1; i >= 0; i--) {
    const p = FALLING[i];
    p.w += p.acc * (Math.sin(p.th) + 0.3) * dt; p.th += p.w * dt;
    if (p.th >= p.th0) { p.th = p.th0; if (!p.bounced && p.w > 1.5) { p.w = -p.w * 0.22; p.bounced = true; } else { p.state = 'down'; FALLING.splice(i, 1); } }
    p.apply(p);
  }
}
export function resetProps() {
  FALLING.length = 0;
  for (const p of PROPS) { p.state = 'up'; p.th = 0; p.w = 0; p.bounced = false; p.apply(p); }
}
