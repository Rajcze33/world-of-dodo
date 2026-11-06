// World of DODO, issue #24: the team game on the server: the two teams' scores, the zones' capture, the supply depots and the rounds.
// The rules and the places are client/shared/rules.ts (the same file the page runs); this module is their state machine, and it is
// authoritative: the browsers only draw what it says (the obj message, docs/PROTOCOL.md). server/server.js feeds it the vehicles every
// tick and the points of every hit; it says when a round ends and when the next one begins (server.js then resets the players' points,
// rebalances the teams and brings the bots back).
//
// - A zone: every living tank (the river zone: ship) of a team inside moves its capture progress towards that team (rules.ts capStep;
//   at most CAP_MAX count, the two sides cancel out); a team owns it at ±100 and loses it when the progress crosses 0 (capOwner). Each
//   full second an owned zone gives its team ZONE_PTS.
// - A depot: DEPOT_HP; a parcel takes 2, a shell 1.5, a bullet 0.25 (DEPOT_DMG); a team cannot damage its own. Destroyed: DEPOT_PTS
//   for the team that destroyed it, rebuilt DEPOT_BACK_S later.
// - A round: ends when a team reaches the round's points or its time is up (the higher score wins, a tie is a draw); then INTER_S of
//   intermission, in which nothing scores (and server.js passes no fire on); then a new round from nothing.
// The limits: ROUND_POINTS and ROUND_SEC in the environment override rules.ts's (for the tests).
'use strict';

const R = require('../client/shared/rules.ts');
const MS = require('../client/shared/monster.ts');

const envNum = (k, d, lo) => { const v = Number(process.env[k]); return Number.isFinite(v) && v >= lo ? v : d; };
const ROUND_POINTS = Math.round(envNum('ROUND_POINTS', R.ROUND_PTS, 1));
const ROUND_SEC = envNum('ROUND_SEC', R.ROUND_S, 5);
const TEAM_SIZE = Math.max(1, Math.min(16, Math.round(envNum('TEAM_SIZE', R.TEAM_SIZE, 1))));

// What a hit weighs: its share of what destroys the vehicle (issue #14, #20), the same numbers as HIT_W in client/src/game/tank.ts
// (there the parcel is 'shot'). Three parcels destroy a tank, one a plane; a ship's hits add up over 20 s (HIT_WIN in tank.ts), a tank's
// and a plane's over 8. A person scores 10 points per unit; issue #24: a hit on a bot (any vehicle) half of that, at least 1.
// Issue #26: the kind 'mon', an attack of Velemlok (client/shared/monster.ts MON_HIT_W, which tank.ts uses too); it scores for nobody.
const HIT_W = {
  tank: { parcel: 1, bullet: 0.25, shell: 1, torp: 0, mon: MS.MON_HIT_W.tank },
  plane: { parcel: 3, bullet: 0.5, shell: 3, torp: 0, mon: MS.MON_HIT_W.plane },
  ship: { parcel: 0.75, bullet: 0.08, shell: 0.35, torp: 1.5, mon: MS.MON_HIT_W.ship },
};
const HIT_WIN_MS = { tank: 8000, plane: 8000, ship: 20000 };
const VEHICLE = ['tank', 'plane', 'ship'], KIND = ['parcel', 'bullet', 'shell', 'torp', 'mon'];
const weight = (veh, k) => HIT_W[VEHICLE[veh] || 'tank'][KIND[k] || 'parcel'];
// the points of a hit of kind k (0 parcel, 1 bullet, 2 shell, 3 torpedo; 4 Velemlok's attack never scores) on vehicle veh (0 tank, 1
// plane, 2 ship)
function hitPoints(veh, k, bot) {
  const p = Math.round(10 * weight(veh, k));
  return bot ? Math.max(1, Math.round(p / 2)) : p;
}

const G = {
  captured: [],                       // zones taken since the server last looked: { i, team, ids } (issue #24, CAP_PTS)
  sc: [0, 0],
  zones: R.ZONES.map(() => ({ owner: -1, p: 0 })),
  depots: R.DEPOTS.map(() => ({ hp: R.DEPOT_HP, upAt: 0 })),
  st: 'play', endAt: 0, win: -1, best: null,
  sec: 0,                 // the time towards the next full second (the zones' points)
  dirty: true,            // something changed that the players must hear at once (obj)
};

const playing = () => G.st === 'play';

