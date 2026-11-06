// World of DODO: quality and the performance readout.
// The original always draws at up to 2× pixel ratio with 2048 px soft shadows: too much for a weak (integrated) GPU, where the whole
// picture stutters. The quality level drops by itself when the game keeps missing frames while driving (below Q_MIN_FPS for two
// seconds in a row, not in the first seconds after a change), never rises by itself, and is remembered in this browser. Q cycles the
// level by hand (auto then stops for this visit; not in a ship, where Q launches the torpedoes). F, a tap on the speed card or ?stats shows FPS, the slowest frame, ping and the level.
import { setPixelRatio, setShadowSize, resize, scene, moon, shadow } from '../core/engine';
import { $, COARSE } from '../core/dom';
import { T } from '../texts';
import { G, car } from './state';
import { flash } from '../ui/hud';
import { sizeMini } from '../ui/minimap';
import { snow } from './fx';
import { NET } from '../net/net';
import { setMatLevel } from '../core/matlib';

export const Q_MIN_FPS = 45;
const BASE_PR = Math.min(window.devicePixelRatio || 1, COARSE ? 1.5 : 2);
// pr: drawn pixels per CSS pixel; shadow: shadow map size (0: no shadows); snow: the share of the flakes drawn; World of DODO, issue #27:
// shadowEvery: the shadow map drawn every n-th frame (medium: every other)
export const QUALITY = [
  { pr: BASE_PR, shadow: COARSE ? 1024 : 2048, snow: 1, shadowEvery: 1 },              // high: the original
  { pr: Math.min(BASE_PR, 1), shadow: 1024, snow: 1, shadowEvery: 2 },                 // medium: 1 pixel per CSS pixel, smaller shadow map
  { pr: Math.min(BASE_PR, 1) * 0.75, shadow: 0, snow: 0.5, shadowEvery: 1 },           // low: three quarters of the resolution, no shadows, half the snow
];
// World of DODO, issue #27: the shadow map's draw calls (every caster in the moon's box) are a third of a frame's on a laptop, whose
// CPU and not its GPU sets the frame rate; medium draws the map every other frame. In between the moon's shadow box stays where that
// map was drawn (main.ts moves it with the tank every frame, core/engine.ts moonAt): the map and its lookup always agree, only what
// moves casts a shadow updated at half the frame rate.
let shadowEvery = 1, shadowTick = 0;
const SHADOW_BOX = { x: 0, y: 0, z: 0, l: 0, r: 0, t: 0, b: 0, far: 0 };
scene.onBeforeRenderObservable.add(() => {                     // (before the shadow map is drawn, after main.ts placed the box)
  const map = shadow?.getShadowMap(); if (!map || shadowEvery <= 1) return;
  const B = SHADOW_BOX;
  if (shadowTick++ % shadowEvery === 0) {
    B.x = moon.position.x; B.y = moon.position.y; B.z = moon.position.z; B.far = moon.shadowMaxZ;
    B.l = moon.orthoLeft; B.r = moon.orthoRight; B.t = moon.orthoTop; B.b = moon.orthoBottom;
    map.resetRefreshCounter();                                  // drawn this frame
  } else {
    moon.position.set(B.x, B.y, B.z); moon.shadowMaxZ = B.far;
    moon.orthoLeft = B.l; moon.orthoRight = B.r; moon.orthoTop = B.t; moon.orthoBottom = B.b;
  }
});
function setShadowEvery(n: number) {
  shadowEvery = n; shadowTick = 0;
  const map = shadow?.getShadowMap(); if (map) map.refreshRate = n > 1 ? 0 : 1;   // 0: drawn only when asked (resetRefreshCounter)
}
// frames/ms/worst: this second so far; fps/low: the last second (low: its slowest frame, ms); bad: seconds in a row below Q_MIN_FPS;
// wait: seconds to ignore after a change; ping: smoothed round trip to the server (net/net.ts writes it); show: the readout is on
export const PERF = {
  frames: 0, ms: 0, worst: 0, fps: 0, low: 0, bad: 0, wait: 3, level: 0, auto: true, ping: 0,
  show: new URLSearchParams(location.search).has('stats'),
};

export function setQuality(l: number) {
  const q = QUALITY[l]; PERF.level = l;
  setPixelRatio(q.pr); resize(); sizeMini();
  setShadowSize(q.shadow);                                       // 0 switches the shadows off; another size rebuilds the shadow map
  setShadowEvery(q.shadowEvery);                                 // issue #27 (after a rebuilt map)
  snow.setFraction(q.snow);
  setMatLevel(l);                                                // issue #27: the material library's maps for this level
  try { localStorage.setItem('wod-quality', String(l)); } catch (_) { /* storage blocked: not remembered */ }
  renderStats();
}
// at boot: the level remembered in this browser, and the keys (F: the readout, Q: the next level by hand)
export function initQuality() {
  let l = 0;
  try { l = parseInt(localStorage.getItem('wod-quality') ?? '', 10) || 0; } catch (_) { /* storage blocked: high */ }
  if (l > 0) setQuality(Math.min(l, QUALITY.length - 1)); else renderStats();
  addEventListener('keydown', e => {
    if (e.target instanceof HTMLInputElement || e.repeat) return;
    if (e.code === 'KeyF') { PERF.show = !PERF.show; renderStats(); }
    // (World of DODO, issue #20: in a ship Q launches the torpedoes, game/ship.ts)
    else if (e.code === 'KeyQ' && !(G.state === 'drive' && car.k === 2)) { PERF.auto = false; setQuality((PERF.level + 1) % QUALITY.length); }
  });
  document.querySelector('.gauge')!.addEventListener('click', () => { PERF.show = !PERF.show; renderStats(); });
}
// once per frame with the real frame time (ms); once a second: FPS, the readout, and maybe a step down
export function perfTick(ms: number) {
  PERF.frames++; PERF.ms += ms; PERF.worst = Math.max(PERF.worst, ms);
  if (PERF.ms < 1000) return;
  PERF.fps = Math.round(PERF.frames * 1000 / PERF.ms); PERF.low = Math.round(PERF.worst); PERF.frames = PERF.ms = PERF.worst = 0;
  if (G.state === 'drive' && PERF.auto && PERF.level < QUALITY.length - 1) {
    if (PERF.wait > 0) PERF.wait--;
    else if (PERF.fps < Q_MIN_FPS) { if (++PERF.bad >= 2) { PERF.bad = 0; PERF.wait = 3; setQuality(PERF.level + 1); flash(T.qDown(T.qNames[PERF.level])); } }
    else PERF.bad = 0;
  }
  renderStats();
}
export function renderStats() {
  const el = $('stats'); el.hidden = !PERF.show; if (!PERF.show) return; el.textContent = '';
  [PERF.fps + ' FPS · max ' + PERF.low + ' ms', T.pingLbl + ' ' + (NET.live && PERF.ping ? Math.round(PERF.ping) + ' ms' : '–'),
    T.qLbl + ': ' + T.qNames[PERF.level] + ' (' + (PERF.auto ? T.qAuto : T.qManual) + (COARSE ? '' : ' · Q') + ')']
    .forEach(t => { const s = document.createElement('span'); s.textContent = t; el.appendChild(s); });
}
