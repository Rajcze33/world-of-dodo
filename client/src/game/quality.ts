// World of DODO: quality and the performance readout.
// The original always draws at up to 2× pixel ratio with 2048 px soft shadows: too much for a weak (integrated) GPU, where the whole
// picture stutters. Q cycles the preset (high, medium, low) by hand (not in a ship, where Q launches the torpedoes). F, a tap on the
// speed card or ?stats shows FPS, the slowest frame, ping and the quality.
//
// World of DODO, issue #34: the automatic quality. It used to drop a whole preset when the game ran under 45 FPS for two seconds,
// and it remembered the drop. A laptop's integrated GPU never reaches 45 here, so every visit walked from high to low within ten
// seconds of driving, and low has no textures at all: the streets turned flat a moment after the start, and the next visit started
// flat (issue #34, "drive a little and the roads are worse again"). Measured on such a laptop (the issue's lever probe), the
// render scale and the shadows buy most of the frame time and are hardly seen, the textures buy little and are what everyone sees.
// So the automatic quality now works on top of the chosen preset with a ladder of small steps (LADDER), cheapest to see first, and
// the textures are the last step, taken only when the game is really slow (Q_TEX_FPS). Every step down says so in the toast; a step
// comes back up when the game has room again; and only the steps before the textures are remembered for the next visit.
import { setPixelRatio, setShadowSize, resize, scene, moon, shadow } from '../core/engine';
import { $, COARSE } from '../core/dom';
import { T } from '../texts';
import { G, car } from './state';
import { flash } from '../ui/hud';
import { LOAD } from '../ui/loading';
import { sizeMini } from '../ui/minimap';
import { snow } from './fx';
import { NET } from '../net/net';
import { setMatLevel } from '../core/matlib';

// World of DODO, issue #34: the thresholds (FPS, a second's average). Down when 3 of the last 4 seconds are under Q_DOWN_FPS: at
// 60 Hz the steady rate below 60 is 30 (a frame every other refresh), and under 27 a fifth of the frames miss even that (stutter).
// The textures only when 4 of the last 5 are under Q_TEX_FPS, from the step before them. Up after Q_UP_SECS seconds in a row at
// Q_UP_FPS or more (a busy moment has passed). Q_WAIT seconds are not judged after entering the game or after any change (the
// change's own long frame, the shaders it compiles).
export const Q_DOWN_FPS = 27, Q_TEX_FPS = 20, Q_UP_FPS = 50;
const Q_UP_SECS = 10, Q_WAIT = 4;
// a step that has to come down again within this long after it went up stays down for the rest of the visit (no flapping, ms)
const Q_PIN_MS = 30000;
const BASE_PR = Math.min(window.devicePixelRatio || 1, COARSE ? 1.5 : 2), PR1 = Math.min(BASE_PR, 1);
// pr: drawn pixels per CSS pixel; shadow: shadow map size (0: no shadows); snow: the share of the flakes drawn; World of DODO, issue #27:
// shadowEvery: the shadow map drawn every n-th frame (medium: every other)
export const QUALITY = [
  { pr: BASE_PR, shadow: COARSE ? 1024 : 2048, snow: 1, shadowEvery: 1 },              // high: the original
  { pr: PR1, shadow: 1024, snow: 1, shadowEvery: 2 },                                  // medium: 1 pixel per CSS pixel, smaller shadow map
  { pr: PR1 * 0.75, shadow: 0, snow: 0.5, shadowEvery: 1 },                            // low: three quarters of the resolution, no shadows, half the snow
];
// World of DODO, issue #34: what is drawn: a preset's values, lowered by the automatic steps; tex the material library's level
// (core/matlib.ts: 0 high, 1 medium, 2 low)
export interface Look { pr: number; shadow: number; snow: number; shadowEvery: number; tex: number }
// The automatic steps a1..a5, cumulative, each the lower of the preset's value and its own, in the order of what they buy per what
// they cost the look (issue #34's lever probe, a laptop's integrated GPU at 1536×730 and 125 %: the render scale to 1 +3..5 FPS, the
// shadow map at 1024 every other frame with it +6, the render scale to 0.75 +6..8, no shadows +4..6, the textures off +4..8). Medium
// textures are no step: they bought +1..3 and flatten the ground. A step that changes nothing for the preset (medium is drawn at 1
// pixel per CSS pixel already) is passed over.
export const LADDER: ((q: Look) => void)[] = [
  q => { q.pr = Math.min(q.pr, PR1); },                                                                       // a1 the render scale 1
  q => { if (q.shadow) { q.shadow = Math.min(q.shadow, 1024); q.shadowEvery = Math.max(q.shadowEvery, 2); } }, // a2 the shadow map 1024, every other frame
  q => { q.pr = Math.min(q.pr, PR1 * 0.75); },                                                                // a3 the render scale 0.75
  q => { q.shadow = 0; q.shadowEvery = 1; q.snow = Math.min(q.snow, 0.5); },                                  // a4 no shadows, half the snow
  q => { q.tex = 2; },                                                                                        // a5 the textures off
];
const TEX_STEP = LADDER.length;
// what preset m at automatic step s draws
export function look(m: number, s: number): Look {
  const q = QUALITY[m], l: Look = { pr: q.pr, shadow: q.shadow, snow: q.snow, shadowEvery: q.shadowEvery, tex: m };
  for (let k = 0; k < s && k < LADDER.length; k++) LADDER[k](l);
  return l;
}
const same = (a: Look, b: Look) => a.pr === b.pr && a.shadow === b.shadow && a.snow === b.snow && a.shadowEvery === b.shadowEvery && a.tex === b.tex;
// does step k (1..5) change anything for preset m?
const real = (m: number, k: number) => !same(look(m, k), look(m, k - 1));

