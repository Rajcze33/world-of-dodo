// World of DODO: the life of the city, run here so that every player sees the same one: N_CARS cars, the tram, PED_N pedestrians,
// the parked cars pushed out of their spots, and the trees and lamps knocked down.
//
// World of DODO, issue #16: the city is the real Karlín, and the traffic, the tram and the pedestrians are no longer a port of the
// client's code kept in step by hand: both run the same modules, client/shared/traffic.ts, tram.ts and peds.ts (Node 24 loads the
// TypeScript by stripping its types). This file is the glue: what the shared city needs from the players (the tanks, the cars they
// push), what the snapshots carry, and the memory of the pedestrians knocked down and the props down. (The three.js copy the tram's
// curve used to need is gone: client/shared/catmull.ts serves both sides.)
//
// What has to be shared, as before: the cars give way to every tank (the players' and the bots'), and a car that a tank keeps
// blocking turns back after a while. A tank can still shove cars about, see "cars a player pushes" below. The parked cars stand where
// traffic.ts's PARK puts them, the same list on every client and here; the server keeps only those that have been pushed away from
// their spot. Pedestrians walk their loops here; a client that hits one with its tank or its own parcel reports it, and the fall
// happens here, for everyone: they lie there for a while, then walk again somewhere else. Knocked-down trees and lamps are only
// remembered and passed on, and stand up again after PROP_BACK_MS.
'use strict';

const { inArena } = require('../client/shared/map.ts');
const { N_CARS, PARK, newCar, seedTraffic, stepTraffic, rejoin: rejoinCar } = require('../client/shared/traffic.ts');
const { TRAM_STOPS, newTram, seedTram, stepTram } = require('../client/shared/tram.ts');
const { PED_N, PED_DOWN_T, newPed, knockPed, stepPeds } = require('../client/shared/peds.ts');

// ---------- traffic, tram, pedestrians (client/shared) ----------
const CARS = [];                            // the traffic, in the order of the client's TRAFFIC (snapshot field c)
const TRAM = newTram();
const PEDS = [];                            // in the order of the client's PEDS (message w)

// ---------- cars a player pushes ----------
// In the original the van shoved cars about: a car it hit became a free body until it came to rest, then rejoined the
// traffic. That works here with the authority scheme of networked physics games: whoever's tank (or pushed car) hits a
// car takes it over. Their browser runs the original body physics for it and reports where it is with every tank state
// ('st', field c); the server stops driving it, passes it on to everyone (snapshot field k, with the owner and the time
// of the report, so it moves in step with the owner's tank) and refuses it to anyone else meanwhile. When it has come
// to rest the owner lets go: a car of the traffic rejoins the nearest street, a parked car stays where it ended up and
// is towed home TOW_MS later once no tank is near. An owner who goes quiet for OWN_MS loses the car.
const OWN_MS = 1500, TOW_MS = 30000, TOW_FAR = 60, CLAIM_R = 30, CAR_JUMP = 25;
const PARKED = new Map();                   // parked car k (index N_CARS + k, PARK[k]) -> { x, z, hx, hz, v, owner, ownAt, ownTs, restAt }

// back onto the street after a push: the lane nearest to where it points, gliding there from where it stands (traffic.ts)
function rejoin(c) {
  rejoinCar(c, c.x, c.z, Math.atan2(c.hx, c.hz));
}
function letGo(c, i) {
  c.owner = 0;
  if (i < N_CARS) rejoin(c);
  else { c.v = 0; c.restAt = Date.now(); }
}
// Player pid (tank at tank.x, tank.z) reports the cars its browser moves, as [index, x, z, heading, speed, released];
// ts: the time of that report on the server's clock. Returns nothing: a refused claim simply does not show up in k.
function carsFrom(pid, tank, list, ts) {
  const now = Date.now();
  for (const e of list.slice(0, 8)) {
    if (!Array.isArray(e)) continue;
    const [i, x, z, a, v, rel] = e;
    if (!Number.isInteger(i) || i < 0 || i >= N_CARS + PARK.length || ![x, z, a, v].every(Number.isFinite)) continue;
    if (!inArena(x, z, -20) || Math.abs(a) > 100 || Math.abs(v) > 60) continue;   // (a pushed car stays in the arena, give or take)
    let c = i < N_CARS ? CARS[i] : PARKED.get(i);
    const mine = c && c.owner === pid;
    if (c && c.owner && !mine && now - c.ownAt < OWN_MS) continue;        // somebody else is pushing it
    if (!mine && Math.hypot(x - tank.x, z - tank.z) > CLAIM_R) continue;    // a new claim: only a car right at the tank
    const at = c || PARK[i - N_CARS];                                       // and about where it is (a parked car: its spot)
    if (Math.hypot(x - at.x - (at.ox || 0), z - at.z - (at.oz || 0)) > CAR_JUMP) continue;
    if (!c) { c = {}; PARKED.set(i, c); }
    Object.assign(c, { x, z, hx: Math.sin(a), hz: Math.cos(a), v: Math.abs(v), owner: pid, ownAt: now, ownTs: ts, ox: 0, oz: 0, oa: 0 });
    if (i < N_CARS) c.phase = 'dyn';
    if (rel === 1) letGo(c, i);
  }
}
// the player left: their cars go back to the traffic (or stay where they are, if parked)
function dropOwner(pid) {
  CARS.forEach((c, i) => { if (c.owner === pid) letGo(c, i); });
  for (const [i, c] of PARKED) if (c.owner === pid) letGo(c, i);
}
// owners who went quiet lose their cars; parked cars left somewhere are towed home when nobody is near
function stepPushed(tanks) {
  const now = Date.now();
  CARS.forEach((c, i) => { if (c.owner && now - c.ownAt > OWN_MS) letGo(c, i); });
  for (const [i, c] of PARKED) {
    if (c.owner) { if (now - c.ownAt > OWN_MS) letGo(c, i); }
    else if (now - c.restAt > TOW_MS && !tanks.some(t => Math.hypot(t.x - c.x, t.z - c.z) < TOW_FAR)) PARKED.delete(i);
  }
}

