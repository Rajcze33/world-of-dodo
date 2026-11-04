// World of DODO, issue #20: the river's effects (the Vltava itself, its embankments and floes are world/land.ts): the foam of a
// ship's wake and its bow wave, a torpedo's trail, the white water column where a shell (or a parcel, a bullet) falls into the river,
// and what stays where a ship went down (bubbles, an oil slick).
//
// Cheap on purpose: every effect is a few textured quads out of one pool, written into one mesh every frame (one draw call, no
// garbage), lying on the water (the foam, the slick) or standing as a column turned to the camera (the spray). A quad fades and
// grows over its life; when the pool is full the oldest makes room. The ships call wake() every frame, torpedoes torpWake(); they
// pass no id, so a wake is told from another by where it was a moment ago. main.ts calls buildWater() once and updateWater(dt) every
// frame (after the camera is placed: the columns face it).
import { Mesh, ShaderMaterial, VertexBuffer, Constants, Color3, BoundingInfo, Vector3 } from '@babylonjs/core';
import { scene, camera } from '../core/engine';
import { canvasTex } from '../core/tex';
import { COARSE } from '../core/dom';
import { WATER_Y } from '../../shared/naval.ts';
import { hash01 } from './poly';

// ---------- the pool ----------
// k: 0 a patch lying on the water (foam, slick, bubble), 1 a column standing up (spray). x, z its middle (a column: its foot), vx, vz
// its drift (u/s), s0 → s1 its size over its life (a column: its width; h its height), age / life in s, a its opacity at the start,
// rgb its colour, rot its turn (patches), d a delay before it shows (s)
const MAX = COARSE ? 900 : 1600;
interface P { on: boolean; k: number; x: number; z: number; vx: number; vz: number; s0: number; s1: number; h: number; age: number; life: number; a: number; c: number; rot: number; d: number }
const POOL: P[] = [];
for (let i = 0; i < MAX; i++) POOL.push({ on: false, k: 0, x: 0, z: 0, vx: 0, vz: 0, s0: 1, s1: 1, h: 0, age: 0, life: 1, a: 1, c: 0xffffff, rot: 0, d: 0 });
let next = 0;
// the next quad of the pool (a free one, or the oldest when every one is in use)
function take(): P {
  for (let n = 0; n < MAX; n++) { const p = POOL[(next + n) % MAX]; if (!p.on) { next = (next + n + 1) % MAX; return p; } }
  const p = POOL[next]; next = (next + 1) % MAX; return p;
}
let seed = 1;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };   // its own numbers: no one else's Math.random sequence
function patch(x: number, z: number, vx: number, vz: number, s0: number, s1: number, life: number, a: number, c = 0xffffff, d = 0) {
  const p = take(); p.on = true; p.k = 0; p.x = x; p.z = z; p.vx = vx; p.vz = vz; p.s0 = s0; p.s1 = s1; p.h = 0; p.age = 0; p.life = life; p.a = a; p.c = c; p.rot = rnd() * 6.283; p.d = d;
}
function column(x: number, z: number, w: number, h: number, life: number, a: number, d = 0) {
  const p = take(); p.on = true; p.k = 1; p.x = x; p.z = z; p.vx = 0; p.vz = 0; p.s0 = w; p.s1 = w * 1.7; p.h = h; p.age = 0; p.life = life; p.a = a; p.c = 0xffffff; p.rot = 0; p.d = d;
}