// World of DODO, issue #27: the shadow map's draw calls (every caster in the moon's box) are a third of a frame's on a laptop; medium
// draws the map every other frame. In between the moon's shadow box stays where that
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
// frames/ms/worst: this second so far; fps/low: the last second (low: its slowest frame, ms); wait: seconds not judged after a
// change; ping: smoothed round trip to the server (net/net.ts writes it); show: the readout is on. World of DODO, issue #34: level
// the preset (Q), step the automatic step on top of it (0: none, 1..5: a1..a5), auto: the automatic quality is on (Q turns it off
// for this visit)
export const PERF = {
  frames: 0, ms: 0, worst: 0, fps: 0, low: 0, wait: Q_WAIT, level: 0, step: 0, auto: true, ping: 0,
  show: new URLSearchParams(location.search).has('stats'),
};
// World of DODO, issue #34: the last seconds' FPS (judged ones only, the newest last), the lowest step auto may go back up to (a step
// that flapped stays), the last step up (when, and from which step), and what is drawn now (the engine's state as set at boot:
// core/engine.ts draws the high preset until told otherwise; the library's level is read by core/matlib.ts itself)
const HIST: number[] = [];
let floor = 0, upAt = -Infinity, upFrom = 0;
let CUR: Look = look(0, 0);

