// The join form on the intro screen: a name, a tank colour, the vehicle and the team, all remembered in this browser for the next
// time, nothing else.
//
// World of DODO, issue #31: the form lives in the page's first, light script (entry.ts), not in main.ts, so it works the moment the
// page shows, while the game's code is still loading and the city is built behind it. Nothing here may import Babylon or the map:
// that would pull them into the first script. What the 3D needs from the form (the tank's paint as the colour changes) goes through
// JOIN_HOOK, which main.ts fills once it runs. TANK_COLORS, cleanName, botName and joinErr moved here from net/net.ts for the same
// reason (net.ts imports them from here).
import { $, COARSE } from '../core/dom';
import { hexCss } from '../core/util';
import { T } from '../texts';
import { LOAD } from './loading';

// what a start asks for: the name (cleaned), the colour, 0 tank / 1 plane (issue #14) / 2 ship (issue #20), the team (issue #24:
// automatic, A or B; the server may still even the teams)
export interface Join { name: string; color: number; veh: 0 | 1 | 2; team: 'auto' | 0 | 1 }
// the form as it stands now (filled from this browser's storage by joinForm); a start takes a copy (LOAD.open)
export const JOIN: Join = { name: '', color: 0, veh: 0, team: 'auto' };
// what the game wants to hear from the form once it is loaded: paint, the tank's own paint for a new colour (main.ts); texAgain,
// whether a Start now waits for the textures again (main.ts texAgainNow, issue #31)
export const JOIN_HOOK: { paint?: (color: number) => void; texAgain?: () => boolean } = {};

// the colours a player can pick; the server accepts only these (COLORS in server/server.js, same order)
export const TANK_COLORS = [0x00a99a, 0xf9aa8f, 0x4d8dff, 0xf2c94c, 0x9b6bff, 0xff7eb6, 0x5ad1e6, 0xff9f43, 0xa3d977, 0xeaebeb, 0x7b8cff, 0xc59b6d];
// the same cleaning as on the server: no control or invisible characters, no < >, at most 16 characters
export function cleanName(s: unknown) {
  const t = String(s || '').normalize('NFC').replace(/[\p{C}<>]/gu, '').replace(/\s+/g, ' ').trim();
  return Array.from(t).slice(0, 16).join('').trim();
}
export const botName = (s: string) => /^bot\s*\d+$/i.test(s);   // BOT1, bot 2, ...: kept for the bots
// the line under the form (role=alert): why the start did not happen; '' hides it
export function joinErr(msg: string) { const e = $('joinErr'); e.textContent = msg; e.hidden = !msg; }

// the name field; the start button
const nameIn = () => $<HTMLInputElement>('nameIn');

// World of DODO, issue #31: a plane or a ship aims with the mouse, which needs the pointer locked, and the browser allows that only
// in answer to a click. Locking it at the start button while the game still loads for seconds would hide the cursor over the
// loading screen (and its Cancel button) for nothing, so only when only the network is left (the city and the textures are in);
// otherwise the game's hint asks for a click into the game (T.hintLock, T.hintLockShip).
function lockAtClick() {
  if (JOIN.veh === 0 || COARSE || !LOAD.isDone('city') || !LOAD.isDone('tex')) return;
  // World of DODO, issue #31: maps asked for again since the textures' step was done (Q in the menu, or the automatic quality drop in
  // the game before an Esc) make the start wait for them (main.ts startRun, texAgain) although the step still reads done here: no lock
  if (JOIN_HOOK.texAgain?.()) return;
  try {
    const p = $('gl').requestPointerLock() as unknown as Promise<void> | undefined;
    p?.catch?.(() => { /* refused: the hint stays */ });
  } catch (_) { /* not allowed now */ }
}

// Fills the form from this browser's storage, keeps JOIN in step with it, and starts on submit. Called once, by entry.ts.
export function joinForm() {
  let savedColor = NaN;
  const nm = nameIn();
  try { nm.value = localStorage.getItem('wod-name') || ''; savedColor = parseInt(localStorage.getItem('wod-color') ?? '', 16); } catch (_) { /* storage blocked */ }
  JOIN.color = TANK_COLORS.includes(savedColor) ? savedColor : TANK_COLORS[Math.random() * TANK_COLORS.length | 0];
  $('swatches').innerHTML = TANK_COLORS.map((c, i) => '<label class="sw"><input type="radio" name="color" value="' + i + '"' + (c === JOIN.color ? ' checked' : '') + '><span style="background:' + hexCss(c) + '"></span></label>').join('');
  document.querySelectorAll<HTMLInputElement>('#swatches input').forEach(r => {
    r.setAttribute('aria-label', T.colorNames[Number(r.value)]);
    r.addEventListener('change', () => { JOIN.color = TANK_COLORS[Number(r.value)]; JOIN_HOOK.paint?.(JOIN.color); });
  });
  // World of DODO, issue #14: the vehicle, a tank or a plane (issue #20: or a ship), remembered too
  const veh = (v: string | null) => (v === '1' ? 1 : v === '2' ? 2 : 0) as 0 | 1 | 2;
  try { JOIN.veh = veh(localStorage.getItem('wod-veh')); } catch (_) { /* storage blocked */ }
  document.querySelectorAll<HTMLInputElement>('input[name=veh]').forEach(r => {
    r.checked = Number(r.value) === JOIN.veh;
    r.addEventListener('change', () => { JOIN.veh = veh(r.value); });
  });
  // World of DODO, issue #24: the team, automatic (the server evens the teams), A or B (the server may still put you into the other one
  // if yours has two people more), remembered too
  const team = (v: string | null) => (v === '0' ? 0 : v === '1' ? 1 : 'auto') as 'auto' | 0 | 1;
  try { JOIN.team = team(localStorage.getItem('wod-team')); } catch (_) { /* storage blocked */ }
  document.querySelectorAll<HTMLInputElement>('input[name=team]').forEach(r => {
    r.checked = team(r.value) === JOIN.team;
    r.addEventListener('change', () => { JOIN.team = team(r.value); });
  });
  $('joinForm').addEventListener('submit', e => {
    e.preventDefault();
    if (LOAD.reloadOnly) { location.reload(); return; }              // issue #31: a part of the game was not downloaded (LOAD.fail 'reload')
    const b = $<HTMLButtonElement>('startBtn'); if (b.disabled || LOAD.isOpen()) return;
    const name = cleanName(nm.value); if (!name || botName(name)) { joinErr(name ? T.errReserved : T.errName); nm.focus(); return; }
    JOIN.name = name;
    try { localStorage.setItem('wod-name', name); localStorage.setItem('wod-color', JOIN.color.toString(16)); localStorage.setItem('wod-veh', String(JOIN.veh)); localStorage.setItem('wod-team', String(JOIN.team)); } catch (_) { /* storage blocked: not remembered */ }
    joinErr('');
    lockAtClick();
    LOAD.open({ ...JOIN });                                            // issue #31: the loading screen; the game takes it from there
  });
  // World of DODO, issue #31: the button works at once; the city is built behind the form meanwhile (T.cityBg under it)
  const b = $<HTMLButtonElement>('startBtn'); b.disabled = false; $('startLbl').textContent = T.start;
  if (!COARSE) nm.focus();
}