// a new round (also the first, when the first person comes in): nothing owned, every depot standing, no points
function newRound(now) {
  G.sc = [0, 0];
  for (const z of G.zones) { z.owner = -1; z.p = 0; }
  for (const d of G.depots) { d.hp = R.DEPOT_HP; d.upAt = 0; }
  G.st = 'play'; G.endAt = now + ROUND_SEC * 1000; G.win = -1; G.best = null; G.sec = 0; G.dirty = true;
}

// points for a team (a hit, a zone, a depot); none in the intermission
function addScore(team, pts) {
  if (!playing() || !(team === 0 || team === 1) || !(pts > 0)) return false;
  G.sc[team] += pts; G.dirty = true;
  return true;
}

// a hit of dmg on depot i by a vehicle of team `team`: true if it took effect, 2 if it destroyed the depot; destroyed: DEPOT_PTS for that team
function hitDepot(i, dmg, team, now) {
  const d = G.depots[i], D = R.DEPOTS[i];
  if (!d || !playing() || d.hp <= 0 || D.team === team || !(dmg > 0)) return false;
  d.hp = Math.max(0, Math.round((d.hp - dmg) * 100) / 100);
  if (d.hp <= 0) { d.upAt = now + R.DEPOT_BACK_S * 1000; addScore(team, R.DEPOT_PTS); }
  G.dirty = true;
  return d.hp <= 0 ? 2 : true;                                    // 2: destroyed (server.js credits the destroyer)
}

// One step of dt seconds at server time now (ms). vehicles: every living tank and ship as { team, k, x, z } (k 0 a tank, 2 a ship;
// planes do not capture). Returns 'end' when the round has just ended, 'new' when the next one has just begun, else null.
function step(dt, now, vehicles, best) {
  if (G.st === 'end') {
    if (now < G.endAt) return null;
    newRound(now);
    return 'new';
  }
  // the zones: who is inside, the capture, the owner
  const cnt = G.zones.map(() => [0, 0]);
  for (const v of vehicles) {
    if (v.team !== 0 && v.team !== 1) continue;
    const i = R.zoneAt(v.x, v.z, v.k === 2);
    if (i >= 0 && (v.k === 2) === R.ZONES[i].sea) cnt[i][v.team]++;
  }
  G.zones.forEach((z, i) => {
    z.p = R.capStep(z.p, cnt[i][0], cnt[i][1], dt);
    const o = R.capOwner(z.owner, z.p);
    if (o !== z.owner) {                                            // taken: the team's vehicles inside it get CAP_PTS each (server.js)
      if (o >= 0) G.captured.push({ i, team: o, ids: vehicles.filter(v => v.team === o && (v.k === 2) === R.ZONES[i].sea && R.zoneAt(v.x, v.z, v.k === 2) === i).map(v => v.id) });
      z.owner = o; G.dirty = true;
    }
  });
  // every full second: the owned zones' points
  G.sec += dt;
  while (G.sec >= 1) { G.sec -= 1; for (const z of G.zones) if (z.owner >= 0) addScore(z.owner, R.ZONE_PTS); }
  // the depots come back
  for (const d of G.depots) if (d.hp <= 0 && now >= d.upAt) { d.hp = R.DEPOT_HP; d.upAt = 0; G.dirty = true; }
  // the end of the round: the points, or the time
  if (G.sc[0] >= ROUND_POINTS || G.sc[1] >= ROUND_POINTS || now >= G.endAt) {
    G.st = 'end'; G.endAt = now + R.INTER_S * 1000;
    G.win = G.sc[0] > G.sc[1] ? 0 : G.sc[1] > G.sc[0] ? 1 : -1;
    G.best = best();
    G.dirty = true;
    return 'end';
  }
  return null;
}

// the objective state as the obj message carries it (docs/PROTOCOL.md): team scores, zones as [owner, progress], depots as [hp, upAt],
// the round: play or end, the seconds left (of the round or of the intermission), the winner, the best players after a round, and to
// (the points that win a round)
function state(now) {
  const r = { st: G.st, left: Math.max(0, Math.ceil((G.endAt - now) / 1000)), win: G.win, to: ROUND_POINTS };
  if (G.st === 'end' && G.best) r.best = G.best;
  return { ts: now, sc: G.sc.slice(), z: G.zones.map(z => [z.owner, Math.round(z.p)]), d: G.depots.map(d => [d.hp, d.upAt]), r };
}

module.exports = {
  G, R, ROUND_POINTS, ROUND_SEC, TEAM_SIZE, HIT_W, HIT_WIN_MS, weight, hitPoints, newRound, addScore, hitDepot, step, state, playing,
};
