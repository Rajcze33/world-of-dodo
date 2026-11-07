// The game's shared state: what screen it is on, the player's tank, the keys held. One object each, imported by every part
// that needs them (the original kept them as variables in one big closure).
import type { TransformNode } from '@babylonjs/core';

// 'intro': the name form over the orbiting city (the browser's own city); 'drive': in the game (the city comes from the server).
// World of DODO, issue #31: 'load': after Start, behind the loading screen (ui/loading.ts), until everything is ready: the city, the
// textures, the connection, the first snapshot, the shaders (main.ts startRun). The game's world runs then (the server's city, the
// round), but nothing is drawn, nothing is sent and no key drives.
export const G = {
  state: 'intro' as 'intro' | 'load' | 'drive',
  camMode: 0,                       // 0: behind the tank, 1: high above it (C or the camera button)
  realSec: 0,                       // seconds since driving out (the start hint shows for the first few)
  hold: false,                      // World of DODO, issue #24: the break after a round (game/teams.ts): nobody fires, no hit counts
  spawned: false,                   // World of DODO, issue #31: in 'load', the vehicle has its place already (the first snapshot came)
};
// World of DODO, issue #31: is the vehicle in its place in the city: in the game, or loading after its spawn. A new round or a move to
// the other team respawns it then (game/teams.ts, net/net.ts); before the spawn the spawn itself takes the new team into account.
export const inPlay = () => G.state === 'drive' || (G.state === 'load' && G.spawned);

// the player's vehicle: a tank or (World of DODO, issue #14) a plane, or (issue #20) a ship on the Vltava. k: what it is now (0 a tank,
// 1 a plane, 2 a ship), next: what the next (re)spawn gives, swT: switching to it (a countdown, game/tank.ts switchVehicle); y, p: a
// plane's altitude and pitch, a ship's heave and sinking below the waterline (0 afloat) and its pitch (a tank stays on the ground, gy).
// slowT: slowed after a hit; topT: destroyed, until it respawns (a tank lies on its side, a ship sinks); roll/rollDir: a tank's tilt
// while destroyed, a plane's bank, a ship's heel; immT: immune after a (re)spawn (it blinks); hitLog: when the last hits came and their
// weight (worth three parcels within 8 s destroy a tank, game/tank.ts HIT_W; a ship's window is 20 s)
export const car = {
  k: 0 as 0 | 1 | 2, next: 0 as 0 | 1 | 2, swT: 0,
  x: 0, z: 0, h: Math.PI, v: 0, steer: 0, gy: 0, y: 0, p: 0,   // (game/tank.ts reset puts it at the depot before the first frame)
  slowT: 0, topT: 0, roll: 0, rollDir: 1, immT: 0, hitLog: [] as [number, number][],
};
export type Tank = typeof car;

// keys held (keyboard and the touch buttons; alt: the second weapon, a tank's anti-aircraft gun, a plane's parcel, a ship's torpedoes),
// the touch steering pad (-1 left .. 1 right; pitchAxis -1 up .. 1 down, for a plane), the mouse moved since the last frame while locked
// to the game (a plane's aim, a ship's camera; issue #20: on a touch screen a drag over the game moves it too) and its buttons held.
// HELD: the keyboard's keys held by code (a plane reads W/S and the arrows apart, a ship Q, E and Shift)
export const K = { up: false, down: false, left: false, right: false, brake: false, fire: false, alt: false };
export const input = { steerAxis: 0, pitchAxis: 0, mx: 0, my: 0, lmb: false, rmb: false };
export const HELD = new Set<string>();

// the player's tank, plane and ship meshes (game/tank.ts, game/plane.ts and game/ship.ts build them)
export const view = { van: null as TransformNode | null, plane: null as TransformNode | null, ship: null as TransformNode | null };
