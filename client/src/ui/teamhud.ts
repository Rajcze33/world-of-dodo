// ---------- World of DODO, issue #24: the team's HUD ----------
// The team bar at the top (client/index.html #teamBar): the two teams' scores (mine underlined), the round's clock, a bar each growing
// from its side towards the round's points, and a chip per zone (its first letter on its owner's colour, under it how far the capture
// has got, in the colour of the team it leans to; the zone I stand in ringed). The capture meter over the toast while my tank (or on
// the river my ship) stands in a zone: its name, how it goes, the capture from B's side to A's. The round's banner in the middle of the
// screen in the break after a round: the winner, the score, the best players, the countdown to the next round. game/teams.ts keeps the
// state (TM); this draws it every frame while playing, touching an element only when what it shows changes.
import { $ } from '../core/dom';
import { T } from '../texts';
import { TEAM_COL, ZONES, zoneAt } from '../../shared/rules.ts';
import { hexCss, now } from '../core/util';
import { G, car, K, input } from '../game/state';
import { TM, zoneP, zoneName, teamName, teamCss, teamOf } from '../game/teams';
import { NET, netName } from '../net/net';
import { flash } from './hud';

// main.ts calls this once at boot: the team colours into the page's styles (--team0, --team1: the join form, the bar, the board), the
// zone chips (a ground zone's first letter, the river's waves)
export function buildTeamHud() {
  const st = document.documentElement.style; TEAM_COL.forEach((c, t) => st.setProperty('--team' + t, hexCss(c)));
  $('zones').innerHTML = ZONES.map(z => '<span class="zc' + (z.sea ? ' sea' : '') + '"><b></b><i></i></span>').join('');
  document.querySelectorAll<HTMLElement>('#zones .zc').forEach((el, i) => {
    const nm = zoneName(i); el.querySelector('b')!.textContent = ZONES[i].sea ? '≈' : nm.charAt(0).toUpperCase(); el.title = nm; el.setAttribute('aria-label', nm);
  });
  document.querySelectorAll<HTMLInputElement>('#joinForm input[name=team]').forEach(r => { if (r.value !== 'auto') r.setAttribute('aria-label', T.teamAria(teamName(Number(r.value)))); });
}

const SHOWN: Record<string, string> = {};
function setText(id: string, s: string) { if (SHOWN[id] !== s) { SHOWN[id] = s; $(id).textContent = s; } }
function setStyle(el: HTMLElement, key: string, prop: string, v: string) { if (SHOWN[key] !== v) { SHOWN[key] = v; el.style.setProperty(prop, v); } }
function setCls(el: HTMLElement, key: string, v: string) { if (SHOWN[key] !== v) { SHOWN[key] = v; el.className = v; } }
function setHidden(id: string, h: boolean) { const el = $(id); if (el.hidden !== h) el.hidden = h; }
const clock = (s: number) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
// the seconds left of the round (or of the break after it), counted down here between the server's messages
export const roundLeft = () => Math.max(0, TM.left - (now() - TM.at) / 1000);
// the zone my vehicle captures now: a tank in a ground zone, a ship in the river zone; -1 elsewhere, in a plane, destroyed, in the break
export function myZone(): number {
  if (G.hold || car.topT > 0 || car.k === 1) return -1;
  return zoneAt(car.x, car.z, car.k === 2);
}
// how many of the enemy's tanks (in the river zone ships) stand in zone i as this browser draws them
function enemiesIn(i: number): number {
  const sea = ZONES[i].sea; let n = 0;
  for (const o of NET.others.values()) if (o.on && o.s !== 2 && o.team >= 0 && o.team !== NET.team && o.k === (sea ? 2 : 0) && zoneAt(o.x, o.z, sea) === i) n++;
  return n;
}