// ---------- the trails: who was where a moment ago ----------
// A ship's (or a torpedo's) last call: where it was, when, and the points its trail and bow wave were last dropped at. A call within
// R of a trail that was called less than half a second ago continues it; otherwise a new one starts (or an old, stale one is reused).
interface Trail { x: number; z: number; t: number; sx: number; sz: number; bx: number; bz: number; ship: boolean; hx: number; hz: number; w: number }
const TRAILS: Trail[] = [];
function trail(x: number, z: number, R: number, now: number): Trail {
  let best: Trail | null = null, bd = R * R;
  for (const t of TRAILS) { if (now - t.t > 0.5) continue; const d = (t.x - x) * (t.x - x) + (t.z - z) * (t.z - z); if (d < bd) { bd = d; best = t; } }
  if (!best) {
    best = TRAILS.find(t => now - t.t > 2) || null;
    if (!best) { if (TRAILS.length >= 48) best = TRAILS.reduce((a, b) => a.t < b.t ? a : b); else { best = { x, z, t: now, sx: x, sz: z, bx: x, bz: z, ship: false, hx: 0, hz: 1, w: 0 }; TRAILS.push(best); } }
    best.sx = best.bx = NaN;                                          // a new trail: drops its first patch at once
  }
  best.x = x; best.z = z; best.t = now; return best;
}
// drop patches every `step` along the way from (px, pz) to (x, z) (at most 8 at once: a long frame leaves a thinner trail, not a hole);
// returns the point the last one went to, or (px, pz) if none
const DROP: number[] = [];
function drops(px: number, pz: number, x: number, z: number, step: number): number {
  DROP.length = 0;
  if (px !== px) { DROP.push(x, z); return 1; }                       // NaN: the first drop of a new trail
  const dx = x - px, dz = z - pz, l = Math.sqrt(dx * dx + dz * dz), n = Math.min(8, Math.floor(l / step));
  for (let k = 1; k <= n; k++) DROP.push(px + dx * k * step / l, pz + dz * k * step / l);
  return n;
}
const sec = () => performance.now() / 1000;

// ---------- what the rest of the game calls ----------
// A ship's wake, every frame while it floats: (x, z) its middle, (hx, hz) its heading (a unit vector), v its speed (u/s, negative
// astern), w its beam (its length is taken as 4.4 beams, the destroyer's proportions). Foam is dropped behind it every 1.4 u it goes,
// wider and fainter as it ages; at speed a bow wave spreads to both sides of the stem.
export function wake(x: number, z: number, hx: number, hz: number, v: number, w: number) {
  const now = sec(), L = 4.4 * w, sp = Math.abs(v), f = Math.min(1, sp / 13), T = trail(x, z, Math.max(8, L * 0.4), now);
  T.ship = true; T.hx = hx; T.hz = hz; T.w = w;                      // the floes keep out of its way (world/land.ts, eachShip)
  if (sp < 0.4) return;
  const back = v >= 0 ? -1 : 1, ex = x + hx * back * L * 0.47, ez = z + hz * back * L * 0.47;   // the end the water leaves
  if (drops(T.sx, T.sz, ex, ez, 1.4)) {
    for (let k = 0; k < DROP.length; k += 2) {
      const j = (rnd() - 0.5) * w * 0.3, px = DROP[k] - hz * j, pz = DROP[k + 1] + hx * j, side = (rnd() - 0.5) * 0.5;
      patch(px, pz, back * hx * 0.25 - hz * side, back * hz * 0.25 + hx * side, w * 0.55, w * (1.7 + 0.7 * rnd()), 6 + 2 * rnd(), 0.22 + 0.5 * f);
    }
    T.sx = DROP[DROP.length - 2]; T.sz = DROP[DROP.length - 1];
  }
  if (v < 1.2) return;
  const bx = x + hx * L * 0.42, bz = z + hz * L * 0.42;                // the stem: the bow wave, both sides, drifting outwards
  if (drops(T.bx, T.bz, bx, bz, 0.8)) {
    for (let k = 0; k < DROP.length; k += 2) for (const s of [-1, 1]) {
      const px = DROP[k] - hz * s * w * 0.32, pz = DROP[k + 1] + hx * s * w * 0.32, out = s * (0.7 + 0.32 * sp);
      patch(px, pz, -hz * out, hx * out, 0.6 + 0.08 * w, 1.6 + 0.25 * w, 1.5 + 0.5 * rnd(), 0.15 + 0.5 * f);
    }
    T.bx = DROP[DROP.length - 2]; T.bz = DROP[DROP.length - 1];
  }
}
// every ship that called wake() in the last moment: its middle, heading and beam (world/land.ts pushes the ice floes aside)
export function eachShip(f: (x: number, z: number, hx: number, hz: number, w: number) => void) {
  const now = sec(); for (const t of TRAILS) if (t.ship && now - t.t < 0.3) f(t.x, t.z, t.hx, t.hz, t.w);
}
// a torpedo's trail, every frame while it runs: (x, z) where it is, (hx, hz) its heading
export function torpWake(x: number, z: number, hx: number, hz: number) {
  const T = trail(x, z, 6, sec()); T.ship = false;
  if (drops(T.sx, T.sz, x - hx * 1.2, z - hz * 1.2, 1.0)) {
    for (let k = 0; k < DROP.length; k += 2) patch(DROP[k], DROP[k + 1], 0, 0, 0.6, 2.2 + 0.6 * rnd(), 4.5 + rnd(), 0.6);
    T.sx = DROP[DROP.length - 2]; T.sz = DROP[DROP.length - 1];
  }
}
// Something fell into the river at (x, z): a white column of water and a ring of foam. size 1 is a main gun's shell (a column some
// 9 u high), a torpedo's blast about 2.4, a parcel about 0.5, a bullet 0.15.
export function splash(x: number, z: number, size = 1) {
  const s = Math.max(0.05, size), w = 0.8 + 3.4 * s, h = 0.8 + 7.5 * s, life = 0.9 + 1.0 * Math.min(2.5, s);
  column(x, z, w, h, life, 0.95);
  if (s >= 0.6) for (let k = 0; k < 3; k++) {                         // a big one: smaller columns round it, a moment later
    const a = rnd() * 6.283, r = w * (0.5 + 0.4 * rnd());
    column(x + Math.sin(a) * r, z + Math.cos(a) * r, w * 0.55, h * (0.45 + 0.25 * rnd()), life * 0.8, 0.85, 0.04 + 0.08 * rnd());
  }
  patch(x, z, 0, 0, w * 0.8, w * 3.2, life * 1.8, 0.8);
  if (s >= 0.6) patch(x, z, 0, 0, w * 0.4, w * 1.6, life * 1.2, 0.9, 0xffffff, 0.15);
}
// A ship went down at (x, z): bubbles for a few seconds, small spouts at first, and an oil slick that spreads and stays a while
const SINKS: { x: number; z: number; t: number; acc: number }[] = [];
export function sinkFx(x: number, z: number) {
  SINKS.push({ x, z, t: 0, acc: 0 });
  patch(x, z, 0, 0, 3, 17, 26, 0.7, 0x0e1413);
  patch(x, z, 0, 0, 5, 14, 3, 0.9);
}

