// Effects: the falling snow, and the blast of a destroyed tank (the dust puff and the shock ring of the original's finale) with the
// camera shake that main.ts applies.
//
// three.js drew the snow and the dust as Points: round soft sprites (poolTex) whose size shrinks with the distance. Babylon's points
// have a fixed size in pixels and no sprite, so both use a small shader of their own (pointsMat) that does what three's
// PointsMaterial did: the size in world units, the soft round spot, the fog.
import { Mesh, ShaderMaterial, VertexBuffer, Color3, Constants, type StandardMaterial } from '@babylonjs/core';
import { scene, engine, camera } from '../core/engine';
import { geoMesh, ringGeo, rotateX } from '../core/geo';
import { basic } from '../core/mat';
import { COARSE } from '../core/dom';
import { R } from '../core/util';

// ---------- points: three's PointsMaterial (sizeAttenuation, map: poolTex, transparent, depthWrite: false) ----------
// size: world units, as three's size; scale: half the drawn height in pixels (three's scale × pixel ratio). The fog as the rest of the
// scene has it (Babylon's linear fog on the distance from the camera).
const POINT_VS = `precision highp float;
attribute vec3 position;
uniform mat4 worldView;
uniform mat4 projection;
uniform float size;
uniform float scale;
uniform float fogStart;
uniform float fogEnd;
varying float vFog;
void main(void) {
  vec4 mv = worldView * vec4(position, 1.0);
  gl_Position = projection * mv;
  gl_PointSize = size * scale / -mv.z;
  vFog = clamp((fogEnd - length(mv.xyz)) / (fogEnd - fogStart), 0.0, 1.0);
}`;
// poolTex was a white spot whose alpha falls from 1 in the middle to 0 at the edge: the same, computed
const POINT_FS = `precision highp float;
uniform vec3 color;
uniform float opacity;
uniform vec3 fogColor;
varying float vFog;
void main(void) {
  float a = 1.0 - length(gl_PointCoord * 2.0 - 1.0);
  if (a <= 0.0) discard;
  gl_FragColor = vec4(mix(fogColor, color, vFog), a * opacity);
}`;
function pointsMat(name: string, size: number, opacity: number): ShaderMaterial {
  const m = new ShaderMaterial(name, scene, { vertexSource: POINT_VS, fragmentSource: POINT_FS }, {
    attributes: ['position'],
    uniforms: ['worldView', 'projection', 'size', 'scale', 'fogStart', 'fogEnd', 'color', 'opacity', 'fogColor'],
    needAlphaBlending: true,
  });
  m.pointsCloud = true; m.disableDepthWrite = true; m.backFaceCulling = false; m.alphaMode = Constants.ALPHA_COMBINE;
  m.setFloat('size', size); m.setFloat('opacity', opacity); m.setColor3('color', Color3.White());
  frameUniforms(m);
  return m;
}
// what changes with the window and the quality level (the drawn height), set before drawing
function frameUniforms(m: ShaderMaterial) {
  m.setFloat('scale', engine.getRenderHeight() * 0.5);
  m.setFloat('fogStart', scene.fogStart); m.setFloat('fogEnd', scene.fogEnd); m.setColor3('fogColor', scene.fogColor);
}
// a cloud of points; its positions are written again every frame. Unindexed: points are drawn straight from the vertices, and the
// first submesh's vertex count is three's draw range.
function pointsMesh(name: string, pos: Float32Array, mat: ShaderMaterial): Mesh {
  const m = new Mesh(name, scene);
  m.isUnIndexed = true;
  m.setVerticesData(VertexBuffer.PositionKind, pos, true);
  m.material = mat; m.isPickable = false;
  m.alwaysSelectAsActiveMesh = true;                 // around the camera or anywhere in the city: never culled (three: frustumCulled = false)
  return m;
}

// ---------- snow ----------
const SN = COARSE ? 1200 : 2600, snowPos = new Float32Array(SN * 3);
let snowN = SN;                                      // flakes drawn and moved (World of DODO quality)
let snowMesh: Mesh | null = null, snowMat: ShaderMaterial | null = null;
// World of DODO quality: the low level draws (and moves) half the flakes (game/quality.ts)
export const snow = {
  setFraction(f: number) { snowN = Math.round(SN * f); if (snowMesh) snowMesh.subMeshes[0].verticesCount = snowN; },
};
// the flakes fall (each a little at its own speed), sway, and wrap around the camera in a 140 × 140 box. main.ts calls this every frame,
// after it has placed the camera and before the shake.
export function updateSnow(dt: number, tnow = performance.now()) {
  if (!snowMesh || !snowMat) return;
  const tt = tnow / 1000, cx = camera.position.x, cz = camera.position.z;
  for (let i = 0; i < snowN; i++) {
    let y = snowPos[i * 3 + 1] - dt * (2.2 + (i % 5) * 0.35); if (y < 0) y += 50; snowPos[i * 3 + 1] = y;
    let x = snowPos[i * 3] + Math.sin(tt * 0.6 + i) * dt * 0.4, z = snowPos[i * 3 + 2];
    if (x - cx > 70) x -= 140; else if (x - cx < -70) x += 140;
    if (z - cz > 70) z -= 140; else if (z - cz < -70) z += 140;
    snowPos[i * 3] = x; snowPos[i * 3 + 2] = z;
  }
  snowMesh.updateVerticesData(VertexBuffer.PositionKind, snowPos);
  frameUniforms(snowMat);
}

