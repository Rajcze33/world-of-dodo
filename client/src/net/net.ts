// ---------- WORLD OF DODO: the other players ----------
// The server (server/server.js) relays, it does not simulate the players: each client sends where its tank is 20× a second and gets
// everyone's tanks back in one snapshot. A parcel fired here is sent to the others, who fly the same parcel in their own world. Whether
// it hits is decided on the screen of the tank it hits (there that tank is exactly where it is), and the server scores it for the
// shooter: a person is worth POINTS (10), a bot 1. The bots (BOT1, BOT2, ...) are driven by the server, which also decides what hits them;
// here they are drawn like the other players, in grey. The cars, the tram and the people are the shared city, see net/world.ts.
// World of DODO, issue #20: a player may sail a ship on the Vltava (k 2 in the rows, with its heave, pitch and turrets), and the ships
// fire shells (fire k 2) and torpedoes (fire k 3), flown and decided like parcels (game/shells.ts).
// World of DODO, issue #24: two teams. hello asks for a team (or auto), welcome and join say everyone's (team moves someone later, at a
// round's end), obj carries the round (game/teams.ts), thit reports my hit on a supply depot. A teammate's tag and paint stay theirs,
// the tag glows in the team's colour, and the scoreboard lists the teams with their scores, mine first.
// World of DODO, issue #26: Velemlok, the giant salamander in the Vltava (game/monster.ts): its pose in snap.g, its state in obj.g, its
// attacks (mon) and the result when it leaves (mres); mhit reports my hit on it.
//
// World of DODO, timing, as most network games do it (Valve's Source engine; Gabriel Gambetta's and Glenn Fiedler's write-ups on
// snapshot interpolation): every snapshot row says which moment of the server's clock it shows, and this browser draws the others INTERP
// ms behind its estimate of that clock, between the two rows around that moment. Drawing by the time a packet arrived (as before) turned
// network jitter, and every tick in which a player's report missed the server's beat, into a stop and a jump. When the next row is late,
// a tank goes on along its heading for at most EXTRAP ms instead of stopping dead.
// INTERP: a player's row can wait up to a tick on the server and the next snapshot comes a tick later, so two ticks (100 ms) plus room
// for the network's jitter.
// World of DODO, issue #31: the connection is made behind the loading screen (main.ts startRun), once the city is built (a snapshot
// needs BODIES). welcome and the first snapshot are two of its steps (onWelcome, onFirstSnap); until the game begins this page sends
// no st, so the server keeps it out of the snapshots (docs/PROTOCOL.md, Limits). A connection lost while loading is not tried again:
// the page goes back to the form with T.errConn (main.ts abortRun); in the game it is, as before.
import { Matrix, type Material, type StandardMaterial, type TransformNode } from '@babylonjs/core';
import { camera, canvas, scene } from '../core/engine';
import { $ } from '../core/dom';
import { lerp, angLerp, r2, hexCss } from '../core/util';
import { groundH, segHit } from '../world/grid';
import { G, car, view, inPlay } from '../game/state';
import type { Other, Row } from '../game/types';
import { TM, objMsg, teamsWelcome, flagTeam, teamCss, teamHex, teamName, thitSent, friendly, type ObjMsg } from '../game/teams';
import { DEPOTS } from '../../shared/rules.ts';
import { T } from '../texts';
import { makeTank, disposeTank, paintMat, vanMat, vanOwnMat, hitPlayer, respawn } from '../game/tank';
import { makePlane, disposePlane, spinProp } from '../game/plane';
import { makeShip, disposeShip, poseShip, turretYaw } from '../game/ship';
import { netBullet } from '../game/bullets';
import { netShell, netTorp } from '../game/shells';
import { WATER_Y } from '../../shared/naval.ts';
import { sinkFx } from '../world/water';
import { nextShot, showShot } from '../game/shots';
import { startImpactFx } from '../game/fx';
import { flash } from '../ui/hud';
import { PERF } from '../game/quality';
import { onWelcome, onFirstSnap, abortRun } from '../main';
import { monSnap, monObj, monAttack, monResult, monReset } from '../game/monster';
import { WORLD, BODIES, worldClear, worldMsg, worldSnap, propMsg, propsDown } from './world';

export const NET_SEND = 1 / 20, INTERP = 150, EXTRAP = 150;   // send interval (s); the others are drawn this far (ms) behind the server's clock; at most this far past the newest row
export const PED_INTERP = INTERP + 50;                         // the pedestrians come every other tick (net/world.ts; kept here so no module reads another's value at load)

