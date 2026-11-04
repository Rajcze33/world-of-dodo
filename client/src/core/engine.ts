// The 3D view: Babylon.js engine, scene, camera, lights, fog and the moon's shadows.
//
// Created when this module is first imported, so every other module can use `scene` at once. The scene is right-handed
// (useRightHandedSystem), as three.js was in the original: x east, z south, y up, a heading h faces (sin h, cos h), and the
// geometry winds counter-clockwise seen from the front (core/geo.ts builds it that way).
import {
  Engine, Scene, FreeCamera, Vector3, HemisphericLight, DirectionalLight, ShadowGenerator, Mesh, VertexData,
  StandardMaterial, Color3, type AbstractMesh,
} from '@babylonjs/core';
import { COL, c3, c4 } from './colors';
import { COARSE } from './dom';

export const canvas = document.getElementById('gl') as HTMLCanvasElement;
export const engine = new Engine(canvas, true, { powerPreference: 'high-performance', stencil: true, preserveDrawingBuffer: false }, false);
export const scene = new Scene(engine);
scene.useRightHandedSystem = true;
scene.clearColor = c4(COL.charcoal);
scene.skipPointerMovePicking = true;                 // nothing in the game is picked with the mouse
scene.fogMode = Scene.FOGMODE_LINEAR;
scene.fogColor = c3(COL.charcoal);
scene.fogStart = 90;
scene.fogEnd = 300;

// the camera: placed and aimed by the game every frame (lookAt), never by the mouse
export const camera = new FreeCamera('camera', new Vector3(0, 95, 210), scene);
camera.minZ = 0.5;
camera.maxZ = 1400;
camera.fov = 55 * Math.PI / 180;
camera.inputs.clear();
export function lookAt(v: Vector3) { camera.setTarget(v); }

// sky dome: charcoal horizon → ink zenith (vertex colours, unlit, no fog)
{
  const n = 32, m = 16, R = 900, p: number[] = [], c: number[] = [], idx: number[] = [];
  const a = c3(COL.charcoal), b = c3(0x0b0e0d);
  for (let j = 0; j <= m; j++) {
    const th = j / m * Math.PI, y = R * Math.cos(th), r = R * Math.sin(th), t = Math.max(0, Math.min(1, y / 500)), k = Math.pow(t, 0.7);
    for (let i = 0; i <= n; i++) {
      const ph = i / n * Math.PI * 2;
      p.push(-r * Math.cos(ph), y, r * Math.sin(ph));
      c.push(a.r + (b.r - a.r) * k, a.g + (b.g - a.g) * k, a.b + (b.b - a.b) * k, 1);
    }
  }
  for (let j = 0; j < m; j++) for (let i = 0; i < n; i++) { const q = j * (n + 1) + i; idx.push(q, q + 1, q + n + 1, q + 1, q + n + 2, q + n + 1); }
  const vd = new VertexData(); vd.positions = p; vd.colors = c; vd.indices = idx;
  const sky = new Mesh('sky', scene); vd.applyToMesh(sky);
  const mat = new StandardMaterial('sky', scene);
  mat.disableLighting = true; mat.emissiveColor = Color3.White(); mat.backFaceCulling = false; mat.fogEnabled = false; mat.disableDepthWrite = true;
  sky.material = mat; sky.isPickable = false; sky.infiniteDistance = true;
}

// light: a cool sky over a charcoal ground, and the moon, which casts the shadows and follows the action (frame loop)
const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
hemi.diffuse = c3(COL.light); hemi.groundColor = c3(COL.charcoal); hemi.specular = Color3.Black(); hemi.intensity = 0.62;
export const moon = new DirectionalLight('moon', new Vector3(50, -110, -40).normalize(), scene);
moon.intensity = 0.55; moon.specular = Color3.Black();
moon.position = new Vector3(-50, 110, 40);
moon.autoUpdateExtends = false;
moon.shadowMinZ = 10; moon.shadowMaxZ = 260;
// the box the shadows are drawn in, around the light's target: ±80 around the tank, ±190 for the wide views
export function moonAt(x: number, z: number, half: number) {
  moon.position.set(x - 50, 110, z + 40);
  moon.orthoLeft = -half; moon.orthoRight = half; moon.orthoTop = half; moon.orthoBottom = -half;
}

// The shadow casters, remembered so the shadow map can be rebuilt at another size (quality levels) or switched off.
const casters: AbstractMesh[] = [];
export let shadow: ShadowGenerator | null = null;
function makeShadow(size: number) {
  shadow?.dispose(); shadow = null;
  if (!size) return;
  shadow = new ShadowGenerator(size, moon);
  shadow.usePercentageCloserFiltering = true;      // soft edges, as the original's PCF soft shadows
  shadow.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
  shadow.bias = 0.0015;
  shadow.normalBias = 0.02;
  for (const m of casters) shadow.addShadowCaster(m, false);
}
export function addCaster(m: AbstractMesh) { casters.push(m); shadow?.addShadowCaster(m, false); }
export function removeCaster(m: AbstractMesh) { const i = casters.indexOf(m); if (i >= 0) casters.splice(i, 1); shadow?.removeShadowCaster(m, false); }
export function setShadowSize(size: number) { if ((shadow?.getShadowMap()?.getSize().width ?? 0) !== size) makeShadow(size); }
makeShadow(COARSE ? 1024 : 2048);

// resolution: drawn pixels per CSS pixel (the quality levels lower it on a weak GPU)
export function setPixelRatio(pr: number) { engine.setHardwareScalingLevel(1 / pr); }
setPixelRatio(Math.min(window.devicePixelRatio || 1, COARSE ? 1.5 : 2));

// the view follows the window; a portrait screen gets a wider lens
export function resize() {
  engine.resize();
  camera.fov = (innerWidth < innerHeight ? 72 : 55) * Math.PI / 180;
}
export const aspect = () => innerWidth / Math.max(1, innerHeight);