// ---------- trees and lamps knocked down ----------
const PROP_BACK_MS = 90000;
const PROPS_DOWN = new Map();               // prop index -> { fx, fz, t }

// ---------- the world ----------
function init() {
  for (let k = 0; k < N_CARS; k++) CARS.push(newCar(k, Math.random));
  seedTram(TRAM, TRAM_STOPS[1] - 60);
  seedTraffic(CARS, Math.random, TRAM);
  for (let k = 0; k < PED_N; k++) PEDS.push(newPed(k, Math.random));
}

// one step; tanks: every tank in the city as { x, z, h, v }. Returns the props that stand up again now (their indexes).
function step(dt, tanks) {
  stepPushed(tanks);
  const parked = [...PARKED.values()];      // the parked cars out of their spots stand in the way like cars that do not move
  stepTram(TRAM, dt, tanks, CARS.concat(parked));
  stepTraffic(CARS, dt, tanks, TRAM, parked);
  stepPeds(PEDS, dt, tanks, false);
  const up = [], now = Date.now();
  for (const [i, d] of PROPS_DOWN) if (now - d.t > PROP_BACK_MS) { PROPS_DOWN.delete(i); up.push(i); }
  return up;
}

const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
// What moves fast, for every tank snapshot: c = the cars as x, z, heading, speed (flat, in the order of the client's TRAFFIC);
// m = the tram's place on its track; k = the cars players push, as [index, owner, time of the owner's report, x, z, heading,
// speed]; q = parked cars pushed away from their spot and left there, as [index, x, z, heading].
function fast() {
  const c = [], k = [], q = [];
  const row = (i, o) => [i, o.owner, o.ownTs, r2(o.x), r2(o.z), r2(Math.atan2(o.hx, o.hz)), r1(o.v)];
  CARS.forEach((o, i) => {
    c.push(r2(o.x + (o.ox || 0)), r2(o.z + (o.oz || 0)), r2(Math.atan2(o.hx, o.hz) + (o.oa || 0)), r1(o.v));
    if (o.owner) k.push(row(i, o));
  });
  for (const [i, o] of PARKED) if (o.owner) k.push(row(i, o)); else q.push([i, r2(o.x), r2(o.z), r2(Math.atan2(o.hx, o.hz))]);
  return { c, m: r2(TRAM.s), k, q };
}
// What walks, every other snapshot: p = the pedestrians as x, z, heading, tilt, fall direction (flat, in the order of the client's PEDS)
function slow() {
  const p = [];
  for (const q of PEDS) p.push(r1(q.x), r1(q.z), r2(q.h), r2(q.th), q.th > 0 ? r2(Math.atan2(q.fx, q.fz)) : 0);
  return { p };
}

// a player reports a pedestrian their tank or their parcel hit; only one near that player counts. In the original they got up a few
// seconds later; here they stay down for PED_DOWN_T seconds, then they are gone and walk again somewhere else (peds.ts respawnPed).
function hitPed(i, vx, vz, from) {
  const p = PEDS[i];
  if (!p || (from && Math.hypot(p.x - from.x, p.z - from.z) > 80)) return false;
  return knockPed(p, vx, vz, PED_DOWN_T[0] + Math.random() * (PED_DOWN_T[1] - PED_DOWN_T[0]));
}
// a player knocked a tree or a lamp down: remembered until it stands up again; false if it is down already
function propDown(i, fx, fz) {
  if (PROPS_DOWN.has(i) || PROPS_DOWN.size >= 1000) return false;
  PROPS_DOWN.set(i, { fx, fz, t: Date.now() });
  return true;
}
const propsDown = () => [...PROPS_DOWN].map(([i, d]) => [i, d.fx, d.fz]);

init();
module.exports = { step, fast, slow, hitPed, propDown, propsDown, carsFrom, dropOwner, N_CARS, PED_N, PARK_N: PARK.length };