// World of DODO, issue #34: remembered in this browser as 'wod-q' = { m: the preset, a: the automatic step, at most a4 }: the textures'
// step is never remembered (a slow moment must not cost the next visit its textures). The old 'wod-quality' mixed the automatic drops
// with Q's choices, and the bug of issue #34 left most players on low: it is ignored and removed, so they start on high again.
const KEY = 'wod-q';
function save() {
  try { localStorage.setItem(KEY, JSON.stringify({ m: PERF.level, a: Math.min(PERF.step, TEX_STEP - 1) })); } catch (_) { /* storage blocked: not remembered */ }
}
function remembered(): { m: number; a: number } {
  let m = 0, a = 0;
  try {
    localStorage.removeItem('wod-quality');
    const j = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { m?: unknown; a?: unknown } | null;
    if (j) { m = Math.max(0, Math.min(QUALITY.length - 1, Number(j.m) | 0)); a = Math.max(0, Math.min(TEX_STEP - 1, Number(j.a) | 0)); }
  } catch (_) { /* storage blocked or garbled: high */ }
  // World of DODO, issue #34: a visit starts one step better than the last one ended: the ladder only steps up at 50 fps, which a laptop
  // that once had a busy moment may never reach, so without this one dip would cost shadows and resolution for every later visit. A
  // device that really needs the step takes it again within seconds (and says so).
  return { m, a: settle(m, Math.max(0, a - 1)) };
}
// a step that changes nothing for the preset is the step before it (the remembered one of another preset, or a passed-over one)
function settle(m: number, s: number) { while (s > 0 && !real(m, s)) s--; return s; }