// every frame while playing (main.ts)
export function teamHud() {
  setHidden('teamBar', !TM.on);
  if (!TM.on) { setHidden('cap', true); setHidden('roundEnd', true); return; }
  // the scores, a bar each from its side (half the bar is the round's points), my team's name underlined
  for (const t of [0, 1]) {
    setText('tbP' + t, String(Math.round(TM.sc[t])));
    setCls($('tbS' + t), 'cs' + t, 'tb-sc' + (t ? ' r' : '') + (t === NET.team ? ' me' : ''));
    setStyle($('tbB' + t), 'bw' + t, 'width', Math.min(50, TM.sc[t] / TM.to * 50).toFixed(1) + '%');
  }
  setText('tbClock', clock(roundLeft()));
  // the zones: the owner's colour, the capture's progress in the colour it leans to, mine ringed
  const mz = myZone();
  document.querySelectorAll<HTMLElement>('#zones .zc').forEach((el, i) => {
    const own = TM.z[i] ? TM.z[i][0] : -1, p = zoneP(i);
    setCls(el, 'zc' + i, 'zc' + (ZONES[i].sea ? ' sea' : '') + (own >= 0 ? ' o' + own : '') + (i === mz ? ' mine' : ''));
    const bar = el.querySelector('i')!;
    setStyle(bar, 'zw' + i, 'width', Math.abs(p).toFixed(0) + '%');
    setStyle(bar, 'zp' + i, '--pc', teamCss(p > 0 ? 0 : p < 0 ? 1 : -1));
  });
  // the capture meter: the zone I stand in; from the middle towards A's side (left, as on the bar) or B's
  setHidden('cap', mz < 0);
  if (mz >= 0) {
    const p = zoneP(mz), own = TM.z[mz][0];
    setText('capNm', zoneName(mz));
    setText('capSt', enemiesIn(mz) ? T.capContest : own === NET.team && Math.abs(p) >= 99.5 ? T.capHeld : T.capTaking);
    const f = $('capFill'), w = Math.abs(p) / 2;
    setStyle(f, 'cl', 'left', (p > 0 ? 50 - w : 50).toFixed(1) + '%'); setStyle(f, 'cw', 'width', w.toFixed(1) + '%');
    setStyle(f, 'cc', '--pc', teamCss(p > 0 ? 0 : p < 0 ? 1 : -1));
  }
  // the break after a round: the banner; firing then says why it does nothing
  setHidden('roundEnd', TM.st !== 'end');
  if (TM.st === 'end') {
    banner();
    setText('reNext', T.roundNext(Math.ceil(roundLeft())));
    if (K.fire || input.lmb) flash(T.hold);
  }
}
// the banner's content, once per round's end (the best players' names as this browser knows them)
function banner() {
  const key = TM.win + '|' + TM.sc.join() + '|' + TM.best.map(b => b.join(':')).join();
  if (SHOWN.banner === key) return; SHOWN.banner = key;
  const w = TM.win;
  $('reWin').textContent = w === 0 || w === 1 ? T.roundWin(teamName(w)) : T.roundDraw;
  $('roundEnd').style.setProperty('--wc', w === 0 || w === 1 ? teamCss(w) : 'var(--dodo-white)');
  $('reYou').textContent = (w === 0 || w === 1) && NET.team >= 0 ? T.roundYou[w === NET.team ? 1 : 0] : '';
  $('reA').textContent = String(Math.round(TM.sc[0])); $('reB').textContent = String(Math.round(TM.sc[1]));
  const ol = $('reBest'); ol.innerHTML = '';
  for (const [id, pts] of TM.best.slice(0, 5)) {
    const li = document.createElement('li'); li.innerHTML = '<i></i><span></span><b></b>';
    li.style.setProperty('--tc', teamCss(teamOf(id)));
    li.querySelector('span')!.textContent = id === NET.id ? NET.name : netName(id); li.querySelector('b')!.textContent = String(pts);
    if (id === NET.id) li.style.fontWeight = '600';
    ol.appendChild(li);
  }
  $('reBest').previousElementSibling!.toggleAttribute('hidden', !TM.best.length);
}