// a name tag over another player's tank: a DOM element over the canvas (the original's sprite). visible: in plain sight (the sprite's
// visible flag; tools/browser-test.js reads it); px, py, pz: the world point it hangs from; shown: on screen now (also not behind the camera)
export type Tag = HTMLDivElement & { visible: boolean; px: number; py: number; pz: number; shown: boolean };
// another player or a bot as this module keeps it: the shared fields (game/types.ts), its own paint, its tag
export interface NetOther extends Other { tag: Tag; mat: Material }

// (issue #31: snaps, the snapshots since the last welcome: the first one is a step of the loading screen)
export const NET = {
  ws: null as WebSocket | null, id: 0, name: '', color: 0, pts: 0, want: false, live: false, inGame: false, err: '', retry: 0, retryT: 0, sendT: 0, sid: 0, rr: 0, snaps: 0,
  off: null as number | null, pingAt: 0, others: new Map<number, NetOther>(),
  team: -1, teamPick: 'auto' as 'auto' | 0 | 1,   // issue #24: my team (0 A, 1 B; -1 none yet), and the one asked for in the join form
  key: Array.from(crypto.getRandomValues(new Uint8Array(24)), b => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[b & 63]).join(''),   // this page load: a reconnect keeps the score, a reload starts at 0
};
// (World of DODO, issue #31: the colours, the name's cleaning and the join form's error line moved to ui/join.ts, the page's first
// script: the form works before this module is loaded)
export function netName(id: number) { const o = NET.others.get(id); return o ? o.name : '?'; }
// the server's clock seen from here: the offset of the fastest snapshot so far (a slower one only adds network delay), creeping up slowly
// in case the route got longer; null until the first snapshot
export function clockSample(ts: unknown) {
  if (typeof ts !== 'number') return;
  const o = performance.now() - ts;
  NET.off = NET.off === null || o < NET.off ? o : NET.off + (o - NET.off) * 0.01;
}
export const serverNow = () => performance.now() - (NET.off ?? 0);   // (the original subtracted null, which is 0 as well)
// a row ({t: server time, x, z, h, v, ...}) for something networked: rows only move forward, two seconds of them are kept
export function pushRow(b: Row[], e: Row) { if (b.length && e.t <= b[b.length - 1].t) return; b.push(e); if (b.length > 40) b.shift(); }
// the networked thing at server time R from its rows b: between the two rows around R; past the newest it goes on along its heading for
// at most EXTRAP ms; a jump between two rows (a respawn, a car turning back into the other lane) is not slid across. Writes into one
// shared object and returns it, so the caller copies what it needs at once. A plane (k 1, issue #14) also has its height y and pitch p,
// and goes on along its pitch too. A ship (k 2, issue #20) has its heave and sinking y, pitch p and the yaw of its turrets a, b.
const BODY = { x: 0, z: 0, h: 0, v: 0, r: 0, s: 0, k: 0, y: 0, p: 0, a: 0, b: 0 };
export function bodyAt(b: Row[] | null | undefined, R: number, jumpD: number): typeof BODY | null {
  const n = b ? b.length : 0; if (!b || !n) return null;
  let i = n - 1; while (i > 0 && b[i].t > R) i--;                                             // the newest row not after R (or the oldest one)
  const a = b[i], c = b[i + 1], o = BODY;
  if (!c || R <= a.t) {
    const e = R > a.t ? Math.min(R - a.t, EXTRAP) / 1000 : 0, fp = a.k === 1 ? a.p || 0 : 0, cp = Math.cos(fp);   // (only a plane climbs along its pitch)
    o.x = a.x + Math.sin(a.h) * cp * a.v * e; o.z = a.z + Math.cos(a.h) * cp * a.v * e; o.h = a.h; o.v = a.v; o.r = a.r || 0; o.s = a.s || 0;
    o.k = a.k || 0; o.y = (a.y || 0) + Math.sin(fp) * a.v * e; o.p = a.p || 0; o.a = a.a || 0; o.b = a.b || 0; return o;
  }
  const k = Math.hypot(c.x - a.x, c.z - a.z) > jumpD || (a.k || 0) !== (c.k || 0) ? (R - a.t < c.t - R ? 0 : 1) : (R - a.t) / (c.t - a.t);
  o.x = lerp(a.x, c.x, k); o.z = lerp(a.z, c.z, k); o.h = angLerp(a.h, c.h, k); o.v = lerp(a.v, c.v, k); o.r = lerp(a.r || 0, c.r || 0, k); o.s = (k < 0.5 ? a : c).s || 0;
  o.k = (k < 0.5 ? a : c).k || 0; o.y = lerp(a.y || 0, c.y || 0, k); o.p = lerp(a.p || 0, c.p || 0, k);
  o.a = angLerp(a.a || 0, c.a || 0, k); o.b = angLerp(a.b || 0, c.b || 0, k);
  return o;
}
export function netSend(m: object) { if (NET.live && NET.ws && NET.ws.readyState === 1) NET.ws.send(JSON.stringify(m)); }
// World of DODO, issue #31, only with ?test (tools/browser-test.js, window.WOD_OVR): another server (ws), and a welcome or the first
// snapshot never let through (hold), to see the loading screen's time limits and its way back
const TEST = new URLSearchParams(location.search).has('test');
export function netConnect() {
  const ovr = TEST ? window.WOD_OVR ?? {} : {}, hold = ovr.hold;
  let ws: WebSocket;
  try { ws = new WebSocket(ovr.ws || (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'); } catch (e) { netFail(T.errConn); return; }
  NET.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', name: NET.name, color: NET.color, key: NET.key, team: NET.teamPick }));
  ws.onmessage = e => {
    let m; try { m = JSON.parse(e.data); } catch (_) { return; }
    if (NET.ws !== ws || (hold === 'welcome' && !NET.live) || (hold === 'snap' && m.t === 'snap')) return;
    netMsg(m);
  };
  ws.onclose = () => {
    if (NET.ws !== ws) return;
    const was = NET.live; NET.ws = null; NET.live = false;
    if (!NET.inGame) { if (NET.want) netFail(NET.err || T.errConn, !!NET.err); return; }           // never got in: back to the name form
    // World of DODO, issue #31: welcomed but still loading: back to the form (Q8), not round again (it could go on for ever behind
    // the screen); the time limits of the loading screen would end it anyway
    if (G.state === 'load') { abortRun(T.errConn, 'screen'); return; }
    NET.others.forEach(netDrop); NET.others.clear(); renderBoard();
    if (was) flash(T.lost);
    NET.retry = Math.min(5000, (NET.retry || 500) * 2); NET.retryT = setTimeout(netConnect, NET.retry);   // in the game: keep driving, keep trying
  };
}
// a message from the server (docs/PROTOCOL.md)
function netMsg(m: any) {
  if (m.t === 'snap') {
    clockSample(m.ts);
    const first = NET.snaps++ === 0;
    for (const s of m.p) { const o = NET.others.get(s[0]); if (o) pushRow(o.buf, { t: s[7] ?? m.ts, x: s[1], z: s[2], h: s[3], v: s[4], r: s[5], s: s[6], k: s[8] || 0, y: s[9] || 0, p: s[10] || 0, a: s[11] || 0, b: s[12] || 0 }); }   // t: the moment the row shows; a plane: k, y, p; a ship: k, y, p and its turrets
    worldSnap(m);
    if (m.g) monSnap(m.g, m.ts);                                                       // issue #26: Velemlok's pose while it is in the water
    if (first) onFirstSnap();                                                          // issue #31: the loading screen's fourth step
  }
  else if (m.t === 'fire') netShot(m);
  else if (m.t === 'w') worldMsg(m);
  else if (m.t === 'prop') propMsg(m);
  else if (m.t === 'pong') { const rtt = performance.now() - m.c; PERF.ping = PERF.ping ? PERF.ping * 0.7 + rtt * 0.3 : rtt; }   // smoothed round trip
  else if (m.t === 'hit') {
    const o = NET.others.get(m.v);
    if (m.kill && o && o.on && o.k !== 1) startImpactFx(o.x, o.z, 0.45, Math.hypot(o.x - car.x, o.z - car.z) < 40 ? 0.35 : 0, o.k === 2 ? WATER_Y + 1.5 : 0);   // someone else's tank (or ship) blew up (a plane: netUpdate)
    if (m.by === NET.id) { NET.pts = m.pts; if (m.gain || m.kill) flash((m.kill ? T.youKill : T.youHit)(netName(m.v), m.gain)); }   // (a bullet in a bot scores nothing)
    else { const sh = NET.others.get(m.by); if (sh) sh.pts = m.pts; }
    renderBoard();
  }
  else if (m.t === 'dmg') {                                                           // issue #14: someone's bullet hit me on their screen (#24: not a teammate's)
    if (!friendly(m.by) && hitPlayer('bullet', 1, T.gunBy(netName(m.by)))) { const kill = car.topT > 0; if (kill) flash(T.killedBy(netName(m.by))); netHit({ by: m.by, sid: m.sid }, kill); }
  }
  else if (m.t === 'obj') { objMsg(m as ObjMsg); if (m.g) monObj(m.g); }             // issue #24: the round, the zones, the depots (#26: Velemlok)
  else if (m.t === 'mon') monAttack(m);                                               // issue #26: Velemlok attacks
  else if (m.t === 'mres') monResult(m);                                              // issue #26: Velemlok has left: the result
  else if (m.t === 'pts') {                                                          // issue #24: points for a zone taken or a depot destroyed
    if (m.id === NET.id) NET.pts = m.pts; else { const o = NET.others.get(m.id); if (o) o.pts = m.pts; }
    renderBoard();
  }
  else if (m.t === 'team') setTeam(m.id, m.team);                                     // issue #24: someone moved to the other team
  else if (m.t === 'join') { netAdd(m.p); renderBoard(); }
  else if (m.t === 'leave') { const o = NET.others.get(m.id); if (o) { netDrop(o); NET.others.delete(m.id); renderBoard(); } }
  else if (m.t === 'welcome') {
    NET.live = true; NET.retry = 0; NET.err = ''; NET.id = m.id; NET.name = m.name; NET.color = m.color; NET.pts = m.pts; paintMat(vanOwnMat, m.color);
    NET.team = m.team === 0 || m.team === 1 ? m.team : -1; paintOwn();                // issue #24: my team, on my vehicles' flags
    NET.others.forEach(netDrop); NET.others.clear(); m.players.forEach(netAdd);
    teamsWelcome(m.game); renderBoard();                                               // issue #24: the round as it stands
    monReset(); if (m.game?.g) monObj(m.game.g, true);                                 // issue #26: Velemlok as it stands
    NET.off = null; worldClear(); NET.snaps = 0;                                       // the server may have restarted: a new clock, a new city
    // issue #31: the first welcome is a step of the loading screen (main.ts onWelcome: a fresh start of this page's world, no spawn
    // yet: that waits for the first snapshot, which says where the others are); a later one is a reconnect in the game
    if (!NET.inGame) { NET.inGame = true; WORLD.on = true; onWelcome(); } else flash(T.back);
    propsDown(m.props);
  }
  else if (m.t === 'err') NET.err = ({ name_taken: T.errTaken, name_reserved: T.errReserved, full: T.errFull } as Record<string, string>)[m.code] || T.errName;   // the server closes the socket next
}
// never got in: back to the name form (and the mouse, locked for a plane at the start button, let go). World of DODO, issue #31:
// through the loading screen (main.ts abortRun), which closes the socket and clears what the start began; the server's refusal (a name
// taken or reserved, the game full: form) goes straight to the form, anything else shows on the screen for a moment first
function netFail(msg: string, form = false) { NET.want = false; abortRun(msg, form ? 'form' : 'screen'); }
// World of DODO, issue #22: back to the menu (Esc): leave the game as a closed tab does (the server drops the player and tells the
// others), for good: no reconnecting, and the next start joins anew. The city goes back to the browser's own (main.ts backToMenu).
export function netLeave() {
  const ws = NET.ws; clearTimeout(NET.retryT);
  Object.assign(NET, { ws: null, live: false, inGame: false, want: false, retry: 0, err: '' });
  if (ws) try { ws.close(); } catch (_) { /* already closing */ }
  NET.others.forEach(netDrop); NET.others.clear(); renderBoard();
  WORLD.on = false; worldClear(); monReset();
}
// another player or a bot: the tank in their paint, the name glowing above it (World of DODO, issue #24: in their team's colour, which
// their vehicles' flags show too)
function netAdd(p: { id: number; name: string; color: number; pts?: number; bot?: boolean; team?: number }) {
  if (p.id === NET.id || NET.others.has(p.id)) return;
  const team = p.team === 0 || p.team === 1 ? p.team : -1;
  const mat = paintMat(vanMat.clone('tank' + p.id), p.color), g = makeTank(false, mat), tag = nameTag(p.name, teamHex(team, p.color));
  g.setEnabled(false); tag.visible = false; flagTeam(g, team);
  NET.others.set(p.id, { id: p.id, name: p.name, color: p.color, pts: p.pts || 0, bot: !!p.bot, team, g, pg: null, sg: null, mat, tag, buf: [], on: false, x: 0, z: 0, h: 0, hx: 0, hz: 1, v: 0, r: 0, s: 0, k: 0, y: 0, p: 0, a: 0, b: Math.PI });
}
// World of DODO, issue #24: someone (or I) moved to team t, at a round's end to even the teams: their tag and flags, or mine (and I come
// back in my new half)
function setTeam(id: unknown, t: unknown) {
  const team = t === 0 || t === 1 ? t : -1;
  if (id === NET.id) {
    const was = NET.team; NET.team = team; TM.on = team >= 0; paintOwn();
    if (was !== team && team >= 0 && inPlay()) { respawn(); flash(T.teamMoved(teamName(team))); }   // (issue #31: also loading, once placed)
  } else {
    const o = NET.others.get(id as number); if (!o) return;
    o.team = team; o.tag.style.setProperty('--c', hexCss(teamHex(team, o.color)));
    flagTeam(o.g, team); flagTeam(o.pg, team); flagTeam(o.sg, team);
  }
  renderBoard();
}
// my tank's, plane's and ship's flags in my team's colour
function paintOwn() { for (const g of [view.van, view.plane, view.ship]) flagTeam(g, NET.team); }
// their tank, plane and ship go with their meshes (and their shadows, game/tank.ts disposeTank), its paint and its tag
function netDrop(o: NetOther) { disposeTank(o.g); if (o.pg) disposePlane(o.pg); if (o.sg) disposeShip(o.sg); o.mat.dispose(); o.tag.remove(); }
// spinning wheels, for the callers that have them (a tank's list is empty, see game/tank.ts)
export function spinWheels(g: TransformNode, a: number) {
  const w = g.metadata?.wheels as TransformNode[] | undefined;
  if (w) for (const x of w) x.rotation.x += a;
}

// ---------- name tags ----------
// The original drew each name as a sprite from a canvas 112 px tall (the pill 76 px of it, the text 44 px Poppins 600), anchored at
// its bottom centre over the tank, seen through buildings (so you can find the others), never fogged, its size not attenuated by the
// distance: TAG_H of the projection's unit height, which is TAG_H / (2 tan(fov/2)) of the view's height (about 4 % of it at the
// landscape lens, 2.9 % at the wider portrait one). Here it is a DOM element over the canvas, placed every frame; --u (on the tags'
// layer) is one pixel of that canvas on the screen, so the CSS keeps the original's proportions (client/index.html, .ntag).
const TAG_H = 0.042;                                     // name tag height as a share of the view's height, the same near and far
let tagLayer: HTMLDivElement | null = null, tagU = 0;
// the tags' layer sits right after the canvas, so the HUD and the intro stay over the tags as they stayed over the 3D view
function tagsLayer() {
  if (!tagLayer) { tagLayer = document.createElement('div'); tagLayer.id = 'tags'; tagLayer.setAttribute('aria-hidden', 'true'); canvas.after(tagLayer); }
  return tagLayer;
}
function nameTag(name: string, hex: number): Tag {
  const tag: Tag = Object.assign(document.createElement('div'), { visible: false, px: 0, py: 0, pz: 0, shown: false });
  tag.className = 'ntag'; tag.textContent = name; tag.hidden = true;
  tag.style.setProperty('--c', hexCss(hex));            // the glow in the player's colour
  tagsLayer().appendChild(tag);
  return tag;
}
// puts the visible tags where their tanks are on the screen; call it after the camera has moved (netUpdate does, as the original
// placed the sprites in the same frame before rendering). A tag behind the camera (or nearer than its near plane) is hidden.
const VP = new Matrix();
export function placeTags() {
  if (!NET.others.size) return;
  const W = innerWidth, H = innerHeight, m = camera.getViewMatrix().multiplyToRef(camera.getProjectionMatrix(), VP).m;
  const u = TAG_H / (2 * Math.tan(camera.fov / 2)) * H / 112;
  if (u !== tagU) { tagU = u; tagsLayer().style.setProperty('--u', u + 'px'); }
  for (const o of NET.others.values()) {
    const t = o.tag; let show = t.visible;
    if (show) {
      const x = t.px, y = t.py, z = t.pz, w = x * m[3] + y * m[7] + z * m[11] + m[15];   // clip w: the distance in front of the camera
      if (w <= camera.minZ) show = false;
      else {
        const sx = (x * m[0] + y * m[4] + z * m[8] + m[12]) / w, sy = (x * m[1] + y * m[5] + z * m[9] + m[13]) / w;
        // the pill's bottom edge is 18 px of the 112 above the anchor (the canvas had room below it for the glow)
        t.style.transform = `translate(${((sx + 1) / 2 * W).toFixed(1)}px,${((1 - sy) / 2 * H - 18 * u).toFixed(1)}px) translate(-50%,-100%)`;
      }
    }
    if (show !== t.shown) { t.shown = show; t.hidden = !show; }
  }
}

// a parcel another player (or a bot) fired: the same flight in this world, owner 'r'; a bullet (k 1, issue #14): game/bullets.ts; a
// ship's shell (k 2) or torpedo (k 3, issue #20): game/shells.ts
function netShot(m: any) {
  const o = NET.others.get(m.id); if (!o) return;
  if (m.k === 1) { netBullet(m, o.bot); return; }
  if (m.k === 2) { netShell(m); return; }
  if (m.k === 3) { netTorp(m); return; }
  const s = nextShot();
  Object.assign(s, { on: true, rest: false, touched: false, owner: 'r', by: m.id, sid: m.sid, scored: false, age: 0, x: m.x, y: m.y, z: m.z, vx: m.vx, vy: m.vy, vz: m.vz, wx: (Math.random() - 0.5) * 10, wy: (Math.random() - 0.5) * 10 });
  // World of DODO: the parcel flies from where the shooter really was; here the shooter's tank is drawn a little in the past. So it is
  // drawn leaving the barrel you see and slides onto its real path within a fraction of a second (it hits where it really is).
  const l = Math.hypot(m.vx, m.vz), dx = o.x + (l > 0.01 ? m.vx / l * 3.1 : 0) - m.x, dz = o.z + (l > 0.01 ? m.vz / l * 3.1 : 0) - m.z, far = !o.on || Math.hypot(dx, dz) > 12;
  s.ox = far ? 0 : dx; s.oz = far ? 0 : dz;
  showShot(s, Math.atan2(m.vx, m.vz));                                // drawn at x + ox, y, z + oz, facing its flight, at full size (game/shots.ts)
}
// what netFire reads of a parcel or a bullet (game/shots.ts, game/bullets.ts), netHit of what hit me
interface Parcel { sid?: number; by?: number | string; x: number; y: number; z: number; vx: number; vy: number; vz: number }
// rt: the moment of the city drawn here when you fired (server clock): the server tests the parcel against the bots where you saw them.
// k 1: a bullet (issue #14), whose hits I report myself (netShotHit); k 2 a ship's shell (with rt: the server flies it at the bots as a
// parcel), k 3 a torpedo (issue #20)
export function netFire(s: Parcel, k = 0) {
  s.sid = ++NET.sid;
  const m: Record<string, unknown> = { t: 'fire', sid: s.sid, x: r2(s.x), y: r2(s.y), z: r2(s.z), vx: r2(s.vx), vy: r2(s.vy), vz: r2(s.vz) };
  if (k) m.k = k;
  if ((k === 0 || k === 2) && NET.off !== null) m.rt = Math.round(serverNow() - INTERP);
  netSend(m);
}
export function netHit(s: { by?: number | string; sid?: number }, kill: boolean) { netSend({ t: 'hit', by: s.by, sid: s.sid, kill }); }
// my bullet sid hit player (or bot) v here (game/bullets.ts): the server passes it on
export function netShotHit(v: number, sid: number) { netSend({ t: 'shot', v, sid }); }
// the cars this tank pushes (or has just let go of), for the server: [index, x, z, heading, speed, let go]; at most 8 a message, taking turns
function pushedRows() {
  const all = BODIES.filter(c => (c.mine && c.dyn) || c.rel), out: number[][] = [];
  for (let k = 0; k < all.length && out.length < 8; k++) {
    const c = all[(k + NET.rr) % all.length];
    out.push([c.ni, r2(c.x), r2(c.z), Math.round(c.ang * 1000) / 1000, r2(Math.hypot(c.vx || 0, c.vz || 0)), c.rel ? 1 : 0]); c.rel = false;
  }
  NET.rr += 8; return out;
}
// every frame: send this tank or plane 20 times a second (ct: the moment, on this browser's clock; s: 1 immune, 2 destroyed; a plane
// adds k 1, its height and pitch; a ship k 2, its heave and sinking, pitch and the yaw of its turrets), draw the others INTERP ms behind
// the server
export function netUpdate(dt: number, tnow: number) {
  if (G.state === 'drive' && NET.live) {
    NET.sendT -= dt;
    if (NET.sendT <= 0) {
      NET.sendT = Math.max(0, NET.sendT + NET_SEND);   // on average 20 a second, whatever the frame rate
      const m: Record<string, unknown> = { t: 'st', ct: Math.round(tnow), x: r2(car.x), z: r2(car.z), h: Math.round(car.h * 1000) / 1000, v: r2(car.v), r: r2(car.roll), s: car.topT > 0 ? 2 : car.immT > 0 ? 1 : 0 };
      if (car.k === 1) { m.k = 1; m.y = r2(car.y); m.p = Math.round(car.p * 1000) / 1000; }
      else if (car.k === 2) { m.k = 2; m.y = r2(car.y); m.p = Math.round(car.p * 1000) / 1000; m.a = [Math.round(turretYaw(0) * 1000) / 1000, Math.round(turretYaw(1) * 1000) / 1000]; }
      else { const c = pushedRows(); if (c.length) m.c = c; }
      netSend(m);
    }
  }
  if (NET.live && tnow - (NET.pingAt || 0) > 2000) { NET.pingAt = tnow; netSend({ t: 'ping', c: Math.round(tnow) }); }   // the ping in the performance readout
  if (NET.off === null) return;
  const R = serverNow() - INTERP;
  for (const o of NET.others.values()) {
    const s = bodyAt(o.buf, R, 20); if (!s) continue;                                                    // 20: a respawn, no sliding across the city
    const was = o.s;
    o.x = s.x; o.z = s.z; o.h = s.h; o.v = s.v; o.r = s.r; o.s = s.s; o.k = s.k; o.y = s.y; o.p = s.p; o.a = s.a; o.b = s.b; o.hx = Math.sin(o.h); o.hz = Math.cos(o.h);
    o.on = true;
    const blink = o.s === 1 && Math.floor(tnow / 110) % 2 === 1, plane = o.k === 1, ship = o.k === 2;   // blinks while immune after a (re)spawn
    if (plane && !o.pg) { o.pg = makePlane(o.mat as StandardMaterial); flagTeam(o.pg, o.team); }   // (issue #24: in the team's colours)
    if (ship && !o.sg) { o.sg = makeShip(o.mat as StandardMaterial); flagTeam(o.sg, o.team); }
    o.g.setEnabled(!plane && !ship && !blink); o.pg?.setEnabled(plane && o.s !== 2 && !blink); o.sg?.setEnabled(ship && o.y > -7.5 && !blink);
    const gy = groundH(o.x, o.z);
    if (plane) {                                                                                         // issue #14: a plane, gone once destroyed
      if (o.s === 2 && was !== 2) startImpactFx(o.x, o.z, 0.5, Math.hypot(o.x - car.x, o.y - (car.k === 1 ? car.y : 0), o.z - car.z) < 40 ? 0.3 : 0, o.y);
      o.pg!.position.set(o.x, o.y, o.z); o.pg!.rotation.set(-o.p, o.h, o.r); spinProp(o.pg!, dt * 50);
    } else if (ship) {                                                                                   // issue #20: a ship, sinking once destroyed
      if (o.s === 2 && was !== 2) sinkFx(o.x, o.z);
      poseShip(o.sg!, o.x, o.y, o.z, o.h, o.p, o.r, o.a, o.b, 0.06, o.v, dt, o.s !== 2);
    } else {
      o.g.position.set(o.x, gy + 0.9 * Math.abs(Math.sin(o.r)), o.z); o.g.rotation.y = o.h; o.g.rotation.z = o.r;
      spinWheels(o.g, o.v * dt / 0.46);
    }
    // spotted: in plain sight of the camera (no building in between, not lost in the fog); checked ten times a second
    const by = plane ? o.y : ship ? WATER_Y + 3 : gy + 1.3;
    if (tnow - (o.losAt || 0) > 100) { o.losAt = tnow; o.seen = o.s !== 2 || !plane ? inSight(o.x, by, o.z) || inSight(o.x, by + 1.3, o.z) : false; }
    if (o.seen) { o.seenAt = tnow; o.seenX = o.x; o.seenZ = o.z; }
    o.tag.visible = !!o.seen; o.tag.px = o.x; o.tag.py = plane ? o.y + 2.4 : ship ? WATER_Y + o.y + 7.5 : gy + 3.2; o.tag.pz = o.z;
  }
  placeTags();
}
// can the camera see the point (x,y,z)? no obstacle in between (segHit: issue #16, Karlín's buildings as polygons, client/shared/map.ts),
// within the fog's reach (230 of the tank's 300; farther from a plane, whose fog is farther, core/engine.ts setFog)
export const SPOT_MS = 3000;                            // a spotted tank stays on the minimap this long after it went out of sight
export function inSight(x: number, y: number, z: number) {
  const c = camera.position, max = scene.fogEnd * 0.77;
  if ((x - c.x) ** 2 + (y - c.y) ** 2 + (z - c.z) ** 2 > max * max) return false;
  return segHit(c.x, c.y, c.z, x, y, z) >= 1;
}
// the scoreboard: the best five, and you below them if you are not among them; ties share a rank; bots are listed too.
// World of DODO, issue #24: by teams, mine first: a team's row with its score (game/teams.ts TM.sc: the hits, the zones and the depots of
// all its players and bots), under it its best six (and me); a phone shows the best two of each (and me), the rows marked x hide there
type BoardRow = { name: string; color: number; pts: number; me?: boolean; bot?: boolean; team?: number };
function boardLi(el: HTMLElement, cls: string, rank: string, color: string, name: string, pts: number) {
  const li = document.createElement('li'); li.className = cls;
  li.innerHTML = '<span class="rk meta"></span><i></i><span class="nm"></span><b class="meta"></b>';
  li.querySelector('.rk')!.textContent = rank; li.querySelector('i')!.style.background = color;
  li.querySelector('.nm')!.textContent = name; li.querySelector('b')!.textContent = String(pts); el.appendChild(li);
}
export function renderBoard() {
  const all: BoardRow[] = [{ name: NET.name, color: NET.color, pts: NET.pts, me: true, team: NET.team }, ...NET.others.values()];
  all.sort((a, b) => b.pts - a.pts || +!!a.bot - +!!b.bot || a.name.localeCompare(b.name, T.lang));
  const el = $('board'), mine = all.find(p => p.me)!; el.innerHTML = '';
  const row = (p: BoardRow, of: BoardRow[], x: boolean) => boardLi(el, (p.me ? 'me' : p.bot ? 'bot' : '') + (x ? ' x' : ''), String(1 + of.filter(q => q.pts > p.pts).length), hexCss(p.color), p.name, p.pts);
  if (NET.team === 0 || NET.team === 1) {
    for (const t of [NET.team, 1 - NET.team]) {
      boardLi(el, 'team t' + t, '', teamCss(t), T.team(teamName(t)), Math.round(TM.sc[t] || 0));
      const mem = all.filter(p => p.team === t), rows = mem.slice(0, 6);
      if (t === NET.team && !rows.includes(mine)) rows.push(mine);
      rows.forEach((p, k) => row(p, mem, k >= 2 && !p.me));
    }
  } else {
    const rows = all.slice(0, 5); if (!rows.includes(mine)) rows.push(mine);
    rows.forEach((p, k) => row(p, all, k >= 3 && !p.me));
  }
  $('online').textContent = T.online(all.filter(p => !p.bot).length); $('myPts').textContent = String(NET.pts);
}
// World of DODO, issue #24: my parcel (k 0), bullet (1) or shell (2) number sid hit supply depot i at (x, y, z) on my screen (game/shots.ts,
// bullets.ts, shells.ts): the server checks it against its depots and applies the damage. Not on my own team's depots (they cannot be
// damaged), not in the break after a round.
export function netThit(i: number, k: number, x: number, y: number, z: number, sid: number) {
  const d = DEPOTS[i]; if (!d || !TM.on || G.hold || d.team === NET.team || !sid) return;
  thitSent(i); netSend({ t: 'thit', i, k, x: r2(x), y: r2(y), z: r2(z), sid });
}
