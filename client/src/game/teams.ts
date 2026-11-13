// ---------- World of DODO, issue #24: the teams ----------
// Teams A (0) and B (1) fight each other; the rules the page and the server share are in client/shared/rules.ts. This module keeps what
// this browser knows of the round (the server's obj messages: the team scores, the zones, the depots, the round's state, the clock;
// ui/teamhud.ts shows them, world/objectives.ts draws them in the city), tells whose a hit is (friendly fire is off: a teammate's
// parcel, bullet, shell, torpedo or ram does nothing here, and the server never scores it), paints the team's colour on the vehicles,
// and starts a new round here when the server does (the scores from zero, everyone back in their own half).
//
// The server decides everything about the objectives (docs/PROTOCOL.md): the zones' capture from the rows it relays, a depot's damage
// from what a browser reports (thit) and from the bots' attacks, the round's end. A server without teams (no team in welcome) leaves
// TM.on false: the page then plays as before issue #24, everyone against everyone.
import type { Mesh, StandardMaterial, TransformNode } from '@babylonjs/core';
import { TEAM_COL, TEAM_NAME, ZONES, DEPOTS, DEPOT_HP, ROUND_PTS, homeSide } from '../../shared/rules.ts';
import { lambert } from '../core/mat';
import { hexCss, now } from '../core/util';
import { T } from '../texts';
import { G, inPlay } from './state';
import { NET, renderBoard } from '../net/net';
import { flash } from '../ui/hud';
import { respawn } from './tank';

// the round as the server last told it: sc the team scores; z each zone's [owner (-1 nobody, 0 A, 1 B), progress from -100 (B) to 100
// (A)], then zr its progress per second (from the last two messages) and zat when that came, for a smooth display; d each depot's
// [hp, upAt] (upAt: the server's time it stands again, 0 while it stands); st the round's state, left its seconds left (of the round,
// or of the break after it) at at; to the points that win it (ROUND_POINTS on the server); win the winner (-1 a draw); best the round's
// best players as [id, points]; thit: when this browser
// last reported a hit on each depot (a damage that follows within 3 s was mine)
export const TM = {
  on: false,
  sc: [0, 0],
  z: ZONES.map(() => [-1, 0]), zr: ZONES.map(() => 0), zts: ZONES.map(() => 0), zat: ZONES.map(() => 0),
  d: DEPOTS.map(() => [DEPOT_HP, 0]),
  st: 'play' as 'play' | 'end', left: 0, at: 0, to: ROUND_PTS, win: -1, best: [] as number[][],
  thit: DEPOTS.map(() => -1e9),
};
export interface ObjMsg { ts?: number; sc?: number[]; z?: number[][]; d?: number[][]; r?: { st?: string; left?: number; to?: number; win?: number; best?: number[][] } }

// ---------- who is whose ----------
export const teamName = (t: number) => TEAM_NAME[t] ?? '?';
export const teamHex = (t: number, or: number) => t === 0 || t === 1 ? TEAM_COL[t] : or;   // team t's colour, or `or` without a team
export const teamCss = (t: number) => hexCss(teamHex(t, 0xadb1b0));
// the team of player (or bot) id, me included; -1 unknown
export function teamOf(id: number): number { return id === NET.id ? NET.team : NET.others.get(id)?.team ?? -1; }
// what player id fired is a teammate's: it does nothing to me (and my bullets do nothing to them)
export function friendly(id: unknown): boolean { return NET.team >= 0 && typeof id === 'number' && teamOf(id) === NET.team; }
// is x in my team's half (game/tank.ts, plane.ts, ship.ts spawn there); without a team everywhere is
export function home(x: number): boolean { return !(NET.team === 0 || NET.team === 1) || homeSide(NET.team, x); }
// a zone's progress now, carried on from the last message at its pace (for at most a second) so the flags and the bars move smoothly
export function zoneP(i: number): number {
  const z = TM.z[i]; if (!z) return 0;
  const e = Math.min(1, Math.max(0, (now() - TM.zat[i]) / 1000)), p = z[1] + TM.zr[i] * e;
  return Math.max(-100, Math.min(100, p));
}
export const zoneName = (i: number) => T.zoneNames[i] ?? ZONES[i]?.name ?? '?';