// ---------- the mesh: every quad of the pool, written every frame ----------
// The texture: the left half a blob of foam, the right half a column of spray (dense at the foot, ragged at the top). The shader:
// the texture times the quad's colour and opacity, the fog as the scene's (linear, on the distance from the camera).
const VS = `precision highp float;
attribute vec3 position;
attribute vec4 color;
attribute vec2 uv;
uniform mat4 viewProjection;
uniform vec3 cam;
uniform float fogStart;
uniform float fogEnd;
varying vec4 vC;
varying vec2 vUV;
varying float vFog;
void main(void) {
  gl_Position = viewProjection * vec4(position, 1.0);
  vC = color; vUV = uv;
  vFog = clamp((fogEnd - length(position - cam)) / (fogEnd - fogStart), 0.0, 1.0);
}`;
const FS = `precision highp float;
uniform sampler2D tex;
uniform vec3 fogColor;
varying vec4 vC;
varying vec2 vUV;
varying float vFog;
void main(void) {
  vec4 t = texture2D(tex, vUV);
  float a = t.a * vC.a;
  if (a < 0.01) discard;
  gl_FragColor = vec4(mix(fogColor, vC.rgb * t.rgb, vFog), a);
}`;
let mesh: Mesh | null = null, mat: ShaderMaterial | null = null;
const POS = new Float32Array(MAX * 12), COLS = new Float32Array(MAX * 16), UVS = new Float32Array(MAX * 8);
export function buildWater() {
  const tex = canvasTex(256, 128, (g) => {
    g.clearRect(0, 0, 256, 128);
    for (let k = 0; k < 60; k++) {                                   // the foam: soft bubbles crowding to the middle, thinning out
      const a = hash01(k, 3) * 6.283, r = Math.sqrt(hash01(k, 4)) * 44, x = 64 + Math.cos(a) * r, y = 64 + Math.sin(a) * r, rr = 6 + hash01(k, 5) * 14;
      const grd = g.createRadialGradient(x, y, 0, x, y, rr), o = 0.35 * (1 - r / 60);
      grd.addColorStop(0, `rgba(255,255,255,${o.toFixed(3)})`); grd.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = grd; g.fillRect(x - rr, y - rr, 2 * rr, 2 * rr);
    }
    // the spray: a column of soft puffs, dense and narrow at the foot, wider and thinner up to a ragged top
    for (let k = 0; k < 90; k++) {
      const t = hash01(k, 7), y = 124 - t * 104, half = 14 + 34 * Math.sqrt(t), x = 192 + (hash01(k, 8) - 0.5) * 2 * half * 0.8;
      const rr = 7 + 9 * t + hash01(k, 9) * 6, o = 0.5 * (1 - 0.55 * t), grd = g.createRadialGradient(x, y, 0, x, y, rr);
      grd.addColorStop(0, `rgba(250,252,252,${o.toFixed(3)})`); grd.addColorStop(1, 'rgba(250,252,252,0)'); g.fillStyle = grd; g.fillRect(x - rr, y - rr, 2 * rr, 2 * rr);
    }
  }, { alpha: true });
  mat = new ShaderMaterial('waterFx', scene, { vertexSource: VS, fragmentSource: FS }, {
    attributes: ['position', 'color', 'uv'], uniforms: ['viewProjection', 'cam', 'fogStart', 'fogEnd', 'fogColor'], samplers: ['tex'], needAlphaBlending: true,
  });
  mat.setTexture('tex', tex); mat.disableDepthWrite = true; mat.backFaceCulling = false; mat.alphaMode = Constants.ALPHA_COMBINE;
  mat.zOffset = -2;                                                   // lying on the water: drawn in front of it, never flickering
  mesh = new Mesh('waterFx', scene);
  const idx = new Uint32Array(MAX * 6);
  for (let i = 0; i < MAX; i++) { idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6); }
  mesh.setVerticesData(VertexBuffer.PositionKind, POS, true, 3);
  mesh.setVerticesData(VertexBuffer.ColorKind, COLS, true, 4);
  mesh.setVerticesData(VertexBuffer.UVKind, UVS, true, 2);
  mesh.setIndices(idx);
  mesh.material = mat; mesh.isPickable = false; mesh.alwaysSelectAsActiveMesh = true;   // anywhere on the river: never culled
  // only the quads in use are drawn (the submesh's index count, every frame): a submesh that no longer spans the whole mesh needs a
  // box of its own, so both get one round the outer square, fixed (the vertices are written without updating the extents)
  const bb = new BoundingInfo(new Vector3(-1200, WATER_Y - 5, -1200), new Vector3(1200, WATER_Y + 60, 1200));
  mesh.setBoundingInfo(bb); mesh.subMeshes[0].setBoundingInfo(bb);
  mesh.subMeshes[0].indexCount = 0;
}

