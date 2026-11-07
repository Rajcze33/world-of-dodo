// World of DODO, issue #16: the city's merged meshes, in tiles. The original merged the whole invented city into one mesh per
// material (core/geo.ts BK). The real Karlín with its surroundings is ±700 units across: one mesh per material would always be drawn
// whole, the shadow pass included, even the parts behind the camera or deep in the fog. So the static geometry goes into buckets per
// tile (280 × 280 units) and per material kind; bakeTiles() makes the meshes, Babylon culls a tile outside the view, and a tile wholly
// beyond the fog's end is switched off (the tank's fog ends at 300, the plane's at 800; core/engine.ts setFog).
// World of DODO, issue #27: more kinds than the three of #16, one per material of the material library (core/matlib.ts): a module
// registers a kind with its material (tileKind), then fills tileB(kind, x, z) as before; bakeTiles bakes every kind it finds. A kind
// may also end nearer than the fog (far: e.g. the houses' detail, drawn only within ~180 of the camera).
import type { Mesh, Material } from '@babylonjs/core';
import { scene, camera } from '../core/engine';
import { Bucket, bake } from '../core/geo';

// World of DODO, issue #31: the city is built in the background, in slices (core/slice.ts runs these builders): a builder is a
// generator that yields between its units of work (a house, a street, a tile's bake), never inside one, and keeps the order of
// the original build call for call, so every page builds the same city (props by index, the lit windows' hashes). What it yields
// is how far it is, 0..1 of itself (part() maps a builder inside another into the outer one's share).
export type Build<R = void> = Generator<number | void, R, void>;
export function* part<R>(w: Build<R>, a: number, b: number): Build<R> {
  for (;;) { const r = w.next(); if (r.done) return r.value; yield typeof r.value === 'number' ? a + (b - a) * r.value : undefined; }
}

// fac: the facades (window texture, lit windows); vc: everything else lit, in vertex colours (roofs, cornices, stone, the site);
// glow: unlit vertex colours (lit windows of the landmarks, shop windows, signs); and every kind registered with tileKind
export type Kind = 'fac' | 'vc' | 'glow' | (string & {});
export const TILE = 280, TX0 = -700, TZ0 = -700, TN = 5;
interface KindDef { mat: Material | null; cast: boolean; far: number }
// fac, vc and glow get their materials from bakeTiles' argument (city.ts); glow casts no shadow (lights)
const KINDS = new Map<string, KindDef>([['fac', { mat: null, cast: true, far: Infinity }], ['vc', { mat: null, cast: true, far: Infinity }], ['glow', { mat: null, cast: false, far: Infinity }]]);
// a kind of one's own: its material, whether it casts shadows, how far from the camera its meshes are drawn at most
export function tileKind(k: string, mat: Material, opt: { cast?: boolean; far?: number } = {}) {
  KINDS.set(k, { mat, cast: opt.cast ?? true, far: opt.far ?? Infinity });
}
interface TMesh { m: Mesh; far: number; on: boolean }
interface Tile { b: Map<string, Bucket>; m: TMesh[]; box: number[]; on: boolean }
const TILES: Tile[] = [];
for (let k = 0; k < TN * TN; k++) TILES.push({ b: new Map(), m: [], box: [0, 0, 0, 0], on: true });
// the bucket of material kind k for something standing at (x, z) (its middle: a house goes whole into one tile)
export function tileB(k: Kind, x: number, z: number): Bucket {
  const i = Math.max(0, Math.min(TN - 1, Math.floor((x - TX0) / TILE))), j = Math.max(0, Math.min(TN - 1, Math.floor((z - TZ0) / TILE)));
  const t = TILES[j * TN + i]; let b = t.b.get(k);
  if (!b) { b = Bucket(); t.b.set(k, b); }
  return b;
}
// the meshes, and the fog switch, checked before every frame (a box per tile, and per mesh of a kind with its own far: nothing)
// (issue #31: a builder, one bake of a tile's kind a unit, in the same order as before)
export function* bakeTiles(mats: Record<'fac' | 'vc' | 'glow', Material>): Build {
  let all = 0, done = 0;
  for (const t of TILES) all += t.b.size;
  for (let n = 0; n < TILES.length; n++) {
    const t = TILES[n];
    for (const [k, bk] of t.b) {
      const def = KINDS.get(k), mat = (mats as Record<string, Material>)[k] ?? def?.mat;
      if (!mat) throw new Error('tiles: no material for the kind ' + k);
      const m = bake('city_' + k + '_' + n, bk, mat, def ? def.cast : true);
      if (m) {
        t.m.push({ m, far: def ? def.far : Infinity, on: true });
        const bb = m.getBoundingInfo().boundingBox, lo = bb.minimumWorld, hi = bb.maximumWorld;
        t.box = t.m.length === 1 ? [lo.x, lo.z, hi.x, hi.z] : [Math.min(t.box[0], lo.x), Math.min(t.box[1], lo.z), Math.max(t.box[2], hi.x), Math.max(t.box[3], hi.z)];
      }
      yield ++done / all;
    }
    t.b.clear();
  }
  scene.onBeforeRenderObservable.add(() => {
    const c = camera.position, f = scene.fogEnd + 10;
    for (const t of TILES) {
      if (!t.m.length) continue;
      const dx = Math.max(t.box[0] - c.x, 0, c.x - t.box[2]), dz = Math.max(t.box[1] - c.z, 0, c.z - t.box[3]), on = dx * dx + dz * dz < f * f;
      if (on !== t.on) { t.on = on; for (const q of t.m) if (q.far === Infinity) q.m.setEnabled(on); }
      // a kind that ends nearer: by the distance to its own mesh's box
      for (const q of t.m) {
        if (q.far === Infinity) continue;
        let v = on;
        if (v) {
          const bb = q.m.getBoundingInfo().boundingBox, lo = bb.minimumWorld, hi = bb.maximumWorld, r = Math.min(q.far, f);
          const ex = Math.max(lo.x - c.x, 0, c.x - hi.x), ez = Math.max(lo.z - c.z, 0, c.z - hi.z); v = ex * ex + ez * ez < r * r;
        }
        if (v !== q.on) { q.on = v; q.m.setEnabled(v); }
      }
    }
  });
}
