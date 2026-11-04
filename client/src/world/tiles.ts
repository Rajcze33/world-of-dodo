// World of DODO, issue #16: the city's merged meshes, in tiles. The original merged the whole invented city into one mesh per
// material (core/geo.ts BK). The real Karlín with its surroundings is ±700 units across: one mesh per material would always be drawn
// whole, the shadow pass included, even the parts behind the camera or deep in the fog. So the static geometry goes into buckets per
// tile (280 × 280 units) and per material kind; bakeTiles() makes the meshes, Babylon culls a tile outside the view, and a tile wholly
// beyond the fog's end is switched off (the tank's fog ends at 300, the plane's at 800; core/engine.ts setFog).
import type { Mesh, Material } from '@babylonjs/core';
import { scene, camera } from '../core/engine';
import { Bucket, bake } from '../core/geo';

// fac: the facades (window texture, lit windows); vc: everything else lit, in vertex colours (roofs, cornices, stone, the site);
// glow: unlit vertex colours (lit windows of the landmarks, shop windows, signs)
export type Kind = 'fac' | 'vc' | 'glow';
export const TILE = 280, TX0 = -700, TZ0 = -700, TN = 5;
interface Tile { b: Record<Kind, Bucket>; m: Mesh[]; box: number[]; on: boolean }
const TILES: Tile[] = [];
for (let k = 0; k < TN * TN; k++) TILES.push({ b: { fac: Bucket(), vc: Bucket(), glow: Bucket() }, m: [], box: [0, 0, 0, 0], on: true });
// the bucket of material kind k for something standing at (x, z) (its middle: a house goes whole into one tile)
export function tileB(k: Kind, x: number, z: number): Bucket {
  const i = Math.max(0, Math.min(TN - 1, Math.floor((x - TX0) / TILE))), j = Math.max(0, Math.min(TN - 1, Math.floor((z - TZ0) / TILE)));
  return TILES[j * TN + i].b[k];
}
// the meshes (casters: fac and vc), and the fog switch, checked before every frame (25 boxes: nothing)
export function bakeTiles(mats: Record<Kind, Material>) {
  TILES.forEach((t, n) => {
    for (const k of ['fac', 'vc', 'glow'] as Kind[]) {
      const m = bake('city_' + k + '_' + n, t.b[k], mats[k], k !== 'glow'); t.b[k] = Bucket();
      if (!m) continue;
      t.m.push(m);
      const bb = m.getBoundingInfo().boundingBox, lo = bb.minimumWorld, hi = bb.maximumWorld;
      t.box = t.m.length === 1 ? [lo.x, lo.z, hi.x, hi.z] : [Math.min(t.box[0], lo.x), Math.min(t.box[1], lo.z), Math.max(t.box[2], hi.x), Math.max(t.box[3], hi.z)];
    }
  });
  scene.onBeforeRenderObservable.add(() => {
    const c = camera.position, f = scene.fogEnd + 10;
    for (const t of TILES) {
      if (!t.m.length) continue;
      const dx = Math.max(t.box[0] - c.x, 0, c.x - t.box[2]), dz = Math.max(t.box[1] - c.z, 0, c.z - t.box[3]), on = dx * dx + dz * dz < f * f;
      if (on !== t.on) { t.on = on; for (const m of t.m) m.setEnabled(on); }
    }
  });
}