// every frame: the wrecks' bubbles, the quads aged, moved and written (those beyond the fog are left out)
const C3 = new Color3();
export function updateWater(dt: number) {
  if (!mesh || !mat) return;
  for (let i = SINKS.length - 1; i >= 0; i--) {
    const s = SINKS[i]; s.t += dt; s.acc += dt * (s.t < 2 ? 26 : 12);
    while (s.acc >= 1) {
      s.acc -= 1; const a = rnd() * 6.283, r = Math.sqrt(rnd()) * 5.5;
      patch(s.x + Math.sin(a) * r, s.z + Math.cos(a) * r, 0, 0, 0.3, 1.1 + rnd(), 0.6 + 0.4 * rnd(), 0.85);
      if (s.t < 2.2 && rnd() < 0.18) column(s.x + Math.sin(a) * r, s.z + Math.cos(a) * r, 0.7, 1.2 + rnd() * 1.6, 0.8, 0.8);
    }
    if (s.t > 7) SINKS.splice(i, 1);
  }
  const c = camera.position, far = scene.fogEnd + 30, far2 = far * far, cy = WATER_Y + 0.04;
  let n = 0;
  for (const p of POOL) {
    if (!p.on) continue;
    if (p.d > 0) { p.d -= dt; continue; }
    p.age += dt; if (p.age >= p.life) { p.on = false; continue; }
    p.x += p.vx * dt; p.z += p.vz * dt; const damp = Math.exp(-dt * 0.6); p.vx *= damp; p.vz *= damp;
    const dx = p.x - c.x, dz = p.z - c.z; if (dx * dx + dz * dz > far2) continue;
    const t = p.age / p.life, o = n * 12, q = n * 16, u = n * 8;
    C3.r = ((p.c >> 16) & 255) / 255; C3.g = ((p.c >> 8) & 255) / 255; C3.b = (p.c & 255) / 255;
    if (p.k === 0) {                                                  // a patch on the water: grows (fast first), fades (slowly first)
      const s = (p.s0 + (p.s1 - p.s0) * Math.sqrt(t)) / 2, a = p.a * (t < 0.08 ? t / 0.08 : 1 - (t - 0.08) / 0.92 * (t - 0.08) / 0.92);
      const cr = Math.cos(p.rot) * s, sr = Math.sin(p.rot) * s;
      POS[o] = p.x - cr + sr; POS[o + 1] = cy; POS[o + 2] = p.z - sr - cr;
      POS[o + 3] = p.x + cr + sr; POS[o + 4] = cy; POS[o + 5] = p.z + sr - cr;
      POS[o + 6] = p.x + cr - sr; POS[o + 7] = cy; POS[o + 8] = p.z + sr + cr;
      POS[o + 9] = p.x - cr - sr; POS[o + 10] = cy; POS[o + 11] = p.z - sr + cr;
      UVS.set([0, 0, 0.5, 0, 0.5, 1, 0, 1], u);
      for (let k = 0; k < 4; k++) { COLS[q + 4 * k] = C3.r; COLS[q + 4 * k + 1] = C3.g; COLS[q + 4 * k + 2] = C3.b; COLS[q + 4 * k + 3] = a; }
    } else {                                                          // a column: shoots up, then sinks back, wider and fading
      const up = Math.min(1, p.age / 0.22), h = p.h * Math.sqrt(up) * (1 - 0.65 * smooth(0.4, 1, t)), w = (p.s0 + (p.s1 - p.s0) * t) / 2;
      const a = p.a * (1 - smooth(0.3, 1, t)), l = Math.sqrt(dx * dx + dz * dz) || 1, rx = -dz / l * w, rz = dx / l * w, y0 = WATER_Y - 0.3;
      POS[o] = p.x - rx; POS[o + 1] = y0; POS[o + 2] = p.z - rz;
      POS[o + 3] = p.x + rx; POS[o + 4] = y0; POS[o + 5] = p.z + rz;
      POS[o + 6] = p.x + rx; POS[o + 7] = y0 + h; POS[o + 8] = p.z + rz;
      POS[o + 9] = p.x - rx; POS[o + 10] = y0 + h; POS[o + 11] = p.z - rz;
      UVS.set([0.5, 1, 1, 1, 1, 0, 0.5, 0], u);
      for (let k = 0; k < 4; k++) { COLS[q + 4 * k] = 1; COLS[q + 4 * k + 1] = 1; COLS[q + 4 * k + 2] = 1; COLS[q + 4 * k + 3] = a; }
    }
    n++;
  }
  mesh.subMeshes[0].indexCount = n * 6;
  if (n) {
    mesh.updateVerticesData(VertexBuffer.PositionKind, POS, false, false);
    mesh.updateVerticesData(VertexBuffer.ColorKind, COLS, false, false);
    mesh.updateVerticesData(VertexBuffer.UVKind, UVS, false, false);
  }
  mesh.setEnabled(n > 0);
  mat.setVector3('cam', c); mat.setFloat('fogStart', scene.fogStart); mat.setFloat('fogEnd', scene.fogEnd); mat.setColor3('fogColor', scene.fogColor);
}
const smooth = (a: number, b: number, t: number) => { const x = Math.max(0, Math.min(1, (t - a) / (b - a))); return x * x * (3 - 2 * x); };
// how many quads are in use (tests)
export const waterFxCount = () => POOL.reduce((n, p) => n + (p.on ? 1 : 0), 0);
