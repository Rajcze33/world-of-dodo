// Materials. The original used three.js's Lambert (lit, no shine) and Basic (unlit) materials; lambert() and basic() make the
// same looks with Babylon's StandardMaterial. A mesh with vertex colours multiplies them in (core/geo.ts gives a mesh colours only
// when its bucket has them).
import { StandardMaterial, Color3, Constants, type BaseTexture } from '@babylonjs/core';
import { scene } from './engine';
import { COL, c3 } from './colors';
import { poolTex } from './tex';

export interface MatOpt {
  map?: BaseTexture;                 // colour texture (multiplies the colour)
  emissive?: number;                 // glow colour, added on top of the lit colour (three's emissive)
  emissiveIntensity?: number;
  emissiveMap?: BaseTexture;         // glow texture (white parts glow, scaled by emissiveIntensity)
  double?: boolean;                  // both sides drawn (three's DoubleSide)
  opacity?: number;                  // with transparent
  transparent?: boolean;
  additive?: boolean;                // adds light instead of covering (three's AdditiveBlending)
  depthWrite?: boolean;              // false: does not hide what is drawn after it
  fog?: boolean;                     // false: the fog does not fade it
  alphaFromMap?: boolean;            // the map's alpha cuts it out
}
function common(m: StandardMaterial, o: MatOpt) {
  m.specularColor = Color3.Black();
  if (o.map) { m.diffuseTexture = o.map; if (o.alphaFromMap || o.transparent) { o.map.hasAlpha = true; m.useAlphaFromDiffuseTexture = true; } }
  if (o.double) { m.backFaceCulling = false; m.twoSidedLighting = true; }   // the back lit with the flipped normal, as three's DoubleSide
  if (o.transparent || o.additive) { m.alpha = o.opacity ?? 1; m.transparencyMode = StandardMaterial.MATERIAL_ALPHABLEND; }
  if (o.additive) m.alphaMode = Constants.ALPHA_ADD;
  if (o.depthWrite === false) m.disableDepthWrite = true;
  if (o.fog === false) m.fogEnabled = false;
  return m;
}
// lit, matt (three's MeshLambertMaterial)
export function lambert(col: number, o: MatOpt = {}): StandardMaterial {
  const m = common(new StandardMaterial('lambert', scene), o);
  m.diffuseColor = c3(col);
  if (o.emissive !== undefined || o.emissiveMap) {
    m.useEmissiveAsIllumination = true;            // the glow is added after the colour (and the vertex colours), as in three.js
    if (o.emissiveMap) { m.emissiveTexture = o.emissiveMap; m.emissiveTexture.level = o.emissiveIntensity ?? 1; m.emissiveColor = Color3.Black(); }
    else m.emissiveColor = c3(o.emissive!).scale(o.emissiveIntensity ?? 1);
  }
  return m;
}
// unlit, always its own colour (three's MeshBasicMaterial). With no lights the standard shader draws emissive × texture × vertex
// colour, so the colour goes into emissive and a map stays the diffuse texture.
export function basic(col: number, o: MatOpt = {}): StandardMaterial {
  const m = common(new StandardMaterial('basic', scene), o);
  m.disableLighting = true;
  m.diffuseColor = Color3.Black();
  m.emissiveColor = c3(col);
  return m;
}
// the shared materials of the original (M)
export const M = {
  road: lambert(COL.c80),
  snow: lambert(COL.paper),
  walk: lambert(COL.lgrey),
  roof: lambert(COL.paper),
  dash: lambert(COL.c20),
  tree: lambert(COL.teal),
  trunk: lambert(COL.charcoal),
  pole: lambert(COL.charcoal),
  lampHead: basic(0xffffff),
  pool: basic(COL.light, { map: poolTex, transparent: true, opacity: 0.22, depthWrite: false, additive: true }),
  glass: lambert(COL.charcoal, { emissive: COL.charcoal, emissiveIntensity: 0.3 }),
  shopGlass: basic(COL.light),
  awning: lambert(COL.teal),
  door: lambert(COL.teal),
  dot: basic(COL.green),
  green: lambert(COL.green),
  white: lambert(COL.white),
  black: lambert(0x1a1d1c),
  skin: lambert(0xd9b9a0),
  charcoal: lambert(COL.charcoal),
  lteal: lambert(COL.light),
  hub: lambert(COL.c20),
  lgreyMat: lambert(COL.c20),
  hair: lambert(0x2b2623),
};
// vertex-coloured materials for the merged buckets (cars, tram, site): lit, and unlit for lights
export const VC_MAT = lambert(0xffffff, { double: true });
export const VC_GLOW = basic(0xffffff, { double: true });