// ---------- impact effects: the dust cloud and a shock ring ----------
// (the original's finale also dropped a big parcel here; the finale is gone, so is the parcel)
const PUFF_N = 140, puffPos = new Float32Array(PUFF_N * 3), puffVel = new Float32Array(PUFF_N * 3);
let puff!: Mesh, puffMat!: ShaderMaterial, shockRing!: Mesh, ringMat!: StandardMaterial;
let puffT = 0, ringT = 0, ringS = 22;
// shakeT: how long the camera still shakes (main.ts applies it to the camera while drawing and counts it down)
export const fx = { shakeT: 0 };
// s scales the blast (1 = the finale's big parcel; World of DODO uses a smaller one for a destroyed tank), shake = camera shake time,
// y: the height of the blast (a plane blows up in the air, issue #14; its pieces fall to the ground)
export function startImpactFx(x: number, z: number, s = 1, shake = 0.9, y = 0) {
  for (let i = 0; i < PUFF_N; i++) {
    const a = Math.random() * 6.283, sp = (4 + Math.random() * 15) * s;
    puffPos[i * 3] = x + Math.cos(a) * 1.5; puffPos[i * 3 + 1] = y + 0.6 + Math.random() * 1.5; puffPos[i * 3 + 2] = z + Math.sin(a) * 1.5;
    puffVel[i * 3] = Math.cos(a) * sp; puffVel[i * 3 + 1] = (3 + Math.random() * 10) * s; puffVel[i * 3 + 2] = Math.sin(a) * sp;
  }
  puff.setEnabled(true); puffT = 2.2; puff.updateVerticesData(VertexBuffer.PositionKind, puffPos);
  shockRing.position.set(x, y + 0.5, z); shockRing.setEnabled(true); ringT = 0.7; ringS = 22 * s; fx.shakeT = Math.max(fx.shakeT, shake);
}
export function updateImpactFx(dt: number) {
  if (puffT > 0) {
    puffT -= dt;
    for (let i = 0; i < PUFF_N; i++) {
      puffVel[i * 3 + 1] -= 14 * dt; puffPos[i * 3] += puffVel[i * 3] * dt; puffPos[i * 3 + 1] += puffVel[i * 3 + 1] * dt; puffPos[i * 3 + 2] += puffVel[i * 3 + 2] * dt;
      if (puffPos[i * 3 + 1] < 0.3) { puffPos[i * 3 + 1] = 0.3; puffVel[i * 3] *= 0.6; puffVel[i * 3 + 2] *= 0.6; puffVel[i * 3 + 1] = 0; }
    }
    puffMat.setFloat('opacity', Math.min(0.9, puffT / 1.2)); frameUniforms(puffMat);
    puff.updateVerticesData(VertexBuffer.PositionKind, puffPos); if (puffT <= 0) puff.setEnabled(false);
  }
  if (ringT > 0) {
    ringT -= dt; const k = 1 - ringT / 0.7;
    shockRing.scaling.setAll(1 + k * ringS); ringMat.alpha = 0.8 * (1 - k); if (ringT <= 0) shockRing.setEnabled(false);
  }
}
export function clearImpactFx() {
  if (puff) { puff.setEnabled(false); shockRing.setEnabled(false); }
  puffT = ringT = fx.shakeT = 0;
}

// The snow and the blast's meshes (main.ts calls this last, after the pedestrians). The flakes take the city's random numbers (R) after
// everything else, as in the original, so this must stay the last thing built.
export function buildFx() {
  for (let i = 0; i < SN; i++) { snowPos[i * 3] = (R() - 0.5) * 140; snowPos[i * 3 + 1] = R() * 50; snowPos[i * 3 + 2] = (R() - 0.5) * 140; }
  snowMat = pointsMat('snow', 0.38, 0.9);
  snowMesh = pointsMesh('snow', snowPos, snowMat);
  snowMesh.subMeshes[0].verticesCount = snowN;
  puffMat = pointsMat('puff', 2.4, 0.9);
  puff = pointsMesh('puff', puffPos, puffMat); puff.setEnabled(false);
  // the ring lies flat (three turned the mesh by -90° about x; here the shape), so a uniform scale widens it
  ringMat = basic(0xffffff, { transparent: true, opacity: 0.8, depthWrite: false, additive: true, double: true });
  shockRing = geoMesh('shockRing', rotateX(ringGeo(0.8, 1.15, 48), -Math.PI / 2), ringMat, false, false);
  shockRing.setEnabled(false);
}
