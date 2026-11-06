// ---------- World of DODO, issue #26: Velemlok in the HUD ----------
// What the page shows of Velemlok (game/monster.ts keeps the state, world/monster.ts draws the monster):
// - in a ship, a chip on the ship's card (client/index.html #seaMon): the countdown to its next appearance, the same for everyone
//   (obj.g.next is the server's moment), and "Velemlok je ve Vltavě!" while it is there; the other vehicles get only the toasts when
//   it surfaces and when it leaves;
// - while it is in the water, a row in the team bar (#tbMon): its hit points, the damage race of team A against B, the time until it
//   swims off;
// - its hit points over it in the 3D view (#monTag, placed every frame like the name tags);
// - when it leaves, a banner (#monRes) for a few seconds: killed or fled, the winning team and its bonus, the damage A : B, who hurt it
//   most; and the same in the toast.
// Elements change only when what they show changes.
import { Matrix } from '@babylonjs/core';
import { camera } from '../core/engine';
import { $ } from '../core/dom';
import { now } from '../core/util';
import { T } from '../texts';
import { G, car } from '../game/state';
import { NET, netName } from '../net/net';
import { TM, teamName, teamCss } from '../game/teams';
import { MON, monLeft } from '../game/monster';
import { flash } from './hud';

// mres as the server sends it (docs/PROTOCOL.md): killed or fled, the damage of A and B, the winner (-1 none: a tie, or the round's end
// sent it away, end 1), the team bonus given, the three who hurt it most as [id, damage]
export interface MonRes { killed: boolean; dmg: number[]; win: number; pts: number; top?: number[][]; end?: number }

const SHOWN: Record<string, string> = {};
function setText(id: string, s: string) { if (SHOWN[id] !== s) { SHOWN[id] = s; $(id).textContent = s; } }
function setHidden(id: string, h: boolean) { const el = $(id); if (el.hidden !== h) el.hidden = h; }
function setCls(id: string, c: string) { if (SHOWN['c' + id] !== c) { SHOWN['c' + id] = c; $(id).className = c; } }
const clock = (s: number) => { const t = Math.max(0, Math.ceil(s)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
const out = () => MON.known && MON.st !== 0;

// every frame while playing (main.ts)
let resUntil = 0;
export function monHud() {
  // the ship's chip: the countdown, or that it is here
  if (car.k === 2) {
    const left = monLeft();
    let s = '', c = 'chip mon';
    if (MON.st === 1 || MON.st === 2) { s = T.monHere; c += ' on'; }
    else if (MON.st === 3) s = MON.dhp <= 0 ? T.monDown : T.monLeaving;
    else if (MON.known && left > 0) s = T.monIn(clock(left));
    else if (MON.known) s = T.monSoon;
    setHidden('seaMon', !s); setText('seaMonT', s); setCls('seaMon', c);
  }
  // the team bar's row while it is in the water: its hit points, the damage A : B, the time until it swims off
  const show = out() && TM.on;
  setHidden('tbMon', !show);
  if (show) {
    const hp = MON.on ? Math.min(MON.dhp, MON.hp || MON.dhp) : MON.hp, f = Math.max(0, Math.min(1, hp / (MON.max || 1)));
    const w = (f * 100).toFixed(1) + '%'; if (SHOWN.hpw !== w) { SHOWN.hpw = w; $('tbMonHp').style.width = w; }
    setText('tbMonA', String(Math.round(MON.dmg[0]))); setText('tbMonB', String(Math.round(MON.dmg[1])));
    const left = monLeft();
    setText('tbMonT', MON.st === 2 && left > 0 ? clock(left) : MON.st === 3 ? '' : '…');
    setCls('tbMon', 'tb-mon' + (MON.st === 3 ? ' gone' : '') + (MON.dmg[0] > MON.dmg[1] ? ' lead0' : MON.dmg[1] > MON.dmg[0] ? ' lead1' : ''));
  }
  if (resUntil && now() > resUntil) { resUntil = 0; setHidden('monRes', true); }
}
// the menu (main.ts backToMenu): nothing of it shows
export function monHudOff() { resUntil = 0; for (const id of ['monRes', 'tbMon', 'monTag']) setHidden(id, true); }

// it left (game/monster.ts on mres): the banner and the toast
export function showMonResult(r: MonRes) {
  if (G.state !== 'drive') return;
  const w = r.win === 0 || r.win === 1 ? r.win : -1, a = Math.round(r.dmg[0] || 0), b = Math.round(r.dmg[1] || 0);
  setText('mrHead', r.killed ? T.monKilled : r.end ? T.monRoundEnd : T.monFled);
  setText('mrWin', w >= 0 ? T.monWin(teamName(w), r.pts) : r.end ? '' : T.monTie);
  $('monRes').style.setProperty('--wc', w >= 0 ? teamCss(w) : 'var(--dodo-white)');
  setText('mrA', String(a)); setText('mrB', String(b));
  const top = Array.isArray(r.top) ? r.top.filter(e => Array.isArray(e)).slice(0, 3) : [];
  setText('mrTop', top.length ? T.monTop(top.map(([id, d]) => (id === NET.id ? NET.name : netName(id)) + ' ' + Math.round(d)).join(', ')) : '');
  setHidden('mrTop', !top.length);
  setHidden('monRes', false); resUntil = now() + 8000;
  flash(r.killed ? T.monKilledToast(w >= 0 ? teamName(w) : '', r.pts) : r.end ? T.monRoundEnd : T.monFledToast(w >= 0 ? teamName(w) : '', r.pts));
}

// ---------- its hit points over it ----------
// A DOM element over the canvas (as the name tags, net/net.ts placeTags): its name and a bar, over the highest of its spheres; hidden
// behind the camera, far off (beyond 600) or while it is under. Call it after the camera has moved.
const VP = new Matrix();
export function placeMonTag() {
  const el = $('monTag');
  if (!MON.on || MON.pose.y < -7 || G.state !== 'drive') { if (!el.hidden) el.hidden = true; return; }
  let top = -1e9, x = 0, z = 0;
  for (const s of MON.sph) if (s[1] + s[3] > top) { top = s[1] + s[3]; x = s[0]; z = s[2]; }
  const y = top + 5, c = camera.position;
  if ((x - c.x) ** 2 + (z - c.z) ** 2 > 600 * 600) { if (!el.hidden) el.hidden = true; return; }
  const m = camera.getViewMatrix().multiplyToRef(camera.getProjectionMatrix(), VP).m, w = x * m[3] + y * m[7] + z * m[11] + m[15];
  if (w <= camera.minZ) { if (!el.hidden) el.hidden = true; return; }
  const sx = (x * m[0] + y * m[4] + z * m[8] + m[12]) / w, sy = (x * m[1] + y * m[5] + z * m[9] + m[13]) / w;
  if (el.hidden) el.hidden = false;
  el.style.transform = `translate(${((sx + 1) / 2 * innerWidth).toFixed(1)}px,${((1 - sy) / 2 * innerHeight).toFixed(1)}px) translate(-50%,-100%)`;
  const f = Math.max(0, Math.min(1, MON.dhp / (MON.max || 1))), wd = (f * 100).toFixed(1) + '%';
  if (SHOWN.tagw !== wd) { SHOWN.tagw = wd; $('monTagHp').style.width = wd; }
}