// draws what the preset and the step say; only what changed is touched (a new shadow map and the shaders it makes cost a frame, a
// new render scale a resize)
function draw(l: Look) {
  const was = CUR; CUR = l;
  if (l.pr !== was.pr) { setPixelRatio(l.pr); resize(); sizeMini(); }
  if (l.shadow !== was.shadow) setShadowSize(l.shadow);           // 0 switches the shadows off; another size rebuilds the shadow map
  if (l.shadow !== was.shadow || l.shadowEvery !== was.shadowEvery) setShadowEvery(l.shadowEvery);   // issue #27 (after a rebuilt map)
  if (l.snow !== was.snow) snow.setFraction(l.snow);
  setMatLevel(l.tex);                                             // issue #27: the material library's maps for this level (a no-op if the same)
}
// World of DODO, issue #34: the preset l (Q, the tests) and the automatic step on top of it (default none); remembered
export function setQuality(l: number, step = 0) {
  PERF.level = Math.max(0, Math.min(QUALITY.length - 1, l | 0)); PERF.step = settle(PERF.level, Math.max(0, Math.min(TEX_STEP, step | 0)));
  draw(look(PERF.level, PERF.step));
  save();
  HIST.length = 0; PERF.wait = Q_WAIT;
  renderStats();
}
// at boot: the preset and the step remembered in this browser, and the keys (F: the readout, Q: the preset by hand)
let KEPT = 0;                                                    // issue #34: the remembered step, said once when the game begins
export function initQuality() {
  const r = remembered();
  KEPT = r.a;
  if (r.m || r.a) setQuality(r.m, r.a); else { save(); renderStats(); }
  addEventListener('keydown', e => {
    if (e.target instanceof HTMLInputElement || e.repeat) return;
    if (e.code === 'KeyF') { PERF.show = !PERF.show; renderStats(); }
    // (World of DODO, issue #20: in a ship Q launches the torpedoes, game/ship.ts.) World of DODO, issue #31: not before the city is
    // built and not while loading: a level change swaps materials and maps, which would undo the shaders and textures made ready
    else if (e.code === 'KeyQ' && G.state !== 'load' && LOAD.isDone('city') && !(G.state === 'drive' && car.k === 2)) qPress();
  });
  document.querySelector('.gauge')!.addEventListener('click', () => { PERF.show = !PERF.show; renderStats(); });
}
// World of DODO, issue #34: Q. The first press after the automatic quality lowered anything gives the preset back as it is (the
// player asked for the look, not for another preset); otherwise the next preset, as before. Either way the automatic quality is off
// for this visit, and the toast says what Q chose (a change by hand used to say nothing).
function qPress() {
  const back = PERF.auto && PERF.step > 0;
  PERF.auto = false;
  setQuality(back ? PERF.level : (PERF.level + 1) % QUALITY.length);
  flash(T.qSet(T.qNames[PERF.level]), 1);
}
// World of DODO, issue #31: into the game: the second being measured starts now (the frames behind the loading screen and the time
// it took do not count), and the first seconds are not judged (the game's first moments: the last cells, a late texture).
// World of DODO, issue #34: a step remembered from the last visit is said once per page, when the game begins.
export function perfReset() {
  PERF.frames = PERF.ms = PERF.worst = 0; HIST.length = 0; PERF.wait = Math.max(PERF.wait, Q_WAIT);
  if (KEPT && PERF.auto && PERF.step) flash(T.qKept(stepNames().join(', ')), 1, 5000);
  KEPT = 0;
}
// World of DODO, issue #34: the names of the steps taken (a1 and a3 both lower the resolution: named once)
function stepNames(): string[] {
  const n: string[] = [];
  for (let k = 1; k <= PERF.step; k++) if (real(PERF.level, k) && !n.includes(T.qLevers[k - 1])) n.push(T.qLevers[k - 1]);
  return n;
}
// how many of the last n judged seconds were under fps
const under = (n: number, fps: number) => HIST.slice(-n).filter(f => f < fps).length;
// World of DODO, issue #34: once a judged second: a step down (said in the toast, priority over the zones' news) or up (silent)
function judge() {
  const m = PERF.level, s = PERF.step;
  let down = s + 1; while (down <= TEX_STEP && !real(m, down)) down++;
  if (down <= TEX_STEP && (down < TEX_STEP ? under(4, Q_DOWN_FPS) >= 3 : s === TEX_STEP - 1 && under(5, Q_TEX_FPS) >= 4)) {
    const t = performance.now();
    if (t - upAt < Q_PIN_MS && down >= upFrom) floor = Math.max(floor, upFrom);   // it went up from here a moment ago: it stays
    setQuality(m, down);
    flash(T.qStep(T.qLevers[down - 1]) + (down === TEX_STEP && !COARSE ? T.qBack : ''), 1, 5000);
    return;
  }
  if (s > floor && HIST.length >= Q_UP_SECS && HIST.slice(-Q_UP_SECS).every(f => f >= Q_UP_FPS)) {
    let up = s - 1; while (up > 0 && !real(m, up)) up--;
    upAt = performance.now(); upFrom = s;
    setQuality(m, Math.max(up, floor));
  }
}
// once per frame with the real frame time (ms); once a second: FPS, the readout, and maybe a step
export function perfTick(ms: number) {
  PERF.frames++; PERF.ms += ms; PERF.worst = Math.max(PERF.worst, ms);
  if (PERF.ms < 1000) return;
  PERF.fps = Math.round(PERF.frames * 1000 / PERF.ms); PERF.low = Math.round(PERF.worst); PERF.frames = PERF.ms = PERF.worst = 0;
  if (G.state === 'drive' && PERF.auto) {
    if (PERF.wait > 0) PERF.wait--;
    else { HIST.push(PERF.fps); if (HIST.length > Q_UP_SECS) HIST.shift(); judge(); }
  }
  renderStats();
}
// World of DODO, issue #34: the quality line of the readout: the preset, then the automatic steps taken (or auto / by hand), and Q
export function qualityLabel(): string {
  const n = stepNames();
  return T.qLbl + ': ' + T.qNames[PERF.level] + ' · ' + (!PERF.auto ? T.qManual : n.length ? T.qAutoLbl + ' ' + n.join(', ') : T.qAuto) + (COARSE ? '' : ' · Q');
}
export function renderStats() {
  const el = $('stats'); el.hidden = !PERF.show; if (!PERF.show) return; el.textContent = '';
  [PERF.fps + ' FPS · max ' + PERF.low + ' ms', T.pingLbl + ' ' + (NET.live && PERF.ping ? Math.round(PERF.ping) + ' ms' : '–'), qualityLabel()]
    .forEach(t => { const s = document.createElement('span'); s.textContent = t; el.appendChild(s); });
}