// ---------- the team's colour on the vehicles ----------
// one material per team (and a grey one before the server says): lit, glowing a little, so a flag reads at night
const MATS: (StandardMaterial | undefined)[] = [];
export function teamMat(t: number): StandardMaterial {
  const k = t === 0 || t === 1 ? t : 2, col = teamHex(t, 0xadb1b0);
  return MATS[k] ??= lambert(col, { emissive: col, emissiveIntensity: 0.45, double: true });
}
// a vehicle's team parts (its flag, band, stripes: game/tank.ts, plane.ts and ship.ts keep them in metadata.team) in team t's colour
export function flagTeam(g: TransformNode | null | undefined, t: number) {
  const ms = g?.metadata?.team as Mesh[] | undefined; if (ms) for (const m of ms) m.material = teamMat(t);
}
export const isTeamPart = (m: { name: string }) => m.name.endsWith('Team');

// ---------- the server's word ----------
// welcome: a fresh start of what this browser knows (the server may have restarted), then the state it came with
export function teamsWelcome(game: ObjMsg | undefined) {
  TM.on = NET.team === 0 || NET.team === 1;
  TM.sc = [0, 0]; TM.st = 'play'; TM.left = 0; TM.win = -1; TM.best = [];
  TM.z.forEach((z, i) => { z[0] = -1; z[1] = 0; TM.zr[i] = 0; TM.zts[i] = 0; });
  TM.d.forEach(d => { d[0] = DEPOT_HP; d[1] = 0; });
  G.hold = false;
  if (game) objMsg(game, true);
}
// obj: the scores, the zones, the depots and the round, once a second and at once on any change. A zone changing hands, a depot
// destroyed (or hit by me) and the round's end and start show in the toast; at a new round the scores here start from zero and my
// vehicle comes back in my half (the server resets its own and has moved the teams already, team messages).
export function objMsg(m: ObjMsg, first = false) {
  if (!m || !Array.isArray(m.sc)) return;
  const t = now(), mine = NET.team;
  if (Array.isArray(m.sc)) TM.sc = [Number(m.sc[0]) || 0, Number(m.sc[1]) || 0];
  (m.z || []).forEach((z, i) => {
    const o = TM.z[i]; if (!o || !Array.isArray(z)) return;
    const owner = z[0] === 0 || z[0] === 1 ? z[0] : -1, p = Number(z[1]) || 0, ts = typeof m.ts === 'number' ? m.ts : t;
    const dt = (ts - TM.zts[i]) / 1000;
    if (TM.zts[i] && dt > 0.05) TM.zr[i] = Math.abs(p) >= 100 ? 0 : (p - o[1]) / dt; else if (!TM.zts[i]) TM.zr[i] = 0;
    // World of DODO, issue #34: zone and depot news at priority -1: a running quality message stays over it (ui/hud.ts flash)
    if (!first && owner !== o[0] && owner >= 0) flash(T.zoneTaken(teamName(owner), zoneName(i)), -1);
    o[0] = owner; o[1] = p; TM.zts[i] = ts; TM.zat[i] = t;
  });
  (m.d || []).forEach((d, i) => {
    const o = TM.d[i]; if (!o || !Array.isArray(d)) return;
    const hp = Number(d[0]) || 0;
    if (!first && hp < o[0]) {
      if (hp <= 0 && mine >= 0) flash(DEPOTS[i].team === mine ? T.depotLost : T.depotOurs, -1);
      else if (t - TM.thit[i] < 3000) flash(T.depotHit, -1);
    }
    o[0] = hp; o[1] = Number(d[1]) || 0;
  });
  const r = m.r;
  if (r) {
    const was = TM.st;
    TM.st = r.st === 'end' ? 'end' : 'play'; TM.left = Number(r.left) || 0; TM.at = t; if (Number(r.to) > 0) TM.to = Number(r.to);
    TM.win = r.win === 0 || r.win === 1 ? r.win : -1; TM.best = Array.isArray(r.best) ? r.best : TM.st === 'end' ? TM.best : [];
    G.hold = TM.st === 'end';                                         // the break after a round: nobody fires, nothing scores
    if (was === 'end' && TM.st === 'play' && !first) newRound();
  }
  renderBoard();
}
// a new round: the personal points from zero (the server has zeroed its own), my vehicle back in my half, as after being destroyed.
// World of DODO, issue #31: also while loading once the vehicle has its place (inPlay); the loading screen then builds the near
// detail round the new place too (main.ts). Before the spawn there is nothing to move: the spawn comes in my half anyway.
function newRound() {
  NET.pts = 0; for (const o of NET.others.values()) o.pts = 0;
  if (inPlay()) { respawn(); flash(T.newRound); }
}
// I reported a hit on depot i (net/net.ts netThit): a damage the next obj brings is mine
export function thitSent(i: number) { if (TM.thit[i] !== undefined) TM.thit[i] = now(); }
